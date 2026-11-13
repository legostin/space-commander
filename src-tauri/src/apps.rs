//! Установленные игры и программы: Steam, Epic Games, GOG и всё, что записало себя
//! в список «Программы и компоненты». Только чтение реестра и файлов описаний.

use crate::winutil::{from_wide, wide};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use windows_sys::Win32::System::Registry::{RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

const KEY_READ: u32 = 0x20019;
const KEY_WOW64_64KEY: u32 = 0x0100;
const KEY_WOW64_32KEY: u32 = 0x0200;

#[derive(Serialize, Clone, Debug, Default)]
pub struct InstalledApp {
    pub name: String,
    /// steam | epic | gog | program
    pub source: String,
    pub path: String,
    pub publisher: String,
    /// Размер по данным магазина или реестра (0 — неизвестен).
    pub reported_size: u64,
    /// Когда последний раз запускали (известно только для Steam).
    pub last_played: i64,
    /// Адрес штатного удаления (`steam://uninstall/…`) или пусто.
    pub uninstall: String,
    // Заполняется по результатам сканирования диска:
    pub size: u64,
    pub alloc: u64,
    pub mtime: i64,
    pub node: Option<u32>,
    pub root: String,
}

struct Key(HKEY);
impl Drop for Key {
    fn drop(&mut self) {
        unsafe { RegCloseKey(self.0) };
    }
}

impl Key {
    fn open(root: HKEY, path: &str, view: u32) -> Option<Key> {
        let w = wide(path);
        let mut h: HKEY = null_mut();
        let r = unsafe { RegOpenKeyExW(root, w.as_ptr(), 0, KEY_READ | view, &mut h) };
        (r == 0).then_some(Key(h))
    }

    fn subkeys(&self) -> Vec<String> {
        let mut out = Vec::new();
        let mut i = 0u32;
        loop {
            let mut name = [0u16; 256];
            let mut len = name.len() as u32;
            let r = unsafe { RegEnumKeyExW(self.0, i, name.as_mut_ptr(), &mut len, null(), null_mut(), null_mut(), null_mut()) };
            if r != 0 {
                break;
            }
            out.push(String::from_utf16_lossy(&name[..len as usize]));
            i += 1;
        }
        out
    }

    fn raw(&self, name: &str) -> Option<(u32, Vec<u8>)> {
        let w = wide(name);
        let mut ty = 0u32;
        let mut size = 0u32;
        if unsafe { RegQueryValueExW(self.0, w.as_ptr(), null(), &mut ty, null_mut(), &mut size) } != 0 || size > 64 * 1024 {
            return None;
        }
        let mut buf = vec![0u8; size as usize + 2];
        let mut size2 = size;
        if unsafe { RegQueryValueExW(self.0, w.as_ptr(), null(), &mut ty, buf.as_mut_ptr(), &mut size2) } != 0 {
            return None;
        }
        buf.truncate(size2 as usize);
        Some((ty, buf))
    }

    fn string(&self, name: &str) -> Option<String> {
        let (ty, buf) = self.raw(name)?;
        if ty != 1 && ty != 2 {
            return None; // REG_SZ / REG_EXPAND_SZ
        }
        let w: Vec<u16> = buf.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        let s = from_wide(&w).trim().to_string();
        (!s.is_empty()).then_some(s)
    }

    fn dword(&self, name: &str) -> Option<u32> {
        let (ty, buf) = self.raw(name)?;
        (ty == 4 && buf.len() >= 4).then(|| u32::from_le_bytes(buf[..4].try_into().unwrap()))
    }
}

/// Значение ключа из текстового формата Valve (`"key"   "value"`), первое вхождение.
pub fn vdf_value(text: &str, key: &str) -> Option<String> {
    vdf_values(text, key).into_iter().next()
}

pub fn vdf_values(text: &str, key: &str) -> Vec<String> {
    let needle = format!("\"{}\"", key.to_lowercase());
    let lower = text.to_lowercase();
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(pos) = lower[from..].find(&needle) {
        let after = from + pos + needle.len();
        from = after;
        let rest = &text[after..];
        let trimmed = rest.trim_start_matches([' ', '\t']);
        let Some(body) = trimmed.strip_prefix('"') else { continue };
        let mut val = String::new();
        let mut chars = body.chars();
        while let Some(c) = chars.next() {
            match c {
                '\\' => {
                    if let Some(n) = chars.next() {
                        val.push(n);
                    }
                }
                '"' => break,
                _ => val.push(c),
            }
        }
        out.push(val);
    }
    out
}

fn norm(path: &str) -> String {
    path.replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

fn steam_root() -> Option<PathBuf> {
    let from_reg = Key::open(HKEY_CURRENT_USER, r"Software\Valve\Steam", 0)
        .and_then(|k| k.string("SteamPath"))
        .or_else(|| Key::open(HKEY_LOCAL_MACHINE, r"SOFTWARE\Valve\Steam", KEY_WOW64_32KEY).and_then(|k| k.string("InstallPath")));
    let candidates = [from_reg.map(|s| PathBuf::from(s.replace('/', "\\"))), std::env::var("ProgramFiles(x86)").ok().map(|p| PathBuf::from(p).join("Steam"))];
    candidates.into_iter().flatten().find(|p| p.join("steamapps").is_dir())
}

fn steam_apps() -> Vec<InstalledApp> {
    let Some(root) = steam_root() else { return vec![] };
    let mut libs: Vec<PathBuf> = vec![root.clone()];
    if let Ok(text) = std::fs::read_to_string(root.join("steamapps").join("libraryfolders.vdf")) {
        for p in vdf_values(&text, "path") {
            let p = PathBuf::from(p);
            if !libs.iter().any(|l| norm(&l.to_string_lossy()) == norm(&p.to_string_lossy())) {
                libs.push(p);
            }
        }
    }
    let mut out = Vec::new();
    for lib in libs {
        let apps = lib.join("steamapps");
        let Ok(rd) = std::fs::read_dir(&apps) else { continue };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.starts_with("appmanifest_") || !name.ends_with(".acf") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(e.path()) else { continue };
            let (Some(title), Some(dir), Some(appid)) = (vdf_value(&text, "name"), vdf_value(&text, "installdir"), vdf_value(&text, "appid")) else { continue };
            let path = apps.join("common").join(&dir);
            if !path.is_dir() || !appid.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            // Служебные пакеты (Steamworks Redistributables и т.п.) — не игры.
            if title.contains("Steamworks Common") || title.starts_with("Proton ") || title.starts_with("Steam Linux Runtime") {
                continue;
            }
            out.push(InstalledApp {
                name: title,
                source: "steam".into(),
                path: path.to_string_lossy().to_string(),
                publisher: "Steam".into(),
                reported_size: vdf_value(&text, "SizeOnDisk").and_then(|s| s.parse().ok()).unwrap_or(0),
                last_played: vdf_value(&text, "LastPlayed").and_then(|s| s.parse().ok()).unwrap_or(0),
                uninstall: format!("steam://uninstall/{}", appid),
                ..Default::default()
            });
        }
    }
    out
}

fn epic_apps() -> Vec<InstalledApp> {
    let base = std::env::var("PROGRAMDATA").unwrap_or_default();
    let dir = Path::new(&base).join("Epic").join("EpicGamesLauncher").join("Data").join("Manifests");
    let Ok(rd) = std::fs::read_dir(dir) else { return vec![] };
    let mut out = Vec::new();
    for e in rd.flatten() {
        if e.path().extension().and_then(|x| x.to_str()) != Some("item") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(e.path()) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        let (Some(name), Some(path)) = (v["DisplayName"].as_str(), v["InstallLocation"].as_str()) else { continue };
        if !Path::new(path).is_dir() {
            continue;
        }
        out.push(InstalledApp {
            name: name.to_string(),
            source: "epic".into(),
            path: path.replace('/', "\\"),
            publisher: "Epic Games".into(),
            reported_size: v["InstallSize"].as_u64().unwrap_or(0),
            ..Default::default()
        });
    }
    out
}

fn gog_apps() -> Vec<InstalledApp> {
    let Some(games) = Key::open(HKEY_LOCAL_MACHINE, r"SOFTWARE\GOG.com\Games", KEY_WOW64_32KEY) else { return vec![] };
    let mut out = Vec::new();
    for id in games.subkeys() {
        let Some(k) = Key::open(HKEY_LOCAL_MACHINE, &format!(r"SOFTWARE\GOG.com\Games\{}", id), KEY_WOW64_32KEY) else { continue };
        let (Some(name), Some(path)) = (k.string("gameName").or_else(|| k.string("GAMENAME")), k.string("path").or_else(|| k.string("PATH"))) else { continue };
        // Дополнения лежат в папке основной игры — отдельной строкой не показываем.
        if k.string("dependsOn").is_some() || !Path::new(&path).is_dir() {
            continue;
        }
        out.push(InstalledApp { name, source: "gog".into(), path, publisher: "GOG".into(), ..Default::default() });
    }
    out
}

fn registry_programs() -> Vec<InstalledApp> {
    const UNINSTALL: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";
    let mut out = Vec::new();
    for (root, view) in [(HKEY_LOCAL_MACHINE, KEY_WOW64_64KEY), (HKEY_LOCAL_MACHINE, KEY_WOW64_32KEY), (HKEY_CURRENT_USER, 0)] {
        let Some(base) = Key::open(root, UNINSTALL, view) else { continue };
        for sub in base.subkeys() {
            let Some(k) = Key::open(root, &format!("{}\\{}", UNINSTALL, sub), view) else { continue };
            let (Some(name), Some(path)) = (k.string("DisplayName"), k.string("InstallLocation")) else { continue };
            if k.dword("SystemComponent") == Some(1) || k.string("ParentKeyName").is_some() {
                continue;
            }
            let path = path.trim_matches('"').trim_end_matches('\\').to_string();
            if path.split('\\').filter(|c| !c.is_empty()).count() < 3 || !Path::new(&path).is_dir() {
                continue; // C:\Program Files и подобное — не папка программы
            }
            out.push(InstalledApp {
                name,
                source: "program".into(),
                path,
                publisher: k.string("Publisher").unwrap_or_default(),
                reported_size: k.dword("EstimatedSize").unwrap_or(0) as u64 * 1024,
                ..Default::default()
            });
        }
    }
    out
}

/// Все найденные игры и программы без повторов: одна папка — одна строка.
pub fn list() -> Vec<InstalledApp> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for app in steam_apps().into_iter().chain(epic_apps()).chain(gog_apps()).chain(registry_programs()) {
        if seen.insert(norm(&app.path)) {
            out.push(app);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valve_format() {
        let acf = "\"AppState\"\n{\n\t\"appid\"\t\t\"1245620\"\n\t\"name\"\t\t\"ELDEN \\\"RING\\\"\"\n\t\"installdir\"\t\t\"ELDEN RING\"\n\t\"SizeOnDisk\"\t\t\"51234567890\"\n\t\"UserConfig\"\n\t{\n\t\t\"name\"\t\t\"other\"\n\t}\n}";
        assert_eq!(vdf_value(acf, "appid").unwrap(), "1245620");
        assert_eq!(vdf_value(acf, "name").unwrap(), "ELDEN \"RING\"");
        assert_eq!(vdf_value(acf, "sizeondisk").unwrap(), "51234567890");
        assert_eq!(vdf_value(acf, "UserConfig"), None, "у вложенного блока нет строкового значения");
        let libs = "\"libraryfolders\"\n{\n\t\"0\"\n\t{\n\t\t\"path\"\t\t\"C:\\\\Program Files (x86)\\\\Steam\"\n\t}\n\t\"1\"\n\t{\n\t\t\"path\"\t\t\"D:\\\\Games\"\n\t}\n}";
        assert_eq!(vdf_values(libs, "path"), ["C:\\Program Files (x86)\\Steam", "D:\\Games"]);
        assert_eq!(norm("C:/Games/Foo/"), "c:\\games\\foo");
    }

    #[test]
    fn lists_without_duplicates() {
        // Реестр читается по-настоящему: проверяем только инварианты.
        let apps = list();
        let mut paths: Vec<String> = apps.iter().map(|a| norm(&a.path)).collect();
        let n = paths.len();
        paths.sort();
        paths.dedup();
        assert_eq!(n, paths.len());
        assert!(apps.iter().all(|a| !a.name.is_empty() && Path::new(&a.path).is_dir()));
    }
}
