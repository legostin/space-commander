// Двуязычный интерфейс. Ключ перевода — сама русская строка: код остаётся читаемым,
// а отсутствующий перевод просто показывает русский текст.
import { EN, EN_PLURALS } from "./en";

export type Lang = "ru" | "en";

function initial(): Lang {
  try {
    const saved = localStorage.getItem("sc.lang");
    if (saved === "ru" || saved === "en") return saved;
  } catch {
    /* нет доступа к хранилищу — определяем по системе */
  }
  return typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("ru") ? "ru" : "en";
}

let lang: Lang = initial();

export function getLang(): Lang {
  return lang;
}

export function setLang(next: Lang) {
  lang = next;
  try {
    localStorage.setItem("sc.lang", next);
  } catch {
    /* выбор не сохранится между запусками */
  }
  document.documentElement.lang = next;
}

/** Перевод строки. `{0}`, `{1}` заменяются аргументами. */
export function t(s: string, ...args: (string | number)[]): string {
  let r = lang === "en" ? (EN[s] ?? s) : s;
  for (let i = 0; i < args.length; i++) r = r.split(`{${i}}`).join(String(args[i]));
  return r;
}

/** Форма слова по числу: «1 файл, 2 файла, 5 файлов» / «1 file, 2 files». */
export function plural(n: number, one: string, few: string, many: string): string {
  if (lang === "en") {
    const forms = EN_PLURALS[many];
    if (forms) return Math.abs(n) === 1 ? forms[0] : forms[1];
  }
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
