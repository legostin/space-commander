//! Дерево файлов в плоской арене и все запросы к нему.
//!
//! Узлы лежат в одном `Vec`, дети каждого каталога — подряд. Фронтенду никогда
//! не отдаётся всё дерево: только срезы (дети папки, усечённое поддерево для карты,
//! топ файлов), поэтому миллионы файлов не тормозят интерфейс.

use crate::categories::{self, CAT_DIR, CAT_REST};
use rayon::prelude::*;
use serde::Serialize;
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};

pub const F_DIR: u16 = 1;
pub const F_REPARSE: u16 = 2;
pub const F_HIDDEN: u16 = 4;
pub const F_SYSTEM: u16 = 8;
pub const F_COMPRESSED: u16 = 16;
pub const F_DENIED: u16 = 32;
pub const F_CLOUD: u16 = 64;
pub const F_DELETED: u16 = 128;
pub const F_SPARSE: u16 = 256;
/// Узел скрыт фильтром «скрытые/системные» (сам или вместе с родительской папкой).
pub const F_FILTERED: u16 = 512;

pub const REST_ID: u32 = u32::MAX;

#[derive(Clone, Copy, Default)]
pub struct Node {
    /// Логический размер (для папок — сумма).
    pub size: u64,
    /// Занято на диске.
    pub alloc: u64,
    /// Unix-время изменения (для папок — самое свежее среди содержимого).
    pub mtime: i64,
    pub parent: u32,
    pub first_child: u32,
    pub child_count: u32,
    pub files: u32,
    pub name_off: u32,
    pub name_len: u16,
    pub flags: u16,
}

impl Node {
    #[inline]
    pub fn is_dir(&self) -> bool {
        self.flags & F_DIR != 0
    }
    /// Узла нет в выдаче: удалён с диска или скрыт фильтром.
    #[inline]
    pub fn deleted(&self) -> bool {
        self.flags & (F_DELETED | F_FILTERED) != 0
    }
    #[inline]
    pub fn metric(&self, by_alloc: bool) -> u64 {
        if by_alloc {
            self.alloc
        } else {
            self.size
        }
    }
}

#[derive(Default)]
pub struct Tree {
    pub nodes: Vec<Node>,
    pub names: Vec<u8>,
    /// `C:\` или `C:\Users\me` — без завершающего `\`, кроме корня диска.
    pub root_path: String,
    pub mode: &'static str,
    pub duration_ms: u64,
    pub denied: Vec<String>,
    pub scanned_at: i64,
    /// Собственное место папок на диске (индексы NTFS) — нужно, чтобы пересчитать суммы при смене фильтра.
    pub dir_own: Vec<(u32, u64)>,
    /// Какие атрибуты сейчас скрыты (F_HIDDEN | F_SYSTEM).
    pub hide_mask: u16,
    /// Сколько скрыто фильтром: размер, место на диске, число файлов.
    pub hidden: (u64, u64, u32),
}

#[derive(Serialize, Clone)]
pub struct NodeDto {
    pub id: u32,
    pub name: String,
    pub size: u64,
    pub alloc: u64,
    pub files: u32,
    pub dir: bool,
    pub mtime: i64,
    pub flags: u16,
    pub cat: u8,
}

#[derive(Serialize)]
pub struct Crumb {
    pub id: u32,
    pub name: String,
}

#[derive(Serialize)]
pub struct DirView {
    pub node: NodeDto,
    pub path: String,
    pub crumbs: Vec<Crumb>,
    pub children: Vec<NodeDto>,
}

/// Узел усечённого поддерева для карты. `p` — индекс родителя в этом же массиве.
#[derive(Serialize)]
pub struct SubNode {
    pub id: u32,
    pub p: i32,
    pub name: String,
    pub size: u64,
    pub dir: bool,
    pub cat: u8,
    pub files: u32,
}

#[derive(Serialize)]
pub struct FileDto {
    pub id: u32,
    pub name: String,
    pub path: String,
    pub size: u64,
    pub alloc: u64,
    pub mtime: i64,
    pub dir: bool,
    pub cat: u8,
}

#[derive(Serialize)]
pub struct ExtStat {
    pub ext: String,
    pub cat: u8,
    pub size: u64,
    pub alloc: u64,
    pub count: u64,
}

#[derive(Serialize)]
pub struct SearchResult {
    pub total: usize,
    pub items: Vec<FileDto>,
}

#[derive(Serialize)]
pub struct Artifact {
    pub id: u32,
    pub path: String,
    pub project: String,
    pub kind: String,
    pub size: u64,
    pub alloc: u64,
    pub files: u32,
    /// Когда в проекте последний раз что-то меняли (кроме самой папки-артефакта).
    pub project_mtime: i64,
}

#[derive(Serialize, Clone)]
pub struct ScanSummary {
    pub root: String,
    pub mode: String,
    pub duration_ms: u64,
    pub files: u32,
    pub dirs: u32,
    pub size: u64,
    pub alloc: u64,
    pub denied: usize,
    pub scanned_at: i64,
    pub hidden_size: u64,
    pub hidden_alloc: u64,
    pub hidden_files: u32,
}

impl Tree {
    pub fn name(&self, id: u32) -> &str {
        let n = &self.nodes[id as usize];
        let off = n.name_off as usize;
        std::str::from_utf8(&self.names[off..off + n.name_len as usize]).unwrap_or("")
    }

    pub fn path(&self, id: u32) -> String {
        let mut parts: Vec<&str> = Vec::new();
        let mut cur = id;
        while cur != 0 {
            parts.push(self.name(cur));
            cur = self.nodes[cur as usize].parent;
        }
        let mut s = self.root_path.clone();
        for p in parts.iter().rev() {
            if !s.ends_with('\\') {
                s.push('\\');
            }
            s.push_str(p);
        }
        s
    }

    /// Суммирует размеры снизу вверх. Дети всегда имеют больший индекс, чем родитель,
    /// поэтому хватает одного обратного прохода.
    pub fn finalize(&mut self) {
        self.dir_own = self
            .nodes
            .iter()
            .enumerate()
            .filter(|(_, n)| n.is_dir() && n.alloc > 0)
            .map(|(i, n)| (i as u32, n.alloc))
            .collect();
        for i in (1..self.nodes.len()).rev() {
            let n = self.nodes[i];
            let p = &mut self.nodes[n.parent as usize];
            p.size += n.size;
            p.alloc += n.alloc;
            p.files += n.files;
            if n.mtime > p.mtime {
                p.mtime = n.mtime;
            }
        }
    }

    /// Скрывает объекты с атрибутами из `mask` (F_HIDDEN, F_SYSTEM) вместе со всем их содержимым
    /// и пересчитывает суммы папок, чтобы проценты и размеры относились только к видимому.
    /// `mask = 0` возвращает всё как было.
    pub fn apply_filter(&mut self, mask: u16) {
        let mask = mask & (F_HIDDEN | F_SYSTEM);
        self.hide_mask = mask;
        let n = self.nodes.len();
        // Скрытость наследуется: родитель всегда раньше ребёнка, хватает прямого прохода.
        for i in 1..n {
            let parent_filtered = self.nodes[self.nodes[i].parent as usize].flags & F_FILTERED != 0;
            let node = &mut self.nodes[i];
            if parent_filtered || node.flags & mask != 0 {
                node.flags |= F_FILTERED;
            } else {
                node.flags &= !F_FILTERED;
            }
        }
        for node in self.nodes.iter_mut() {
            if node.is_dir() {
                node.size = 0;
                node.alloc = 0;
                node.files = 0;
            }
        }
        for &(id, own) in &self.dir_own {
            let node = &mut self.nodes[id as usize];
            if node.flags & F_DELETED == 0 {
                node.alloc = own;
            }
        }
        let mut hidden = (0u64, 0u64, 0u32);
        for i in (1..n).rev() {
            let node = self.nodes[i];
            if node.flags & F_DELETED != 0 {
                continue;
            }
            if node.flags & F_FILTERED != 0 {
                // До скрытых папок суммы детей не доходят, так что здесь только их собственное место.
                hidden.0 += node.size;
                hidden.1 += node.alloc;
                hidden.2 += node.files;
                continue;
            }
            let p = &mut self.nodes[node.parent as usize];
            p.size += node.size;
            p.alloc += node.alloc;
            p.files += node.files;
        }
        self.hidden = hidden;
    }

    pub fn summary(&self) -> ScanSummary {
        let root = &self.nodes[0];
        let dirs = self.nodes.iter().filter(|n| n.is_dir() && !n.deleted()).count() as u32;
        ScanSummary {
            root: self.root_path.clone(),
            mode: self.mode.to_string(),
            duration_ms: self.duration_ms,
            files: root.files,
            dirs,
            size: root.size,
            alloc: root.alloc,
            denied: self.denied.len(),
            scanned_at: self.scanned_at,
            hidden_size: self.hidden.0,
            hidden_alloc: self.hidden.1,
            hidden_files: self.hidden.2,
        }
    }

    fn cat(&self, id: u32) -> u8 {
        if self.nodes[id as usize].is_dir() {
            CAT_DIR
        } else {
            categories::category_of_name(self.name(id))
        }
    }

    pub fn dto(&self, id: u32) -> NodeDto {
        let n = &self.nodes[id as usize];
        NodeDto {
            id,
            name: if id == 0 { self.root_path.clone() } else { self.name(id).to_string() },
            size: n.size,
            alloc: n.alloc,
            files: n.files,
            dir: n.is_dir(),
            mtime: n.mtime,
            flags: n.flags,
            cat: self.cat(id),
        }
    }

    fn file_dto(&self, id: u32) -> FileDto {
        let n = &self.nodes[id as usize];
        FileDto {
            id,
            name: self.name(id).to_string(),
            path: self.path(id),
            size: n.size,
            alloc: n.alloc,
            mtime: n.mtime,
            dir: n.is_dir(),
            cat: self.cat(id),
        }
    }

    fn child_ids(&self, id: u32) -> std::ops::Range<u32> {
        let n = &self.nodes[id as usize];
        n.first_child..n.first_child + n.child_count
    }

    pub fn valid(&self, id: u32) -> bool {
        (id as usize) < self.nodes.len() && !self.nodes[id as usize].deleted()
    }

    pub fn dir_view(&self, id: u32, by_alloc: bool) -> DirView {
        let mut children: Vec<NodeDto> = self
            .child_ids(id)
            .filter(|&c| !self.nodes[c as usize].deleted())
            .map(|c| self.dto(c))
            .collect();
        children.sort_unstable_by(|a, b| {
            let (ma, mb) = if by_alloc { (a.alloc, b.alloc) } else { (a.size, b.size) };
            mb.cmp(&ma).then_with(|| a.name.cmp(&b.name))
        });
        let mut crumbs = Vec::new();
        let mut cur = id;
        loop {
            crumbs.push(Crumb {
                id: cur,
                name: if cur == 0 { self.root_path.clone() } else { self.name(cur).to_string() },
            });
            if cur == 0 {
                break;
            }
            cur = self.nodes[cur as usize].parent;
        }
        crumbs.reverse();
        DirView { node: self.dto(id), path: self.path(id), crumbs, children }
    }

    /// Усечённое поддерево: самые крупные узлы раскрываются первыми, пока не кончится
    /// бюджет; мелочь в каждой папке схлопывается в один узел «остальное».
    pub fn subtree(&self, id: u32, budget: usize, by_alloc: bool) -> Vec<SubNode> {
        let root = &self.nodes[id as usize];
        let total = root.metric(by_alloc).max(1);
        let min = total / 40_000;
        let hard_cap = budget + budget / 2;
        let mut out = vec![SubNode {
            id,
            p: -1,
            name: if id == 0 { self.root_path.clone() } else { self.name(id).to_string() },
            size: root.metric(by_alloc),
            dir: root.is_dir(),
            cat: self.cat(id),
            files: root.files,
        }];
        let mut heap: BinaryHeap<(u64, u32, u32)> = BinaryHeap::new();
        if root.is_dir() {
            heap.push((total, id, 0));
        }
        let mut kids: Vec<(u64, u32)> = Vec::new();
        while let Some((_, nid, oi)) = heap.pop() {
            if out.len() >= budget {
                break;
            }
            kids.clear();
            for c in self.child_ids(nid) {
                let n = &self.nodes[c as usize];
                let m = n.metric(by_alloc);
                if !n.deleted() && m > 0 {
                    kids.push((m, c));
                }
            }
            kids.sort_unstable_by(|a, b| b.cmp(a));
            let (mut rest_size, mut rest_count, mut rest_files) = (0u64, 0u32, 0u32);
            for &(m, c) in kids.iter() {
                let n = &self.nodes[c as usize];
                if m < min || out.len() >= hard_cap {
                    rest_size += m;
                    rest_count += 1;
                    rest_files += n.files;
                    continue;
                }
                let idx = out.len() as u32;
                out.push(SubNode {
                    id: c,
                    p: oi as i32,
                    name: self.name(c).to_string(),
                    size: m,
                    dir: n.is_dir(),
                    cat: self.cat(c),
                    files: n.files,
                });
                if n.is_dir() && n.child_count > 0 {
                    heap.push((m, c, idx));
                }
            }
            if rest_size > 0 {
                out.push(SubNode {
                    id: REST_ID,
                    p: oi as i32,
                    name: rest_count.to_string(),
                    size: rest_size,
                    dir: false,
                    cat: CAT_REST,
                    files: rest_files,
                });
            }
        }
        out
    }

    pub fn top_files(&self, id: u32, limit: usize, by_alloc: bool) -> Vec<FileDto> {
        let mut heap: BinaryHeap<Reverse<(u64, u32)>> = BinaryHeap::with_capacity(limit + 1);
        let mut stack = vec![id];
        while let Some(cur) = stack.pop() {
            let n = &self.nodes[cur as usize];
            if n.deleted() {
                continue;
            }
            let m = n.metric(by_alloc);
            // В папке не может быть файла крупнее самой папки — отсекаем целые ветки.
            if heap.len() >= limit {
                if let Some(Reverse((lo, _))) = heap.peek() {
                    if m <= *lo {
                        continue;
                    }
                }
            }
            if n.is_dir() {
                stack.extend(self.child_ids(cur));
            } else {
                heap.push(Reverse((m, cur)));
                if heap.len() > limit {
                    heap.pop();
                }
            }
        }
        let mut v: Vec<(u64, u32)> = heap.into_iter().map(|r| r.0).collect();
        v.sort_unstable_by(|a, b| b.cmp(a));
        v.into_iter().map(|(_, i)| self.file_dto(i)).collect()
    }

    pub fn ext_stats(&self, id: u32) -> Vec<ExtStat> {
        let mut map: HashMap<String, (u64, u64, u64)> = HashMap::new();
        let mut stack = vec![id];
        let mut buf = [0u8; 16];
        while let Some(cur) = stack.pop() {
            let n = &self.nodes[cur as usize];
            if n.deleted() {
                continue;
            }
            if n.is_dir() {
                stack.extend(self.child_ids(cur));
                continue;
            }
            let ext = categories::ext_of(self.name(cur));
            let len = ext.len();
            buf[..len].copy_from_slice(ext.as_bytes());
            buf[..len].make_ascii_lowercase();
            let key = std::str::from_utf8(&buf[..len]).unwrap_or("");
            match map.get_mut(key) {
                Some(e) => {
                    e.0 += n.size;
                    e.1 += n.alloc;
                    e.2 += 1;
                }
                None => {
                    map.insert(key.to_string(), (n.size, n.alloc, 1));
                }
            }
        }
        let mut v: Vec<ExtStat> = map
            .into_iter()
            .map(|(ext, (size, alloc, count))| ExtStat { cat: categories::category(&ext), ext, size, alloc, count })
            .collect();
        v.sort_unstable_by(|a, b| b.alloc.cmp(&a.alloc));
        v
    }

    /// Поиск по имени: подстрока или шаблон с `*`. Возвращает крупнейшие совпадения.
    pub fn search(&self, query: &str, limit: usize, by_alloc: bool) -> SearchResult {
        let q = query.trim().to_lowercase();
        if q.is_empty() {
            return SearchResult { total: 0, items: vec![] };
        }
        let is_glob = q.contains('*') || q.contains('?');
        let qb = q.as_bytes();
        let mut ids: Vec<u32> = (1..self.nodes.len() as u32)
            .into_par_iter()
            .filter(|&i| {
                let n = &self.nodes[i as usize];
                if n.deleted() {
                    return false;
                }
                let off = n.name_off as usize;
                let name = &self.names[off..off + n.name_len as usize];
                if is_glob {
                    return crate::winutil::wild_match(&q, std::str::from_utf8(name).unwrap_or(""));
                }
                if name.len() < qb.len() {
                    return false;
                }
                if name.is_ascii() {
                    name.windows(qb.len()).any(|w| w.eq_ignore_ascii_case(qb))
                } else {
                    std::str::from_utf8(name).map(|s| s.to_lowercase().contains(&q)).unwrap_or(false)
                }
            })
            .collect();
        let total = ids.len();
        let key = |i: &u32| Reverse(self.nodes[*i as usize].metric(by_alloc));
        if ids.len() > limit {
            ids.select_nth_unstable_by_key(limit, key);
            ids.truncate(limit);
        }
        ids.sort_unstable_by_key(key);
        SearchResult { total, items: ids.into_iter().map(|i| self.file_dto(i)).collect() }
    }

    /// Ищет узел по полному пути (без учёта регистра).
    pub fn find_path(&self, path: &str) -> Option<u32> {
        let root_l = self.root_path.to_lowercase();
        let path_l = path.to_lowercase();
        let rest = path_l.strip_prefix(root_l.trim_end_matches('\\'))?;
        let mut cur = 0u32;
        for comp in rest.split('\\').filter(|c| !c.is_empty()) {
            let mut found = None;
            for c in self.child_ids(cur) {
                if !self.nodes[c as usize].deleted() && self.name(c).to_lowercase() == comp {
                    found = Some(c);
                    break;
                }
            }
            cur = found?;
        }
        Some(cur)
    }

    /// Убирает узел из дерева после удаления с диска и пересчитывает размеры предков.
    pub fn mark_deleted(&mut self, id: u32) {
        if id == 0 || !self.valid(id) {
            return;
        }
        let n = self.nodes[id as usize];
        let mut cur = n.parent;
        loop {
            let p = &mut self.nodes[cur as usize];
            p.size = p.size.saturating_sub(n.size);
            p.alloc = p.alloc.saturating_sub(n.alloc);
            p.files = p.files.saturating_sub(n.files);
            if cur == 0 {
                break;
            }
            cur = p.parent;
        }
        let mut stack = vec![id];
        while let Some(c) = stack.pop() {
            let range = self.child_ids(c);
            let node = &mut self.nodes[c as usize];
            if node.flags & F_FILTERED != 0 {
                // Скрытое содержимое удалённой папки больше не числится в «скрыто фильтром».
                self.hidden.0 = self.hidden.0.saturating_sub(node.size);
                self.hidden.1 = self.hidden.1.saturating_sub(node.alloc);
                self.hidden.2 = self.hidden.2.saturating_sub(node.files);
            }
            node.flags |= F_DELETED;
            node.size = 0;
            node.alloc = 0;
            node.files = 0;
            stack.extend(range);
        }
    }

    fn has_child_named(&self, dir: u32, names: &[&str]) -> bool {
        self.child_ids(dir).any(|c| {
            let n = &self.nodes[c as usize];
            !n.deleted() && names.iter().any(|x| self.name(c).eq_ignore_ascii_case(x))
        })
    }

    /// Папки, которые можно пересоздать командой сборки: node_modules, target, .venv и т.п.
    /// Берём только те, рядом с которыми лежит файл проекта, и не трогаем системные места.
    pub fn dev_artifacts(&self, min_size: u64) -> Vec<Artifact> {
        const KINDS: &[(&str, &[&str], bool, &str)] = &[
            // (имя папки, маркеры, маркер внутри папки?, подпись)
            ("node_modules", &["package.json"], false, "Node.js"),
            ("target", &["Cargo.toml"], false, "Rust"),
            (".venv", &["pyvenv.cfg"], true, "Python venv"),
            ("venv", &["pyvenv.cfg"], true, "Python venv"),
            (".next", &["package.json"], false, "Next.js"),
            (".nuxt", &["package.json"], false, "Nuxt"),
            (".turbo", &["package.json"], false, "Turborepo"),
            (".parcel-cache", &["package.json"], false, "Parcel"),
            (".gradle", &["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"], false, "Gradle"),
            ("vendor", &["composer.json"], false, "Composer"),
            (".tox", &["tox.ini"], false, "tox"),
        ];
        const EXCLUDE: &[&str] = &[
            "\\appdata\\", "\\program files", "\\windows\\", "\\programdata\\", "$recycle.bin",
            "\\.cargo\\", "\\.rustup\\", "\\.vscode\\", "\\.nvm\\", "\\.cursor\\", "\\scoop\\",
        ];
        let mut out = Vec::new();
        for i in 1..self.nodes.len() as u32 {
            let n = &self.nodes[i as usize];
            if !n.is_dir() || n.deleted() || n.alloc < min_size {
                continue;
            }
            let name = self.name(i);
            let Some(kind) = KINDS.iter().find(|k| name.eq_ignore_ascii_case(k.0)) else { continue };
            let marker_ok = if kind.2 {
                self.has_child_named(i, kind.1)
            } else {
                self.has_child_named(n.parent, kind.1)
            };
            if !marker_ok {
                continue;
            }
            // Вложенные (node_modules внутри node_modules) уже учтены во внешней папке.
            let mut anc = n.parent;
            let mut nested = false;
            while anc != 0 {
                let an = self.name(anc);
                if KINDS.iter().any(|k| an.eq_ignore_ascii_case(k.0)) {
                    nested = true;
                    break;
                }
                anc = self.nodes[anc as usize].parent;
            }
            if nested {
                continue;
            }
            let path = self.path(i);
            let pl = path.to_lowercase();
            if EXCLUDE.iter().any(|e| pl.contains(e)) {
                continue;
            }
            let project_mtime = self
                .child_ids(n.parent)
                .filter(|&c| c != i)
                .filter(|&c| !KINDS.iter().any(|k| self.name(c).eq_ignore_ascii_case(k.0)) && self.name(c) != ".git")
                .map(|c| self.nodes[c as usize].mtime)
                .max()
                .unwrap_or(0);
            out.push(Artifact {
                id: i,
                project: self.path(n.parent),
                path,
                kind: kind.3.to_string(),
                size: n.size,
                alloc: n.alloc,
                files: n.files,
                project_mtime,
            });
        }
        out.sort_unstable_by(|a, b| b.alloc.cmp(&a.alloc));
        out
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// Маленькое дерево для тестов: (родитель, имя, каталог?, размер).
    pub fn build(root: &str, items: &[(u32, &str, bool, u64)]) -> Tree {
        let mut t = Tree {
            nodes: vec![Node { flags: F_DIR, ..Default::default() }],
            names: Vec::new(),
            root_path: root.to_string(),
            mode: "test",
            ..Default::default()
        };
        for &(parent, name, dir, size) in items {
            let id = t.nodes.len() as u32;
            let off = t.names.len() as u32;
            t.names.extend_from_slice(name.as_bytes());
            t.nodes.push(Node {
                size,
                alloc: size,
                parent,
                files: if dir { 0 } else { 1 },
                name_off: off,
                name_len: name.len() as u16,
                flags: if dir { F_DIR } else { 0 },
                ..Default::default()
            });
            let p = &mut t.nodes[parent as usize];
            if p.child_count == 0 {
                p.first_child = id;
            }
            p.child_count += 1;
        }
        t.finalize();
        t
    }

    fn sample() -> Tree {
        build(
            "C:\\",
            &[
                (0, "Users", true, 0),      // 1
                (0, "pagefile.sys", false, 500), // 2
                (1, "me", true, 0),         // 3
                (3, "movie.MKV", false, 300), // 4
                (3, "проект", true, 0),     // 5
                (3, "notes.txt", false, 10), // 6
                (5, "package.json", false, 1), // 7
                (5, "node_modules", true, 0), // 8
                (8, "big.js", false, 200),  // 9
            ],
        )
    }

    #[test]
    fn aggregates_and_paths() {
        let t = sample();
        assert_eq!(t.nodes[0].size, 1011);
        assert_eq!(t.nodes[0].files, 5);
        assert_eq!(t.nodes[3].size, 511);
        assert_eq!(t.path(9), "C:\\Users\\me\\проект\\node_modules\\big.js");
        assert_eq!(t.find_path("c:\\users\\ME\\Проект"), Some(5));
        assert_eq!(t.find_path("C:\\nope"), None);
    }

    #[test]
    fn listing_is_sorted() {
        let t = sample();
        let v = t.dir_view(3, true);
        let names: Vec<&str> = v.children.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["movie.MKV", "проект", "notes.txt"]);
        assert_eq!(v.crumbs.len(), 3);
    }

    #[test]
    fn top_search_ext() {
        let t = sample();
        let top = t.top_files(0, 2, true);
        assert_eq!(top.iter().map(|f| f.size).collect::<Vec<_>>(), [500, 300]);
        assert_eq!(t.search("MOVIE", 10, true).total, 1);
        assert_eq!(t.search("*.js", 10, true).items[0].name, "big.js");
        assert_eq!(t.search("проект", 10, true).total, 1);
        let ext = t.ext_stats(0);
        assert_eq!(ext[0].ext, "sys");
        assert!(ext.iter().any(|e| e.ext == "mkv" && e.cat == categories::CAT_VIDEO));
    }

    #[test]
    fn delete_updates_ancestors() {
        let mut t = sample();
        t.mark_deleted(8);
        assert_eq!(t.nodes[0].size, 811);
        assert_eq!(t.nodes[0].files, 4);
        assert_eq!(t.search("big", 10, true).total, 0);
        assert_eq!(t.dir_view(5, true).children.len(), 1);
    }

    #[test]
    fn filter_hides_subtrees_and_restores() {
        let mut t = sample();
        t.nodes[2].flags |= F_HIDDEN | F_SYSTEM; // pagefile.sys
        t.nodes[5].flags |= F_HIDDEN; // папка «проект» со всем содержимым
        t.dir_own = vec![(5, 7)]; // у папки есть собственное место на диске
        t.nodes[5].alloc += 7;
        t.nodes[3].alloc += 7;
        t.nodes[1].alloc += 7;
        t.nodes[0].alloc += 7;
        let full = (t.nodes[0].size, t.nodes[0].alloc, t.nodes[0].files);

        t.apply_filter(F_HIDDEN);
        assert_eq!((t.nodes[0].size, t.nodes[0].files), (310, 2), "остались movie и notes");
        assert_eq!(t.hidden, (701, 708, 3));
        assert!(!t.valid(5) && !t.valid(9), "скрыта папка и всё, что в ней");
        assert_eq!(t.dir_view(0, true).children.len(), 1);
        assert_eq!(t.search("big", 10, true).total, 0);
        assert_eq!(t.top_files(0, 10, true).len(), 2);
        assert_eq!(t.summary().hidden_files, 3);

        t.apply_filter(F_SYSTEM);
        assert_eq!(t.nodes[0].size, 511, "скрыт только pagefile.sys");
        assert!(t.valid(9));

        t.apply_filter(0);
        assert_eq!((t.nodes[0].size, t.nodes[0].alloc, t.nodes[0].files), full);
        assert_eq!(t.hidden, (0, 0, 0));
    }

    #[test]
    fn filter_survives_deletion() {
        let mut t = sample();
        t.nodes[9].flags |= F_HIDDEN; // big.js внутри node_modules
        t.apply_filter(F_HIDDEN);
        assert_eq!(t.hidden.0, 200);
        t.mark_deleted(5); // удаляем видимую папку со скрытым файлом внутри
        assert_eq!(t.hidden.0, 0);
        t.apply_filter(0);
        assert_eq!((t.nodes[0].size, t.nodes[0].files), (810, 3), "удалённое не возвращается");
    }

    #[test]
    fn subtree_groups_small_items() {
        let t = sample();
        let s = t.subtree(0, 1000, true);
        assert_eq!(s[0].p, -1);
        assert!(s.iter().any(|n| n.name == "big.js"));
        let total: u64 = s.iter().filter(|n| n.p == 0).map(|n| n.size).sum();
        assert_eq!(total, 1011);
    }

    #[test]
    fn artifacts_need_a_project_marker() {
        let t = sample();
        let a = t.dev_artifacts(1);
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].kind, "Node.js");
    }
}
