//! Консольная проверка ядра без интерфейса:
//!   cargo run --release --example scan -- walk C:\
//!   cargo run --release --example scan -- mft C        (нужен терминал администратора)
//!   cargo run --release --example scan -- junk

use space_commander_lib::{junk, scan_mft, scan_walk, tree::Tree};

fn gb(b: u64) -> String {
    format!("{:.2} ГБ", b as f64 / (1u64 << 30) as f64)
}

fn report(t: &Tree) {
    let s = t.summary();
    println!(
        "режим={} время={} мс файлов={} папок={} размер={} на диске={} недоступно={}",
        s.mode, s.duration_ms, s.files, s.dirs, gb(s.size), gb(s.alloc), s.denied
    );
    println!("узлов={} имена={} МБ", t.nodes.len(), t.names.len() >> 20);
    println!("— крупнейшие папки в корне —");
    for c in t.dir_view(0, true).children.iter().take(12) {
        println!("  {:>12}  {:>9} файлов  {}", gb(c.alloc), c.files, c.name);
    }
    let started = std::time::Instant::now();
    let top = t.top_files(0, 5, true, 0);
    println!("— крупнейшие файлы ({} мс) —", started.elapsed().as_millis());
    for f in top {
        println!("  {:>12}  {}", gb(f.alloc), f.path);
    }
    let started = std::time::Instant::now();
    let sub = t.subtree(0, 8000, true);
    println!("поддерево для карты: {} узлов за {} мс", sub.len(), started.elapsed().as_millis());
    let started = std::time::Instant::now();
    let ext = t.ext_stats(0);
    println!("типов файлов: {} за {} мс", ext.len(), started.elapsed().as_millis());
    let started = std::time::Instant::now();
    let found = t.search(".dll", 5, true);
    println!("поиск «.dll»: {} совпадений за {} мс", found.total, started.elapsed().as_millis());
    println!("артефактов разработки: {}", t.dev_artifacts(20 << 20).len());
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).map(|s| s.as_str()).unwrap_or("walk");
    let progress = scan_walk::Progress::default();
    match mode {
        "walk" => match scan_walk::scan(args.get(2).map(|s| s.as_str()).unwrap_or("C:\\"), &progress) {
            Ok(t) => report(&t),
            Err(e) => println!("ошибка: {}", e),
        },
        "mft" => {
            let letter = args.get(2).and_then(|s| s.chars().next()).unwrap_or('C');
            match scan_mft::scan(letter, &progress) {
                Ok(t) => report(&t),
                Err(e) => println!("ошибка: {}", e),
            }
        }
        "junk" => {
            let started = std::time::Instant::now();
            let items = junk::scan();
            let total: u64 = items.iter().filter(|i| i.safety != "info").map(|i| i.size).sum();
            for i in &items {
                println!(
                    "  [{:8}] {:>10}  {:>7} ф.  {}{}",
                    i.safety,
                    gb(i.size),
                    i.files,
                    i.title,
                    if i.accessible { "" } else { "  (нет доступа)" }
                );
            }
            println!("найдено правил: {}, можно освободить: {}, время: {} мс", items.len(), gb(total), started.elapsed().as_millis());
        }
        "apps" => {
            let started = std::time::Instant::now();
            let apps = space_commander_lib::apps::list();
            println!("найдено: {} за {} мс", apps.len(), started.elapsed().as_millis());
            for src in ["steam", "epic", "gog", "program"] {
                let of: Vec<_> = apps.iter().filter(|a| a.source == src).collect();
                println!("— {}: {} —", src, of.len());
                for a in of.iter().take(6) {
                    println!("  {:>10}  played={}  {}  [{}]", gb(a.reported_size), a.last_played, a.name, a.path);
                }
            }
        }
        "cache" => {
            let t = scan_walk::scan(args.get(2).map(|s| s.as_str()).unwrap_or("C:\\"), &progress).expect("scan");
            let started = std::time::Instant::now();
            space_commander_lib::cache::save(&t).expect("save");
            println!("сохранение: {} мс", started.elapsed().as_millis());
            for f in std::fs::read_dir(space_commander_lib::cache::dir()).unwrap().flatten() {
                println!("  {} — {} МБ", f.file_name().to_string_lossy(), f.metadata().unwrap().len() >> 20);
            }
            let started = std::time::Instant::now();
            let mut back = space_commander_lib::cache::load_all();
            println!("загрузка: {} мс, деревьев {}", started.elapsed().as_millis(), back.len());
            let started = std::time::Instant::now();
            back[0].apply_filter(0);
            println!("пересчёт сумм: {} мс; совпало: {}", started.elapsed().as_millis(), back[0].nodes[0].alloc == t.nodes[0].alloc && back[0].nodes[0].files == t.nodes[0].files);
            let snap = space_commander_lib::snapshot::capture(&t);
            println!("снимок: {} записей, {} КБ JSON", snap.entries.len(), serde_json::to_string(&snap).unwrap().len() >> 10);
        }
        _ => println!("режимы: walk <путь> | mft <буква> | junk | apps | cache <путь>"),
    }
}
