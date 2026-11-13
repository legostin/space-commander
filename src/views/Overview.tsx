import { useEffect, useMemo, useState } from "react";
import { ArrowRight, CalendarClock, File, Folder, FolderSearch, HardDrive, LayoutGrid, Sparkles, TrendingDown, TrendingUp, Usb, X, Zap } from "lucide-react";
import { call, Diff, DirView, Drive, RunLog, Sample, SnapMeta, Task } from "../api";
import { catOf, fmtAgo, fmtBytes, fmtCount, fmtDelta, fmtDuration, fmtPct } from "../format";
import { t } from "../i18n";
import { isDriveRoot, reclaimable, useStore } from "../store";
import { Bar, Ring, Size, Spinner } from "../components/ui";
import { describeSchedule, nextRun } from "./Schedule";

/** Снимок для сравнения: предыдущий в том же режиме сканирования, иначе просто предыдущий. */
export function pickBaseline(list: SnapMeta[]): SnapMeta | undefined {
  if (list.length < 2) return undefined;
  return list.slice(1).find((m) => m.mode === list[0].mode) ?? list[1];
}

function DriveCard({ d }: { d: Drive }) {
  const scan = useStore((s) => s.scans[d.root]);
  const scanning = useStore((s) => s.scanning);
  const priv = useStore((s) => s.priv);
  const startScan = useStore((s) => s.startScan);
  const askElevation = useStore((s) => s.askElevation);
  const open = useStore((s) => s.openInExplorer);
  const used = d.total - d.free;
  const frac = used / d.total;
  const canFast = d.fs === "NTFS";
  const busy = scanning?.root === d.root;

  return (
    <div className="card drive-card">
      <Ring value={frac}>
        <div className="ring-pct">{Math.round(frac * 100)}%</div>
        <div className="ring-sub">{t("занято")}</div>
      </Ring>
      <div className="drive-info">
        <div className="drive-name">
          {d.kind === "removable" ? <Usb size={15} /> : <HardDrive size={15} />}
          <b>{d.label || (d.kind === "removable" ? t("Съёмный диск") : d.kind === "network" ? t("Сетевой диск") : t("Локальный диск"))}</b>
          <span>{d.letter}:</span>
          <em>{d.fs}</em>
        </div>
        <div className="drive-nums">
          <div>
            <Size bytes={d.free} className="big" />
            <span>{t("свободно")}</span>
          </div>
          <div>
            <Size bytes={used} className="big dim" />
            <span>{t("занято из {0}", fmtBytes(d.total))}</span>
          </div>
        </div>
        <div className="drive-actions">
          {scan ? (
            <button className="btn primary" onClick={() => open(d.root, 0)}>
              <LayoutGrid size={15} />
              {t("Открыть карту")}
            </button>
          ) : (
            <button className="btn primary" disabled={!!scanning} onClick={() => void startScan(d.root, "auto")}>
              {busy ? <Spinner /> : priv?.elevated && canFast ? <Zap size={15} /> : <LayoutGrid size={15} />}
              {t("Сканировать")}
            </button>
          )}
          {scan && (
            <button className="btn" disabled={!!scanning} onClick={() => void startScan(d.root, "auto")}>
              {busy && <Spinner size={13} />}
              {t("Обновить")}
            </button>
          )}
          {!priv?.elevated && canFast && (
            <button className="btn ghost" disabled={!!scanning} onClick={() => askElevation({ reason: "scan", root: d.root })} title={t("Чтение таблицы файлов напрямую — нужны права администратора")}>
              <Zap size={14} />
              {t("Быстрый режим")}
            </button>
          )}
        </div>
        <div className="drive-meta">
          {scan ? (
            <>
              {scan.mode === "mft" && <Zap size={11} className="tone-sun" />}
              {t("{0} файлов за {1}", fmtCount(scan.files), fmtDuration(scan.duration_ms))} · {fmtAgo(scan.scanned_at)}
            </>
          ) : canFast ? (
            priv?.elevated ? (
              t("Будет использован быстрый режим")
            ) : (
              t("Обычный режим — без прав администратора")
            )
          ) : (
            t("{0}: обход папок", d.fs)
          )}
        </div>
      </div>
    </div>
  );
}

function Spark({ points, total }: { points: { t: number; free: number }[]; total: number }) {
  const W = 320;
  const H = 86;
  if (points.length < 2) return <div className="spark-empty">{t("История появится после нескольких запусков")}</div>;
  const min = Math.min(...points.map((p) => p.free));
  const max = Math.max(...points.map((p) => p.free));
  const pad = Math.max((max - min) * 0.15, total * 0.002);
  const lo = min - pad;
  const hi = max + pad;
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const xy = points.map((p) => [((p.t - t0) / Math.max(1, t1 - t0)) * W, H - ((p.free - lo) / (hi - lo)) * H] as const);
  const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const last = xy[xy.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="spark" preserveAspectRatio="none">
      <defs>
        <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#38bdf8" stopOpacity=".28" />
          <stop offset="1" stopColor="#38bdf8" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L${W} ${H} L0 ${H} Z`} fill="url(#spark-fill)" />
      <path d={line} fill="none" stroke="#38bdf8" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r="3.5" fill="#38bdf8" />
    </svg>
  );
}

export function Overview() {
  const drives = useStore((s) => s.drives);
  const junk = useStore((s) => s.junk);
  const junkLoading = useStore((s) => s.junkLoading);
  const setView = useStore((s) => s.setView);
  const setAnalysisTab = useStore((s) => s.setAnalysisTab);
  const activeRoot = useStore((s) => s.activeRoot);
  const scans = useStore((s) => s.scans);
  const scanning = useStore((s) => s.scanning);
  const byAlloc = useStore((s) => s.byAlloc);
  const treeVersion = useStore((s) => s.treeVersion);
  const open = useStore((s) => s.openInExplorer);
  const openPath = useStore((s) => s.openPath);
  const scanFolder = useStore((s) => s.scanFolder);
  const forgetScan = useStore((s) => s.forgetScan);
  const startScan = useStore((s) => s.startScan);
  const elevated = useStore((s) => !!s.priv?.elevated);
  const [history, setHistory] = useState<Sample[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [runs, setRuns] = useState<RunLog[]>([]);
  const [top, setTop] = useState<DirView | null>(null);
  const [diff, setDiff] = useState<Diff | null>(null);

  const mainDrive = drives.find((d) => activeRoot && activeRoot.toUpperCase().startsWith(d.root.toUpperCase())) ?? drives.find((d) => d.kind === "fixed") ?? drives[0];
  const scanned = activeRoot && scans[activeRoot] ? activeRoot : null;
  const scannedAt = scanned ? scans[scanned].scanned_at : 0;
  const folders = Object.values(scans).filter((s) => !isDriveRoot(s.root));

  useEffect(() => {
    void call<Sample[]>("history_get").then(setHistory);
    void call<Task[]>("tasks_list").then(setTasks);
    void call<RunLog[]>("task_runs").then(setRuns);
  }, []);

  useEffect(() => {
    if (!scanned) return setTop(null);
    void call<DirView>("get_dir", { root: scanned, id: 0, byAlloc }).then(setTop).catch(() => setTop(null));
  }, [scanned, byAlloc, treeVersion]);

  useEffect(() => {
    setDiff(null);
    if (!scanned) return;
    void call<SnapMeta[]>("snapshots_list", { root: scanned }).then((list) => {
      const base = pickBaseline(list);
      if (base) void call<Diff>("snapshot_diff", { root: scanned, baseId: base.id, limit: 7 }).then(setDiff).catch(() => setDiff(null));
    });
  }, [scanned, scannedAt]);

  const safe = useMemo(() => reclaimable(junk, elevated), [junk, elevated]);
  const reclaim = safe.reduce((s, j) => s + j.size, 0);
  const caution = (junk ?? []).filter((j) => j.safety === "caution").reduce((s, j) => s + j.size, 0);
  const topJunk = [...safe].sort((a, b) => b.size - a.size).slice(0, 4);

  const points = useMemo(() => {
    if (!mainDrive) return [];
    return history.flatMap((s) => {
      const d = s.drives.find((x) => x.root === mainDrive.root);
      return d ? [{ t: s.t, free: d.free }] : [];
    });
  }, [history, mainDrive]);
  const delta = points.length > 1 ? points[points.length - 1].free - points[0].free : 0;
  const spanDays = points.length > 1 ? Math.max(1, Math.round((points[points.length - 1].t - points[0].t) / 86400)) : 0;

  const active = tasks.filter((x) => x.enabled);
  const next = active.map((x) => ({ task: x, at: nextRun(x) })).sort((a, b) => a.at - b.at)[0];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t("Обзор")}</h1>
          <p>{t("Куда ушло место и сколько можно вернуть")}</p>
        </div>
        <button className="btn" disabled={!!scanning} onClick={() => void scanFolder()} title={t("Просканировать одну папку, сетевой путь или внешний диск")}>
          <FolderSearch size={15} />
          {t("Сканировать папку…")}
        </button>
      </div>

      <div className="drive-grid">
        {drives.map((d) => (
          <DriveCard key={d.root} d={d} />
        ))}
      </div>

      {folders.length > 0 && (
        <div className="folder-scans">
          {folders.map((f) => (
            <div key={f.root} className={`folder-scan ${activeRoot === f.root ? "active" : ""}`}>
              <button className="folder-scan-main" onClick={() => open(f.root, 0)} title={f.root}>
                <Folder size={15} className="tone-sun" />
                <span className="ellipsis">{f.root}</span>
                <Size bytes={byAlloc ? f.alloc : f.size} />
              </button>
              <button className="icon-btn sm" disabled={!!scanning} title={t("Обновить")} onClick={() => void startScan(f.root, "walk")}>
                <Zap size={12} />
              </button>
              <button className="icon-btn sm" title={t("Убрать из списка")} onClick={() => forgetScan(f.root)}>
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="grid3">
        <div className="card clickable" onClick={() => setView("cleanup")}>
          <div className="card-head">
            <span>
              <Sparkles size={15} className="tone-sun" /> {t("Можно освободить")}
            </span>
            <ArrowRight size={15} />
          </div>
          {junk ? (
            <>
              <div className="hero-num">
                <Size bytes={reclaim} />
              </div>
              <div className="card-sub">
                {t("безопасно")}
                {caution > 0 && ` · ${t("ещё {0} с оговорками", fmtBytes(caution))}`}
              </div>
              <div className="mini-list">
                {topJunk.map((j) => (
                  <div key={j.id}>
                    <span>{j.title}</span>
                    <Bar value={j.size / (topJunk[0]?.size || 1)} thin color="linear-gradient(90deg,#ffc46b,#ff6b57)" />
                    <Size bytes={j.size} />
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="card-loading">
              {junkLoading && <Spinner />} {t("Ищу кеши и временные файлы…")}
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <span>
              {delta < 0 ? <TrendingDown size={15} className="tone-bad" /> : <TrendingUp size={15} className="tone-ok" />}{" "}
              {mainDrive ? t("Свободное место на {0}:", mainDrive.letter) : t("Свободное место")}
            </span>
          </div>
          <div className="hero-num">{mainDrive && <Size bytes={mainDrive.free} />}</div>
          <div className="card-sub">
            {points.length > 1 ? (
              <>
                <span className={delta < 0 ? "tone-bad" : "tone-ok"}>{fmtDelta(delta)}</span> {t("за {0} дн.", spanDays)}
              </>
            ) : (
              t("Собираю историю")
            )}
          </div>
          <Spark points={points} total={mainDrive?.total ?? 1} />
        </div>

        <div className="card clickable" onClick={() => setView("schedule")}>
          <div className="card-head">
            <span>
              <CalendarClock size={15} className="tone-sky" /> {t("Расписание")}
            </span>
            <ArrowRight size={15} />
          </div>
          {next ? (
            <>
              <div className="hero-num small">{next.task.name}</div>
              <div className="card-sub">{describeSchedule(next.task)}</div>
            </>
          ) : (
            <>
              <div className="hero-num small">{t("Задач нет")}</div>
              <div className="card-sub">{t("Настройте автоматическую уборку кешей — приложению не нужно быть запущенным")}</div>
            </>
          )}
          <div className="mini-list runs">
            {runs.slice(0, 3).map((r, i) => (
              <div key={i}>
                <span>{fmtAgo(r.at)}</span>
                <span className="grow" />
                <span>
                  {t("освобождено")} <b>{fmtBytes(r.freed)}</b>
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {scanned && (top || diff) && (
        <div className="grid2 wide-left">
          {top && (
            <div className="card">
              <div className="card-head">
                <span>
                  <Folder size={15} className="tone-sun" /> {t("Самое тяжёлое на {0}", isDriveRoot(scanned) ? scanned.replace(/\\$/, "") : (scanned.split("\\").pop() ?? scanned))}
                </span>
                <button className="btn sm ghost" onClick={() => open(scanned, 0)}>
                  {t("Вся карта")} <ArrowRight size={13} />
                </button>
              </div>
              <div className="heavy">
                {top.children.slice(0, 8).map((c) => {
                  const m = byAlloc ? c.alloc : c.size;
                  const total = byAlloc ? top.node.alloc : top.node.size;
                  return (
                    <button key={c.id} className="heavy-row" onClick={() => (c.dir ? open(scanned, c.id) : open(scanned, 0, c.id))}>
                      <span className="dot" style={{ background: c.dir ? "#ffc46b" : catOf(c.cat).color }} />
                      <span className="heavy-name">{c.name}</span>
                      <Bar value={m / (total || 1)} color={c.dir ? undefined : catOf(c.cat).color} />
                      <span className="heavy-pct">{fmtPct(m, total)}</span>
                      <Size bytes={m} />
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <div className="card">
            <div className="card-head">
              <span>
                <TrendingUp size={15} className="tone-sky" /> {t("Что изменилось")}
              </span>
              {diff && (
                <button
                  className="btn sm ghost"
                  onClick={() => {
                    setAnalysisTab("changes");
                    setView("analysis");
                  }}
                >
                  {t("Подробнее")} <ArrowRight size={13} />
                </button>
              )}
            </div>
            {diff ? (
              <>
                <div className="card-sub top">
                  <span className={diff.delta > 0 ? "tone-bad" : "tone-ok"}>{fmtDelta(diff.delta)}</span> {t("с прошлого сканирования")} · {fmtAgo(diff.base.taken_at)}
                </div>
                <div className="changes mini">
                  {diff.items.length === 0 && <div className="dim">{t("Заметных изменений нет")}</div>}
                  {diff.items.map((it) => (
                    <button key={it.path} className="change-row" onClick={() => void openPath(it.path, it.dir)} title={it.path}>
                      {it.dir ? <Folder size={14} className="tone-sun" /> : <File size={14} />}
                      <span className="ellipsis rtl">{it.path}</span>
                      <b className={it.delta > 0 ? "tone-bad" : "tone-ok"}>{fmtDelta(it.delta)}</b>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <div className="card-sub top">{t("После следующего сканирования здесь появится список папок, которые выросли или уменьшились.")}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
