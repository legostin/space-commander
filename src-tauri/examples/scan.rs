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
    let top = t.top_files(0, 5, true);
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
        _ => println!("режимы: walk <путь> | mft <буква> | junk"),
    }
}
