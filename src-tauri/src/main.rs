// В релизе не открываем консольное окно.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    space_commander_lib::run()
}
