//! Обычный режим: параллельный обход каталогов через FindFirstFileExW.
//! Работает без прав администратора и на любой файловой системе.

use crate::tree::*;
use crate::winutil::{self, filetime_to_unix};
use std::ffi::c_void;
use std::ptr::null;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::Relaxed};
use std::sync::Mutex;
use std::time::Instant;
use windows_sys::Win32::Foundation::{GetLastError, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{
    FindClose, FindExInfoBasic, FindExSearchNameMatch, FindFirstFileExW, FindNextFileW,
    GetCompressedFileSizeW, FIND_FIRST_EX_LARGE_FETCH, WIN32_FIND_DATAW,
};

const ATTR_HIDDEN: u32 = 0x2;
const ATTR_SYSTEM: u32 = 0x4;
const ATTR_DIRECTORY: u32 = 0x10;
const ATTR_SPARSE: u32 = 0x200;
const ATTR_REPARSE: u32 = 0x400;
const ATTR_COMPRESSED: u32 = 0x800;
const ATTR_OFFLINE: u32 = 0x1000;
const ATTR_RECALL_ON_OPEN: u32 = 0x4_0000;
const ATTR_RECALL_ON_DATA: u32 = 0x40_0000;
/// Бит «name surrogate»: точка повторной обработки ведёт в другое место (ссылка, junction).
const TAG_NAME_SURROGATE: u32 = 0x2000_0000;

#[derive(Default)]
pub struct Progress {
    pub files: AtomicU64,
    pub dirs: AtomicU64,
    pub bytes: AtomicU64,
    /// Для режима MFT: сколько байт таблицы прочитано / всего.
    pub done: AtomicU64,
    pub total: AtomicU64,
    pub cancel: AtomicBool,
}

struct Arena {
    nodes: Vec<Node>,
    names: Vec<u8>,
}

struct Ctx<'a> {
    arena: Mutex<Arena>,
    denied: Mutex<Vec<String>>,
    progress: &'a Progress,
    cluster: u64,
}

fn display_path(w: &[u16]) -> String {
    let s = String::from_utf16_lossy(w);
    match s.strip_prefix(r"\\?\UNC\") {
        Some(rest) => format!(r"\\{}", rest),
        None => s.strip_prefix(r"\\?\").unwrap_or(&s).to_string(),
    }
}

fn walk<'s>(s: &rayon::Scope<'s>, ctx: &'s Ctx<'s>, dir_id: u32, path: Vec<u16>) {
    if ctx.progress.cancel.load(Relaxed) {
        return;
    }
    let mut pat = Vec::with_capacity(path.len() + 3);
    pat.extend_from_slice(&path);
    pat.extend_from_slice(&[b'\\' as u16, b'*' as u16, 0]);

    let mut fd: WIN32_FIND_DATAW = unsafe { std::mem::zeroed() };
    let h = unsafe {
        FindFirstFileExW(
            pat.as_ptr(),
            FindExInfoBasic,
            &mut fd as *mut _ as *mut c_void,
            FindExSearchNameMatch,
            null(),
            FIND_FIRST_EX_LARGE_FETCH,
        )
    };
    if h == INVALID_HANDLE_VALUE {
        let err = unsafe { GetLastError() };
        // 2/18 — папка просто пуста или исчезла; остальное считаем отказом в доступе.
        if err != 2 && err != 18 && err != 3 {
            ctx.denied.lock().unwrap().push(display_path(&path));
            ctx.arena.lock().unwrap().nodes[dir_id as usize].flags |= F_DENIED;
        }
        return;
    }

    let mut ents: Vec<Node> = Vec::with_capacity(32);
    let mut names: Vec<u8> = Vec::with_capacity(512);
    let mut subdirs: Vec<(u32, Vec<u16>)> = Vec::new();
    let (mut n_files, mut n_bytes) = (0u64, 0u64);

    loop {
        let len = fd.cFileName.iter().position(|&c| c == 0).unwrap_or(fd.cFileName.len());
        let wname = &fd.cFileName[..len];
        let dot = b'.' as u16;
        let is_dots = (len == 1 && wname[0] == dot) || (len == 2 && wname[0] == dot && wname[1] == dot);
        if !is_dots && len > 0 {
            let attr = fd.dwFileAttributes;
            let is_dir = attr & ATTR_DIRECTORY != 0;
            let mut flags = 0u16;
            if is_dir {
                flags |= F_DIR;
            }
            if attr & ATTR_HIDDEN != 0 {
                flags |= F_HIDDEN;
            }
            if attr & ATTR_SYSTEM != 0 {
                flags |= F_SYSTEM;
            }
            if attr & ATTR_COMPRESSED != 0 {
                flags |= F_COMPRESSED;
            }
            if attr & ATTR_SPARSE != 0 {
                flags |= F_SPARSE;
            }
            let surrogate = attr & ATTR_REPARSE != 0 && fd.dwReserved0 & TAG_NAME_SURROGATE != 0;
            if surrogate {
                flags |= F_REPARSE;
            }
            let cloud = attr & (ATTR_OFFLINE | ATTR_RECALL_ON_OPEN | ATTR_RECALL_ON_DATA) != 0;
            if cloud {
                flags |= F_CLOUD;
            }

            let name_off = names.len() as u32;
            for ch in char::decode_utf16(wname.iter().copied()) {
                let c = ch.unwrap_or(char::REPLACEMENT_CHARACTER);
                let mut b = [0u8; 4];
                names.extend_from_slice(c.encode_utf8(&mut b).as_bytes());
            }
            let name_len = (names.len() as u32 - name_off) as u16;

            let (mut size, mut alloc) = (0u64, 0u64);
            if !is_dir {
                size = ((fd.nFileSizeHigh as u64) << 32) | fd.nFileSizeLow as u64;
                alloc = if cloud {
                    0
                } else if attr & (ATTR_COMPRESSED | ATTR_SPARSE) != 0 {
                    // Реальный размер сжатого/разрежённого файла знает только отдельный вызов.
                    let mut full = Vec::with_capacity(path.len() + len + 2);
                    full.extend_from_slice(&path);
                    full.push(b'\\' as u16);
                    full.extend_from_slice(wname);
                    full.push(0);
                    let mut high = 0u32;
                    let low = unsafe { GetCompressedFileSizeW(full.as_ptr(), &mut high) };
                    if low == u32::MAX && unsafe { GetLastError() } != 0 {
                        size
                    } else {
                        ((high as u64) << 32) | low as u64
                    }
                } else {
                    size.div_ceil(ctx.cluster) * ctx.cluster
                };
                n_files += 1;
                n_bytes += size;
            } else if !surrogate {
                let mut child = Vec::with_capacity(path.len() + len + 1);
                child.extend_from_slice(&path);
                child.push(b'\\' as u16);
                child.extend_from_slice(wname);
                subdirs.push((ents.len() as u32, child));
            }

            let ft = ((fd.ftLastWriteTime.dwHighDateTime as u64) << 32) | fd.ftLastWriteTime.dwLowDateTime as u64;
            ents.push(Node {
                size,
                alloc,
                mtime: filetime_to_unix(ft),
                parent: dir_id,
                first_child: 0,
                child_count: 0,
                files: if is_dir { 0 } else { 1 },
                name_off,
                name_len,
                flags,
            });
        }
        if unsafe { FindNextFileW(h, &mut fd) } == 0 {
            break;
        }
    }
    unsafe { FindClose(h) };

    ctx.progress.files.fetch_add(n_files, Relaxed);
    ctx.progress.bytes.fetch_add(n_bytes, Relaxed);
    ctx.progress.dirs.fetch_add(1, Relaxed);
    if ents.is_empty() {
        return;
    }

    // Один короткий захват на каталог: дети ложатся в арену подряд.
    let start = {
        let mut a = ctx.arena.lock().unwrap();
        let start = a.nodes.len() as u32;
        let base = a.names.len() as u32;
        a.names.extend_from_slice(&names);
        for e in ents.iter_mut() {
            e.name_off += base;
        }
        a.nodes.extend_from_slice(&ents);
        let d = &mut a.nodes[dir_id as usize];
        d.first_child = start;
        d.child_count = ents.len() as u32;
        start
    };

    for (idx, child_path) in subdirs {
        s.spawn(move |s| walk(s, ctx, start + idx, child_path));
    }
}

/// Сканирует `root` (`C:\` или любую папку).
pub fn scan(root: &str, progress: &Progress) -> Result<Tree, String> {
    let started = Instant::now();
    let trimmed = if root.len() > 3 { root.trim_end_matches('\\') } else { root };
    let root_path = if trimmed.len() == 2 && trimmed.ends_with(':') {
        format!("{}\\", trimmed)
    } else {
        trimmed.to_string()
    };
    // Для FindFirstFile нужен путь без завершающего слэша: `\\?\C:` + `\*`.
    let ext = winutil::extended(root_path.trim_end_matches('\\'));
    let wroot: Vec<u16> = ext.encode_utf16().collect();

    let meta = std::fs::metadata(&root_path).map_err(|e| format!("{} {}: {}", crate::i18n::tr("Не удалось открыть", "Could not open"), root_path, e))?;
    if !meta.is_dir() {
        return Err(format!("{} — {}", root_path, crate::i18n::tr("не папка", "not a folder")));
    }

    let ctx = Ctx {
        arena: Mutex::new(Arena {
            nodes: vec![Node { flags: F_DIR, ..Default::default() }],
            names: Vec::new(),
        }),
        denied: Mutex::new(Vec::new()),
        progress,
        cluster: winutil::cluster_size(&winutil::volume_root(&root_path)) as u64,
    };

    // Перечисление каталогов упирается в ввод-вывод, а не в процессор — потоков берём с запасом.
    let threads = (std::thread::available_parallelism().map(|n| n.get()).unwrap_or(8) * 2).clamp(4, 48);
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(threads)
        .thread_name(|i| format!("scan-{}", i))
        .build()
        .map_err(|e| e.to_string())?;
    pool.scope(|s| walk(s, &ctx, 0, wroot));

    if progress.cancel.load(Relaxed) {
        return Err("cancelled".into());
    }
    let arena = ctx.arena.into_inner().unwrap();
    let mut denied = ctx.denied.into_inner().unwrap();
    denied.sort();
    let mut tree = Tree {
        nodes: arena.nodes,
        names: arena.names,
        root_path,
        mode: "walk",
        duration_ms: 0,
        denied,
        scanned_at: winutil::now_unix(),
        ..Default::default()
    };
    tree.finalize();
    tree.duration_ms = started.elapsed().as_millis() as u64;
    Ok(tree)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn scans_a_real_directory() {
        let dir = std::env::temp_dir().join(format!("sc-walk-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("a").join("глубоко")).unwrap();
        fs::write(dir.join("one.bin"), vec![0u8; 5000]).unwrap();
        fs::write(dir.join("a").join("two.txt"), b"hello").unwrap();
        fs::write(dir.join("a").join("глубоко").join("три.dat"), vec![1u8; 10_000]).unwrap();

        let p = Progress::default();
        let t = scan(dir.to_str().unwrap(), &p).unwrap();
        assert_eq!(t.nodes[0].size, 15_005);
        assert_eq!(t.nodes[0].files, 3);
        assert!(t.nodes[0].alloc >= 15_005);
        assert_eq!(p.files.load(Relaxed), 3);
        let id = t.find_path(dir.join("a").join("глубоко").join("три.dat").to_str().unwrap()).unwrap();
        assert_eq!(t.nodes[id as usize].size, 10_000);
        assert!(t.denied.is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }
}
