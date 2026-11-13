import { useEffect, useRef, useState } from "react";
import { CalendarClock, ChartColumn, Eye, EyeOff, File, Folder, LayoutDashboard, LayoutGrid, Minus, Search, ShieldCheck, Sparkles, Square, User, X, Zap } from "lucide-react";
import { call, FileDto, windowAction } from "../api";
import { catOf, fmtBytes, fmtCount, fmtDuration, fmtNum, fmtPct } from "../format";
import { reclaimable, useStore, View } from "../store";
import { Bar, Size, Spinner } from "./ui";

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <defs>
        <linearGradient id="lg-sun" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffc46b" />
          <stop offset="1" stopColor="#ff5f57" />
        </linearGradient>
        <linearGradient id="lg-sky" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#7dd3fc" />
          <stop offset="1" stopColor="#a78bfa" />
        </linearGradient>
      </defs>
      <circle cx="32" cy="32" r="25" fill="none" stroke="rgba(255,255,255,.1)" strokeWidth="7" />
      <path d="M32 7 A25 25 0 1 1 10.3 44.5" fill="none" stroke="url(#lg-sun)" strokeWidth="7" strokeLinecap="round" />
      <circle cx="32" cy="32" r="12" fill="none" stroke="url(#lg-sky)" strokeWidth="4.5" strokeDasharray="46 30" strokeLinecap="round" transform="rotate(140 32 32)" />
      <circle cx="32" cy="32" r="4" fill="url(#lg-sun)" />
    </svg>
  );
}

function GlobalSearch() {
  const root = useStore((s) => s.activeRoot);
  const scans = useStore((s) => s.scans);
  const byAlloc = useStore((s) => s.byAlloc);
  const open = useStore((s) => s.openInExplorer);
  const [q, setQ] = useState("");
  const [res, setRes] = useState<{ total: number; items: FileDto[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [focus, setFocus] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const ready = !!root && !!scans[root];

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  useEffect(() => {
    if (!ready || q.trim().length < 2) {
      setRes(null);
      return;
    }
    setBusy(true);
    let stale = false;
    const t = window.setTimeout(async () => {
      try {
        const r = await call<{ total: number; items: FileDto[] }>("search", { root, query: q, limit: 40, byAlloc });
        if (!stale) {
          setRes(r);
          setActive(0);
        }
      } finally {
        if (!stale) setBusy(false);
      }
    }, 140);
    return () => {
      stale = true;
      window.clearTimeout(t);
    };
  }, [q, root, ready, byAlloc]);

  const go = async (f: FileDto) => {
    if (!root) return;
    const parent = f.dir ? f.id : await call<number>("parent_of", { root, id: f.id });
    open(root, parent, f.dir ? null : f.id);
    setFocus(false);
    input.current?.blur();
  };

  return (
    <div className="search" data-open={focus && q.trim().length >= 2}>
      <Search size={14} />
      <input
        ref={input}
        value={q}
        placeholder={ready ? "Поиск по именам: отчёт, *.iso, node_modules…" : "Поиск появится после сканирования"}
        disabled={!ready}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => setFocus(true)}
        onBlur={() => window.setTimeout(() => setFocus(false), 150)}
        onKeyDown={(e) => {
          if (!res) return;
          if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, res.items.length - 1));
          else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
          else if (e.key === "Enter" && res.items[active]) void go(res.items[active]);
          else if (e.key === "Escape") input.current?.blur();
          else return;
          e.preventDefault();
        }}
      />
      {busy ? <Spinner size={13} /> : <kbd>Ctrl K</kbd>}
      {focus && q.trim().length >= 2 && (
        <div className="search-pop">
          {res && res.items.length === 0 && <div className="search-empty">Ничего не найдено</div>}
          {res?.items.map((f, i) => (
            <button key={f.id} className={`search-row ${i === active ? "active" : ""}`} onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => void go(f)}>
              {f.dir ? <Folder size={15} className="tone-sun" /> : <File size={15} style={{ color: catOf(f.cat).color }} />}
              <span className="search-name">
                <b>{f.name}</b>
                <small>{f.path}</small>
              </span>
              <Size bytes={byAlloc ? f.alloc : f.size} />
            </button>
          ))}
          {res && res.total > res.items.length && <div className="search-more">Показаны {res.items.length} крупнейших из {fmtNum(res.total)}</div>}
        </div>
      )}
    </div>
  );
}

export function Titlebar() {
  const priv = useStore((s) => s.priv);
  const setView = useStore((s) => s.setView);
  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="brand" data-tauri-drag-region>
        <Logo />
        <span data-tauri-drag-region>Space Commander</span>
      </div>
      <GlobalSearch />
      <div className="titlebar-right" data-tauri-drag-region>
        {priv && (
          <button className={`chip ${priv.elevated ? "elevated" : ""}`} onClick={() => setView("access")} title="Подробнее о правах доступа">
            {priv.elevated ? <ShieldCheck size={13} /> : <User size={13} />}
            {priv.elevated ? "Администратор" : "Обычные права"}
          </button>
        )}
        <div className="winbtns">
          <button onClick={() => void windowAction("minimize")} aria-label="Свернуть">
            <Minus size={15} />
          </button>
          <button onClick={() => void windowAction("toggleMaximize")} aria-label="Развернуть">
            <Square size={12} />
          </button>
          <button className="close" onClick={() => void windowAction("close")} aria-label="Закрыть">
            <X size={16} />
          </button>
        </div>
      </div>
    </header>
  );
}

const NAV: { id: View; label: string; icon: React.ReactNode }[] = [
  { id: "overview", label: "Обзор", icon: <LayoutDashboard size={17} /> },
  { id: "explorer", label: "Карта диска", icon: <LayoutGrid size={17} /> },
  { id: "analysis", label: "Анализ", icon: <ChartColumn size={17} /> },
  { id: "cleanup", label: "Очистка", icon: <Sparkles size={17} /> },
  { id: "schedule", label: "Расписание", icon: <CalendarClock size={17} /> },
  { id: "access", label: "Права доступа", icon: <ShieldCheck size={17} /> },
];

export function Sidebar() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const drives = useStore((s) => s.drives);
  const junk = useStore((s) => s.junk);
  const activeRoot = useStore((s) => s.activeRoot);
  const scans = useStore((s) => s.scans);
  const elevated = useStore((s) => !!s.priv?.elevated);
  const reclaim = reclaimable(junk, elevated).reduce((s, j) => s + j.size, 0);
  const drive = drives.find((d) => d.root === activeRoot) ?? drives[0];
  const scan = drive ? scans[drive.root] : undefined;

  return (
    <nav className="sidebar">
      <div className="nav">
        {NAV.map((n) => (
          <button key={n.id} className={`nav-item ${view === n.id ? "active" : ""}`} onClick={() => setView(n.id)}>
            {n.icon}
            <span>{n.label}</span>
            {n.id === "cleanup" && reclaim > 100 * 1024 * 1024 && <em>{fmtBytes(reclaim)}</em>}
          </button>
        ))}
      </div>
      {drive && (
        <div className="side-drive">
          <div className="side-drive-top">
            <b>{drive.label || "Локальный диск"} ({drive.letter}:)</b>
            <span>{fmtPct(drive.total - drive.free, drive.total, 0)}</span>
          </div>
          <Bar value={(drive.total - drive.free) / drive.total} thin />
          <div className="side-drive-bottom">
            Свободно <Size bytes={drive.free} /> из <Size bytes={drive.total} />
          </div>
          {scan && (
            <div className="side-scan">
              {scan.mode === "mft" && <Zap size={11} />}
              {fmtCount(scan.files)} файлов · {fmtDuration(scan.duration_ms)}
            </div>
          )}
        </div>
      )}
    </nav>
  );
}

/** Переключатели «Скрытые» и «Системные»: выключенные объекты пропадают из списков, карты и сумм. */
export function VisibilityToggles() {
  const showHidden = useStore((s) => s.showHidden);
  const showSystem = useStore((s) => s.showSystem);
  const setVisibility = useStore((s) => s.setVisibility);
  return (
    <div className="vis" role="group" aria-label="Что показывать">
      <button
        className={showHidden ? "on" : ""}
        aria-pressed={showHidden}
        onClick={() => void setVisibility(!showHidden, showSystem)}
        title={showHidden ? "Скрытые файлы и папки показаны (например, AppData, ProgramData). Нажмите, чтобы убрать их из карты и сумм." : "Скрытые файлы и папки убраны из карты и сумм. Нажмите, чтобы показать."}
      >
        {showHidden ? <Eye size={13} /> : <EyeOff size={13} />}
        Скрытые
      </button>
      <button
        className={showSystem ? "on" : ""}
        aria-pressed={showSystem}
        onClick={() => void setVisibility(showHidden, !showSystem)}
        title={showSystem ? "Системные файлы и папки показаны (файл подкачки, гибернация, точки восстановления, служебные файлы NTFS). Нажмите, чтобы убрать их из карты и сумм." : "Системные файлы и папки убраны из карты и сумм. Нажмите, чтобы показать."}
      >
        {showSystem ? <Eye size={13} /> : <EyeOff size={13} />}
        Системные
      </button>
    </div>
  );
}

export function ScanOverlay() {
  const scanning = useStore((s) => s.scanning);
  const cancel = useStore((s) => s.cancelScan);
  const drives = useStore((s) => s.drives);
  const priv = useStore((s) => s.priv);
  if (!scanning) return null;
  const p = scanning.progress;
  const drive = drives.find((d) => d.root === scanning.root);
  const used = drive ? drive.total - drive.free : 0;
  const mft = p?.mode === "mft";
  let frac = 0;
  if (p) {
    if (mft && p.total > 0) frac = p.done / p.total;
    else if (used > 0) frac = Math.min(0.99, p.bytes / used);
  }
  return (
    <div className="scan-overlay">
      <div className="scan-card">
        <div className="orbit">
          <i />
          <i />
          <i />
          <Logo size={44} />
        </div>
        <div className="scan-title">Сканирую {scanning.root.replace(/\\$/, "")}</div>
        <div className={`scan-mode ${mft ? "fast" : ""}`}>
          {mft ? (
            <>
              <Zap size={12} /> Быстрый режим · чтение таблицы файлов
            </>
          ) : (
            "Обычный режим · обход папок"
          )}
        </div>
        <div className="scan-stats">
          <div>
            <b>{fmtNum(p?.files ?? 0)}</b>
            <span>файлов</span>
          </div>
          <div>
            <b>{fmtNum(p?.dirs ?? 0)}</b>
            <span>папок</span>
          </div>
          <div>
            <b>{fmtBytes(p?.bytes ?? 0)}</b>
            <span>найдено</span>
          </div>
          <div>
            <b>{fmtDuration(p?.elapsed_ms ?? 0)}</b>
            <span>прошло</span>
          </div>
        </div>
        <div className="scan-bar">
          <div style={{ width: `${frac * 100}%` }} />
        </div>
        {!mft && priv && !priv.elevated && <div className="scan-hint">Первый проход по диску самый долгий: Windows читает каталоги с диска. Повторные сканирования занимают секунды.</div>}
        <button className="btn ghost" onClick={cancel}>
          Отменить
        </button>
      </div>
    </div>
  );
}
