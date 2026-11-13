import type { Locale } from "./types";

// Русский — исходный язык: строки берутся прямо из кода, тексты правил очистки — из ядра,
// формы слов передаются в plural() явно. Поэтому словари здесь пустые.
const locale: Locale = {
  code: "ru",
  name: "Русский",
  intl: "ru-RU",
  units: ["Б", "КБ", "МБ", "ГБ", "ТБ", "ПБ"],
  strings: {},
  plurals: {},
  rules: {},
};

export default locale;
