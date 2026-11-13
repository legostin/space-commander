import { useEffect, useState } from "react";
import { Ban, Check, FolderLock, Lock, ShieldCheck, User, Zap } from "lucide-react";
import { call } from "../api";
import { fmtNum, plural } from "../format";
import { t } from "../i18n";
import { useStore } from "../store";
import { Rich } from "../components/ElevationDialog";

interface Cap {
  title: string;
  without: string;
  with: string;
  why: string;
  needsAdmin: boolean;
}

const CAPS: Cap[] = [
  {
    title: "Сканирование диска",
    without: "Обход папок одну за другой. Первый проход по большому диску — десятки секунд, повторные — секунды.",
    with: "Чтение таблицы файлов NTFS ($MFT) целиком — секунды даже на холодном диске. Жёсткие ссылки считаются один раз.",
    why: "Таблица читается с тома `\\\\.\\C:` в обход разрешений отдельных папок, поэтому Windows открывает том только администраторам.",
    needsAdmin: true,
  },
  {
    title: "Папки, закрытые системой",
    without: "Не читаются: их размер не попадает в карту. Список таких папок — ниже.",
    with: "Видны все, включая System Volume Information и профили других пользователей.",
    why: "У этих папок в списке доступа нет вашей учётной записи — только SYSTEM и «Администраторы».",
    needsAdmin: true,
  },
  {
    title: "Кеши браузеров, приложений и инструментов",
    without: "Полностью доступно.",
    with: "То же самое.",
    why: "Всё это лежит в вашем профиле (AppData) и принадлежит вам.",
    needsAdmin: false,
  },
  {
    title: "Системные временные файлы и обновления",
    without: "Недоступно: `C:\\Windows\\Temp`, загруженные обновления, системные дампы.",
    with: "Очищаются выбранные правила. Каждый путь показан заранее.",
    why: "Папки внутри `C:\\Windows` и `C:\\ProgramData` может изменять только администратор.",
    needsAdmin: true,
  },
  {
    title: "Удаление файлов и папок",
    without: "Всё, что вы можете удалить сами в Проводнике. По умолчанию — в Корзину.",
    with: "Плюс файлы, принадлежащие системе. Корневые системные папки защищены от удаления в любом случае.",
    why: "Приложение действует строго в рамках прав своего процесса.",
    needsAdmin: false,
  },
  {
    title: "Задачи по расписанию",
    without: "Задачи для вашего профиля создаются в Планировщике Windows без повышения прав.",
    with: "Можно добавить в задачу системные правила — она будет запускаться с правами администратора.",
    why: "Создать задачу с наивысшими правами может только процесс, уже запущенный от администратора.",
    needsAdmin: false,
  },
];

const NEVER = [
  "Не устанавливает службы, драйверы и не прописывается в автозагрузку",
  "Не отправляет данные в сеть: в нём нет телеметрии, облака и автообновления",
  "Не открывает содержимое файлов — только имена и размеры (кроме поиска дубликатов, который вы запускаете сами)",
  "Не удаляет ничего без явного подтверждения со списком путей",
];

const INSIDE = [
  "Интерфейсу разрешено только управлять окном и получать события — прямого доступа к файлам у него нет.",
  "Все действия с диском идут через фиксированный набор команд ядра на Rust; произвольную команду выполнить нельзя.",
  "Том при быстром сканировании открывается только на чтение.",
  "Правила очистки — это явные списки папок; ссылки и точки соединения внутри них не раскрываются.",
  "Данные приложения (задачи, история, снимки размеров, кеш сканирования) лежат в `AppData\\Roaming\\SpaceCommander` и `AppData\\Local\\SpaceCommander`.",
];

export function Access() {
  const priv = useStore((s) => s.priv);
  const askElevation = useStore((s) => s.askElevation);
  const activeRoot = useStore((s) => s.activeRoot);
  const scan = useStore((s) => (s.activeRoot ? s.scans[s.activeRoot] : undefined));
  const [denied, setDenied] = useState<string[]>([]);

  useEffect(() => {
    if (!activeRoot || !scan) return setDenied([]);
    void call<string[]>("denied_paths", { root: activeRoot }).then(setDenied).catch(() => setDenied([]));
  }, [activeRoot, scan?.scanned_at]);

  const elevated = !!priv?.elevated;
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t("Права доступа")}</h1>
          <p>{t("Что приложению разрешено, что нет и почему — без мелкого шрифта")}</p>
        </div>
      </div>

      <div className={`card access-hero ${elevated ? "elevated" : ""}`}>
        <div className="access-icon">{elevated ? <ShieldCheck size={26} /> : <User size={26} />}</div>
        <div className="access-text">
          <h2>{elevated ? t("Работает с правами администратора") : t("Работает с обычными правами")}</h2>
          <p>
            {priv?.user && <code>{priv.user}</code>}{" "}
            {elevated
              ? t("— доступны быстрое сканирование и системные папки. Права действуют до закрытия приложения.")
              : priv?.elevation_type === 3
                ? t("— учётная запись входит в администраторы, но приложение запущено без повышения. Этого хватает почти для всего.")
                : t("— обычная учётная запись. Для повышения Windows попросит пароль администратора.")}
          </p>
        </div>
        {!elevated && (
          <button className="btn primary" onClick={() => askElevation({ reason: "general" })}>
            <ShieldCheck size={15} />
            {t("Перезапустить с правами")}
          </button>
        )}
      </div>

      <div className="card flush">
        <div className="caps">
          <div className="cap th">
            <span>{t("Возможность")}</span>
            <span>
              <User size={12} /> {t("Без прав администратора")}
            </span>
            <span>
              <ShieldCheck size={12} /> {t("С правами")}
            </span>
            <span>{t("Почему так")}</span>
          </div>
          {CAPS.map((c) => (
            <div key={c.title} className="cap">
              <span className="cap-title">
                {c.needsAdmin && !elevated ? <Lock size={14} className="tone-warn" /> : <Check size={14} className="tone-ok" />}
                <b>{t(c.title)}</b>
              </span>
              <span className={!elevated ? "now" : ""}>
                <Rich text={t(c.without)} />
              </span>
              <span className={elevated ? "now" : ""}>
                <Rich text={t(c.with)} />
              </span>
              <span className="cap-why">
                <Rich text={t(c.why)} />
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="grid2">
        <div className="card">
          <div className="card-head">
            <span>
              <Ban size={15} className="tone-bad" /> {t("Чего приложение не делает никогда")}
            </span>
          </div>
          <ul className="never">
            {NEVER.map((n) => (
              <li key={n}>{t(n)}</li>
            ))}
          </ul>
        </div>
        <div className="card">
          <div className="card-head">
            <span>
              <Zap size={15} className="tone-sun" /> {t("Как устроено изнутри")}
            </span>
          </div>
          <ul className="never plain">
            {INSIDE.map((n) => (
              <li key={n}>
                <Rich text={t(n)} />
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="card flush">
        <div className="card-head pad">
          <span>
            <FolderLock size={15} className="tone-warn" /> {t("Папки, которые не удалось прочитать")}
          </span>
          {denied.length > 0 && (
            <span className="dim">
              {fmtNum(denied.length)} {plural(denied.length, "папка", "папки", "папок")}
            </span>
          )}
        </div>
        {!scan ? (
          <div className="pad dim">{t("Список появится после сканирования диска.")}</div>
        ) : scan.mode === "mft" ? (
          <div className="pad dim">{t("Быстрый режим читает таблицу файлов целиком — непрочитанных папок нет.")}</div>
        ) : denied.length === 0 ? (
          <div className="pad dim">{t("Все папки прочитаны.")}</div>
        ) : (
          <>
            <div className="pad dim small">
              {t("У этих папок в списке доступа нет вашей учётной записи. Их содержимое не попало в карту, поэтому сумма на карте чуть меньше занятого места на диске.")}
              {!elevated && ` ${t("В быстром режиме они читаются.")}`}
            </div>
            <div className="denied">
              {denied.slice(0, 300).map((d) => (
                <code key={d}>{d}</code>
              ))}
              {denied.length > 300 && <span className="dim">{t("и ещё {0}", fmtNum(denied.length - 300))}</span>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
