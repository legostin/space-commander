import { getLang, plural, t } from "./i18n";

export { plural };

const UNITS_RU = ["Б", "КБ", "МБ", "ГБ", "ТБ", "ПБ"];
const UNITS_EN = ["B", "KB", "MB", "GB", "TB", "PB"];
const en = () => getLang() === "en";
const locale = () => (en() ? "en-US" : "ru-RU");
const dec = (s: string) => (en() ? s : s.replace(".", ","));

/** 1536 → «1,5 КБ». Три значащие цифры, запятая как десятичный разделитель. */
export function fmtBytes(bytes: number): string {
  const [v, u] = splitBytes(bytes);
  return `${v} ${u}`;
}

export function splitBytes(bytes: number): [string, string] {
  const units = en() ? UNITS_EN : UNITS_RU;
  if (!isFinite(bytes) || bytes <= 0) return ["0", units[0]];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = i === 0 ? 0 : v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return [dec(v.toFixed(digits)), units[i]];
}

/** Изменение размера со знаком: «+6,2 ГБ», «−1,1 ГБ». */
export function fmtDelta(bytes: number): string {
  return `${bytes < 0 ? "−" : "+"}${fmtBytes(Math.abs(bytes))}`;
}

export function fmtNum(n: number): string {
  return new Intl.NumberFormat(locale()).format(Math.round(n));
}

/** Короткое число: 1 928 468 → «1,9 млн». */
export function fmtCount(n: number): string {
  if (n >= 1e6) return `${dec((n / 1e6).toFixed(1))} ${en() ? "M" : "млн"}`;
  if (n >= 1e4) return `${Math.round(n / 1e3)} ${en() ? "K" : "тыс."}`;
  return fmtNum(n);
}

export function fmtPct(part: number, total: number, digits = 1): string {
  if (total <= 0) return "0%";
  const p = (part / total) * 100;
  if (p > 0 && p < 0.1) return `<${dec("0.1")}%`;
  return `${dec(p.toFixed(digits))}%`;
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ${t("мс")}`;
  const s = ms / 1000;
  if (s < 60) return `${dec(s.toFixed(1))} ${t("с")}`;
  const m = Math.floor(s / 60);
  return `${m} ${t("мин")} ${Math.round(s - m * 60)} ${t("с")}`;
}

/** Unix-секунды → «3 дня назад». */
export function fmtAgo(unix: number): string {
  if (!unix) return "—";
  const s = Math.max(0, Date.now() / 1000 - unix);
  if (s < 60) return t("только что");
  const ago = (n: number, one: string, few: string, many: string) => t("{0} назад", `${n} ${plural(n, one, few, many)}`);
  const m = Math.floor(s / 60);
  if (m < 60) return ago(m, "минуту", "минуты", "минут");
  const h = Math.floor(m / 60);
  if (h < 24) return ago(h, "час", "часа", "часов");
  const d = Math.floor(h / 24);
  if (d < 31) return ago(d, "день", "дня", "дней");
  const mo = Math.floor(d / 30.44);
  if (mo < 12) return ago(mo, "месяц", "месяца", "месяцев");
  const y = Math.floor(d / 365.25);
  return ago(y, "год", "года", "лет");
}

export function fmtDate(unix: number): string {
  if (!unix) return "—";
  return new Date(unix * 1000).toLocaleDateString(locale(), { day: "numeric", month: "short", year: "numeric" });
}

export function fmtDateTime(unix: number): string {
  if (!unix) return "—";
  return new Date(unix * 1000).toLocaleString(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export interface Category {
  name: string;
  color: string;
}

/** Категории файлов — те же номера, что в categories.rs. */
const CATS: Record<number, Category> = {
  0: { name: "Прочее", color: "#6b7391" },
  1: { name: "Видео", color: "#f0689a" },
  2: { name: "Аудио", color: "#b98cf5" },
  3: { name: "Изображения", color: "#f5b942" },
  4: { name: "Архивы и пакеты", color: "#f58a4b" },
  5: { name: "Документы", color: "#5b9df5" },
  6: { name: "Код и сборка", color: "#3fcf8e" },
  7: { name: "Программы", color: "#ef6461" },
  8: { name: "Образы дисков", color: "#31c6d8" },
  9: { name: "Системные и временные", color: "#8f9bb8" },
  10: { name: "Данные и ресурсы", color: "#a3d55d" },
  100: { name: "Папка", color: "#4a5272" },
  255: { name: "Мелкие объекты", color: "#3a4059" },
};

export function catOf(cat: number): Category {
  const c = CATS[cat] ?? CATS[0];
  return { name: t(c.name), color: c.color };
}

export const F_DIR = 1,
  F_REPARSE = 2,
  F_HIDDEN = 4,
  F_SYSTEM = 8,
  F_COMPRESSED = 16,
  F_DENIED = 32,
  F_CLOUD = 64;

export const REST_ID = 4294967295;
