// Многоязычный интерфейс. Ключ перевода — сама русская строка: код остаётся читаемым,
// а отсутствующий перевод показывает английский текст (или русский, если нет и его).
// Языки подхватываются автоматически из src/locales/*.ts.
import type { Locale, RuleText } from "./locales/types";

const modules = import.meta.glob<{ default: Locale }>("./locales/*.ts", { eager: true });

export const LOCALES: Record<string, Locale> = {};
for (const [path, mod] of Object.entries(modules)) {
  if (!path.endsWith("/types.ts") && mod.default?.code) LOCALES[mod.default.code] = mod.default;
}

export type Lang = string;

/** Порядок языков в переключателе. */
const ORDER = ["en", "ru", "es", "de", "fr", "pt", "zh", "ja"];
export const LANGS: Locale[] = Object.values(LOCALES).sort((a, b) => {
  const ia = ORDER.indexOf(a.code);
  const ib = ORDER.indexOf(b.code);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.name.localeCompare(b.name);
});

function initial(): Lang {
  try {
    const saved = localStorage.getItem("sc.lang");
    if (saved && LOCALES[saved]) return saved;
  } catch {
    /* нет доступа к хранилищу — определяем по системе */
  }
  const system = (typeof navigator !== "undefined" ? navigator.language : "en").toLowerCase().split("-")[0];
  return LOCALES[system] ? system : "en";
}

let lang: Lang = initial();
let cur: Locale = LOCALES[lang] ?? LOCALES.ru;
const en: Locale | undefined = LOCALES.en;

export function getLang(): Lang {
  return lang;
}

export function getLocale(): Locale {
  return cur;
}

export function setLang(next: Lang) {
  if (!LOCALES[next]) return;
  lang = next;
  cur = LOCALES[next];
  try {
    localStorage.setItem("sc.lang", next);
  } catch {
    /* выбор не сохранится между запусками */
  }
  document.documentElement.lang = next;
}

/** Перевод строки. `{0}`, `{1}` заменяются аргументами. */
export function t(s: string, ...args: (string | number)[]): string {
  let r = lang === "ru" ? s : (cur.strings[s] ?? en?.strings[s] ?? s);
  for (let i = 0; i < args.length; i++) r = r.split(`{${i}}`).join(String(args[i]));
  return r;
}

const rulesCache = new Map<string, Intl.PluralRules>();

/** Форма слова по числу: «1 файл, 2 файла, 5 файлов» / «1 file, 2 files». */
export function plural(n: number, one: string, few: string, many: string): string {
  if (lang === "ru") {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  }
  const forms = cur.plurals[many] ?? en?.plurals[many];
  if (!forms) return many;
  let pr = rulesCache.get(cur.intl);
  if (!pr) rulesCache.set(cur.intl, (pr = new Intl.PluralRules(cur.intl)));
  return forms[pr.select(n)] ?? forms.other ?? many;
}

interface RuleLike {
  id: string;
  category: string;
  title: string;
  desc: string;
  hint: string;
  admin_reason: string;
  needs_admin: boolean;
}

/**
 * Тексты правила очистки на языке интерфейса. Ядро присылает их по-русски или по-английски;
 * для остальных языков берём перевод из словаря по идентификатору правила.
 */
export function ruleText(item: RuleLike): { title: string; desc: string; hint: string; admin_reason: string } {
  const base = { title: item.title, desc: item.desc, hint: item.hint, admin_reason: item.admin_reason };
  if (lang === "ru") return base;
  const pick = (id: string): RuleText | undefined => cur.rules[id] ?? en?.rules[id];
  const own = item.id.startsWith("chromium:") ? pick(item.category === "browsers" ? "chromium:browsers" : "chromium:apps") : pick(item.id);
  const reason = !item.needs_admin ? undefined : pick(item.id === "restore-points" ? "@admin:svi" : item.id === "wer-system" ? "@admin:programdata" : "@admin:windir");
  return {
    title: own?.title ?? base.title,
    desc: own?.desc ?? base.desc,
    hint: base.hint ? (own?.hint ?? base.hint) : "",
    admin_reason: reason?.desc ?? base.admin_reason,
  };
}
