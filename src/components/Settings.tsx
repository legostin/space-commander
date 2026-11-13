import { Monitor, Moon, Sun } from "lucide-react";
import { LANGS, t } from "../i18n";
import { Theme, useStore } from "../store";
import { Modal } from "./ui";

const THEMES: { id: Theme; label: string; icon: React.ReactNode }[] = [
  { id: "system", label: "Как в Windows", icon: <Monitor size={14} /> },
  { id: "dark", label: "Тёмная", icon: <Moon size={14} /> },
  { id: "light", label: "Светлая", icon: <Sun size={14} /> },
];

export function SettingsDialog() {
  const open = useStore((s) => s.settingsOpen);
  const close = useStore((s) => s.openSettings);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const lang = useStore((s) => s.lang);
  const setLanguage = useStore((s) => s.setLanguage);
  const showHidden = useStore((s) => s.showHidden);
  const showSystem = useStore((s) => s.showSystem);
  const setVisibility = useStore((s) => s.setVisibility);
  if (!open) return null;
  return (
    <Modal title={t("Настройки")} onClose={() => close(false)}>
      <div className="form">
        <div className="field">
          <span>{t("Оформление")}</span>
          <div className="seg">
            {THEMES.map((x) => (
              <button key={x.id} className={theme === x.id ? "on" : ""} onClick={() => setTheme(x.id)}>
                {x.icon}
                {t(x.label)}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span>{t("Язык")}</span>
          <select className="select" value={lang} onChange={(e) => setLanguage(e.target.value)}>
            {LANGS.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <span>{t("Показывать на карте и в списках")}</span>
          <div className="seg">
            <button className={showHidden ? "on" : ""} onClick={() => void setVisibility(!showHidden, showSystem)}>
              {t("Скрытые")}
            </button>
            <button className={showSystem ? "on" : ""} onClick={() => void setVisibility(showHidden, !showSystem)}>
              {t("Системные")}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
