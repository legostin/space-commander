//! Задачи по расписанию (через Планировщик Windows), журнал запусков и история свободного места.
//!
//! Задача в Планировщике запускает это же приложение с ключом `--run-task <id>`:
//! окно не открывается, выполняется очистка по выбранным правилам, результат пишется
//! в журнал и показывается уведомлением.

use crate::junk;
use crate::winutil::{self, wide, CREATE_NO_WINDOW};
use serde::{Deserialize, Serialize};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;
use std::ptr::{null, null_mut};
use windows_sys::Win32::System::Registry::{RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER};

pub const APP_ID: &str = "SpaceCommander.App";
const TASK_FOLDER: &str = "SpaceCommander";

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Task {
    pub id: String,
    pub name: String,
    /// daily | weekly | monthly
    pub kind: String,
    /// ЧЧ:ММ
    pub time: String,
    /// 1 — понедельник … 7 — воскресенье
    pub weekday: u32,
    pub monthday: u32,
    /// Идентификаторы правил очистки.
    pub rules: Vec<String>,
    pub notify: bool,
    /// Предупреждать, если свободно меньше N процентов (0 — выключено).
    pub low_space_pct: u32,
    /// Запускать с правами администратора (нужно для системных правил).
    pub elevated: bool,
    pub enabled: bool,
    /// Заполняется при чтении: задача действительно есть в Планировщике.
    pub registered: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct DriveSample {
    pub root: String,
    pub total: u64,
    pub free: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct RunLog {
    pub task_id: String,
    pub task_name: String,
    pub at: i64,
    pub freed: u64,
    pub files: u64,
    pub failed: u64,
    pub note: String,
    pub drives: Vec<DriveSample>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Sample {
    pub t: i64,
    pub drives: Vec<DriveSample>,
}

/// Папка AppData\Roaming. Спрашиваем у Windows, а не у переменной окружения: у процесса,
/// запущенного Планировщиком, окружение может отличаться от обычного.
fn roaming_appdata() -> PathBuf {
    let mut buf = [0u16; 260];
    // CSIDL_APPDATA = 0x1A
    let hr = unsafe { windows_sys::Win32::UI::Shell::SHGetFolderPathW(null_mut(), 0x1A, null_mut(), 0, buf.as_mut_ptr()) };
    let known = winutil::from_wide(&buf);
    if hr == 0 && !known.is_empty() {
        PathBuf::from(known)
    } else {
        PathBuf::from(std::env::var("APPDATA").unwrap_or_else(|_| ".".into()))
    }
}

pub fn data_dir() -> PathBuf {
    let dir = roaming_appdata().join("SpaceCommander");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Строка в журнал фоновых запусков (`task.log`) — чтобы было видно, что и почему произошло,
/// даже если задача не дошла до записи результата.
fn log_line(text: &str) {
    use std::io::Write;
    let path = data_dir().join("task.log");
    if std::fs::metadata(&path).map(|m| m.len() > 256 * 1024).unwrap_or(false) {
        let _ = std::fs::remove_file(&path);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{} {}", winutil::now_unix(), text);
    }
}

fn load<T: for<'a> Deserialize<'a> + Default>(file: &str) -> T {
    std::fs::read_to_string(data_dir().join(file))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save<T: Serialize>(file: &str, value: &T) -> Result<(), String> {
    let path = data_dir().join(file);
    let tmp = path.with_extension("tmp");
    let json = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

fn task_name(id: &str) -> String {
    format!("{}\\{}", TASK_FOLDER, id)
}

fn schtasks(args: &[&str]) -> Result<(), String> {
    let out = Command::new("schtasks.exe")
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Не удалось запустить schtasks: {}", e))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("Планировщик Windows отклонил операцию (код {})", out.status.code().unwrap_or(-1)))
    }
}

fn is_registered(id: &str) -> bool {
    schtasks(&["/Query", "/TN", &task_name(id)]).is_ok()
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn valid_time(t: &str) -> bool {
    let b = t.as_bytes();
    b.len() == 5
        && b[2] == b':'
        && t[..2].parse::<u32>().map(|h| h < 24).unwrap_or(false)
        && t[3..].parse::<u32>().map(|m| m < 60).unwrap_or(false)
}

/// Описание задачи в формате Планировщика. Через XML, а не ключи командной строки, чтобы
/// задача работала от батареи и запускалась позже, если компьютер был выключен.
pub fn task_xml(task: &Task, exe: &str, user: &str) -> Result<String, String> {
    if !valid_time(&task.time) {
        return Err("Время должно быть в формате ЧЧ:ММ".into());
    }
    let schedule = match task.kind.as_str() {
        "daily" => "<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>".to_string(),
        "weekly" => {
            let days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
            let d = days.get(task.weekday.saturating_sub(1) as usize).ok_or("Неверный день недели")?;
            format!("<ScheduleByWeek><DaysOfWeek><{} /></DaysOfWeek><WeeksInterval>1</WeeksInterval></ScheduleByWeek>", d)
        }
        "monthly" => {
            if !(1..=28).contains(&task.monthday) {
                return Err("День месяца — от 1 до 28".into());
            }
            let months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
            let m: String = months.iter().map(|m| format!("<{} />", m)).collect();
            format!("<ScheduleByMonth><DaysOfMonth><Day>{}</Day></DaysOfMonth><Months>{}</Months></ScheduleByMonth>", task.monthday, m)
        }
        _ => return Err("Неизвестный тип расписания".into()),
    };
    let run_level = if task.elevated { "HighestAvailable" } else { "LeastPrivilege" };
    Ok(format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>Space Commander</Author>
    <Description>{desc}</Description>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>2026-01-01T{time}:00</StartBoundary>
      <Enabled>true</Enabled>
      {schedule}
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>{run_level}</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
    <Enabled>{enabled}</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{exe}</Command>
      <Arguments>--run-task {id}</Arguments>
    </Exec>
  </Actions>
</Task>
"#,
        desc = xml_escape(&format!("Space Commander: {}", task.name)),
        time = task.time,
        schedule = schedule,
        user = xml_escape(user),
        run_level = run_level,
        enabled = task.enabled,
        exe = xml_escape(exe),
        id = xml_escape(&task.id),
    ))
}

fn register(task: &Task) -> Result<(), String> {
    if task.elevated && !winutil::is_elevated() {
        return Err("Задачу с правами администратора можно создать, только когда само приложение запущено с ними".into());
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let xml = task_xml(task, &exe.to_string_lossy(), &winutil::user_name())?;
    let path = data_dir().join(format!("{}.xml", task.id));
    let mut bytes: Vec<u8> = vec![0xFF, 0xFE];
    for u in xml.encode_utf16() {
        bytes.extend_from_slice(&u.to_le_bytes());
    }
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    let r = schtasks(&["/Create", "/F", "/TN", &task_name(&task.id), "/XML", &path.to_string_lossy()]);
    let _ = std::fs::remove_file(&path);
    r
}

pub fn list_tasks() -> Vec<Task> {
    let mut tasks: Vec<Task> = load("tasks.json");
    for t in tasks.iter_mut() {
        t.registered = is_registered(&t.id);
    }
    tasks
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 40 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

pub fn save_task(mut task: Task) -> Result<Task, String> {
    if task.name.trim().is_empty() {
        return Err("Дайте задаче название".into());
    }
    if task.id.is_empty() {
        let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        task.id = format!("task-{:x}", ms);
    }
    if !valid_id(&task.id) {
        return Err("Недопустимый идентификатор задачи".into());
    }
    register(&task)?;
    task.registered = true;
    let mut tasks: Vec<Task> = load("tasks.json");
    match tasks.iter_mut().find(|t| t.id == task.id) {
        Some(t) => *t = task.clone(),
        None => tasks.push(task.clone()),
    }
    save("tasks.json", &tasks)?;
    Ok(task)
}

pub fn delete_task(id: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err("Недопустимый идентификатор задачи".into());
    }
    if is_registered(id) {
        schtasks(&["/Delete", "/F", "/TN", &task_name(id)])?;
    }
    let mut tasks: Vec<Task> = load("tasks.json");
    tasks.retain(|t| t.id != id);
    save("tasks.json", &tasks)
}

pub fn run_task_now(id: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err("Недопустимый идентификатор задачи".into());
    }
    schtasks(&["/Run", "/TN", &task_name(id)])
}

pub fn runs() -> Vec<RunLog> {
    let mut v: Vec<RunLog> = load("runs.json");
    v.reverse();
    v
}

fn drive_samples() -> Vec<DriveSample> {
    winutil::list_drives()
        .into_iter()
        .filter(|d| d.kind == "fixed")
        .map(|d| DriveSample { root: d.root, total: d.total, free: d.free })
        .collect()
}

/// Добавляет точку в историю свободного места (не чаще раза в `min_gap` секунд).
pub fn record_history(min_gap: i64) {
    let mut h: Vec<Sample> = load("history.json");
    let now = winutil::now_unix();
    if h.last().map(|s| now - s.t < min_gap).unwrap_or(false) {
        return;
    }
    h.push(Sample { t: now, drives: drive_samples() });
    if h.len() > 3000 {
        let cut = h.len() - 3000;
        h.drain(..cut);
    }
    let _ = save("history.json", &h);
}

pub fn history() -> Vec<Sample> {
    load("history.json")
}

/// Регистрирует имя приложения для уведомлений (HKCU, права администратора не нужны).
pub fn register_app_id() {
    let key = wide(&format!("Software\\Classes\\AppUserModelId\\{}", APP_ID));
    let mut hkey: HKEY = null_mut();
    unsafe {
        // KEY_WRITE = 0x20006
        if RegCreateKeyExW(HKEY_CURRENT_USER, key.as_ptr(), 0, null(), 0, 0x20006, null(), &mut hkey, null_mut()) != 0 {
            return;
        }
        let name = wide("DisplayName");
        let value = wide("Space Commander");
        RegSetValueExW(hkey, name.as_ptr(), 0, 1, value.as_ptr() as *const u8, (value.len() * 2) as u32);
        RegCloseKey(hkey);
    }
}

pub fn toast(title: &str, text: &str) {
    register_app_id();
    let _ = tauri_winrt_notification::Toast::new(APP_ID).title(title).text1(text).show();
}

fn human(bytes: u64) -> String {
    const U: [&str; 5] = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
    let mut v = bytes as f64;
    let mut i = 0;
    while v >= 1024.0 && i < 4 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{} {}", bytes, U[0])
    } else {
        format!("{:.1} {}", v, U[i]).replace('.', ",")
    }
}

/// Выполняет задачу без окна. Возвращает код завершения процесса.
pub fn run_headless(id: &str) -> i32 {
    let tasks: Vec<Task> = load("tasks.json");
    let known = tasks.len();
    let Some(task) = tasks.into_iter().find(|t| t.id == id) else {
        log_line(&format!(
            "задача {:?} не найдена: в {} задач: {}; аргументы: {:?}",
            id,
            data_dir().join("tasks.json").display(),
            known,
            std::env::args().collect::<Vec<_>>()
        ));
        return 2;
    };
    let missing: Vec<&str> = ["LOCALAPPDATA", "APPDATA", "USERPROFILE", "TEMP", "WINDIR"]
        .into_iter()
        .filter(|v| std::env::var(v).map(|s| s.is_empty()).unwrap_or(true))
        .collect();
    if !missing.is_empty() {
        log_line(&format!("задача {}: в окружении нет переменных {:?} — часть правил будет пропущена", id, missing));
    }
    let report = junk::clean(&task.rules, |_, _, _| {});
    log_line(&format!("задача {}: освобождено {} Б, файлов {}, пропущено {}", id, report.freed, report.files, report.failed));
    record_history(0);
    let drives = drive_samples();
    let mut note = String::new();
    if !report.errors.is_empty() {
        note = report.errors.iter().take(3).cloned().collect::<Vec<_>>().join("; ");
    }
    let mut log: Vec<RunLog> = load("runs.json");
    log.push(RunLog {
        task_id: task.id.clone(),
        task_name: task.name.clone(),
        at: winutil::now_unix(),
        freed: report.freed,
        files: report.files,
        failed: report.failed,
        note,
        drives: drives.clone(),
    });
    if log.len() > 300 {
        let cut = log.len() - 300;
        log.drain(..cut);
    }
    let _ = save("runs.json", &log);

    if task.notify && (report.freed > 0 || !task.rules.is_empty()) {
        toast(&task.name, &format!("Освобождено {} · удалено файлов: {}", human(report.freed), report.files));
    }
    if task.low_space_pct > 0 {
        for d in &drives {
            let pct = d.free as f64 / d.total.max(1) as f64 * 100.0;
            if pct < task.low_space_pct as f64 {
                toast(
                    &format!("На диске {} заканчивается место", d.root.trim_end_matches('\\')),
                    &format!("Свободно {} ({:.0}%)", human(d.free), pct),
                );
            }
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(kind: &str) -> Task {
        Task {
            id: "task-1".into(),
            name: "Ночная <уборка> & \"кеши\"".into(),
            kind: kind.into(),
            time: "03:30".into(),
            weekday: 7,
            monthday: 15,
            rules: vec!["user-temp".into()],
            enabled: true,
            ..Default::default()
        }
    }

    #[test]
    fn xml_for_each_schedule() {
        let d = task_xml(&sample("daily"), r"C:\Program Files\Space Commander\app.exe", r"PC\me").unwrap();
        assert!(d.contains("<DaysInterval>1</DaysInterval>"));
        assert!(d.contains("2026-01-01T03:30:00"));
        assert!(d.contains("<Command>C:\\Program Files\\Space Commander\\app.exe</Command>"));
        assert!(d.contains("<Arguments>--run-task task-1</Arguments>"));
        assert!(d.contains("&lt;уборка&gt; &amp; &quot;кеши&quot;"));
        assert!(d.contains("LeastPrivilege"));
        assert!(task_xml(&sample("weekly"), "x", "u").unwrap().contains("<Sunday />"));
        assert!(task_xml(&sample("monthly"), "x", "u").unwrap().contains("<Day>15</Day>"));
    }

    #[test]
    fn rejects_bad_input() {
        let mut t = sample("daily");
        t.time = "25:00".into();
        assert!(task_xml(&t, "x", "u").is_err());
        let mut t = sample("monthly");
        t.monthday = 31;
        assert!(task_xml(&t, "x", "u").is_err());
        assert!(task_xml(&sample("hourly"), "x", "u").is_err());
        assert!(!valid_id("../evil"));
        assert!(valid_id("task-18f"));
    }

    #[test]
    fn human_sizes() {
        assert_eq!(human(512), "512 Б");
        assert_eq!(human(1536), "1,5 КБ");
        assert_eq!(human(3 * 1024 * 1024 * 1024), "3,0 ГБ");
    }
}
