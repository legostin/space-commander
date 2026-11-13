import { useEffect, useMemo, useState } from "react";
import { AppWindow, ChevronRight, CodeXml, Download, ExternalLink, FolderOpen, Globe, HardDrive, Hammer, Info, Lock, Play, RefreshCw, Sparkles, TriangleAlert } from "lucide-react";
import { Artifact, call, CleanReport, JunkItem, listen } from "../api";
import { fmtAgo, fmtBytes, fmtCount, fmtNum, plural } from "../format";
import { t } from "../i18n";
import { useStore } from "../store";
import { Check, Empty, Modal, Size, Spinner, Toggle } from "../components/ui";

const SECTIONS: { id: string; title: string; icon: React.ReactNode; hint: string }[] = [
  { id: "system", title: "Система", icon: <HardDrive size={16} />, hint: "Временные файлы, обновления, дампы, эскизы" },
  { id: "browsers", title: "Браузеры", icon: <Globe size={16} />, hint: "Только кеш — пароли, история и вкладки не затрагиваются" },
  { id: "apps", title: "Приложения", icon: <AppWindow size={16} />, hint: "Кеши встроенных браузеров и лаунчеров, найдены автоматически" },
  { id: "dev", title: "Разработка", icon: <CodeXml size={16} />, hint: "Кеши пакетных менеджеров и сборки" },
  { id: "downloads", title: "Загрузки", icon: <Download size={16} />, hint: "Давно скачанные установщики" },
];

/** Подпись кнопки для штатного средства Windows, на которое ссылается справочная карточка. */
function actionLabel(action: string): string {
  if (action === "tool:system-protection") return t("Открыть «Защиту системы»");
  if (action === "tool:disk-cleanup") return t("Открыть «Очистку диска»");
  return t("Открыть Параметры");
}

function SafetyBadge({ item }: { item: JunkItem }) {
  if (item.safety === "safe") return <span className="badge safe">{t("Безопасно")}</span>;
  if (item.safety === "caution") return <span className="badge caution">{t("С оговорками")}</span>;
  return <span className="badge info">{t("Справка")}</span>;
}

function Row({ item, checked, onCheck, locked }: { item: JunkItem; checked: boolean; onCheck: (v: boolean) => void; locked: boolean }) {
  const [open, setOpen] = useState(false);
  const askElevation = useStore((s) => s.askElevation);
  const toast = useStore((s) => s.toast);
  const reveal = (path: string) => void call("reveal", { path }).catch((e) => toast("error", t("Не удалось открыть Проводник"), String(e)));
  const known = item.accessible || item.size > 0;
  return (
    <div className={`junk-row ${open ? "open" : ""}`}>
      <div className="junk-main" onClick={() => setOpen(!open)}>
        {locked ? (
          <span className="check-lock" title={t("Нужны права администратора")}>
            <Lock size={12} />
          </span>
        ) : (
          <Check checked={checked} onChange={onCheck} disabled={item.size === 0} />
        )}
        <div className="junk-title">
          <b>{item.title}</b>
          <SafetyBadge item={item} />
          {item.needs_admin && (
            <span className="badge admin">
              <Lock size={10} /> {t("Администратор")}
            </span>
          )}
          {item.running && (
            <span className="badge running" title={t("Приложение сейчас запущено: часть файлов занята и не удалится")}>
              <Play size={9} /> {t("Запущено")}
            </span>
          )}
        </div>
        <span className="junk-files">{known ? `${fmtCount(item.files)} ${plural(item.files, "файл", "файла", "файлов")}` : ""}</span>
        <span className="junk-size">{known ? <Size bytes={item.size} /> : <span className="dim">{t("размер скрыт")}</span>}</span>
        <ChevronRight size={15} className="chev" />
      </div>
      {open && (
        <div className="junk-detail">
          <p>{item.desc}</p>
          {item.running && (
            <div className="why warn">
              <Play size={13} />
              <div>
                <b>{t("Приложение запущено")}</b>
                <span>{t("Занятые файлы будут пропущены, а приложение может повести себя странно до перезапуска. Лучше закрыть его перед очисткой.")}</span>
              </div>
            </div>
          )}
          {item.needs_admin && (
            <div className="why">
              <Lock size={13} />
              <div>
                <b>{t("Почему нужны права администратора")}</b>
                <span>{item.admin_reason}</span>
                {locked && (
                  <button className="link" onClick={() => askElevation({ reason: "clean", what: item.title })}>
                    {t("Как получить доступ")}
                  </button>
                )}
              </div>
            </div>
          )}
          {item.targets.length > 0 && (
            <div className="targets">
              <div className="targets-head">{t("Что именно будет очищено")}</div>
              {item.targets.slice(0, 12).map((x) => (
                <div key={x.path} className="target">
                  <code className="ellipsis">{x.path}</code>
                  <Size bytes={x.size} />
                  {x.path.includes(":\\") && (
                    <button className="icon-btn sm" title={t("Показать в Проводнике")} onClick={() => reveal(x.path)}>
                      <FolderOpen size={13} />
                    </button>
                  )}
                </div>
              ))}
              {item.targets.length > 12 && <div className="target more">{t("и ещё {0}", item.targets.length - 12)}</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function InfoCard({ item }: { item: JunkItem }) {
  const toast = useStore((s) => s.toast);
  const askElevation = useStore((s) => s.askElevation);
  const elevated = useStore((s) => !!s.priv?.elevated);
  const known = item.accessible || item.size > 0;
  return (
    <div className="info-card">
      <div className="info-top">
        <b>{item.title}</b>
        {known ? (
          <Size bytes={item.size} />
        ) : (
          <button className="link" onClick={() => !elevated && askElevation({ reason: "general" })} title={item.admin_reason}>
            <Lock size={11} /> {t("размер скрыт")}
          </button>
        )}
      </div>
      <p>{item.desc}</p>
      {item.hint && (
        <div className="info-hint">
          <Info size={13} />
          <span>{item.hint}</span>
        </div>
      )}
      <div className="info-foot">
        {item.targets[0] && <code className="ellipsis">{item.targets[0].path}</code>}
        {item.action && (
          <button className="btn sm" onClick={() => void call("open_settings", { uri: item.action }).catch((e) => toast("error", t("Не удалось открыть"), String(e)))}>
            <ExternalLink size={12} />
            {actionLabel(item.action)}
          </button>
        )}
      </div>
    </div>
  );
}

function Artifacts({ root }: { root: string }) {
  const treeVersion = useStore((s) => s.treeVersion);
  const scannedAt = useStore((s) => s.scans[root]?.scanned_at);
  const askDelete = useStore((s) => s.askDelete);
  const [items, setItems] = useState<Artifact[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());

  useEffect(() => {
    void call<Artifact[]>("dev_artifacts", { root }).then((a) => {
      setItems(a);
      setPicked(new Set());
    });
  }, [root, treeVersion, scannedAt]);

  if (!items || items.length === 0) return null;
  const stale = (a: Artifact) => Date.now() / 1000 - a.project_mtime > 86400 * 60;
  const pickedItems = items.filter((a) => picked.has(a.id));
  const size = pickedItems.reduce((s, a) => s + a.alloc, 0);

  return (
    <section className="junk-section">
      <div className="junk-section-head">
        <span className="sec-icon">
          <Hammer size={16} />
        </span>
        <div>
          <h3>{t("Папки сборки в проектах")}</h3>
          <p>{t("node_modules, target, .venv и подобные — восстанавливаются командой установки или сборки")}</p>
        </div>
        <div className="grow" />
        <button className="btn sm ghost" onClick={() => setPicked(new Set(items.filter(stale).map((a) => a.id)))}>
          {t("Выбрать заброшенные (60+ дней)")}
        </button>
        <button
          className="btn sm danger"
          disabled={!pickedItems.length}
          onClick={() => askDelete({ root, items: pickedItems.map((a) => ({ id: a.id, name: a.path, size: a.alloc })), permanent: true })}
        >
          {t("Удалить")}
          {pickedItems.length > 0 && ` · ${fmtBytes(size)}`}
        </button>
      </div>
      <div className="junk-rows">
        {items.slice(0, 60).map((a) => (
          <div key={a.id} className="junk-row">
            <div className="junk-main static">
              <Check
                checked={picked.has(a.id)}
                onChange={(v) =>
                  setPicked((p) => {
                    const n = new Set(p);
                    if (v) n.add(a.id);
                    else n.delete(a.id);
                    return n;
                  })
                }
              />
              <div className="junk-title col">
                <b className="ellipsis">{a.path}</b>
                <small>
                  {a.kind} · {t("проект меняли {0}", fmtAgo(a.project_mtime))}
                  {stale(a) && <em className="tone-warn"> · {t("заброшен")}</em>}
                </small>
              </div>
              <span className="junk-files">
                {fmtCount(a.files)} {t("файлов")}
              </span>
              <span className="junk-size">
                <Size bytes={a.alloc} />
              </span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function Cleanup() {
  const junk = useStore((s) => s.junk);
  const loading = useStore((s) => s.junkLoading);
  const loadJunk = useStore((s) => s.loadJunk);
  const priv = useStore((s) => s.priv);
  const activeRoot = useStore((s) => s.activeRoot);
  const scans = useStore((s) => s.scans);
  const refreshDrives = useStore((s) => s.refreshDrives);
  const askElevation = useStore((s) => s.askElevation);
  const toast = useStore((s) => s.toast);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [skipRunning, setSkipRunning] = useState(true);
  const [cleaning, setCleaning] = useState<{ index: number; total: number; title: string } | null>(null);
  const [report, setReport] = useState<CleanReport | null>(null);

  const elevated = !!priv?.elevated;
  const isLocked = (j: JunkItem) => j.needs_admin && !elevated;

  useEffect(() => {
    if (!junk && !loading) void loadJunk();
  }, []);

  // По умолчанию отмечено только безопасное и доступное.
  useEffect(() => {
    if (junk && picked === null) setPicked(new Set(junk.filter((j) => j.safety === "safe" && !isLocked(j) && j.size > 0).map((j) => j.id)));
  }, [junk]);

  useEffect(() => listen<{ index: number; total: number; title: string }>("clean-progress", setCleaning), []);

  const items = junk ?? [];
  const sel = picked ?? new Set<string>();
  const chosen = items.filter((j) => sel.has(j.id) && j.safety !== "info" && !isLocked(j));
  const running = chosen.filter((j) => j.running);
  const effective = skipRunning ? chosen.filter((j) => !j.running) : chosen;
  const chosenSize = chosen.reduce((s, j) => s + j.size, 0);
  const effectiveSize = effective.reduce((s, j) => s + j.size, 0);
  const cautionChosen = chosen.filter((j) => j.safety === "caution");
  const lockedItems = items.filter((j) => j.safety !== "info" && isLocked(j));
  const info = items.filter((j) => j.safety === "info");
  const scannedRoot = activeRoot && scans[activeRoot] ? activeRoot : null;

  const toggle = (id: string, v: boolean) =>
    setPicked((p) => {
      const n = new Set(p ?? []);
      if (v) n.add(id);
      else n.delete(id);
      return n;
    });

  const run = async () => {
    setConfirm(false);
    setCleaning({ index: 0, total: chosen.length, title: "" });
    try {
      const r = await call<CleanReport>("junk_clean", { ids: chosen.map((j) => j.id), skipRunning });
      setReport(r);
      setPicked(null);
      await loadJunk();
      void refreshDrives();
    } catch (e) {
      toast("error", t("Очистка не выполнена"), String(e));
    } finally {
      setCleaning(null);
    }
  };

  const groups = useMemo(
    () => SECTIONS.map((s) => ({ ...s, rows: items.filter((j) => j.category === s.id && j.safety !== "info").sort((a, b) => b.size - a.size) })).filter((g) => g.rows.length),
    [junk],
  );
  const points = (n: number) => `${n} ${plural(n, "пункт", "пункта", "пунктов")}`;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t("Очистка")}</h1>
          <p>{t("Кеши, временные файлы и всё, что можно удалить без последствий")}</p>
        </div>
        <button className="btn" disabled={loading || !!cleaning} onClick={() => void loadJunk().then(() => setPicked(null))}>
          {loading ? <Spinner size={13} /> : <RefreshCw size={14} />}
          {t("Проверить заново")}
        </button>
      </div>

      {!junk ? (
        <div className="card center-row pad">
          <Spinner /> {t("Ищу кеши и временные файлы…")}
        </div>
      ) : (
        <>
          <div className="card clean-hero">
            <div className="clean-hero-num">
              <Size bytes={chosenSize} />
              <span>
                {t("выбрано")} · {points(chosen.length)}
              </span>
            </div>
            <div className="clean-hero-notes">
              {cautionChosen.length > 0 && (
                <div className="tone-warn">
                  <TriangleAlert size={13} /> {t("Среди выбранного {0} с оговорками — раскройте строки, чтобы прочитать", points(cautionChosen.length))}
                </div>
              )}
              {running.length > 0 && (
                <div className="tone-warn">
                  <Play size={12} /> {t("Запущено: {0}", running.map((j) => j.title).join(", "))}
                </div>
              )}
              {lockedItems.length > 0 && (
                <button className="link" onClick={() => askElevation({ reason: "clean", what: lockedItems.map((j) => j.title.toLowerCase()).join(", ") })}>
                  <Lock size={12} /> {t("Ещё {0} — нужны права администратора. Почему?", points(lockedItems.length))}
                </button>
              )}
            </div>
            <button className="btn primary lg" disabled={!chosen.length || !!cleaning} onClick={() => setConfirm(true)}>
              {cleaning ? <Spinner /> : <Sparkles size={16} />}
              {cleaning ? t("Очищаю: {0}", cleaning.title || "…") : t("Очистить выбранное")}
            </button>
          </div>

          {groups.map((g) => {
            const selectable = g.rows.filter((j) => !isLocked(j) && j.size > 0);
            const on = selectable.filter((j) => sel.has(j.id)).length;
            const total = g.rows.reduce((s, j) => s + j.size, 0);
            return (
              <section key={g.id} className="junk-section">
                <div className="junk-section-head">
                  <Check checked={on > 0 && on === selectable.length} partial={on > 0 && on < selectable.length} disabled={!selectable.length} onChange={(v) => selectable.forEach((j) => toggle(j.id, v))} />
                  <span className="sec-icon">{g.icon}</span>
                  <div>
                    <h3>{t(g.title)}</h3>
                    <p>{t(g.hint)}</p>
                  </div>
                  <div className="grow" />
                  <Size bytes={total} className="sec-size" />
                </div>
                <div className="junk-rows">
                  {g.rows.map((j) => (
                    <Row key={j.id} item={j} checked={sel.has(j.id)} onCheck={(v) => toggle(j.id, v)} locked={isLocked(j)} />
                  ))}
                </div>
              </section>
            );
          })}

          {scannedRoot ? (
            <Artifacts root={scannedRoot} />
          ) : (
            <div className="hint-card">
              <Hammer size={15} /> {t("После сканирования диска здесь появятся папки сборки в заброшенных проектах (node_modules, target, .venv).")}
            </div>
          )}

          {info.length > 0 && (
            <section className="junk-section">
              <div className="junk-section-head">
                <span className="sec-icon">
                  <Info size={16} />
                </span>
                <div>
                  <h3>{t("Системные гиганты")}</h3>
                  <p>{t("Отсюда не удаляются — но вот что это и как уменьшить штатными средствами")}</p>
                </div>
              </div>
              <div className="info-grid">
                {info.map((j) => (
                  <InfoCard key={j.id} item={j} />
                ))}
              </div>
            </section>
          )}

          {groups.length === 0 && <Empty icon={<Sparkles size={30} />} title={t("Чисто")} text={t("Кешей и временных файлов не найдено.")} />}
        </>
      )}

      {confirm && (
        <Modal
          title={t("Очистить выбранное?")}
          onClose={() => setConfirm(false)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setConfirm(false)}>
                {t("Отмена")}
              </button>
              <button className="btn primary" autoFocus disabled={!effective.length} onClick={() => void run()}>
                {t("Очистить {0}", fmtBytes(effectiveSize))}
              </button>
            </>
          }
        >
          <p className="lead">{t("Файлы удаляются сразу, мимо Корзины. Занятые другими программами файлы будут пропущены.")}</p>
          {running.length > 0 && (
            <label className="switch-row boxed">
              <Toggle checked={skipRunning} onChange={setSkipRunning} />
              <span>
                {t("Не трогать запущенные приложения")} <small>{running.map((j) => j.title).join(", ")}</small>
              </span>
            </label>
          )}
          <ul className="path-list">
            {chosen.map((j) => {
              const skipped = skipRunning && j.running;
              return (
                <li key={j.id} className={skipped ? "skipped" : ""}>
                  <span>
                    {j.title}
                    {j.safety === "caution" && <em className="tone-warn"> · {t("с оговорками")}</em>}
                    {skipped && <em> · {t("запущено, пропускаю")}</em>}
                  </span>
                  <b>{fmtBytes(j.size)}</b>
                </li>
              );
            })}
          </ul>
        </Modal>
      )}

      {report && (
        <Modal
          title={t("Готово")}
          onClose={() => setReport(null)}
          footer={
            <button className="btn primary" autoFocus onClick={() => setReport(null)}>
              {t("Отлично")}
            </button>
          }
        >
          <div className="report-hero">
            <Size bytes={report.freed} />
            <span>
              {t("освобождено")} · {t("удалено файлов: {0}", fmtNum(report.files))}
            </span>
          </div>
          {report.skipped.length > 0 && <div className="note">{t("Пропущены запущенные приложения: {0}. Закройте их и повторите, если нужно.", report.skipped.join(", "))}</div>}
          {report.failed > 0 && (
            <div className="note">
              {t("Пропущено {0} — чаще всего они заняты запущенными программами. Закройте программы и повторите, если нужно.", `${fmtNum(report.failed)} ${plural(report.failed, "файл", "файла", "файлов")}`)}
            </div>
          )}
          {report.errors.length > 0 && (
            <details className="errors">
              <summary>{t("Подробности ({0})", report.errors.length)}</summary>
              {report.errors.map((e, i) => (
                <code key={i}>{e}</code>
              ))}
            </details>
          )}
        </Modal>
      )}
    </div>
  );
}
