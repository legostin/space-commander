pub mod categories;
pub mod dupes;
pub mod junk;
pub mod scan_mft;
pub mod scan_walk;
pub mod schedule;
pub mod tree;
pub mod winutil;

use scan_walk::Progress;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering::Relaxed};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tree::{Tree, F_DELETED};

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
    let tree = trees.get(&key(root)).ok_or("Этот диск ещё не просканирован")?;
    Ok(f(tree))
}

fn check_id(tree: &Tree, id: u32) -> Result<(), String> {
    if tree.valid(id) {
        Ok(())
    } else {
        Err("Объект больше не существует".into())
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
        return Err("Путь не существует".into());
    }
    winutil::shell_open(&path)
}

/// Открывает раздел «Параметров» Windows. Разрешены только адреса ms-settings.
#[tauri::command]
fn open_settings(uri: String) -> Result<(), String> {
    if !uri.starts_with("ms-settings:") {
        return Err("Разрешены только адреса ms-settings:".into());
    }
    winutil::shell_open(&uri)
}

// ───────────── Сканирование ─────────────

#[derive(Serialize, Clone)]
struct ProgressEvent {
    root: String,
    mode: String,
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
    /// Почему быстрый режим не сработал и пришлось обходить папки.
    note: Option<String>,
}

#[derive(Serialize, Clone)]
struct ScanError {
    root: String,
    message: String,
    cancelled: bool,
}

#[tauri::command]
fn start_scan(app: AppHandle, state: State<AppState>, root: String, mode: String) -> Result<(), String> {
    let progress = {
        let mut slot = state.scan.lock().unwrap();
        if slot.is_some() {
            return Err("Сканирование уже идёт".into());
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
                let mask = state.hide_mask.load(Relaxed);
                if mask != 0 {
                    tree.apply_filter(mask);
                }
                let summary = tree.summary();
                state.trees.write().unwrap().insert(key(&tree.root_path), tree);
                schedule::record_history(600);
                let _ = app.emit("scan-done", ScanDone { summary, note });
            }
            Err(e) => {
                let cancelled = e == "cancelled";
                let _ = app.emit("scan-error", ScanError { root, message: e, cancelled });
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

#[tauri::command(async)]
fn top_files(state: State<AppState>, root: String, id: u32, limit: usize, by_alloc: bool) -> Result<Vec<tree::FileDto>, String> {
    with_tree(&state, &root, |t| check_id(t, id).map(|_| t.top_files(id, limit.clamp(1, 2000), by_alloc)))?
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
            return Err(format!("{} — защищённая системная папка, удаление запрещено", path));
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

#[tauri::command(async)]
fn junk_clean(app: AppHandle, ids: Vec<String>) -> junk::CleanReport {
    let report = junk::clean(&ids, |index, total, title| {
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
            return Err("Поиск дубликатов уже идёт".into());
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

    tauri::Builder::default()
        .manage(AppState::default())
        .setup(|_app| {
            std::thread::spawn(|| {
                schedule::register_app_id();
                schedule::record_history(3600);
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
            start_scan,
            cancel_scan,
            scan_summaries,
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

#[allow(dead_code)]
const _: u16 = F_DELETED;
