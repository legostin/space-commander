//! Тонкие обёртки над Win32: строки, диски, права, перезапуск с повышением.

use serde::Serialize;
use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::process::CommandExt;
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::Security::{
    GetTokenInformation, TokenElevation, TokenElevationType, TOKEN_ELEVATION, TOKEN_QUERY,
};
use windows_sys::Win32::Storage::FileSystem::{
    GetDiskFreeSpaceExW, GetDiskFreeSpaceW, GetDriveTypeW, GetLogicalDrives, GetVolumeInformationW,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows_sys::Win32::UI::Shell::ShellExecuteW;

pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

pub fn from_wide(buf: &[u16]) -> String {
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len])
}

/// `C:\foo` → `\\?\C:\foo` — снимает ограничение в 260 символов.
pub fn extended(path: &str) -> String {
    if path.starts_with(r"\\?\") {
        path.to_string()
    } else if let Some(rest) = path.strip_prefix(r"\\") {
        format!(r"\\?\UNC\{}", rest)
    } else {
        format!(r"\\?\{}", path)
    }
}

pub fn filetime_to_unix(ft: u64) -> i64 {
    if ft == 0 {
        0
    } else {
        (ft as i64 - 116_444_736_000_000_000) / 10_000_000
    }
}

pub fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn token_u32(class: i32) -> Option<u32> {
    unsafe {
        let mut token: HANDLE = null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return None;
        }
        let mut value: u32 = 0;
        let mut ret = 0u32;
        let ok = GetTokenInformation(
            token,
            class,
            &mut value as *mut u32 as *mut _,
            std::mem::size_of::<u32>() as u32,
            &mut ret,
        );
        CloseHandle(token);
        if ok != 0 {
            Some(value)
        } else {
            None
        }
    }
}

/// Процесс запущен с полными правами администратора.
pub fn is_elevated() -> bool {
    debug_assert_eq!(std::mem::size_of::<TOKEN_ELEVATION>(), 4);
    token_u32(TokenElevation).map(|v| v != 0).unwrap_or(false)
}

/// 1 — обычный токен (UAC выключен или пользователь не админ), 2 — полный, 3 — урезанный
/// (пользователь входит в «Администраторы», но процесс работает без повышения).
pub fn elevation_type() -> u32 {
    token_u32(TokenElevationType).unwrap_or(1)
}

#[derive(Serialize, Clone, Debug)]
pub struct DriveInfo {
    pub root: String,
    pub letter: String,
    pub label: String,
    pub fs: String,
    pub kind: String,
    pub total: u64,
    pub free: u64,
    pub cluster: u32,
}

pub fn cluster_size(root: &str) -> u32 {
    let w = wide(root);
    let (mut spc, mut bps, mut fc, mut tc) = (0u32, 0u32, 0u32, 0u32);
    let ok = unsafe { GetDiskFreeSpaceW(w.as_ptr(), &mut spc, &mut bps, &mut fc, &mut tc) };
    if ok != 0 && spc > 0 && bps > 0 {
        spc * bps
    } else {
        4096
    }
}

/// Корень тома для произвольного пути: `C:\Users\x` → `C:\`.
pub fn volume_root(path: &str) -> String {
    let b = path.as_bytes();
    if b.len() >= 2 && b[1] == b':' {
        format!("{}:\\", (b[0] as char).to_ascii_uppercase())
    } else {
        path.to_string()
    }
}

pub fn list_drives() -> Vec<DriveInfo> {
    let mask = unsafe { GetLogicalDrives() };
    let mut out = Vec::new();
    for i in 0..26u32 {
        if mask & (1 << i) == 0 {
            continue;
        }
        let letter = (b'A' + i as u8) as char;
        let root = format!("{}:\\", letter);
        let w = wide(&root);
        let dtype = unsafe { GetDriveTypeW(w.as_ptr()) };
        let kind = match dtype {
            2 => "removable",
            3 => "fixed",
            4 => "network",
            5 => "cdrom",
            6 => "ram",
            _ => continue,
        };
        let mut label = [0u16; 261];
        let mut fs = [0u16; 261];
        let ok = unsafe {
            GetVolumeInformationW(
                w.as_ptr(),
                label.as_mut_ptr(),
                label.len() as u32,
                null_mut(),
                null_mut(),
                null_mut(),
                fs.as_mut_ptr(),
                fs.len() as u32,
            )
        };
        if ok == 0 {
            continue; // нет носителя
        }
        let (mut avail, mut total, mut free) = (0u64, 0u64, 0u64);
        let ok = unsafe { GetDiskFreeSpaceExW(w.as_ptr(), &mut avail, &mut total, &mut free) };
        if ok == 0 || total == 0 {
            continue;
        }
        out.push(DriveInfo {
            cluster: cluster_size(&root),
            root,
            letter: letter.to_string(),
            label: from_wide(&label),
            fs: from_wide(&fs),
            kind: kind.to_string(),
            total,
            free,
        });
    }
    out
}

/// Перезапускает приложение через UAC («runas»). Текущий процесс должен завершиться сам.
pub fn relaunch_elevated(args: &str) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_w = wide(&exe.to_string_lossy());
    let verb = wide("runas");
    let args_w = wide(args);
    let r = unsafe {
        ShellExecuteW(
            null_mut(),
            verb.as_ptr(),
            exe_w.as_ptr(),
            if args.is_empty() { null() } else { args_w.as_ptr() },
            null(),
            1, // SW_SHOWNORMAL
        )
    };
    if (r as isize) > 32 {
        Ok(())
    } else {
        Err("Повышение прав отменено или не удалось".to_string())
    }
}

pub fn reveal_in_explorer(path: &str) -> Result<(), String> {
    std::process::Command::new("explorer.exe")
        .raw_arg(format!("/select,\"{}\"", path))
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Открывает файл, папку или URI (`ms-settings:…`) приложением по умолчанию.
pub fn shell_open(target: &str) -> Result<(), String> {
    let verb = wide("open");
    let t = wide(target);
    let r = unsafe { ShellExecuteW(null_mut(), verb.as_ptr(), t.as_ptr(), null(), null(), 1) };
    if (r as isize) > 32 {
        Ok(())
    } else {
        Err(format!("Не удалось открыть: {}", target))
    }
}

/// Отправляет файлы и папки в Корзину (можно восстановить).
pub fn recycle(paths: &[&str]) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::{SHFileOperationW, SHFILEOPSTRUCTW};
    // Список путей: каждый завершается нулём, в конце — ещё один ноль.
    let mut from: Vec<u16> = Vec::new();
    for p in paths {
        from.extend(OsStr::new(p).encode_wide());
        from.push(0);
    }
    from.push(0);
    let mut op: SHFILEOPSTRUCTW = unsafe { std::mem::zeroed() };
    op.wFunc = 3; // FO_DELETE
    op.pFrom = from.as_ptr();
    // FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI | FOF_WANTNUKEWARNING:
    // если объект не помещается в Корзину, Windows спросит сама, а не удалит молча.
    op.fFlags = (0x40 | 0x10 | 0x4 | 0x400 | 0x4000) as u16;
    let r = unsafe { SHFileOperationW(&mut op) };
    if r != 0 {
        Err(format!("Не удалось переместить в Корзину (код 0x{:X})", r))
    } else if op.fAnyOperationsAborted != 0 {
        Err("Удаление отменено".into())
    } else {
        Ok(())
    }
}

pub fn user_name() -> String {
    let user = std::env::var("USERNAME").unwrap_or_default();
    match std::env::var("USERDOMAIN") {
        Ok(d) if !d.is_empty() => format!("{}\\{}", d, user),
        _ => user,
    }
}

/// Простой glob: `*` — любая последовательность символов. Регистр не учитывается.
pub fn wild_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let t: Vec<char> = text.to_lowercase().chars().collect();
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star, mut mark) = (usize::MAX, 0usize);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == t[ti] || p[pi] == '?') {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = pi;
            mark = ti;
            pi += 1;
        } else if star != usize::MAX {
            pi = star + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob() {
        assert!(wild_match("*.ISO", "ubuntu.iso"));
        assert!(wild_match("thumbcache_*.db", "thumbcache_256.db"));
        assert!(!wild_match("*.iso", "ubuntu.iso.part"));
        assert!(wild_match("Profile *", "Profile 3"));
        assert!(wild_match("*", ""));
    }

    #[test]
    fn ext_path() {
        assert_eq!(extended(r"C:\a"), r"\\?\C:\a");
        assert_eq!(extended(r"\\srv\share\a"), r"\\?\UNC\srv\share\a");
        assert_eq!(volume_root(r"c:\Users"), "C:\\");
    }
}
