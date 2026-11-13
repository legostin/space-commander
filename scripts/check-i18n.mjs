// Проверка перевода: каждая русская строка интерфейса должна быть в src/en.ts,
// а русский текст прямо в разметке (мимо t()) — не должен встречаться.
//   node scripts/check-i18n.mjs          — отчёт
//   node scripts/check-i18n.mjs --json   — недостающие ключи в виде JSON
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SRC = join(import.meta.dirname, "..", "src");
const SKIP = new Set(["mock.ts", "en.ts"]);
const CYR = /[А-Яа-яЁё]/;

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.tsx?$/.test(name) && !SKIP.has(name) ? [p] : [];
  });
}

/** Убирает комментарии, не трогая строки. */
function stripComments(src) {
  return src.replace(/("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str ?? "");
}

const keys = new Map(); // строка → файл
const templates = [];
const rawJsx = [];
for (const file of files(SRC)) {
  const rel = file.slice(SRC.length + 1);
  const src = stripComments(readFileSync(file, "utf8"));
  for (const m of src.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) {
    if (!CYR.test(m[1])) continue;
    const value = JSON.parse(`"${m[1]}"`);
    if (!keys.has(value)) keys.set(value, rel);
  }
  for (const m of src.matchAll(/`((?:[^`\\]|\\.)*)`/g)) if (CYR.test(m[1])) templates.push(`${rel}: ${m[1].slice(0, 70)}`);
  // Русский текст между тегами, не обёрнутый в {t("…")}.
  const noStrings = src.replace(/"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');
  for (const m of noStrings.matchAll(/>([^<>{}]*[А-Яа-яЁё][^<>{}]*)</g)) {
    // Название языка в переключателе пишется на самом языке и не переводится.
    if (m[1].trim() !== "Русский") rawJsx.push(`${rel}: ${m[1].trim().slice(0, 70)}`);
  }
}

const { EN, EN_PLURALS } = await import(pathToFileURL(join(SRC, "en.ts")).href).catch(async () => {
  // Node не исполняет .ts напрямую без флага — читаем словарь как текст.
  const text = readFileSync(join(SRC, "en.ts"), "utf8");
  const body = (name) => text.slice(text.indexOf("{", text.indexOf(`export const ${name}`)), text.indexOf("\n};", text.indexOf(`export const ${name}`)) + 2);
  return { EN: Function(`return (${body("EN")})`)(), EN_PLURALS: Function(`return (${body("EN_PLURALS")})`)() };
});

// Формы «один/несколько» для plural() переводятся по форме «много»; сами по себе в словаре не нужны.
const pluralForms = new Set();
for (const file of files(SRC)) {
  const src = stripComments(readFileSync(file, "utf8"));
  for (const m of src.matchAll(/(?:plural|ago)\(\s*[^,]+,\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)"/g)) {
    pluralForms.add(m[1]);
    pluralForms.add(m[2]);
    if (!(m[3] in EN_PLURALS)) console.error(`нет формы множественного числа: ${m[3]}`);
    pluralForms.add(m[3]);
  }
}

const EXEMPT = new Set(["Русский", "понедельник", "вторник", "среду", "четверг", "пятницу", "субботу", "воскресенье", "Каждую", "Каждое", "Каждый", "млн", "тыс.", "Б", "КБ", "МБ", "ГБ", "ТБ", "ПБ"]);
const missing = [...keys.keys()].filter((k) => !(k in EN) && !pluralForms.has(k) && !EXEMPT.has(k));
const unused = Object.keys(EN).filter((k) => !keys.has(k));

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(missing, null, 1));
} else {
  console.log(`строк в интерфейсе: ${keys.size}, переведено: ${keys.size - missing.length}, не переведено: ${missing.length}`);
  missing.forEach((k) => console.log(`  нет перевода [${keys.get(k)}]: ${k}`));
  if (rawJsx.length) console.log(`русский текст мимо t(): ${rawJsx.length}`);
  rawJsx.forEach((x) => console.log(`  ${x}`));
  if (unused.length) console.log(`лишние ключи в словаре: ${unused.length}`);
  unused.forEach((k) => console.log(`  ${k}`));
  console.log(`шаблонные строки с русским текстом (проверить вручную): ${templates.length}`);
  templates.forEach((x) => console.log(`  ${x}`));
  process.exitCode = missing.length || rawJsx.length ? 1 : 0;
}
