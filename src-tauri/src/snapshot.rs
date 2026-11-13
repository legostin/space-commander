//! Снимки размеров папок после каждого сканирования и сравнение двух снимков:
//! отвечает на вопрос «что выросло с прошлого раза».

use crate::schedule::data_dir;
use crate::tree::Tree;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

/// Папки меньше этого в снимок не попадают.
const DIR_MIN: u64 = 16 << 20;
/// Отдельные файлы — только действительно большие (образы, виртуальные диски, архивы игр).
const FILE_MIN: u64 = 128 << 20;
const MAX_ENTRIES: usize = 25_000;
const KEEP_PER_ROOT: usize = 30;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Entry {
    /// Путь относительно корня снимка; пустой — сам корень.
    pub p: String,
    pub d: bool,
    pub a: u64,
    pub f: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct SnapMeta {
    pub id: String,
    pub root: String,
    pub mode: String,
    pub taken_at: i64,
    pub alloc: u64,
    pub files: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Snapshot {
    pub meta: SnapMeta,
    pub entries: Vec<Entry>,
}

#[derive(Serialize, Clone, Debug)]
pub struct DiffItem {
    pub path: String,
    pub dir: bool,
    pub old: u64,
    pub new: u64,
    pub delta: i64,
    /// В прежнем снимке объекта не было (или он был меньше порога).
    pub is_new: bool,
    /// В новом снимке объекта нет (удалён или стал меньше порога).
    pub gone: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct Diff {
    pub base: SnapMeta,
    pub current: SnapMeta,
    pub delta: i64,
    pub delta_files: i64,
    /// Снимки сделаны в разных режимах сканирования — возможны небольшие расхождения.
    pub mixed_modes: bool,
    pub items: Vec<DiffItem>,
}

fn dir() -> PathBuf {
    let d = data_dir().join("snapshots");
    let _ = std::fs::create_dir_all(&d);
    d
}

fn root_key(root: &str) -> String {
    root.trim_end_matches('\\').chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_uppercase() } else { '_' }).collect()
}

/// Снимает размеры со свежего дерева. Вызывать до применения фильтра скрытых объектов.
pub fn capture(tree: &Tree) -> Snapshot {
    let root = &tree.nodes[0];
    let mut entries = vec![Entry { p: String::new(), d: true, a: root.alloc, f: root.files }];
    let mut stack: Vec<(u32, String)> = vec![(0, String::new())];
    while let Some((id, path)) = stack.pop() {
        let n = &tree.nodes[id as usize];
        for c in n.first_child..n.first_child + n.child_count {
            let ch = &tree.nodes[c as usize];
            if ch.deleted() {
                continue;
            }
            let is_dir = ch.is_dir();
            if ch.alloc < if is_dir { DIR_MIN } else { FILE_MIN } {
                continue;
            }
            let p = if path.is_empty() { tree.name(c).to_string() } else { format!("{}\\{}", path, tree.name(c)) };
            entries.push(Entry { p: p.clone(), d: is_dir, a: ch.alloc, f: ch.files });
            if is_dir {
                stack.push((c, p));
            }
        }
    }
    if entries.len() > MAX_ENTRIES {
        entries[1..].sort_unstable_by(|a, b| b.a.cmp(&a.a));
        entries.truncate(MAX_ENTRIES);
    }
    Snapshot {
        meta: SnapMeta {
            id: format!("{}__{}", root_key(&tree.root_path), tree.scanned_at),
            root: tree.root_path.clone(),
            mode: tree.mode.to_string(),
            taken_at: tree.scanned_at,
            alloc: root.alloc,
            files: root.files,
        },
        entries,
    }
}

fn read_index() -> Vec<SnapMeta> {
    std::fs::read_to_string(dir().join("index.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn write_index(index: &[SnapMeta]) {
    if let Ok(json) = serde_json::to_string(index) {
        let _ = std::fs::write(dir().join("index.json"), json);
    }
}

/// Сохраняет снимок и убирает самые старые сверх лимита для этого корня.
pub fn save(snap: &Snapshot) -> Result<(), String> {
    let json = serde_json::to_string(snap).map_err(|e| e.to_string())?;
    std::fs::write(dir().join(format!("{}.json", snap.meta.id)), json).map_err(|e| e.to_string())?;
    let mut index = read_index();
    index.retain(|m| m.id != snap.meta.id);
    index.push(snap.meta.clone());
    let key = root_key(&snap.meta.root);
    let mut mine: Vec<SnapMeta> = index.iter().filter(|m| root_key(&m.root) == key).cloned().collect();
    mine.sort_by_key(|m| m.taken_at);
    while mine.len() > KEEP_PER_ROOT {
        let old = mine.remove(0);
        let _ = std::fs::remove_file(dir().join(format!("{}.json", old.id)));
        index.retain(|m| m.id != old.id);
    }
    write_index(&index);
    Ok(())
}

/// Снимки для корня, от новых к старым.
pub fn list(root: &str) -> Vec<SnapMeta> {
    let key = root_key(root);
    let mut v: Vec<SnapMeta> = read_index().into_iter().filter(|m| root_key(&m.root) == key).collect();
    v.sort_by_key(|m| std::cmp::Reverse(m.taken_at));
    v
}

pub fn load(id: &str) -> Option<Snapshot> {
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return None;
    }
    let s = std::fs::read_to_string(dir().join(format!("{}.json", id))).ok()?;
    serde_json::from_str(&s).ok()
}

fn parent_of(path: &str) -> &str {
    match path.rfind('\\') {
        Some(i) => &path[..i],
        None => "",
    }
}

fn full_path(root: &str, rel: &str) -> String {
    if rel.is_empty() {
        root.to_string()
    } else if root.ends_with('\\') {
        format!("{}{}", root, rel)
    } else {
        format!("{}\\{}", root, rel)
    }
}

/// Сравнивает два снимка. Папка, изменение которой почти целиком объясняется одной
/// вложенной, в список не попадает — остаётся самая глубокая причина.
pub fn diff(old: &Snapshot, new: &Snapshot, limit: usize) -> Diff {
    const MIN_DELTA: i64 = 8 << 20;
    let old_map: HashMap<String, &Entry> = old.entries.iter().map(|e| (e.p.to_lowercase(), e)).collect();
    let new_map: HashMap<String, &Entry> = new.entries.iter().map(|e| (e.p.to_lowercase(), e)).collect();

    let mut items: Vec<(String, DiffItem)> = Vec::new();
    for e in &new.entries {
        if e.p.is_empty() {
            continue;
        }
        let key = e.p.to_lowercase();
        let before = old_map.get(&key).map(|o| o.a);
        let delta = e.a as i64 - before.unwrap_or(0) as i64;
        if delta.abs() >= MIN_DELTA {
            items.push((
                key,
                DiffItem { path: full_path(&new.meta.root, &e.p), dir: e.d, old: before.unwrap_or(0), new: e.a, delta, is_new: before.is_none(), gone: false },
            ));
        }
    }
    for e in &old.entries {
        let key = e.p.to_lowercase();
        if !e.p.is_empty() && !new_map.contains_key(&key) && e.a as i64 >= MIN_DELTA {
            items.push((key, DiffItem { path: full_path(&new.meta.root, &e.p), dir: e.d, old: e.a, new: 0, delta: -(e.a as i64), is_new: false, gone: true }));
        }
    }

    // Для каждой папки — самое крупное изменение среди прямых детей того же знака.
    let mut best_child: HashMap<String, i64> = HashMap::new();
    for (key, it) in &items {
        let b = best_child.entry(parent_of(key).to_string()).or_insert(0);
        if it.delta.abs() > b.abs() {
            *b = it.delta;
        }
    }
    let mut out: Vec<DiffItem> = items
        .into_iter()
        .filter(|(key, it)| match best_child.get(key) {
            Some(&c) => !(c.signum() == it.delta.signum() && c.abs() as f64 >= it.delta.abs() as f64 * 0.85),
            None => true,
        })
        .map(|(_, it)| it)
        .collect();
    out.sort_by_key(|it| std::cmp::Reverse(it.delta.abs()));
    out.truncate(limit);

    Diff {
        delta: new.meta.alloc as i64 - old.meta.alloc as i64,
        delta_files: new.meta.files as i64 - old.meta.files as i64,
        mixed_modes: old.meta.mode != new.meta.mode,
        base: old.meta.clone(),
        current: new.meta.clone(),
        items: out,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(t: i64, entries: &[(&str, bool, u64)]) -> Snapshot {
        let total = entries.iter().find(|e| e.0.is_empty()).map(|e| e.2).unwrap_or(0);
        Snapshot {
            meta: SnapMeta { id: format!("C__{}", t), root: "C:\\".into(), mode: "walk".into(), taken_at: t, alloc: total, files: 10 },
            entries: entries.iter().map(|&(p, d, a)| Entry { p: p.into(), d, a, f: 1 }).collect(),
        }
    }

    const GB: u64 = 1 << 30;

    #[test]
    fn reports_deepest_cause() {
        let old = snap(1, &[("", true, 100 * GB), ("Users", true, 50 * GB), ("Users\\me", true, 50 * GB), ("Users\\me\\AppData", true, 20 * GB), ("Users\\me\\Videos", true, 30 * GB), ("Games", true, 40 * GB)]);
        let new = snap(
            2,
            &[
                ("", true, 112 * GB),
                ("Users", true, 60 * GB),
                ("Users\\me", true, 60 * GB),
                ("Users\\me\\AppData", true, 29 * GB),
                ("Users\\me\\Videos", true, 31 * GB),
                ("Users\\me\\AppData\\cache.bin", false, 9 * GB),
                ("Games", true, 35 * GB),
                ("Новая", true, 7 * GB),
            ],
        );
        let d = diff(&old, &new, 50);
        assert_eq!(d.delta, 12 * GB as i64);
        let paths: Vec<&str> = d.items.iter().map(|i| i.path.as_str()).collect();
        // Users и Users\me объясняются ростом AppData, а AppData — файлом cache.bin.
        assert_eq!(paths, ["C:\\Users\\me\\AppData\\cache.bin", "C:\\Новая", "C:\\Games", "C:\\Users\\me\\Videos"]);
        assert!(d.items[0].is_new && d.items[1].is_new);
        assert_eq!(d.items[2].delta, -5 * GB as i64);
    }

    #[test]
    fn keeps_parent_when_growth_is_spread() {
        let old = snap(1, &[("", true, 10 * GB), ("A", true, 10 * GB), ("A\\x", true, 5 * GB), ("A\\y", true, 5 * GB)]);
        let new = snap(2, &[("", true, 14 * GB), ("A", true, 14 * GB), ("A\\x", true, 7 * GB), ("A\\y", true, 7 * GB)]);
        let d = diff(&old, &new, 50);
        let paths: Vec<&str> = d.items.iter().map(|i| i.path.as_str()).collect();
        assert_eq!(paths[0], "C:\\A", "рост размазан по детям — показываем и саму папку");
        assert_eq!(paths.len(), 3);
    }

    #[test]
    fn reports_removed_folders() {
        let old = snap(1, &[("", true, 10 * GB), ("Old", true, 6 * GB)]);
        let new = snap(2, &[("", true, 4 * GB)]);
        let d = diff(&old, &new, 50);
        assert!(d.items[0].gone);
        assert_eq!(d.items[0].delta, -6 * GB as i64);
    }

    #[test]
    fn captures_tree() {
        let t = crate::tree::tests::build(
            "C:\\",
            &[(0, "Big", true, 0), (0, "Tiny", true, 0), (1, "movie.mkv", false, 300 << 20), (1, "small.txt", false, 10), (2, "a.txt", false, 100)],
        );
        let s = capture(&t);
        let paths: Vec<&str> = s.entries.iter().map(|e| e.p.as_str()).collect();
        assert_eq!(paths, ["", "Big", "Big\\movie.mkv"]);
        assert_eq!(s.meta.alloc, (300 << 20) + 110);
        assert_eq!(root_key("C:\\"), "C_");
        assert!(load("..\\evil").is_none());
    }
}
