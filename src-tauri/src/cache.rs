//! Кеш результата сканирования на диске: при следующем запуске карта открывается сразу,
//! а свежие данные подтягиваются фоновым пересканированием.

use crate::tree::{Node, Tree};
use crate::winutil;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::PathBuf;

const MAGIC: &[u8; 4] = b"SCT2";
const NODE_SIZE: usize = std::mem::size_of::<Node>();

#[derive(Serialize, Deserialize)]
struct Header {
    root_path: String,
    mode: String,
    duration_ms: u64,
    scanned_at: i64,
    denied: Vec<String>,
    dir_own: Vec<(u32, u64)>,
    node_count: u64,
}

pub fn dir() -> PathBuf {
    let d = winutil::local_appdata().join("SpaceCommander").join("cache");
    let _ = std::fs::create_dir_all(&d);
    d
}

fn file_for(root: &str) -> PathBuf {
    let key: String = root.trim_end_matches('\\').chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_uppercase() } else { '_' }).collect();
    dir().join(format!("{}.sctree", key))
}

fn is_drive_root(root: &str) -> bool {
    let b = root.as_bytes();
    b.len() <= 3 && b.len() >= 2 && b[1] == b':'
}

fn write_block(f: &mut impl Write, data: &[u8]) -> std::io::Result<()> {
    let packed = lz4_flex::compress_prepend_size(data);
    f.write_all(&(packed.len() as u64).to_le_bytes())?;
    f.write_all(&packed)
}

fn read_block(f: &mut impl Read) -> Result<Vec<u8>, String> {
    let mut len = [0u8; 8];
    f.read_exact(&mut len).map_err(|e| e.to_string())?;
    let len = u64::from_le_bytes(len) as usize;
    if len > 4 << 30 {
        return Err("повреждённый кеш".into());
    }
    let mut packed = vec![0u8; len];
    f.read_exact(&mut packed).map_err(|e| e.to_string())?;
    lz4_flex::decompress_size_prepended(&packed).map_err(|e| e.to_string())
}

/// Сохраняет дерево диска. Папки, отсканированные отдельно, не кешируются — они сканируются быстро.
pub fn save(tree: &Tree) -> Result<(), String> {
    if !is_drive_root(&tree.root_path) {
        return Ok(());
    }
    let header = Header {
        root_path: tree.root_path.clone(),
        mode: tree.mode.to_string(),
        duration_ms: tree.duration_ms,
        scanned_at: tree.scanned_at,
        denied: tree.denied.iter().take(2000).cloned().collect(),
        dir_own: tree.dir_own.clone(),
        node_count: tree.nodes.len() as u64,
    };
    let path = file_for(&tree.root_path);
    let tmp = path.with_extension("tmp");
    let io = |e: std::io::Error| e.to_string();
    {
        let mut f = std::io::BufWriter::new(std::fs::File::create(&tmp).map_err(io)?);
        f.write_all(MAGIC).map_err(io)?;
        f.write_all(&(NODE_SIZE as u32).to_le_bytes()).map_err(io)?;
        write_block(&mut f, &serde_json::to_vec(&header).map_err(|e| e.to_string())?).map_err(io)?;
        // Node — плоская структура без указателей и выравнивающих дыр, её можно писать как байты.
        let bytes = unsafe { std::slice::from_raw_parts(tree.nodes.as_ptr() as *const u8, tree.nodes.len() * NODE_SIZE) };
        write_block(&mut f, bytes).map_err(io)?;
        write_block(&mut f, &tree.names).map_err(io)?;
        f.flush().map_err(io)?;
    }
    std::fs::rename(&tmp, &path).map_err(io)
}

fn load_file(path: &std::path::Path) -> Result<Tree, String> {
    let mut f = std::io::BufReader::new(std::fs::File::open(path).map_err(|e| e.to_string())?);
    let mut magic = [0u8; 8];
    f.read_exact(&mut magic).map_err(|e| e.to_string())?;
    if &magic[..4] != MAGIC || u32::from_le_bytes(magic[4..8].try_into().unwrap()) as usize != NODE_SIZE {
        return Err("кеш от другой версии".into());
    }
    let header: Header = serde_json::from_slice(&read_block(&mut f)?).map_err(|e| e.to_string())?;
    let node_bytes = read_block(&mut f)?;
    let names = read_block(&mut f)?;
    let count = header.node_count as usize;
    if count == 0 || node_bytes.len() != count * NODE_SIZE {
        return Err("повреждённый кеш".into());
    }
    let mut nodes: Vec<Node> = vec![Node::default(); count];
    unsafe { std::ptr::copy_nonoverlapping(node_bytes.as_ptr(), nodes.as_mut_ptr() as *mut u8, node_bytes.len()) };
    drop(node_bytes);
    // Проверяем ссылки: повреждённый файл не должен привести к выходу за границы.
    let names_len = names.len() as u64;
    for (i, n) in nodes.iter().enumerate() {
        let ok = (n.parent as usize) < count
            && (i == 0 || (n.parent as usize) < i)
            && n.first_child as u64 + n.child_count as u64 <= count as u64
            && n.name_off as u64 + n.name_len as u64 <= names_len;
        if !ok {
            return Err("повреждённый кеш".into());
        }
    }
    if std::str::from_utf8(&names).is_err() {
        return Err("повреждённый кеш".into());
    }
    Ok(Tree {
        nodes,
        names,
        root_path: header.root_path,
        mode: match header.mode.as_str() {
            "mft" => "mft",
            _ => "walk",
        },
        duration_ms: header.duration_ms,
        denied: header.denied,
        scanned_at: header.scanned_at,
        dir_own: header.dir_own,
        ..Default::default()
    })
}

/// Загружает все сохранённые деревья. Испорченные и устаревшие файлы удаляются.
pub fn load_all() -> Vec<Tree> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir()) else { return out };
    for e in rd.flatten() {
        let path = e.path();
        if path.extension().and_then(|x| x.to_str()) != Some("sctree") {
            continue;
        }
        match load_file(&path) {
            Ok(t) => out.push(t),
            Err(_) => {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_corruption() {
        let mut t = crate::tree::tests::build("Q:\\", &[(0, "папка", true, 0), (0, "b.txt", false, 7), (1, "файл.bin", false, 12345)]);
        t.dir_own = vec![(1, 99)];
        t.denied = vec!["Q:\\secret".into()];
        t.scanned_at = 42;
        save(&t).unwrap();
        let path = file_for("Q:\\");
        let back = load_file(&path).unwrap();
        assert_eq!(back.nodes.len(), t.nodes.len());
        assert_eq!(back.nodes[0].size, 12352);
        assert_eq!(back.path(3), "Q:\\папка\\файл.bin");
        assert_eq!((back.scanned_at, back.dir_own.clone(), back.denied.len()), (42, vec![(1, 99)], 1));

        // Обрезанный файл не должен читаться как дерево.
        let bytes = std::fs::read(&path).unwrap();
        std::fs::write(&path, &bytes[..bytes.len() - 5]).unwrap();
        assert!(load_file(&path).is_err());
        std::fs::remove_file(&path).unwrap();

        // Папки не кешируются.
        let folder = crate::tree::tests::build("Q:\\some\\folder", &[(0, "a", false, 1)]);
        save(&folder).unwrap();
        assert!(!file_for("Q:\\some\\folder").exists());
    }
}
