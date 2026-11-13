//! Язык сообщений ядра. Интерфейс сообщает выбор командой `set_language`; фоновые
//! задачи читают его из сохранённых настроек.

use std::sync::atomic::{AtomicBool, Ordering::Relaxed};

static ENGLISH: AtomicBool = AtomicBool::new(false);

pub fn set_english(on: bool) {
    ENGLISH.store(on, Relaxed);
}

pub fn is_english() -> bool {
    ENGLISH.load(Relaxed)
}

/// Возвращает русский или английский вариант строки.
pub fn tr<'a>(ru: &'a str, en: &'a str) -> &'a str {
    if is_english() {
        en
    } else {
        ru
    }
}
