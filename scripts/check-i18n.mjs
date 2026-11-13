// Проверка перевода.
//  1. Каждая русская строка интерфейса есть в src/locales/en.ts, а русского текста
//     прямо в разметке (мимо t()) нет.
//  2. Каждый остальной язык содержит ровно те же ключи, что и английский, с теми же
//     подстановками ({0}, {1}) и фрагментами в обратных кавычках.
//
//   node scripts/check-i18n.mjs            — отчёт по всем языкам
//   node scripts/check-i18n.mjs de         — только один язык
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SRC = join(import.meta.dirname, "..", "src");
const LOCALES = join(SRC, "locales");
const SKIP = new Set(["mock.ts"]);
const CYR = /[А-Яа-яЁё]/;
const only = process.argv[2];

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return p === LOCALES ? [] : files(p);
    return /\.tsx?$/.test(name) && !SKIP.has(name) ? [p] : [];
  });
}

/** Убирает комментарии, не трогая строки. */
function stripComments(src) {
  return src.replace(/("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str ?? "");
}

const keys = new Map(); // строка → файл
const pluralKeys = new Set();
const pluralForms = new Set();
const rawJsx = [];
for (const file of files(SRC)) {
  const rel = file.slice(SRC.length + 1);
  const src = stripComments(readFileSync(file, "utf8"));
  for (const m of src.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) {
    const value = JSON.parse(`"${m[1]}"`);
    // Служебные ключи вида t("@weekly") тоже переводятся.
    if (CYR.test(value) || /^@[a-z]+$/.test(value)) if (!keys.has(value)) keys.set(value, rel);
  }
  for (const m of src.matchAll(/plural\(\s*[^,]+,\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)"/g)) {
    pluralForms.add(m[1]).add(m[2]).add(m[3]);
    pluralKeys.add(m[3]);
  }
  // Русский текст между тегами, не обёрнутый в {t("…")}.
  const noStrings = src.replace(/"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');
  for (const m of noStrings.matchAll(/>([^<>{}]*[А-Яа-яЁё][^<>{}]*)</g)) rawJsx.push(`${rel}: ${m[1].trim().slice(0, 70)}`);
}

const locales = {};
for (const name of readdirSync(LOCALES)) {
  if (!name.endsWith(".ts") || name === "types.ts") continue;
  const mod = await import(pathToFileURL(join(LOCALES, name)).href);
  locales[mod.default.code] = mod.default;
}
const en = locales.en;

// Слова, которые остаются в коде как есть: формы для русского plural() и части русских фраз.
const EXEMPT = new Set(["понедельник", "вторник", "среду", "четверг", "пятницу", "субботу", "воскресенье", "Каждую", "Каждое", "Каждый"]);
let failed = false;
const say = (line) => console.log(line);

if (!only || only === "en") {
  const missing = [...keys.keys()].filter((k) => !(k in en.strings) && !EXEMPT.has(k) && !(pluralForms.has(k) && !k.startsWith("@")));
  const missingPlurals = [...pluralKeys].filter((k) => !(k in en.plurals));
  // Формы множественного числа могут использоваться и как обычные слова: t("файлов").
  say(`en: строк в интерфейсе ${keys.size}, без перевода ${missing.length}, форм числа без перевода ${missingPlurals.length}`);
  missing.forEach((k) => say(`  нет перевода [${keys.get(k)}]: ${k}`));
  missingPlurals.forEach((k) => say(`  нет форм числа: ${k}`));
  const unused = Object.keys(en.strings).filter((k) => !keys.has(k));
  unused.forEach((k) => say(`  лишний ключ: ${k}`));
  if (rawJsx.length) say(`русский текст мимо t(): ${rawJsx.length}`);
  rawJsx.forEach((x) => say(`  ${x}`));
  if (missing.length || missingPlurals.length || rawJsx.length || unused.length) failed = true;
}

const marks = (s) => [...s.matchAll(/\{\d\}/g)].map((m) => m[0]).sort().join("");
const ticks = (s) => [...s.matchAll(/`([^`]*)`/g)].map((m) => m[1]).sort().join("|");

for (const [code, loc] of Object.entries(locales)) {
  if (code === "en" || code === "ru" || (only && only !== code)) continue;
  const problems = [];
  for (const [k, v] of Object.entries(en.strings)) {
    const tr = loc.strings[k];
    if (tr === undefined) problems.push(`нет строки: ${k}`);
    else if (typeof tr !== "string" || !tr.trim()) problems.push(`пустая строка: ${k}`);
    else if (marks(tr) !== marks(v)) problems.push(`подстановки не совпали: ${k} → ${tr}`);
    else if (ticks(tr) !== ticks(v)) problems.push(`фрагменты в обратных кавычках изменены: ${k} → ${tr}`);
  }
  for (const k of Object.keys(loc.strings)) if (!(k in en.strings)) problems.push(`лишняя строка: ${k}`);
  const cats = new Set(new Intl.PluralRules(loc.intl).resolvedOptions().pluralCategories);
  for (const k of Object.keys(en.plurals)) {
    const forms = loc.plurals[k];
    if (!forms) problems.push(`нет форм числа: ${k}`);
    else for (const c of cats) if (!forms[c]) problems.push(`нет формы «${c}» для: ${k}`);
  }
  for (const [id, r] of Object.entries(en.rules)) {
    const tr = loc.rules[id];
    if (!tr) problems.push(`нет правила: ${id}`);
    else for (const f of Object.keys(r)) if (!tr[f] || !String(tr[f]).trim()) problems.push(`нет поля ${f} у правила: ${id}`);
  }
  for (const id of Object.keys(loc.rules)) if (!(id in en.rules)) problems.push(`лишнее правило: ${id}`);
  if (!Array.isArray(loc.units) || loc.units.length !== 6) problems.push("units: нужно ровно 6 единиц");
  try {
    new Intl.NumberFormat(loc.intl);
  } catch {
    problems.push(`intl: неизвестный тег ${loc.intl}`);
  }
  say(`${code} (${loc.name}): строк ${Object.keys(loc.strings).length}/${Object.keys(en.strings).length}, правил ${Object.keys(loc.rules).length}/${Object.keys(en.rules).length}, замечаний ${problems.length}`);
  problems.slice(0, 40).forEach((p) => say(`  ${p}`));
  if (problems.length) failed = true;
}

process.exitCode = failed ? 1 : 0;
