import { useEffect, useMemo, useState } from "react";
import { ArrowRight, CalendarClock, Folder, HardDrive, LayoutGrid, Sparkles, TrendingDown, TrendingUp, Usb, Zap } from "lucide-react";
import { call, DirView, Drive, RunLog, Sample, Task } from "../api";
import { catOf, fmtAgo, fmtBytes, fmtCount, fmtDuration, fmtPct } from "../format";
import { reclaimable, useStore } from "../store";
import { Bar, Ring, Size, Spinner } from "../components/ui";
import { describeSchedule, nextRun } from "./Schedule";

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
        <div className="ring-sub">занято</div>
      </Ring>
      <div className="drive-info">
        <div className="drive-name">
          {d.kind === "removable" ? <Usb size={15} /> : <HardDrive size={15} />}
          <b>{d.label || (d.kind === "removable" ? "Съёмный диск" : "Локальный диск")}</b>
          <span>{d.letter}:</span>
          <em>{d.fs}</em>
        </div>
        <div className="drive-nums">
          <div>
            <Size bytes={d.free} className="big" />
            <span>свободно</span>
          </div>
          <div>
            <Size bytes={used} className="big dim" />
            <span>занято из {fmtBytes(d.total)}</span>
          </div>
        </div>
        <div className="drive-actions">
          {scan ? (
            <button className="btn primary" onClick={() => open(d.root, 0)}>
              <LayoutGrid size={15} />
              Открыть карту
            </button>
          ) : (
            <button className="btn primary" disabled={!!scanning} onClick={() => void startScan(d.root, "auto")}>
              {busy ? <Spinner /> : priv?.elevated && canFast ? <Zap size={15} /> : <LayoutGrid size={15} />}
              Сканировать
            </button>
          )}
          {scan && (
            <button className="btn" disabled={!!scanning} onClick={() => void startScan(d.root, "auto")}>
              Обновить
            </button>
          )}
          {!priv?.elevated && canFast && (
            <button className="btn ghost" disabled={!!scanning} onClick={() => askElevation({ reason: "scan", root: d.root })} title="Чтение таблицы файлов напрямую — нужны права администратора">
              <Zap size={14} />
              Быстрый режим
            </button>
          )}
        </div>
        <div className="drive-meta">
          {scan ? (
            <>
              {scan.mode === "mft" && <Zap size={11} className="tone-sun" />}
              {fmtCount(scan.files)} файлов за {fmtDuration(scan.duration_ms)} · {fmtAgo(scan.scanned_at)}
            </>
          ) : canFast ? (
            priv?.elevated ? "Будет использован быстрый режим" : "Обычный режим — без прав администратора"
          ) : (
            `${d.fs}: обход папок`
          )}
        </div>
      </div>
    </div>
  );
}

function Spark({ points, total }: { points: { t: number; free: number }[]; total: number }) {
  const W = 320;
  const H = 86;
  if (points.length < 2) return <div className="spark-empty">История появится после нескольких запусков</div>;
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
          <stop offset="0" stopColor="#7dd3fc" stopOpacity=".28" />
          <stop offset="1" stopColor="#7dd3fc" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L${W} ${H} L0 ${H} Z`} fill="url(#spark-fill)" />
      <path d={line} fill="none" stroke="#7dd3fc" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r="3.5" fill="#7dd3fc" />
    </svg>
  );
}

export function Overview() {
  const drives = useStore((s) => s.drives);
  const junk = useStore((s) => s.junk);
  const junkLoading = useStore((s) => s.junkLoading);
  const setView = useStore((s) => s.setView);
  const activeRoot = useStore((s) => s.activeRoot);
  const scans = useStore((s) => s.scans);
  const byAlloc = useStore((s) => s.byAlloc);
  const treeVersion = useStore((s) => s.treeVersion);
  const open = useStore((s) => s.openInExplorer);
  const [history, setHistory] = useState<Sample[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [runs, setRuns] = useState<RunLog[]>([]);
  const [top, setTop] = useState<DirView | null>(null);

  const mainDrive = drives.find((d) => d.root === activeRoot) ?? drives.find((d) => d.kind === "fixed") ?? drives[0];
  const scanned = activeRoot && scans[activeRoot] ? activeRoot : null;

  useEffect(() => {
    void call<Sample[]>("history_get").then(setHistory);
    void call<Task[]>("tasks_list").then(setTasks);
    void call<RunLog[]>("task_runs").then(setRuns);
  }, []);

  useEffect(() => {
    if (!scanned) return setTop(null);
    void call<DirView>("get_dir", { root: scanned, id: 0, byAlloc }).then(setTop).catch(() => setTop(null));
  }, [scanned, byAlloc, treeVersion]);

  const elevated = useStore((s) => !!s.priv?.elevated);
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

  const active = tasks.filter((t) => t.enabled);
  const next = active.map((t) => ({ t, at: nextRun(t) })).sort((a, b) => a.at - b.at)[0];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Обзор</h1>
          <p>Куда ушло место и сколько можно вернуть</p>
        </div>
      </div>

      <div className="drive-grid">
        {drives.map((d) => (
          <DriveCard key={d.root} d={d} />
        ))}
      </div>

      <div className="grid3">
        <div className="card clickable" onClick={() => setView("cleanup")}>
          <div className="card-head">
            <span>
              <Sparkles size={15} className="tone-sun" /> Можно освободить
            </span>
            <ArrowRight size={15} />
          </div>
          {junk ? (
            <>
              <div className="hero-num">
                <Size bytes={reclaim} />
              </div>
              <div className="card-sub">безопасно{caution > 0 && <> · ещё {fmtBytes(caution)} с оговорками</>}</div>
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
              {junkLoading && <Spinner />} Ищу кеши и временные файлы…
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <span>
              {delta < 0 ? <TrendingDown size={15} className="tone-bad" /> : <TrendingUp size={15} className="tone-ok" />} Свободное место{mainDrive ? ` на ${mainDrive.letter}:` : ""}
            </span>
          </div>
          <div className="hero-num">{mainDrive && <Size bytes={mainDrive.free} />}</div>
          <div className="card-sub">
            {points.length > 1 ? (
              <>
                <span className={delta < 0 ? "tone-bad" : "tone-ok"}>
                  {delta < 0 ? "−" : "+"}
                  {fmtBytes(Math.abs(delta))}
                </span>{" "}
                за {spanDays} дн.
              </>
            ) : (
              "Собираю историю"
            )}
          </div>
          <Spark points={points} total={mainDrive?.total ?? 1} />
        </div>

        <div className="card clickable" onClick={() => setView("schedule")}>
          <div className="card-head">
            <span>
              <CalendarClock size={15} className="tone-sky" /> Расписание
            </span>
            <ArrowRight size={15} />
          </div>
          {next ? (
            <>
              <div className="hero-num small">{next.t.name}</div>
              <div className="card-sub">{describeSchedule(next.t)}</div>
            </>
          ) : (
            <>
              <div className="hero-num small">Задач нет</div>
              <div className="card-sub">Настройте автоматическую уборку кешей — приложению не нужно быть запущенным</div>
            </>
          )}
          <div className="mini-list runs">
            {runs.slice(0, 3).map((r, i) => (
              <div key={i}>
                <span>{fmtAgo(r.at)}</span>
                <span className="grow" />
                <span>
                  освобождено <b>{fmtBytes(r.freed)}</b>
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {top && scanned && (
        <div className="card">
          <div className="card-head">
            <span>
              <Folder size={15} className="tone-sun" /> Самое тяжёлое на {scanned.replace(/\\$/, "")}
            </span>
            <button className="btn sm ghost" onClick={() => open(scanned, 0)}>
              Вся карта <ArrowRight size={13} />
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
    </div>
  );
}
