pub mod apps;
pub mod cache;
pub mod categories;
pub mod dupes;
pub mod i18n;
pub mod junk;
pub mod junk_en;
pub mod scan_mft;
pub mod scan_walk;
pub mod schedule;
pub mod snapshot;
pub mod tree;
pub mod winutil;

use i18n::tr;
use scan_walk::Progress;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering::Relaxed};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tree::Tree;

#[derive(Default)]
pub struct AppState {
    trees: RwLock<HashMap<String, Tree>>,
    scan: Mutex<Option<Arc<Progress>>>,
    dupes: Mutex<Option<Arc<Progress>>>,
    /// Какие атрибуты скрыты в выдаче (F_HIDDEN | F_SYSTEM); действует на все деревья.
    hide_mask: AtomicU16,
}

fn key(root: &str) -> String {
    root.trim_end_matches('\\').to_uppercase()
}

fn with_tree<T>(state: &AppState, root: &str, f: impl FnOnce(&Tree) -> T) -> Result<T, String> {
    let trees = state.trees.read().unwrap();
    let tree = trees.get(&key(root)).ok_or_else(|| tr("Этот диск ещё не просканирован", "This drive has not been scanned yet").to_string())?;
    Ok(f(tree))
}

fn check_id(tree: &Tree, id: u32) -> Result<(), String> {
    if tree.valid(id) {
        Ok(())
    } else {
        Err(tr("Объект больше не существует", "The item no longer exists").into())
    }
}

// ───────────── Диски, права, система ─────────────

#[tauri::command(async)]
fn list_drives() -> Vec<winutil::DriveInfo> {
    winutil::list_drives()
}

#[derive(Serialize)]
struct PrivilegeInfo {
    elevated: bool,
    /// 1 — обычный пользователь, 2 — полный токен, 3 — администратор без повышения.
    elevation_type: u32,
    user: String,
}

#[tauri::command]
fn privilege_info() -> PrivilegeInfo {
    PrivilegeInfo { elevated: winutil::is_elevated(), elevation_type: winutil::elevation_type(), user: winutil::user_name() }
}

/// Перезапуск с правами администратора. `scan` — диск, который нужно сразу просканировать.
#[tauri::command]
fn relaunch_elevated(app: AppHandle, scan: Option<String>) -> Result<(), String> {
    let args = match scan {
        Some(root) if root.len() <= 3 && root.chars().next().map(|c| c.is_ascii_alphabetic()).unwrap_or(false) => {
            format!("--scan {}:", &root[..1])
        }
        _ => String::new(),
    };
    winutil::relaunch_elevated(&args)?;
    app.exit(0);
    Ok(())
}

/// Диск, переданный ключом `--scan` (после перезапуска с повышением прав).
#[tauri::command]
fn startup_scan() -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    let pos = args.iter().position(|a| a == "--scan")?;
    let v = args.get(pos + 1)?;
    let letter = v.chars().next().filter(|c| c.is_ascii_alphabetic())?;
    Some(format!("{}:\\", letter.to_ascii_uppercase()))
}

#[tauri::command]
fn reveal(path: String) -> Result<(), String> {
    winutil::reveal_in_explorer(&path)
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    if !std::path::Path::new(&path).exists() {
        return Err(tr("Путь не существует", "The path does not exist").into());
    }
    winutil::shell_open(&path)
}

/// Открывает штатное средство Windows. Разрешён только короткий список адресов:
/// разделы «Параметров», «Защита системы», «Очистка диска» и удаление игры через Steam.
#[tauri::command]
fn open_settings(uri: String) -> Result<(), String> {
    let spawn = |exe: &str| std::process::Command::new(exe).spawn().map(|_| ()).map_err(|e| e.to_string());
    match uri.as_str() {
        "tool:system-protection" => spawn("SystemPropertiesProtection.exe"),
        "tool:disk-cleanup" => spawn("cleanmgr.exe"),
        "tool:apps" => winutil::shell_open("ms-settings:appsfeatures"),
        u if u.starts_with("ms-settings:") && u[12..].chars().all(|c| c.is_ascii_alphanumeric() || c == '-') => winutil::shell_open(u),
        u if u.strip_prefix("steam://uninstall/").map(|id| !id.is_empty() && id.chars().all(|c| c.is_ascii_digit())).unwrap_or(false) => {
            winutil::shell_open(u)
        }
        _ => Err(tr("Этот адрес открывать нельзя", "This address is not allowed").into()),
    }
}

#[tauri::command]
fn set_language(lang: String) {
    let en = lang == "en";
    i18n::set_english(en);
    let _ = schedule::save_settings(&schedule::Settings { lang: if en { "en" } else { "ru" }.into() });
}

/// Системный диалог выбора папки для сканирования.
#[tauri::command(async)]
fn pick_folder(app: AppHandle) -> Option<String> {
    let picked = app.dialog().file().set_title(tr("Папка для сканирования", "Folder to scan")).blocking_pick_folder()?;
    picked.into_path().ok().map(|p| p.to_string_lossy().to_string())
}

// ───────────── Сканирование ─────────────

#[derive(Serialize, Clone)]
struct ProgressEvent {
    root: String,
    mode: String,
    quiet: bool,
    files: u64,
    dirs: u64,
    bytes: u64,
    done: u64,
    total: u64,
    elapsed_ms: u64,
}

#[derive(Serialize, Clone)]
struct ScanDone {
    summary: tree::ScanSummary,
    quiet: bool,
    /// Почему быстрый режим не сработал и пришлось обходить папки.
    note: Option<String>,
}

#[derive(Serialize, Clone)]
struct ScanError {
    root: String,
    message: String,
    cancelled: bool,
    quiet: bool,
}

/// `quiet` — фоновое обновление: интерфейс не закрывается индикатором и остаётся на текущем экране.
#[tauri::command]
fn start_scan(app: AppHandle, state: State<AppState>, root: String, mode: String, quiet: Option<bool>) -> Result<(), String> {
    let quiet = quiet.unwrap_or(false);
    let progress = {
        let mut slot = state.scan.lock().unwrap();
        if slot.is_some() {
            return Err(tr("Сканирование уже идёт", "A scan is already running").into());
        }
        let p = Arc::new(Progress::default());
        *slot = Some(p.clone());
        p
    };
    let is_drive_root = root.trim_end_matches('\\').len() == 2 && root.as_bytes().get(1) == Some(&b':');
    let is_ntfs = winutil::list_drives()
        .iter()
        .any(|d| d.root.eq_ignore_ascii_case(&winutil::volume_root(&root)) && d.fs == "NTFS");
    let use_mft = is_drive_root && is_ntfs && (mode == "mft" || (mode == "auto" && winutil::is_elevated()));

    std::thread::spawn(move || {
        let started = Instant::now();
        let finished = Arc::new(AtomicBool::new(false));
        let mode_now = Arc::new(Mutex::new(if use_mft { "mft" } else { "walk" }.to_string()));
        let ticker = {
            let (app, p, finished, root, mode_now) = (app.clone(), progress.clone(), finished.clone(), root.clone(), mode_now.clone());
            std::thread::spawn(move || {
                while !finished.load(Relaxed) {
                    let _ = app.emit(
                        "scan-progress",
                        ProgressEvent {
                            root: root.clone(),
                            mode: mode_now.lock().unwrap().clone(),
                            quiet,
                            files: p.files.load(Relaxed),
                            dirs: p.dirs.load(Relaxed),
                            bytes: p.bytes.load(Relaxed),
                            done: p.done.load(Relaxed),
                            total: p.total.load(Relaxed),
                            elapsed_ms: started.elapsed().as_millis() as u64,
                        },
                    );
                    std::thread::sleep(Duration::from_millis(90));
                }
            })
        };

        let mut note = None;
        let result = if use_mft {
            let letter = root.chars().next().unwrap_or('C');
            match scan_mft::scan(letter, &progress) {
                Ok(t) => Ok(t),
                Err(e) if e == "cancelled" => Err(e),
                Err(e) => {
                    // Быстрый режим не удался — честно сообщаем причину и идём обычным путём.
                    note = Some(e);
                    for c in [&progress.files, &progress.dirs, &progress.bytes, &progress.done, &progress.total] {
                        c.store(0, Relaxed);
                    }
                    *mode_now.lock().unwrap() = "walk".into();
                    scan_walk::scan(&root, &progress)
                }
            }
        } else {
            scan_walk::scan(&root, &progress)
        };
        finished.store(true, Relaxed);
        let _ = ticker.join();

        let state = app.state::<AppState>();
        *state.scan.lock().unwrap() = None;
        match result {
            Ok(mut tree) => {
                // Снимок размеров — пока дерево полное, до фильтра скрытых объектов.
                let _ = snapshot::save(&snapshot::capture(&tree));
                let mask = state.hide_mask.load(Relaxed);
                if mask != 0 {
                    tree.apply_filter(mask);
                }
                let summary = tree.summary();
                let tree_key = key(&tree.root_path);
                state.trees.write().unwrap().insert(tree_key.clone(), tree);
                schedule::record_history(600);
                let _ = app.emit("scan-done", ScanDone { summary, quiet, note });
                // Кеш на диск пишем уже после того, как интерфейс получил результат.
                if let Some(t) = state.trees.read().unwrap().get(&tree_key) {
                    let _ = cache::save(t);
                }
            }
            Err(e) => {
                let cancelled = e == "cancelled";
                let _ = app.emit("scan-error", ScanError { root, message: e, cancelled, quiet });
            }
        }
    });
    Ok(())
}

#[tauri::command]
fn cancel_scan(state: State<AppState>) {
    if let Some(p) = state.scan.lock().unwrap().as_ref() {
        p.cancel.store(true, Relaxed);
    }
}

#[tauri::command]
fn scan_summaries(state: State<AppState>) -> Vec<tree::ScanSummary> {
    state.trees.read().unwrap().values().map(|t| t.summary()).collect()
}

/// Убирает результат сканирования из памяти (для папок, отсканированных отдельно).
#[tauri::command]
fn forget_scan(state: State<AppState>, root: String) {
    state.trees.write().unwrap().remove(&key(&root));
}

/// Показывать ли объекты с атрибутами «скрытый» и «системный». Скрытые не попадают
/// в списки, карту, поиск и суммы; возвращает обновлённые сводки по всем дискам.
#[tauri::command(async)]
fn set_visibility(state: State<AppState>, show_hidden: bool, show_system: bool) -> Vec<tree::ScanSummary> {
    let mut mask = 0u16;
    if !show_hidden {
        mask |= tree::F_HIDDEN;
    }
    if !show_system {
        mask |= tree::F_SYSTEM;
    }
    state.hide_mask.store(mask, Relaxed);
    let mut trees = state.trees.write().unwrap();
    trees
        .values_mut()
        .map(|t| {
            if t.hide_mask != mask {
                t.apply_filter(mask);
            }
            t.summary()
        })
        .collect()
}

// ───────────── Запросы к дереву ─────────────

#[tauri::command(async)]
fn get_dir(state: State<AppState>, root: String, id: u32, by_alloc: bool) -> Result<tree::DirView, String> {
    with_tree(&state, &root, |t| check_id(t, id).map(|_| t.dir_view(id, by_alloc)))?
}

#[tauri::command(async)]
fn get_subtree(state: State<AppState>, root: String, id: u32, budget: usize, by_alloc: bool) -> Result<Vec<tree::SubNode>, String> {
    with_tree(&state, &root, |t| check_id(t, id).map(|_| t.subtree(id, budget.clamp(100, 30_000), by_alloc)))?
}

/// `older_than_days > 0` — только файлы, которые не менялись дольше указанного срока.
#[tauri::command(async)]
fn top_files(state: State<AppState>, root: String, id: u32, limit: usize, by_alloc: bool, older_than_days: Option<u32>) -> Result<Vec<tree::FileDto>, String> {
    let cutoff = match older_than_days.unwrap_or(0) {
        0 => 0,
        d => winutil::now_unix() - d as i64 * 86400,
    };
    with_tree(&state, &root, |t| check_id(t, id).map(|_| t.top_files(id, limit.clamp(1, 5000), by_alloc, cutoff)))?
}

#[tauri::command(async)]
fn ext_stats(state: State<AppState>, root: String, id: u32) -> Result<Vec<tree::ExtStat>, String> {
    with_tree(&state, &root, |t| {
        check_id(t, id).map(|_| {
            let mut v = t.ext_stats(id);
            v.truncate(400);
            v
        })
    })?
}

#[tauri::command(async)]
fn search(state: State<AppState>, root: String, query: String, limit: usize, by_alloc: bool) -> Result<tree::SearchResult, String> {
    with_tree(&state, &root, |t| t.search(&query, limit.clamp(1, 1000), by_alloc))
}

#[tauri::command(async)]
fn find_path(state: State<AppState>, root: String, path: String) -> Result<Option<u32>, String> {
    with_tree(&state, &root, |t| t.find_path(&path))
}

/// Родительская папка узла — чтобы показать файл в обозревателе.
#[tauri::command(async)]
fn parent_of(state: State<AppState>, root: String, id: u32) -> Result<u32, String> {
    with_tree(&state, &root, |t| check_id(t, id).map(|_| t.nodes[id as usize].parent))?
}

#[tauri::command(async)]
fn denied_paths(state: State<AppState>, root: String) -> Result<Vec<String>, String> {
    with_tree(&state, &root, |t| t.denied.iter().take(1000).cloned().collect())
}

#[tauri::command(async)]
fn dev_artifacts(state: State<AppState>, root: String) -> Result<Vec<tree::Artifact>, String> {
    with_tree(&state, &root, |t| t.dev_artifacts(20 << 20))
}

// ───────────── Сравнение сканов ─────────────

#[tauri::command(async)]
fn snapshots_list(root: String) -> Vec<snapshot::SnapMeta> {
    snapshot::list(&root)
}

/// Сравнивает последний снимок корня с выбранным базовым.
#[tauri::command(async)]
fn snapshot_diff(root: String, base_id: String, limit: usize) -> Result<snapshot::Diff, String> {
    let latest = snapshot::list(&root).into_iter().next().ok_or_else(|| tr("Снимков ещё нет", "There are no snapshots yet").to_string())?;
    let missing = || tr("Снимок не найден", "Snapshot not found").to_string();
    let new = snapshot::load(&latest.id).ok_or_else(missing)?;
    let old = snapshot::load(&base_id).ok_or_else(missing)?;
    Ok(snapshot::diff(&old, &new, limit.clamp(1, 500)))
}

// ───────────── Игры и программы ─────────────

/// Установленные игры и программы. Размер берётся из сканирования диска, если оно есть,
/// иначе — из данных магазина или реестра.
#[tauri::command(async)]
fn installed_apps(state: State<AppState>) -> Vec<apps::InstalledApp> {
    let mut list = apps::list();
    let trees = state.trees.read().unwrap();
    for a in list.iter_mut() {
        for t in trees.values() {
            if let Some(id) = t.find_path(&a.path) {
                let n = &t.nodes[id as usize];
                a.size = n.size;
                a.alloc = n.alloc;
                a.mtime = n.mtime;
                a.node = Some(id);
                a.root = t.root_path.clone();
                a.path = t.path(id); // написание как на диске

                break;
            }
        }
        if a.node.is_none() {
            a.size = a.reported_size;
            a.alloc = a.reported_size;
        }
    }
    list.sort_by(|a, b| b.alloc.cmp(&a.alloc).then_with(|| a.name.cmp(&b.name)));
    list
}

// ───────────── Экспорт ─────────────

fn csv_field(s: &str) -> String {
    if s.contains([';', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// Unix-секунды → `ГГГГ-ММ-ДД` (UTC).
fn iso_date(unix: i64) -> String {
    if unix <= 0 {
        return String::new();
    }
    let days = unix.div_euclid(86400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{:04}-{:02}-{:02}", y, m, d)
}

fn build_csv(tree: &Tree, kind: &str, id: u32, by_alloc: bool, older_than_days: u32) -> Result<String, String> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    match kind {
        "dir" => {
            rows.push(
                [tr("Имя", "Name"), tr("Вид", "Kind"), tr("Размер, байт", "Size, bytes"), tr("На диске, байт", "On disk, bytes"), tr("Файлов", "Files"), tr("Изменён", "Modified"), tr("Путь", "Path")]
                    .map(String::from)
                    .to_vec(),
            );
            let view = tree.dir_view(id, by_alloc);
            for c in view.children {
                let path = if view.path.ends_with('\\') { format!("{}{}", view.path, c.name) } else { format!("{}\\{}", view.path, c.name) };
                rows.push(vec![
                    c.name,
                    if c.dir { tr("папка", "folder") } else { tr("файл", "file") }.to_string(),
                    c.size.to_string(),
                    c.alloc.to_string(),
                    c.files.to_string(),
                    iso_date(c.mtime),
                    path,
                ]);
            }
        }
        "top" => {
            rows.push([tr("Имя", "Name"), tr("Размер, байт", "Size, bytes"), tr("На диске, байт", "On disk, bytes"), tr("Изменён", "Modified"), tr("Путь", "Path")].map(String::from).to_vec());
            let cutoff = if older_than_days > 0 { winutil::now_unix() - older_than_days as i64 * 86400 } else { 0 };
            for f in tree.top_files(id, 5000, by_alloc, cutoff) {
                rows.push(vec![f.name, f.size.to_string(), f.alloc.to_string(), iso_date(f.mtime), f.path]);
            }
        }
        "types" => {
            rows.push([tr("Расширение", "Extension"), tr("Файлов", "Files"), tr("Размер, байт", "Size, bytes"), tr("На диске, байт", "On disk, bytes")].map(String::from).to_vec());
            for e in tree.ext_stats(id) {
                rows.push(vec![e.ext, e.count.to_string(), e.size.to_string(), e.alloc.to_string()]);
            }
        }
        _ => return Err(tr("Неизвестный вид отчёта", "Unknown report kind").into()),
    }
    // BOM и «;» — чтобы Excel открыл файл с кириллицей и колонками без настройки.
    let mut out = String::from("\u{FEFF}");
    for r in rows {
        out.push_str(&r.iter().map(|f| csv_field(f)).collect::<Vec<_>>().join(";"));
        out.push_str("\r\n");
    }
    Ok(out)
}

/// Сохраняет отчёт в CSV через системный диалог. Возвращает путь или None, если диалог закрыли.
#[tauri::command(async)]
fn export_csv(app: AppHandle, state: State<AppState>, root: String, kind: String, id: u32, by_alloc: bool, older_than_days: Option<u32>) -> Result<Option<String>, String> {
    let csv = with_tree(&state, &root, |t| check_id(t, id).and_then(|_| build_csv(t, &kind, id, by_alloc, older_than_days.unwrap_or(0))))??;
    let name = format!("space-commander-{}-{}.csv", kind, iso_date(winutil::now_unix()));
    let Some(target) = app.dialog().file().set_file_name(name).add_filter("CSV", &["csv"]).blocking_save_file() else { return Ok(None) };
    let path = target.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, csv).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().to_string()))
}

// ───────────── Удаление ─────────────

#[derive(Serialize, Default)]
struct DeleteReport {
    freed: u64,
    deleted: Vec<u32>,
    errors: Vec<String>,
}

#[tauri::command(async)]
fn delete_nodes(state: State<AppState>, root: String, ids: Vec<u32>, permanent: bool) -> Result<DeleteReport, String> {
    let targets: Vec<(u32, String, u64)> = with_tree(&state, &root, |t| {
        ids.iter()
            .filter(|&&id| id != 0 && t.valid(id))
            .map(|&id| (id, t.path(id), t.nodes[id as usize].alloc))
            .collect()
    })?;
    if targets.is_empty() {
        return Ok(DeleteReport::default());
    }
    let mut report = DeleteReport::default();
    for (_, path, _) in &targets {
        if junk::is_protected(std::path::Path::new(path)) {
            return Err(format!("{} — {}", path, tr("защищённая системная папка, удаление запрещено", "a protected system folder, deletion is not allowed")));
        }
    }
    if permanent {
        for (_, path, _) in &targets {
            match junk::remove_path(path) {
                Ok((_, _, _, errs)) => report.errors.extend(errs.into_iter().take(5)),
                Err(e) => report.errors.push(e),
            }
        }
    } else {
        let paths: Vec<&str> = targets.iter().map(|t| t.1.as_str()).collect();
        if let Err(e) = winutil::recycle(&paths) {
            report.errors.push(e);
        }
    }
    // В дереве отмечаем только то, что действительно исчезло с диска.
    let mut trees = state.trees.write().unwrap();
    if let Some(tree) = trees.get_mut(&key(&root)) {
        for (id, path, alloc) in targets {
            if std::fs::symlink_metadata(winutil::extended(&path)).is_err() {
                tree.mark_deleted(id);
                report.freed += alloc;
                report.deleted.push(id);
            }
        }
    }
    report.errors.truncate(20);
    Ok(report)
}

// ───────────── Мусор и кеши ─────────────

#[tauri::command(async)]
fn junk_scan() -> Vec<junk::JunkItem> {
    junk::scan()
}

#[derive(Serialize, Clone)]
struct CleanProgress {
    index: usize,
    total: usize,
    title: String,
}

/// `skip_running` — не трогать кеши приложений, которые сейчас запущены.
#[tauri::command(async)]
fn junk_clean(app: AppHandle, ids: Vec<String>, skip_running: Option<bool>) -> junk::CleanReport {
    let report = junk::clean(&ids, skip_running.unwrap_or(false), |index, total, title| {
        let _ = app.emit("clean-progress", CleanProgress { index, total, title: title.to_string() });
    });
    schedule::record_history(0);
    report
}

// ───────────── Дубликаты ─────────────

#[derive(Serialize, Clone)]
struct DupProgress {
    files: u64,
    done: u64,
    total: u64,
}

#[tauri::command]
fn dupes_start(app: AppHandle, state: State<AppState>, root: String, id: u32, min_size: u64) -> Result<(), String> {
    let progress = {
        let mut slot = state.dupes.lock().unwrap();
        if slot.is_some() {
            return Err(tr("Поиск дубликатов уже идёт", "A duplicate search is already running").into());
        }
        let p = Arc::new(Progress::default());
        *slot = Some(p.clone());
        p
    };
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let cands = with_tree(&state, &root, |t| if t.valid(id) { dupes::candidates(t, id, min_size.max(4096)) } else { vec![] });
        let finished = Arc::new(AtomicBool::new(false));
        let ticker = {
            let (app, p, finished) = (app.clone(), progress.clone(), finished.clone());
            std::thread::spawn(move || {
                while !finished.load(Relaxed) {
                    let _ = app.emit(
                        "dupes-progress",
                        DupProgress { files: p.files.load(Relaxed), done: p.done.load(Relaxed), total: p.total.load(Relaxed) },
                    );
                    std::thread::sleep(Duration::from_millis(120));
                }
            })
        };
        let result = match cands {
            Ok(c) => Ok(dupes::find(c, &progress)),
            Err(e) => Err(e),
        };
        finished.store(true, Relaxed);
        let _ = ticker.join();
        let cancelled = progress.cancel.load(Relaxed);
        *state.dupes.lock().unwrap() = None;
        match result {
            Ok(_) if cancelled => {
                let _ = app.emit("dupes-error", "cancelled");
            }
            Ok(r) => {
                let _ = app.emit("dupes-done", r);
            }
            Err(e) => {
                let _ = app.emit("dupes-error", e);
            }
        }
    });
    Ok(())
}

#[tauri::command]
fn dupes_cancel(state: State<AppState>) {
    if let Some(p) = state.dupes.lock().unwrap().as_ref() {
        p.cancel.store(true, Relaxed);
    }
}

// ───────────── Расписание и история ─────────────

#[tauri::command(async)]
fn tasks_list() -> Vec<schedule::Task> {
    schedule::list_tasks()
}

#[tauri::command(async)]
fn task_save(task: schedule::Task) -> Result<schedule::Task, String> {
    schedule::save_task(task)
}

#[tauri::command(async)]
fn task_delete(id: String) -> Result<(), String> {
    schedule::delete_task(&id)
}

#[tauri::command(async)]
fn task_run(id: String) -> Result<(), String> {
    schedule::run_task_now(&id)
}

#[tauri::command(async)]
fn task_runs() -> Vec<schedule::RunLog> {
    schedule::runs()
}

#[tauri::command(async)]
fn history_get() -> Vec<schedule::Sample> {
    schedule::history()
}

pub fn run() {
    // Запуск из Планировщика: выполняем задачу без окна и выходим.
    let args: Vec<String> = std::env::args().collect();
    if let Some(pos) = args.iter().position(|a| a == "--run-task") {
        let code = args.get(pos + 1).map(|id| schedule::run_headless(id)).unwrap_or(2);
        std::process::exit(code);
    }
    i18n::set_english(schedule::load_settings().lang == "en");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .setup(|app| {
            std::thread::spawn(|| {
                schedule::register_app_id();
                schedule::record_history(3600);
                schedule::refresh_registrations();
            });
            // Прошлые результаты сканирования поднимаем из кеша в фоне: окно открывается сразу.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let restored = cache::load_all();
                if restored.is_empty() {
                    return;
                }
                let state = handle.state::<AppState>();
                let mask = state.hide_mask.load(Relaxed);
                let mut summaries = Vec::new();
                {
                    let mut trees = state.trees.write().unwrap();
                    for mut t in restored {
                        let k = key(&t.root_path);
                        if trees.contains_key(&k) {
                            continue; // пока читали кеш, диск уже пересканировали
                        }
                        // Пересчёт сумм заодно снимает сохранённый фильтр и ставит текущий.
                        t.apply_filter(mask);
                        summaries.push(t.summary());
                        trees.insert(k, t);
                    }
                }
                let _ = handle.emit("scan-restored", summaries);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_drives,
            privilege_info,
            relaunch_elevated,
            startup_scan,
            reveal,
            open_path,
            open_settings,
            set_language,
            pick_folder,
            start_scan,
            cancel_scan,
            scan_summaries,
            forget_scan,
            set_visibility,
            get_dir,
            get_subtree,
            top_files,
            ext_stats,
            search,
            find_path,
            parent_of,
            denied_paths,
            dev_artifacts,
            snapshots_list,
            snapshot_diff,
            installed_apps,
            export_csv,
            delete_nodes,
            junk_scan,
            junk_clean,
            dupes_start,
            dupes_cancel,
            tasks_list,
            task_save,
            task_delete,
            task_run,
            task_runs,
            history_get,
        ])
        .run(tauri::generate_context!())
        .expect("не удалось запустить приложение");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_is_excel_friendly() {
        let t = tree::tests::build("C:\\", &[(0, "Отчёт; итог.xlsx", false, 1500), (0, "папка \"A\"", true, 0), (2, "x.bin", false, 10)]);
        let csv = build_csv(&t, "dir", 0, true, 0).unwrap();
        assert!(csv.starts_with('\u{FEFF}'));
        let lines: Vec<&str> = csv.trim_start_matches('\u{FEFF}').lines().collect();
        assert_eq!(lines.len(), 3);
        assert!(lines[1].starts_with("\"Отчёт; итог.xlsx\";файл;1500;1500;1;"));
        assert!(lines[2].contains("\"папка \"\"A\"\"\";папка;10"));
        assert!(build_csv(&t, "types", 0, true, 0).unwrap().contains("xlsx;1;1500;1500"));
        assert!(build_csv(&t, "nope", 0, true, 0).is_err());
    }

    #[test]
    fn dates() {
        assert_eq!(iso_date(0), "");
        assert_eq!(iso_date(86400), "1970-01-02");
        assert_eq!(iso_date(1_700_000_000), "2023-11-14");
        assert_eq!(iso_date(951_782_400), "2000-02-29");
    }
}
