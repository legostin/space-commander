//! Детект мусора и кешей и их безопасная очистка.
//!
//! Каждое правило — это явный список мест на диске. Удаляется только то, что лежит
//! внутри этих мест; ссылки и junction-ы не раскрываются; занятые файлы пропускаются.

use crate::winutil::{self, extended, wild_match};
use rayon::prelude::*;
use serde::Serialize;
use std::collections::BTreeMap;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::ptr::null;
use windows_sys::Win32::UI::Shell::{SHEmptyRecycleBinW, SHQueryRecycleBinW, SHQUERYRBINFO};

const ATTR_REPARSE: u32 = 0x400;
const ATTR_READONLY: u32 = 0x1;

#[derive(Clone, Debug)]
pub enum Spec {
    /// Удаляется содержимое папки, сама папка остаётся.
    Contents(String),
    /// Удаляется файл или папка целиком.
    Path(String),
    /// Удаляются файлы в папке, подходящие под шаблон имени.
    Files(String, String),
}

#[derive(Clone, Debug)]
pub struct Rule {
    pub id: String,
    pub category: &'static str,
    pub title: String,
    pub desc: String,
    /// "safe" — пересоздаётся само; "caution" — придётся скачать или собрать заново; "info" — здесь не удаляется.
    pub safety: &'static str,
    pub needs_admin: bool,
    pub admin_reason: &'static str,
    pub specs: Vec<Spec>,
    /// Не трогать объекты моложе N часов (защита файлов, которыми сейчас пользуются).
    pub min_age_h: u64,
    pub hint: &'static str,
    pub action: &'static str,
}

impl Rule {
    fn new(id: &str, category: &'static str, title: &str, desc: &str, safety: &'static str, specs: Vec<Spec>) -> Rule {
        Rule {
            id: id.to_string(),
            category,
            title: title.to_string(),
            desc: desc.to_string(),
            safety,
            needs_admin: false,
            admin_reason: "",
            specs,
            min_age_h: 0,
            hint: "",
            action: "",
        }
    }
    fn admin(mut self, reason: &'static str) -> Rule {
        self.needs_admin = true;
        self.admin_reason = reason;
        self
    }
    fn age(mut self, hours: u64) -> Rule {
        self.min_age_h = hours;
        self
    }
    fn info(mut self, hint: &'static str, action: &'static str) -> Rule {
        self.hint = hint;
        self.action = action;
        self
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct TargetInfo {
    pub path: String,
    pub size: u64,
    pub files: u64,
}

#[derive(Serialize, Clone, Debug)]
pub struct JunkItem {
    pub id: String,
    pub category: String,
    pub title: String,
    pub desc: String,
    pub safety: String,
    pub needs_admin: bool,
    pub admin_reason: String,
    /// false — без повышения прав размер посчитать не удалось.
    pub accessible: bool,
    pub size: u64,
    pub files: u64,
    pub targets: Vec<TargetInfo>,
    pub hint: String,
    pub action: String,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct CleanReport {
    pub freed: u64,
    pub files: u64,
    pub failed: u64,
    pub errors: Vec<String>,
    pub items: Vec<CleanedItem>,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct CleanedItem {
    pub id: String,
    pub title: String,
    pub freed: u64,
    pub files: u64,
    pub failed: u64,
}

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_default()
}

/// Подставляет %ПЕРЕМЕННЫЕ%. Если переменная пуста — возвращает None (правило пропускается).
fn expand_env(template: &str) -> Option<String> {
    let mut out = String::new();
    let mut rest = template;
    while let Some(a) = rest.find('%') {
        out.push_str(&rest[..a]);
        let after = &rest[a + 1..];
        let b = after.find('%')?;
        let val = env(&after[..b]);
        if val.is_empty() {
            return None;
        }
        out.push_str(val.trim_end_matches('\\'));
        rest = &after[b + 1..];
    }
    out.push_str(rest);
    Some(out)
}

/// Раскрывает шаблон пути с `*` в отдельных компонентах в список существующих путей.
pub fn expand(template: &str) -> Vec<PathBuf> {
    let Some(full) = expand_env(template) else { return vec![] };
    let mut comps = full.split('\\').filter(|c| !c.is_empty());
    let Some(first) = comps.next() else { return vec![] };
    let mut cur: Vec<PathBuf> = vec![PathBuf::from(format!("{}\\", first))];
    for comp in comps {
        let mut next = Vec::new();
        for base in &cur {
            if comp.contains('*') {
                if let Ok(rd) = std::fs::read_dir(extended(&base.to_string_lossy())) {
                    for e in rd.flatten() {
                        let name = e.file_name().to_string_lossy().to_string();
                        if wild_match(comp, &name) {
                            next.push(base.join(name));
                        }
                    }
                }
            } else {
                next.push(base.join(comp));
            }
        }
        cur = next;
        if cur.is_empty() {
            break;
        }
    }
    cur.into_iter().filter(|p| std::fs::symlink_metadata(extended(&p.to_string_lossy())).is_ok()).collect()
}

/// Защита от катастрофы: эти места нельзя чистить ни при каких правилах.
pub fn is_protected(path: &Path) -> bool {
    let p = path.to_string_lossy().trim_end_matches('\\').to_lowercase();
    if p.split('\\').filter(|c| !c.is_empty()).count() < 3 {
        return true; // C:\ , C:\Windows, C:\Users …
    }
    let mut guarded: Vec<String> = ["USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)", "ProgramData", "PUBLIC"]
        .iter()
        .map(|v| env(v))
        .collect();
    let up = env("USERPROFILE");
    let win = env("WINDIR");
    for sub in ["Documents", "Desktop", "Pictures", "Videos", "Music", "Downloads", "OneDrive", "AppData\\LocalLow"] {
        guarded.push(format!("{}\\{}", up, sub));
    }
    for sub in ["System32", "SysWOW64", "WinSxS", "Fonts", "Installer", "assembly", "servicing"] {
        guarded.push(format!("{}\\{}", win, sub));
    }
    guarded.iter().any(|g| !g.is_empty() && g.trim_end_matches('\\').to_lowercase() == p)
}

#[derive(Default, Clone, Copy)]
struct Usage {
    size: u64,
    files: u64,
    denied: bool,
}

fn age_ok(meta: &std::fs::Metadata, min_age_h: u64) -> bool {
    if min_age_h == 0 {
        return true;
    }
    let mtime = winutil::filetime_to_unix(meta.last_write_time());
    winutil::now_unix() - mtime >= (min_age_h * 3600) as i64
}

fn measure_entry(path: &Path, meta: &std::fs::Metadata, u: &mut Usage) {
    if meta.file_attributes() & ATTR_REPARSE != 0 {
        return;
    }
    if meta.is_dir() {
        match std::fs::read_dir(path) {
            Ok(rd) => {
                for e in rd.flatten() {
                    if let Ok(m) = e.metadata() {
                        measure_entry(&e.path(), &m, u);
                    }
                }
            }
            Err(_) => u.denied = true,
        }
    } else {
        u.size += meta.len();
        u.files += 1;
    }
}

/// Перечисляет объекты верхнего уровня, которые правило затронет (с учётом возраста).
fn top_entries(spec: &Spec, min_age_h: u64) -> (Vec<(PathBuf, std::fs::Metadata)>, bool, Vec<PathBuf>) {
    let mut out = Vec::new();
    let mut denied = false;
    let mut roots = Vec::new();
    match spec {
        Spec::Contents(t) | Spec::Files(t, _) => {
            let pattern = if let Spec::Files(_, p) = spec { Some(p.as_str()) } else { None };
            for dir in expand(t) {
                if is_protected(&dir) {
                    continue;
                }
                roots.push(dir.clone());
                let ext = PathBuf::from(extended(&dir.to_string_lossy()));
                match std::fs::read_dir(&ext) {
                    Ok(rd) => {
                        for e in rd.flatten() {
                            let Ok(m) = e.metadata() else { continue };
                            if let Some(p) = pattern {
                                if m.is_dir() || !wild_match(p, &e.file_name().to_string_lossy()) {
                                    continue;
                                }
                            }
                            if age_ok(&m, min_age_h) {
                                out.push((e.path(), m));
                            }
                        }
                    }
                    Err(e) => {
                        if e.kind() == std::io::ErrorKind::PermissionDenied {
                            denied = true;
                        }
                    }
                }
            }
        }
        Spec::Path(t) => {
            for p in expand(t) {
                if is_protected(&p) {
                    continue;
                }
                roots.push(p.clone());
                let ext = PathBuf::from(extended(&p.to_string_lossy()));
                if let Ok(m) = std::fs::symlink_metadata(&ext) {
                    if age_ok(&m, min_age_h) {
                        out.push((ext, m));
                    }
                }
            }
        }
    }
    (out, denied, roots)
}

fn spec_template(spec: &Spec) -> &str {
    match spec {
        Spec::Contents(t) | Spec::Path(t) | Spec::Files(t, _) => t,
    }
}

fn display(p: &Path) -> String {
    let s = p.to_string_lossy();
    s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
}

fn recycle_bin_usage() -> Usage {
    let mut info: SHQUERYRBINFO = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHQUERYRBINFO>() as u32;
    let hr = unsafe { SHQueryRecycleBinW(null(), &mut info) };
    if hr == 0 {
        Usage { size: info.i64Size.max(0) as u64, files: info.i64NumItems.max(0) as u64, denied: false }
    } else {
        Usage::default()
    }
}

/// Размер файла по записи каталога — работает даже для занятых системой pagefile/hiberfil.
fn dir_entry_size(path: &str) -> Option<u64> {
    let p = Path::new(path);
    let parent = p.parent()?;
    let name = p.file_name()?.to_string_lossy().to_lowercase();
    for e in std::fs::read_dir(parent).ok()?.flatten() {
        if e.file_name().to_string_lossy().to_lowercase() == name {
            return e.metadata().ok().map(|m| m.len());
        }
    }
    None
}

fn evaluate(rule: &Rule) -> JunkItem {
    let mut item = JunkItem {
        id: rule.id.clone(),
        category: rule.category.to_string(),
        title: rule.title.clone(),
        desc: rule.desc.clone(),
        safety: rule.safety.to_string(),
        needs_admin: rule.needs_admin,
        admin_reason: rule.admin_reason.to_string(),
        accessible: true,
        size: 0,
        files: 0,
        targets: vec![],
        hint: rule.hint.to_string(),
        action: rule.action.to_string(),
    };
    if rule.id == "recycle-bin" {
        let u = recycle_bin_usage();
        item.size = u.size;
        item.files = u.files;
        if u.size > 0 {
            item.targets.push(TargetInfo { path: "Корзина на всех дисках".into(), size: u.size, files: u.files });
        }
        return item;
    }
    if rule.safety == "info" {
        for spec in &rule.specs {
            for p in expand(spec_template(spec)) {
                let ps = p.to_string_lossy().to_string();
                let meta = std::fs::symlink_metadata(&p);
                let (size, files) = match &meta {
                    Ok(m) if m.is_dir() => {
                        let mut u = Usage::default();
                        measure_entry(&PathBuf::from(extended(&ps)), m, &mut u);
                        if u.denied {
                            item.accessible = false;
                        }
                        (u.size, u.files)
                    }
                    _ => (dir_entry_size(&ps).unwrap_or(0), 1),
                };
                item.size += size;
                item.files += files;
                item.targets.push(TargetInfo { path: ps, size, files });
            }
        }
        return item;
    }
    let mut by_root: BTreeMap<String, Usage> = BTreeMap::new();
    for spec in &rule.specs {
        let (entries, denied, roots) = top_entries(spec, rule.min_age_h);
        if denied {
            item.accessible = false;
        }
        for r in &roots {
            by_root.entry(display(r)).or_default();
        }
        for (path, meta) in entries {
            let mut u = Usage::default();
            measure_entry(&path, &meta, &mut u);
            if u.denied {
                item.accessible = false;
            }
            let shown = display(&path);
            let key = match spec {
                Spec::Path(_) => shown,
                _ => roots
                    .iter()
                    .map(|r| display(r))
                    .find(|r| shown.to_lowercase().starts_with(&format!("{}\\", r.to_lowercase())))
                    .unwrap_or(shown),
            };
            let e = by_root.entry(key).or_default();
            e.size += u.size;
            e.files += u.files;
        }
    }
    for (path, u) in by_root {
        item.size += u.size;
        item.files += u.files;
        if u.size > 0 || u.files > 0 {
            item.targets.push(TargetInfo { path, size: u.size, files: u.files });
        }
    }
    item.targets.sort_by(|a, b| b.size.cmp(&a.size));
    item
}

#[derive(Default)]
struct DelStats {
    freed: u64,
    files: u64,
    failed: u64,
    errors: Vec<String>,
}

fn note_error(st: &mut DelStats, path: &Path, e: &std::io::Error) {
    st.failed += 1;
    if st.errors.len() < 12 {
        st.errors.push(format!("{} — {}", display(path), e));
    }
}

fn remove_entry(path: &Path, meta: &std::fs::Metadata, st: &mut DelStats) {
    let attrs = meta.file_attributes();
    if attrs & ATTR_REPARSE != 0 {
        // Ссылку удаляем как ссылку и никогда не заходим внутрь.
        // is_dir() для junction-ов возвращает false, поэтому смотрим на сам атрибут каталога.
        let r = if attrs & 0x10 != 0 { std::fs::remove_dir(path) } else { std::fs::remove_file(path) };
        if let Err(e) = r {
            note_error(st, path, &e);
        }
        return;
    }
    if meta.is_dir() {
        match std::fs::read_dir(path) {
            Ok(rd) => {
                for e in rd.flatten() {
                    match e.metadata() {
                        Ok(m) => remove_entry(&e.path(), &m, st),
                        Err(err) => note_error(st, &e.path(), &err),
                    }
                }
                // Папка может остаться непустой, если часть файлов занята — это не ошибка.
                let _ = std::fs::remove_dir(path);
            }
            Err(e) => note_error(st, path, &e),
        }
        return;
    }
    let size = meta.len();
    let mut r = std::fs::remove_file(path);
    if r.is_err() && attrs & ATTR_READONLY != 0 {
        if let Ok(m) = std::fs::metadata(path) {
            let mut perm = m.permissions();
            #[allow(clippy::permissions_set_readonly_false)]
            perm.set_readonly(false);
            let _ = std::fs::set_permissions(path, perm);
            r = std::fs::remove_file(path);
        }
    }
    match r {
        Ok(()) => {
            st.freed += size;
            st.files += 1;
        }
        Err(e) => note_error(st, path, &e),
    }
}

fn clean_rule(rule: &Rule) -> DelStats {
    let mut st = DelStats::default();
    if rule.safety == "info" {
        return st;
    }
    if rule.id == "recycle-bin" {
        let before = recycle_bin_usage();
        // SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI | SHERB_NOSOUND
        let hr = unsafe { SHEmptyRecycleBinW(std::ptr::null_mut(), null(), 0x1 | 0x2 | 0x4) };
        if hr == 0 || before.files == 0 {
            st.freed = before.size;
            st.files = before.files;
        } else {
            st.failed = 1;
            st.errors.push(format!("Не удалось очистить корзину (0x{:08X})", hr as u32));
        }
        return st;
    }
    for spec in &rule.specs {
        let (entries, _, _) = top_entries(spec, rule.min_age_h);
        for (path, meta) in entries {
            remove_entry(&path, &meta, &mut st);
        }
    }
    st
}

// ───────────────────────── Правила ─────────────────────────

const WHY_WINDIR: &str = "Папка принадлежит системе: читать и удалять в ней могут только администраторы и сама Windows.";
const WHY_PROGRAMDATA: &str = "Это общие для всех пользователей данные; изменять их Windows разрешает только администраторам.";

fn c(t: &str) -> Spec {
    Spec::Contents(t.to_string())
}
fn p(t: &str) -> Spec {
    Spec::Path(t.to_string())
}
fn f(dir: &str, pat: &str) -> Spec {
    Spec::Files(dir.to_string(), pat.to_string())
}

fn static_rules() -> Vec<Rule> {
    let mut v = vec![
        // ── Система ──
        Rule::new("user-temp", "system", "Временные файлы пользователя",
            "Файлы, которые программы создают на время работы и часто забывают убрать. Удаляется только то, что старше суток; занятые файлы пропускаются.",
            "safe", vec![c("%TEMP%")]).age(24),
        Rule::new("win-temp", "system", "Временные файлы Windows",
            "Общая временная папка системы и установщиков. Удаляется только то, что старше суток.",
            "safe", vec![c("%WINDIR%\\Temp")]).age(24).admin(WHY_WINDIR),
        Rule::new("win-update", "system", "Загруженные обновления Windows",
            "Пакеты обновлений, которые уже установлены. Если обновление ещё понадобится, Windows скачает его заново.",
            "safe", vec![c("%WINDIR%\\SoftwareDistribution\\Download")]).admin(WHY_WINDIR),
        Rule::new("delivery-opt", "system", "Кеш оптимизации доставки",
            "Копии обновлений, которые Windows держит, чтобы раздавать другим компьютерам в сети.",
            "safe", vec![c("%WINDIR%\\ServiceProfiles\\NetworkService\\AppData\\Local\\Microsoft\\Windows\\DeliveryOptimization\\Cache")]).admin(WHY_WINDIR),
        Rule::new("wer", "system", "Отчёты об ошибках",
            "Архив отчётов о сбоях программ, которые Windows собирает для отправки в Microsoft.",
            "safe", vec![c("%LOCALAPPDATA%\\Microsoft\\Windows\\WER\\ReportArchive"), c("%LOCALAPPDATA%\\Microsoft\\Windows\\WER\\ReportQueue")]),
        Rule::new("wer-system", "system", "Системные отчёты об ошибках",
            "То же самое для сбоев системных служб.",
            "safe", vec![c("%PROGRAMDATA%\\Microsoft\\Windows\\WER\\ReportArchive"), c("%PROGRAMDATA%\\Microsoft\\Windows\\WER\\ReportQueue")]).admin(WHY_PROGRAMDATA),
        Rule::new("crash-dumps", "system", "Дампы памяти программ",
            "Снимки памяти упавших программ. Нужны только разработчикам для разбора сбоя.",
            "safe", vec![c("%LOCALAPPDATA%\\CrashDumps")]),
        Rule::new("crash-dumps-system", "system", "Дампы памяти системы",
            "Снимки памяти после «синих экранов». Бывают размером с оперативную память.",
            "safe", vec![c("%WINDIR%\\Minidump"), p("%WINDIR%\\MEMORY.DMP"), c("%WINDIR%\\LiveKernelReports")]).admin(WHY_WINDIR),
        Rule::new("thumbcache", "system", "Кеш эскизов Проводника",
            "Уменьшенные копии картинок и видео для предпросмотра. Проводник создаст их заново при открытии папок.",
            "safe", vec![f("%LOCALAPPDATA%\\Microsoft\\Windows\\Explorer", "thumbcache_*.db"), f("%LOCALAPPDATA%\\Microsoft\\Windows\\Explorer", "iconcache_*.db")]),
        Rule::new("shader-cache", "system", "Кеш шейдеров видеокарты",
            "Скомпилированные шейдеры DirectX, NVIDIA и AMD. Пересобираются при следующем запуске игр — первый запуск может быть чуть дольше.",
            "safe", vec![c("%LOCALAPPDATA%\\D3DSCache"), c("%LOCALAPPDATA%\\NVIDIA\\DXCache"), c("%LOCALAPPDATA%\\NVIDIA\\GLCache"),
                c("%LOCALAPPDATA%\\AMD\\DxCache"), c("%LOCALAPPDATA%\\AMD\\DxcCache"), c("%LOCALAPPDATA%\\AMD\\GLCache"), c("%LOCALAPPDATA%\\AMD\\VkCache")]),
        Rule::new("win-logs", "system", "Журналы обслуживания Windows",
            "Старые журналы установки компонентов (CBS) и архивы журналов.",
            "safe", vec![f("%WINDIR%\\Logs\\CBS", "CbsPersist_*"), f("%WINDIR%\\Logs\\CBS", "*.cab")]).admin(WHY_WINDIR),
        Rule::new("recycle-bin", "system", "Корзина",
            "Удалённые файлы, которые всё ещё занимают место. После очистки восстановить их будет нельзя.",
            "caution", vec![]),

        // ── Разработка ──
        Rule::new("npm-cache", "dev", "Кеш npm", "Скачанные пакеты npm. При следующей установке загрузятся заново.",
            "safe", vec![c("%LOCALAPPDATA%\\npm-cache\\_cacache"), c("%APPDATA%\\npm-cache\\_cacache"), c("%LOCALAPPDATA%\\npm-cache\\_npx")]),
        Rule::new("yarn-cache", "dev", "Кеш Yarn", "Скачанные пакеты Yarn.", "safe",
            vec![c("%LOCALAPPDATA%\\Yarn\\Cache"), c("%LOCALAPPDATA%\\Yarn\\Berry\\cache")]),
        Rule::new("pnpm-store", "dev", "Хранилище pnpm",
            "Общее хранилище пакетов pnpm. Проекты продолжат работать, но новые установки скачают пакеты заново.",
            "caution", vec![c("%LOCALAPPDATA%\\pnpm\\store"), c("%LOCALAPPDATA%\\pnpm-cache")]),
        Rule::new("pip-cache", "dev", "Кеш pip и uv", "Скачанные и собранные пакеты Python.", "safe",
            vec![c("%LOCALAPPDATA%\\pip\\Cache"), c("%LOCALAPPDATA%\\uv\\cache"), c("%LOCALAPPDATA%\\pypoetry\\Cache")]),
        Rule::new("cargo-cache", "dev", "Кеш Cargo",
            "Архивы и распакованные исходники зависимостей Rust. Cargo скачает нужное при следующей сборке.",
            "caution", vec![c("%USERPROFILE%\\.cargo\\registry\\cache"), c("%USERPROFILE%\\.cargo\\registry\\src"), c("%USERPROFILE%\\.cargo\\git\\checkouts")]),
        Rule::new("gradle-cache", "dev", "Кеш Gradle и Maven",
            "Скачанные зависимости и результаты сборок Java/Android. Следующая сборка будет долгой.",
            "caution", vec![c("%USERPROFILE%\\.gradle\\caches"), c("%USERPROFILE%\\.gradle\\daemon"), c("%USERPROFILE%\\.m2\\repository")]),
        Rule::new("nuget-cache", "dev", "Кеш NuGet",
            "Пакеты .NET. Восстановятся командой dotnet restore.",
            "caution", vec![c("%USERPROFILE%\\.nuget\\packages"), c("%LOCALAPPDATA%\\NuGet\\v3-cache"), c("%LOCALAPPDATA%\\NuGet\\plugins-cache")]),
        Rule::new("go-cache", "dev", "Кеш сборки Go", "Промежуточные результаты компиляции Go.", "safe",
            vec![c("%LOCALAPPDATA%\\go-build")]),
        Rule::new("playwright", "dev", "Браузеры Playwright и Puppeteer",
            "Отдельные копии браузеров для автотестов. Скачаются заново командой установки.",
            "caution", vec![c("%LOCALAPPDATA%\\ms-playwright"), c("%USERPROFILE%\\.cache\\puppeteer")]),
        Rule::new("electron-cache", "dev", "Кеш сборки Electron и node-gyp", "Скачанные бинарники Electron и заголовки Node.js.", "safe",
            vec![c("%LOCALAPPDATA%\\electron\\Cache"), c("%LOCALAPPDATA%\\electron-builder\\Cache"), c("%LOCALAPPDATA%\\node-gyp\\Cache")]),
        Rule::new("jetbrains-cache", "dev", "Кеши и индексы JetBrains",
            "Индексы проектов IDE. После очистки IDE переиндексирует проекты при открытии.",
            "caution", vec![c("%LOCALAPPDATA%\\JetBrains\\*\\caches"), c("%LOCALAPPDATA%\\JetBrains\\*\\index"), c("%LOCALAPPDATA%\\JetBrains\\*\\log")]),
        Rule::new("vscode-cache", "dev", "Кеш расширений VS Code", "Скачанные установщики расширений и журналы.", "safe",
            vec![c("%APPDATA%\\Code\\CachedExtensionVSIXs"), c("%APPDATA%\\Code\\logs"), c("%APPDATA%\\Code\\CachedData")]),
        Rule::new("hf-cache", "dev", "Модели Hugging Face и PyTorch",
            "Скачанные нейросетевые модели. Могут занимать десятки гигабайт; при следующем использовании скачаются заново.",
            "caution", vec![c("%USERPROFILE%\\.cache\\huggingface\\hub"), c("%USERPROFILE%\\.cache\\torch\\hub")]),

        // ── Приложения ──
        Rule::new("spotify", "apps", "Spotify", "Кеш прослушанной музыки.", "safe",
            vec![c("%LOCALAPPDATA%\\Spotify\\Storage"), c("%LOCALAPPDATA%\\Spotify\\Data")]),
        Rule::new("telegram", "apps", "Telegram Desktop",
            "Кеш просмотренных фото и видео. Сообщения и вложения остаются в облаке и подгрузятся снова.",
            "caution", vec![c("%APPDATA%\\Telegram Desktop\\tdata\\user_data\\cache"), c("%APPDATA%\\Telegram Desktop\\tdata\\user_data\\media_cache")]),
        Rule::new("steam", "apps", "Steam",
            "Кеш встроенного браузера, шейдеров и незавершённые загрузки. Игры и сохранения не затрагиваются.",
            "caution", vec![c("%ProgramFiles(x86)%\\Steam\\appcache\\httpcache"), c("%ProgramFiles(x86)%\\Steam\\steamapps\\shadercache"),
                c("%LOCALAPPDATA%\\Steam\\htmlcache")]),
        Rule::new("epic", "apps", "Epic Games Launcher", "Кеш встроенного браузера лаунчера.", "safe",
            vec![c("%LOCALAPPDATA%\\EpicGamesLauncher\\Saved\\webcache*")]),
        Rule::new("firefox", "browsers", "Firefox", "Кеш страниц. Закладки, пароли и история не затрагиваются.", "safe",
            vec![c("%LOCALAPPDATA%\\Mozilla\\Firefox\\Profiles\\*\\cache2"), c("%LOCALAPPDATA%\\Mozilla\\Firefox\\Profiles\\*\\startupCache"),
                c("%LOCALAPPDATA%\\Mozilla\\Firefox\\Profiles\\*\\thumbnails")]),

        // ── Загрузки ──
        Rule::new("old-installers", "downloads", "Старые установщики в «Загрузках»",
            "Установщики и образы дисков, которые лежат в «Загрузках» больше 90 дней. Скорее всего, программы уже установлены.",
            "caution", vec![f("%USERPROFILE%\\Downloads", "*.exe"), f("%USERPROFILE%\\Downloads", "*.msi"),
                f("%USERPROFILE%\\Downloads", "*.iso"), f("%USERPROFILE%\\Downloads", "*.msix")]).age(24 * 90),

        // ── Системные гиганты: только информация ──
        Rule::new("hiberfil", "info", "Файл гибернации",
            "Сюда Windows сохраняет память при гибернации и быстром запуске. Размер — около 40% оперативной памяти.",
            "info", vec![p("%SystemDrive%\\hiberfil.sys")])
            .info("Отключается командой powercfg /h off в терминале администратора. Пропадут гибернация и быстрый запуск.", ""),
        Rule::new("pagefile", "info", "Файл подкачки",
            "Продолжение оперативной памяти на диске. Windows управляет размером сама.",
            "info", vec![p("%SystemDrive%\\pagefile.sys"), p("%SystemDrive%\\swapfile.sys")])
            .info("Размер меняется в «Дополнительных параметрах системы» → Быстродействие → Виртуальная память. Уменьшать стоит, только если памяти с запасом.", "ms-settings:about"),
        Rule::new("windows-old", "info", "Предыдущая версия Windows",
            "Копия системы до крупного обновления — нужна для отката. Windows сама удаляет её через 10 дней.",
            "info", vec![p("%SystemDrive%\\Windows.old")])
            .info("Удаляется штатно: Параметры → Система → Память → Временные файлы → «Предыдущие установки Windows».", "ms-settings:storagesense"),
        Rule::new("docker-wsl", "info", "Виртуальные диски Docker и WSL",
            "Файлы .vhdx растут по мере использования и сами не уменьшаются, даже если внутри всё удалить.",
            "info", vec![p("%LOCALAPPDATA%\\Docker\\wsl\\disk\\docker_data.vhdx"), p("%LOCALAPPDATA%\\Docker\\wsl\\data\\ext4.vhdx"),
                p("%LOCALAPPDATA%\\Docker\\wsl\\main\\ext4.vhdx"), p("%LOCALAPPDATA%\\Packages\\*\\LocalState\\ext4.vhdx"), p("%LOCALAPPDATA%\\wsl\\*\\ext4.vhdx")])
            .info("Сначала docker system prune -a, затем wsl --shutdown и сжатие диска: Optimize-VHD или diskpart → compact vdisk.", ""),
    ];
    v.retain(|r| r.id == "recycle-bin" || !r.specs.is_empty());
    v
}

// ───────────── Автоопределение кешей Chromium/Electron ─────────────

const PROFILE_CACHES: &[&str] = &[
    "Cache\\Cache_Data", "Code Cache", "GPUCache", "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache",
    "Service Worker\\CacheStorage", "Service Worker\\ScriptCache",
];
const SHARED_CACHES: &[&str] = &["ShaderCache", "GrShaderCache", "GraphiteDawnCache", "component_crx_cache"];
const SKIP_DIRS: &[&str] = &[
    "temp", "npm-cache", "pip", "node_modules", "cache_data", "code cache", "gpucache", "microsoft\\windows",
    "programs", "packages\\microsoft.windows", "pnpm", "yarn", "uv", "nuget", "go-build", "jetbrains", "docker", "wsl",
];

fn exists(p: &Path) -> bool {
    std::fs::symlink_metadata(p).map(|m| m.is_dir() && m.file_attributes() & ATTR_REPARSE == 0).unwrap_or(false)
}

fn is_chromium_profile(dir: &Path) -> bool {
    let hits = [dir.join("Cache").join("Cache_Data"), dir.join("Code Cache"), dir.join("GPUCache")]
        .iter()
        .filter(|p| exists(p))
        .count();
    hits >= 2
}

fn find_profiles(dir: &Path, rel: &str, depth: u32, out: &mut Vec<PathBuf>) {
    if is_chromium_profile(dir) {
        out.push(dir.to_path_buf());
        return;
    }
    if depth == 0 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let Ok(m) = e.metadata() else { continue };
        if !m.is_dir() || m.file_attributes() & ATTR_REPARSE != 0 {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        let child_rel = if rel.is_empty() { name.to_lowercase() } else { format!("{}\\{}", rel, name.to_lowercase()) };
        if SKIP_DIRS.iter().any(|s| (s.contains('\\') && child_rel.starts_with(s)) || name.eq_ignore_ascii_case(s)) {
            continue;
        }
        find_profiles(&e.path(), &child_rel, depth - 1, out);
    }
}

const KNOWN_APPS: &[(&str, &str, &str)] = &[
    // (начало относительного пути в нижнем регистре, название, категория)
    ("google\\chrome", "Google Chrome", "browsers"),
    ("microsoft\\edge", "Microsoft Edge", "browsers"),
    ("bravesoftware\\brave-browser", "Brave", "browsers"),
    ("yandex\\yandexbrowser", "Яндекс Браузер", "browsers"),
    ("vivaldi", "Vivaldi", "browsers"),
    ("opera software", "Opera", "browsers"),
    ("chromium", "Chromium", "browsers"),
    ("thorium", "Thorium", "browsers"),
    ("arc", "Arc", "browsers"),
    ("discord", "Discord", "apps"),
    ("slack", "Slack", "apps"),
    ("code", "Visual Studio Code", "apps"),
    ("cursor", "Cursor", "apps"),
    ("claude", "Claude", "apps"),
    ("microsoft\\teams", "Microsoft Teams", "apps"),
    ("packages\\msteams", "Microsoft Teams", "apps"),
    ("packages\\microsoft.outlookforwindows", "Outlook", "apps"),
    ("notion", "Notion", "apps"),
    ("obsidian", "Obsidian", "apps"),
    ("figma", "Figma", "apps"),
    ("postman", "Postman", "apps"),
    ("zoom", "Zoom", "apps"),
    ("signal", "Signal", "apps"),
    ("whatsapp", "WhatsApp", "apps"),
    ("github desktop", "GitHub Desktop", "apps"),
    ("spotify", "Spotify (веб-часть)", "apps"),
    ("steam", "Steam (веб-часть)", "apps"),
];

/// Из относительного пути профиля делает ключ приложения: всё до «User Data»/«EBWebView»/имени профиля.
fn app_key(rel: &str) -> String {
    let comps: Vec<&str> = rel.split('\\').collect();
    let mut end = comps.len();
    for (i, c) in comps.iter().enumerate() {
        let l = c.to_lowercase();
        if l == "user data" || l == "ebwebview" || l == "partitions" {
            end = i;
            break;
        }
    }
    if end == comps.len() && end > 1 {
        let last = comps[end - 1].to_lowercase();
        if last == "default" || last.starts_with("profile ") || last == "network" {
            end -= 1;
        }
    }
    comps[..end.clamp(1, 2).min(comps.len())].join("\\")
}

/// Название для приложения, которого нет в списке известных: берём имена папок как есть.
fn pretty_name(key: &str) -> String {
    let comps: Vec<&str> = key.split('\\').collect();
    let shown: Vec<String> = if comps[0].eq_ignore_ascii_case("packages") && comps.len() > 1 {
        // Пакеты Магазина: Vendor.App_8wekyb3d8bbwe → Vendor.App
        vec![comps[1].split('_').next().unwrap_or(comps[1]).to_string()]
    } else {
        comps.iter().map(|c| c.to_string()).collect()
    };
    let mut name = shown.join(" · ");
    if let Some(first) = name.chars().next() {
        if first.is_lowercase() {
            name = first.to_uppercase().collect::<String>() + &name[first.len_utf8()..];
        }
    }
    name
}

fn chromium_rules() -> Vec<Rule> {
    let roots = [env("LOCALAPPDATA"), env("APPDATA")];
    let found: Vec<(String, PathBuf)> = roots
        .par_iter()
        .filter(|r| !r.is_empty())
        .flat_map(|root| {
            let base = PathBuf::from(root);
            let mut tops: Vec<(String, PathBuf)> = Vec::new();
            if let Ok(rd) = std::fs::read_dir(&base) {
                for e in rd.flatten() {
                    let name = e.file_name().to_string_lossy().to_lowercase();
                    if e.metadata().map(|m| m.is_dir() && m.file_attributes() & ATTR_REPARSE == 0).unwrap_or(false)
                        && !SKIP_DIRS.contains(&name.as_str())
                    {
                        tops.push((name, e.path()));
                    }
                }
            }
            tops.into_par_iter()
                .flat_map(move |(name, path)| {
                    let mut out = Vec::new();
                    find_profiles(&path, &name, 7, &mut out);
                    let base = base.clone();
                    out.into_iter()
                        .map(move |p| {
                            let rel = p.strip_prefix(&base).map(|r| r.to_string_lossy().to_string()).unwrap_or_default();
                            (rel, p)
                        })
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>()
        })
        .collect();

    // Ключ группы — в нижнем регистре, но для показа помним написание как на диске.
    let mut groups: BTreeMap<String, (String, Vec<PathBuf>)> = BTreeMap::new();
    for (rel, path) in found {
        let shown = app_key(&rel);
        groups.entry(shown.to_lowercase()).or_insert_with(|| (shown, Vec::new())).1.push(path);
    }
    let mut rules = Vec::new();
    for (key, (shown, profiles)) in groups {
        let known = KNOWN_APPS.iter().find(|k| {
            key.strip_prefix(k.0).map(|rest| rest.is_empty() || rest.starts_with('\\') || rest.starts_with('_')).unwrap_or(false)
        });
        let (title, category) = match known {
            Some(k) => (k.1.to_string(), k.2),
            None => (pretty_name(&shown), "apps"),
        };
        let mut specs = Vec::new();
        for prof in &profiles {
            for sub in PROFILE_CACHES {
                let d = prof.join(sub);
                if exists(&d) {
                    specs.push(Spec::Contents(d.to_string_lossy().to_string()));
                }
            }
            for base in [Some(prof.as_path()), prof.parent()].into_iter().flatten() {
                for sub in SHARED_CACHES {
                    let d = base.join(sub);
                    let s = d.to_string_lossy().to_string();
                    if exists(&d) && !specs.iter().any(|x| matches!(x, Spec::Contents(t) if *t == s)) {
                        specs.push(Spec::Contents(s));
                    }
                }
            }
        }
        if specs.is_empty() {
            continue;
        }
        let desc = if category == "browsers" {
            "Кеш страниц, скриптов и графики. Закладки, пароли, история и открытые вкладки не затрагиваются. Лучше закрыть браузер перед очисткой."
        } else {
            "Кеш встроенного браузера приложения: загруженные картинки, скрипты, шейдеры. Настройки и переписка не затрагиваются. Лучше закрыть приложение перед очисткой."
        };
        // Если несколько ключей дали одно название (Roaming и Local), объединяем.
        if let Some(prev) = rules.iter_mut().find(|r: &&mut Rule| r.title == title) {
            prev.specs.extend(specs);
            continue;
        }
        rules.push(Rule::new(&format!("chromium:{}", key), category, &title, desc, "safe", specs));
    }
    rules
}

pub fn all_rules() -> Vec<Rule> {
    let mut rules = static_rules();
    rules.extend(chromium_rules());
    rules
}

/// Находит и взвешивает весь мусор. Пустые правила в результат не попадают.
pub fn scan() -> Vec<JunkItem> {
    let rules = all_rules();
    let mut items: Vec<JunkItem> = rules.par_iter().map(evaluate).collect();
    items.retain(|i| i.size > 0 || i.files > 0 || (!i.accessible && i.needs_admin));
    items
}

/// Чистит выбранные правила. Правила, требующие прав администратора, без них пропускаются.
pub fn clean(ids: &[String], mut on_progress: impl FnMut(usize, usize, &str)) -> CleanReport {
    let rules = all_rules();
    let elevated = winutil::is_elevated();
    let selected: Vec<&Rule> = rules.iter().filter(|r| ids.contains(&r.id)).collect();
    let mut report = CleanReport::default();
    for (i, rule) in selected.iter().enumerate() {
        on_progress(i, selected.len(), &rule.title);
        if rule.needs_admin && !elevated {
            report.errors.push(format!("{} — пропущено: нужны права администратора", rule.title));
            continue;
        }
        let st = clean_rule(rule);
        report.freed += st.freed;
        report.files += st.files;
        report.failed += st.failed;
        for e in st.errors {
            if report.errors.len() < 40 {
                report.errors.push(e);
            }
        }
        report.items.push(CleanedItem { id: rule.id.clone(), title: rule.title.clone(), freed: st.freed, files: st.files, failed: st.failed });
    }
    report
}

/// Безвозвратное удаление произвольного пути (для «удалить навсегда» в обозревателе).
pub fn remove_path(path: &str) -> Result<(u64, u64, u64, Vec<String>), String> {
    let p = Path::new(path);
    if is_protected(p) {
        return Err(format!("{} — защищённая системная папка, удаление запрещено", path));
    }
    let ext = PathBuf::from(extended(path));
    let meta = std::fs::symlink_metadata(&ext).map_err(|e| e.to_string())?;
    let mut st = DelStats::default();
    remove_entry(&ext, &meta, &mut st);
    Ok((st.freed, st.files, st.failed, st.errors))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sc-junk-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn protected_places() {
        assert!(is_protected(Path::new("C:\\")));
        assert!(is_protected(Path::new("C:\\Windows")));
        assert!(is_protected(Path::new(&env("USERPROFILE"))));
        assert!(is_protected(Path::new(&format!("{}\\Documents", env("USERPROFILE")))));
        assert!(is_protected(Path::new(&format!("{}\\System32", env("WINDIR")))));
        assert!(!is_protected(Path::new(&format!("{}\\Temp", env("LOCALAPPDATA")))));
    }

    #[test]
    fn expands_wildcards() {
        let d = scratch("expand");
        fs::create_dir_all(d.join("Profile 1").join("cache2")).unwrap();
        fs::create_dir_all(d.join("Profile 2").join("cache2")).unwrap();
        fs::create_dir_all(d.join("Other").join("nope")).unwrap();
        let found = expand(&format!("{}\\Profile *\\cache2", d.display()));
        assert_eq!(found.len(), 2);
        assert!(expand("%NO_SUCH_VAR_SC%\\x").is_empty());
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn cleans_contents_but_keeps_folder_and_links() {
        let d = scratch("clean");
        let cache = d.join("app").join("Cache");
        let outside = d.join("precious");
        fs::create_dir_all(cache.join("sub")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(cache.join("a.bin"), vec![0u8; 1000]).unwrap();
        fs::write(cache.join("sub").join("b.bin"), vec![0u8; 2000]).unwrap();
        fs::write(outside.join("keep.txt"), b"important").unwrap();
        // junction внутри кеша ведёт наружу — содержимое цели должно уцелеть
        let link = cache.join("link");
        let ok = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        let rule = Rule::new("t", "apps", "t", "", "safe", vec![Spec::Contents(cache.to_string_lossy().to_string())]);
        let item = evaluate(&rule);
        assert_eq!((item.size, item.files), (3000, 2));

        let st = clean_rule(&rule);
        assert_eq!((st.freed, st.files, st.failed), (3000, 2, 0));
        assert!(cache.exists(), "сама папка кеша остаётся");
        assert_eq!(fs::read_dir(&cache).unwrap().count(), 0);
        if ok {
            assert!(outside.join("keep.txt").exists(), "файл за junction-ом не тронут");
        }
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn respects_min_age_and_patterns() {
        let d = scratch("age");
        fs::write(d.join("fresh.exe"), vec![0u8; 10]).unwrap();
        fs::write(d.join("doc.txt"), vec![0u8; 10]).unwrap();
        let fresh_only = Rule::new("t", "x", "t", "", "safe", vec![Spec::Files(d.to_string_lossy().to_string(), "*.exe".into())]).age(24);
        assert_eq!(evaluate(&fresh_only).files, 0, "свежие файлы не трогаем");
        let any_age = Rule::new("t", "x", "t", "", "safe", vec![Spec::Files(d.to_string_lossy().to_string(), "*.exe".into())]);
        let st = clean_rule(&any_age);
        assert_eq!(st.files, 1);
        assert!(d.join("doc.txt").exists());
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn app_keys() {
        assert_eq!(app_key("Google\\Chrome\\User Data\\Default"), "Google\\Chrome");
        assert_eq!(app_key("discord"), "discord");
        assert_eq!(app_key("Packages\\MSTeams_8wekyb3d8bbwe\\LocalCache\\Microsoft\\MSTeams\\EBWebView\\Default"), "Packages\\MSTeams_8wekyb3d8bbwe");
        assert_eq!(app_key("Programs\\foo\\Default"), "Programs\\foo");
        assert_eq!(pretty_name("Packages\\Microsoft.GamingApp_8wekyb3d8bbwe"), "Microsoft.GamingApp");
        assert_eq!(pretty_name("NVIDIA Corporation\\NVIDIA app"), "NVIDIA Corporation · NVIDIA app");
        assert_eq!(pretty_name("unityhub"), "Unityhub");
    }
}
