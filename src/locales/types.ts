/** Категории множественного числа по CLDR — те, что возвращает Intl.PluralRules. */
export type PluralForms = Partial<Record<"zero" | "one" | "two" | "few" | "many" | "other", string>>;

export interface RuleText {
  /** Название правила очистки (у автоматически найденных приложений не задаётся). */
  title?: string;
  desc?: string;
  hint?: string;
}

/**
 * Один язык интерфейса. Ключ перевода — русская строка из кода (или служебный ключ с «@»).
 * Полноту проверяет `npm run i18n`.
 */
export interface Locale {
  code: string;
  /** Название языка на нём самом — для переключателя. */
  name: string;
  /** Тег для Intl: формат чисел, дат, «3 дня назад». */
  intl: string;
  /** Единицы размера: байт, кило-, мега-, гига-, тера-, петабайт. */
  units: [string, string, string, string, string, string];
  strings: Record<string, string>;
  /** Формы слова по числу; ключ — русская форма «много» («файлов»). */
  plurals: Record<string, PluralForms>;
  /**
   * Тексты правил очистки по идентификатору правила. Служебные ключи:
   * `chromium:browsers`, `chromium:apps` — описания кешей найденных приложений;
   * `@admin:windir`, `@admin:programdata`, `@admin:svi` — почему нужны права (в поле desc).
   */
  rules: Record<string, RuleText>;
}
