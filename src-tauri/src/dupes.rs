//! Поиск дубликатов: сначала по размеру, затем по хешу начала файла, затем по полному хешу.

use crate::scan_walk::Progress;
use crate::tree::*;
use crate::winutil::extended;
use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::os::windows::io::AsRawHandle;
use std::sync::atomic::Ordering::Relaxed;
use windows_sys::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION};

#[derive(Serialize, Clone)]
pub struct DupFile {
    pub id: u32,
    pub path: String,
    pub mtime: i64,
}

#[derive(Serialize, Clone)]
pub struct DupGroup {
    pub size: u64,
    pub wasted: u64,
    pub files: Vec<DupFile>,
}

#[derive(Serialize, Default, Clone)]
pub struct DupResult {
    pub groups: Vec<DupGroup>,
    pub wasted: u64,
    pub candidates: usize,
}

const HEAD: usize = 64 * 1024;

/// (хеш первых 64 КБ, идентификатор файла на томе). Одинаковый идентификатор — это жёсткая
/// ссылка на тот же файл, а не дубликат.
fn head_hash(path: &str) -> Option<([u8; 32], u64)> {
    let mut f = std::fs::File::open(extended(path)).ok()?;
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    let ok = unsafe { GetFileInformationByHandle(f.as_raw_handle() as _, &mut info) };
    let file_id = if ok != 0 { ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64 } else { 0 };
    let mut buf = vec![0u8; HEAD];
    let mut n = 0;
    while n < HEAD {
        match f.read(&mut buf[n..]) {
            Ok(0) => break,
            Ok(k) => n += k,
            Err(_) => return None,
        }
    }
    Some((*blake3::hash(&buf[..n]).as_bytes(), file_id))
}

fn full_hash(path: &str, progress: &Progress) -> Option<[u8; 32]> {
    let mut f = std::fs::File::open(extended(path)).ok()?;
    let mut hasher = blake3::Hasher::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        if progress.cancel.load(Relaxed) {
            return None;
        }
        match f.read(&mut buf) {
            Ok(0) => break,
            Ok(k) => {
                hasher.update(&buf[..k]);
                progress.done.fetch_add(k as u64, Relaxed);
            }
            Err(_) => return None,
        }
    }
    Some(*hasher.finalize().as_bytes())
}

/// Кандидаты: файлы не меньше `min_size` внутри `root_id`. Облачные заглушки пропускаем —
/// чтение вызвало бы их скачивание; системную папку Windows — тоже (там сплошные жёсткие ссылки).
pub fn candidates(tree: &Tree, root_id: u32, min_size: u64) -> Vec<(u64, u32, String, i64)> {
    let mut by_size: HashMap<u64, Vec<u32>> = HashMap::new();
    let mut stack = vec![root_id];
    while let Some(cur) = stack.pop() {
        let n = &tree.nodes[cur as usize];
        if n.deleted() || n.size < min_size {
            continue;
        }
        if n.is_dir() {
            if n.flags & F_REPARSE != 0 {
                continue;
            }
            if n.parent == 0 && cur != 0 {
                let name = tree.name(cur);
                if name.eq_ignore_ascii_case("Windows") || name.starts_with('$') || name.eq_ignore_ascii_case("System Volume Information") {
                    continue;
                }
            }
            stack.extend(n.first_child..n.first_child + n.child_count);
        } else if n.flags & (F_CLOUD | F_REPARSE) == 0 {
            by_size.entry(n.size).or_default().push(cur);
        }
    }
    let mut out = Vec::new();
    for (size, ids) in by_size {
        if ids.len() > 1 {
            for id in ids {
                out.push((size, id, tree.path(id), tree.nodes[id as usize].mtime));
            }
        }
    }
    out
}

pub fn find(cands: Vec<(u64, u32, String, i64)>, progress: &Progress) -> DupResult {
    let n_cands = cands.len();
    progress.total.store(cands.iter().map(|c| c.0).sum(), Relaxed);

    // Этап 1: хеш первых 64 КБ отсекает почти все ложные совпадения по размеру.
    let heads: Vec<(usize, [u8; 32], u64)> = cands
        .par_iter()
        .enumerate()
        .filter_map(|(i, c)| {
            if progress.cancel.load(Relaxed) {
                return None;
            }
            let r = head_hash(&c.2).map(|(h, fid)| (i, h, fid));
            if r.is_none() {
                progress.done.fetch_add(c.0, Relaxed);
            }
            progress.files.fetch_add(1, Relaxed);
            r
        })
        .collect();

    let mut by_head: HashMap<(u64, [u8; 32]), Vec<(usize, u64)>> = HashMap::new();
    for (i, h, fid) in heads {
        by_head.entry((cands[i].0, h)).or_default().push((i, fid));
    }
    let mut stage2: Vec<usize> = Vec::new();
    let mut small_groups: Vec<Vec<usize>> = Vec::new();
    for ((size, _), mut v) in by_head {
        // Жёсткие ссылки на один и тот же файл оставляем в одном экземпляре.
        v.sort_by_key(|x| x.1);
        v.dedup_by(|a, b| a.1 != 0 && a.1 == b.1);
        if v.len() < 2 {
            progress.done.fetch_add(size * v.len() as u64, Relaxed);
            continue;
        }
        if size as usize <= HEAD {
            progress.done.fetch_add(size * v.len() as u64, Relaxed);
            small_groups.push(v.into_iter().map(|x| x.0).collect());
        } else {
            stage2.extend(v.into_iter().map(|x| x.0));
        }
    }

    // Этап 2: полный хеш только для уцелевших.
    let fulls: Vec<(usize, [u8; 32])> = stage2
        .par_iter()
        .filter_map(|&i| full_hash(&cands[i].2, progress).map(|h| (i, h)))
        .collect();
    let mut by_full: HashMap<(u64, [u8; 32]), Vec<usize>> = HashMap::new();
    for (i, h) in fulls {
        by_full.entry((cands[i].0, h)).or_default().push(i);
    }

    let mut groups: Vec<DupGroup> = by_full
        .into_values()
        .chain(small_groups)
        .filter(|v| v.len() > 1)
        .map(|v| {
            let size = cands[v[0]].0;
            let mut files: Vec<DupFile> =
                v.iter().map(|&i| DupFile { id: cands[i].1, path: cands[i].2.clone(), mtime: cands[i].3 }).collect();
            files.sort_by(|a, b| a.mtime.cmp(&b.mtime).then_with(|| a.path.cmp(&b.path)));
            DupGroup { size, wasted: size * (files.len() as u64 - 1), files }
        })
        .collect();
    groups.sort_by(|a, b| b.wasted.cmp(&a.wasted));
    let wasted = groups.iter().map(|g| g.wasted).sum();
    groups.truncate(500);
    DupResult { groups, wasted, candidates: n_cands }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn finds_real_duplicates_only() {
        let d = std::env::temp_dir().join(format!("sc-dupes-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("x")).unwrap();
        let big: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
        let mut other = big.clone();
        other[150_000] ^= 0xFF; // тот же размер и то же начало, но другой хвост
        fs::write(d.join("a.bin"), &big).unwrap();
        fs::write(d.join("x").join("copy.bin"), &big).unwrap();
        fs::write(d.join("almost.bin"), &other).unwrap();
        fs::write(d.join("unique.bin"), vec![7u8; 1234]).unwrap();
        fs::hard_link(d.join("a.bin"), d.join("hardlink.bin")).unwrap();

        let p = Progress::default();
        let tree = crate::scan_walk::scan(d.to_str().unwrap(), &p).unwrap();
        let p2 = Progress::default();
        let res = find(candidates(&tree, 0, 1), &p2);
        assert_eq!(res.groups.len(), 1);
        let g = &res.groups[0];
        assert_eq!(g.size, 200_000);
        // a.bin и hardlink.bin — один файл; дубликат ровно один.
        assert_eq!(g.files.len(), 2);
        assert_eq!(g.wasted, 200_000);
        assert!(g.files.iter().any(|f| f.path.ends_with("copy.bin")));
        fs::remove_dir_all(&d).unwrap();
    }
}
