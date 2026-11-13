//! Английские тексты правил очистки. Русские тексты — в junk.rs рядом с самими правилами;
//! здесь только перевод по идентификатору правила.

use crate::junk::Rule;

const WHY_WINDIR: &str = "The folder belongs to the system: only administrators and Windows itself can read and delete in it.";
const WHY_PROGRAMDATA: &str = "This is data shared by all users; Windows lets only administrators change it.";
const WHY_SVI: &str = "The folder is accessible to the system only: its size is visible with administrator rights.";

/// (название, описание, подсказка)
fn text(id: &str) -> Option<(&'static str, &'static str, &'static str)> {
    Some(match id {
        "user-temp" => ("User temporary files", "Files that programs create while running and often forget to remove. Only items older than a day are deleted; files in use are skipped.", ""),
        "win-temp" => ("Windows temporary files", "The shared temporary folder of the system and installers. Only items older than a day are deleted.", ""),
        "win-update" => ("Downloaded Windows updates", "Update packages that are already installed. If an update is needed again, Windows downloads it again.", ""),
        "delivery-opt" => ("Delivery Optimization cache", "Copies of updates that Windows keeps to share with other computers on the network.", ""),
        "wer" => ("Error reports", "An archive of program crash reports that Windows collects to send to Microsoft.", ""),
        "wer-system" => ("System error reports", "The same for crashes of system services.", ""),
        "crash-dumps" => ("Program memory dumps", "Memory snapshots of crashed programs. Only developers need them to analyze a crash.", ""),
        "crash-dumps-system" => ("System memory dumps", "Memory snapshots taken after blue screens. They can be as large as the installed RAM.", ""),
        "thumbcache" => ("Explorer thumbnail cache", "Small copies of pictures and videos for previews. Explorer rebuilds them when folders are opened.", ""),
        "shader-cache" => ("Graphics shader cache", "Compiled DirectX, NVIDIA and AMD shaders. They are rebuilt the next time games start — the first launch may take a little longer.", ""),
        "win-logs" => ("Windows servicing logs", "Old component installation logs (CBS) and log archives.", ""),
        "recycle-bin" => ("Recycle Bin", "Deleted files that still take up space. After emptying, they can no longer be restored.", ""),
        "npm-cache" => ("npm cache", "Downloaded npm packages. They are fetched again on the next install.", ""),
        "yarn-cache" => ("Yarn cache", "Downloaded Yarn packages.", ""),
        "pnpm-store" => ("pnpm store", "The shared pnpm package store. Projects keep working, but new installs download packages again.", ""),
        "pip-cache" => ("pip and uv cache", "Downloaded and built Python packages.", ""),
        "cargo-cache" => ("Cargo cache", "Archives and unpacked sources of Rust dependencies. Cargo downloads what it needs on the next build.", ""),
        "gradle-cache" => ("Gradle and Maven cache", "Downloaded dependencies and build results for Java/Android. The next build will be slow.", ""),
        "nuget-cache" => ("NuGet cache", ".NET packages. Restored with dotnet restore.", ""),
        "go-cache" => ("Go build cache", "Intermediate Go compilation results.", ""),
        "playwright" => ("Playwright and Puppeteer browsers", "Separate browser copies for automated tests. Downloaded again by the install command.", ""),
        "electron-cache" => ("Electron and node-gyp build cache", "Downloaded Electron binaries and Node.js headers.", ""),
        "jetbrains-cache" => ("JetBrains caches and indexes", "IDE project indexes. After cleaning, the IDE re-indexes projects when they are opened.", ""),
        "vscode-cache" => ("VS Code extension cache", "Downloaded extension installers and logs.", ""),
        "hf-cache" => ("Hugging Face and PyTorch models", "Downloaded neural network models. They can take tens of gigabytes and are downloaded again when next used.", ""),
        "spotify" => ("Spotify", "Cache of music you listened to.", ""),
        "telegram" => ("Telegram Desktop", "Cache of viewed photos and videos. Messages and attachments stay in the cloud and load again.", ""),
        "steam" => ("Steam", "Cache of the built-in browser, shaders and unfinished downloads. Games and saves are not touched.", ""),
        "epic" => ("Epic Games Launcher", "Cache of the launcher's built-in browser.", ""),
        "firefox" => ("Firefox", "Page cache. Bookmarks, passwords and history are not touched.", ""),
        "old-installers" => ("Old installers in Downloads", "Installers and disk images that have been in Downloads for more than 90 days. The programs are most likely installed already.", ""),
        "hiberfil" => (
            "Hibernation file",
            "Windows saves memory here for hibernation and fast startup. Its size is about 40% of the installed RAM.",
            "Turned off with powercfg /h off in an administrator terminal. Hibernation and fast startup will no longer work.",
        ),
        "pagefile" => (
            "Page file",
            "An extension of RAM on disk. Windows manages its size by itself.",
            "The size is changed in Advanced system settings → Performance → Virtual memory. Reduce it only if you have RAM to spare.",
        ),
        "windows-old" => (
            "Previous Windows installation",
            "A copy of the system from before a major update, kept for rollback. Windows removes it by itself after 10 days.",
            "Removed the regular way: Settings → System → Storage → Temporary files → Previous Windows installation(s).",
        ),
        "docker-wsl" => (
            "Docker and WSL virtual disks",
            ".vhdx files grow with use and do not shrink by themselves, even when everything inside is deleted.",
            "First docker system prune -a, then wsl --shutdown and compacting the disk: Optimize-VHD or diskpart → compact vdisk.",
        ),
        "restore-points" => (
            "Restore points and shadow copies",
            "System snapshots for rolling back after failed updates and drivers. They live in the locked System Volume Information folder.",
            "Space limit and removal of old points: System Protection → pick the drive → Configure. Do not turn protection off completely — lowering the limit is enough.",
        ),
        "winsxs" => (
            "Windows component store (WinSxS)",
            "All versions of system files, kept for updates and repair. Most of it is hard links to files in Windows itself, so the real usage is lower than shown.",
            "Old component versions are removed by Dism /Online /Cleanup-Image /StartComponentCleanup in an administrator terminal, or by Disk Cleanup → Clean up system files.",
        ),
        _ => return None,
    })
}

/// Переводит правило на английский на месте.
pub fn apply(rule: &mut Rule) {
    if let Some((title, desc, hint)) = text(&rule.id) {
        rule.title = title.to_string();
        rule.desc = desc.to_string();
        if !hint.is_empty() {
            rule.hint = hint;
        }
    } else if rule.id.starts_with("chromium:") {
        rule.desc = if rule.category == "browsers" {
            "Cache of pages, scripts and graphics. Bookmarks, passwords, history and open tabs are not touched. It is better to close the browser before cleaning."
        } else {
            "Cache of the app's built-in browser: downloaded images, scripts, shaders. Settings and conversations are not touched. It is better to close the app before cleaning."
        }
        .to_string();
        rule.title = rule.title.replace("Яндекс Браузер", "Yandex Browser").replace("(веб-часть)", "(web part)");
    }
    if rule.needs_admin {
        rule.admin_reason = match rule.id.as_str() {
            "restore-points" => WHY_SVI,
            "wer-system" => WHY_PROGRAMDATA,
            _ => WHY_WINDIR,
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// У каждого встроенного правила должен быть английский текст.
    #[test]
    fn every_static_rule_is_translated() {
        for rule in crate::junk::static_rule_ids() {
            assert!(text(&rule).is_some(), "нет перевода для правила {}", rule);
        }
    }
}
