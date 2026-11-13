import { useEffect, useMemo, useState } from "react";
import { ChartColumn, CopyMinus, File, Folder, Trash2 } from "lucide-react";
import { call, DupResult, ExtStat, FileDto, listen } from "../api";
import { CATEGORIES, catOf, fmtAgo, fmtBytes, fmtCount, fmtNum, fmtPct, plural } from "../format";
import { useStore } from "../store";
import { Bar, Check, ContextMenu, Empty, MenuItem, Size, Spinner } from "../components/ui";
import { fileMenu } from "../components/DeleteDialog";
import { VisibilityToggles } from "../components/Chrome";

function useOpenFile(root: string | null) {
  const open = useStore((s) => s.openInExplorer);
  return async (f: { id: number; dir?: boolean }) => {
    if (!root) return;
    if (f.dir) return open(root, f.id);
    const parent = await call<number>("parent_of", { root, id: f.id });
    open(root, parent, f.id);
  };
}

function TopFiles({ root }: { root: string }) {
  const byAlloc = useStore((s) => s.byAlloc);
  const treeVersion = useStore((s) => s.treeVersion);
  const [files, setFiles] = useState<FileDto[] | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: (MenuItem | null)[] } | null>(null);
  const openFile = useOpenFile(root);

  useEffect(() => {
    void call<FileDto[]>("top_files", { root, id: 0, limit: 300, byAlloc }).then(setFiles);
  }, [root, byAlloc, treeVersion]);

  if (!files) return <div className="pad center-row"><Spinner /></div>;
  const max = files[0] ? (byAlloc ? files[0].alloc : files[0].size) : 1;
  return (
    <div className="table">
      <div className="tr th">
        <span className="c-n">#</span>
        <span className="c-name">Файл</span>
        <span className="c-cat">Тип</span>
        <span className="c-date">Изменён</span>
        <span className="c-bar" />
        <span className="c-size">{byAlloc ? "На диске" : "Размер"}</span>
      </div>
      <div className="tbody">
        {files.map((f, i) => {
          const m = byAlloc ? f.alloc : f.size;
          return (
            <div
              key={f.id}
              className="tr"
              onDoubleClick={() => void openFile(f)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, items: fileMenu({ root, id: f.id, name: f.name, path: f.path, size: m, dir: false, onOpen: () => void openFile(f) }) });
              }}
            >
              <span className="c-n">{i + 1}</span>
              <span className="c-name">
                <File size={15} style={{ color: catOf(f.cat).color }} />
                <span className="two-line">
                  <b>{f.name}</b>
                  <small>{f.path.slice(0, f.path.length - f.name.length - 1)}</small>
                </span>
              </span>
              <span className="c-cat">{catOf(f.cat).name}</span>
              <span className="c-date">{fmtAgo(f.mtime)}</span>
              <span className="c-bar">
                <Bar value={m / max} thin color={catOf(f.cat).color} />
              </span>
              <span className="c-size">
                <Size bytes={m} />
              </span>
            </div>
          );
        })}
      </div>
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

function Types({ root }: { root: string }) {
  const byAlloc = useStore((s) => s.byAlloc);
  const treeVersion = useStore((s) => s.treeVersion);
  const [stats, setStats] = useState<ExtStat[] | null>(null);
  const [cat, setCat] = useState<number | null>(null);

  useEffect(() => {
    void call<ExtStat[]>("ext_stats", { root, id: 0 }).then(setStats);
  }, [root, treeVersion]);

  const m = (e: ExtStat) => (byAlloc ? e.alloc : e.size);
  const cats = useMemo(() => {
    const map = new Map<number, { size: number; count: number }>();
    for (const e of stats ?? []) {
      const c = map.get(e.cat) ?? { size: 0, count: 0 };
      c.size += m(e);
      c.count += e.count;
      map.set(e.cat, c);
    }
    return [...map.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.size - a.size);
  }, [stats, byAlloc]);

  if (!stats) return <div className="pad center-row"><Spinner /></div>;
  const total = cats.reduce((s, c) => s + c.size, 0) || 1;
  const rows = stats.filter((e) => cat == null || e.cat === cat).sort((a, b) => m(b) - m(a)).slice(0, 200);
  const max = rows[0] ? m(rows[0]) : 1;

  return (
    <div className="types">
      <div className="types-left">
        <div className="stack">
          {cats.map((c) => (
            <div key={c.id} style={{ flex: c.size, background: catOf(c.id).color }} title={`${catOf(c.id).name}: ${fmtBytes(c.size)}`} />
          ))}
        </div>
        <div className="cat-list">
          {cats.map((c) => (
            <button key={c.id} className={`cat-row ${cat === c.id ? "on" : ""}`} onClick={() => setCat(cat === c.id ? null : c.id)}>
              <span className="dot" style={{ background: catOf(c.id).color }} />
              <span className="cat-name">
                {catOf(c.id).name}
                <small>{fmtCount(c.count)} файлов</small>
              </span>
              <span className="cat-pct">{fmtPct(c.size, total)}</span>
              <Size bytes={c.size} />
            </button>
          ))}
        </div>
      </div>
      <div className="table">
        <div className="tr th">
          <span className="c-ext">Расширение</span>
          <span className="c-cat">Категория</span>
          <span className="c-count">Файлов</span>
          <span className="c-bar" />
          <span className="c-size">{byAlloc ? "На диске" : "Размер"}</span>
        </div>
        <div className="tbody">
          {rows.map((e) => (
            <div key={e.ext} className="tr">
              <span className="c-ext">
                <span className="dot" style={{ background: catOf(e.cat).color }} />
                <b>{e.ext ? `.${e.ext}` : "без расширения"}</b>
              </span>
              <span className="c-cat">{CATEGORIES[e.cat]?.name ?? "Прочее"}</span>
              <span className="c-count">{fmtNum(e.count)}</span>
              <span className="c-bar">
                <Bar value={m(e) / max} thin color={catOf(e.cat).color} />
              </span>
              <span className="c-size">
                <Size bytes={m(e)} />
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const MIN_SIZES = [
  { v: 1 << 20, label: "от 1 МБ" },
  { v: 10 << 20, label: "от 10 МБ" },
  { v: 100 << 20, label: "от 100 МБ" },
  { v: 1 << 30, label: "от 1 ГБ" },
];

function Dupes({ root }: { root: string }) {
  const askDelete = useStore((s) => s.askDelete);
  const toast = useStore((s) => s.toast);
  const openFile = useOpenFile(root);
  const [minSize, setMinSize] = useState(10 << 20);
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState<{ files: number; done: number; total: number } | null>(null);
  const [res, setRes] = useState<DupResult | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());

  useEffect(() => {
    const offs = [
      listen<{ files: number; done: number; total: number }>("dupes-progress", setProg),
      listen<DupResult>("dupes-done", (r) => {
        setRes(r);
        setBusy(false);
        setProg(null);
        setPicked(new Set());
      }),
      listen<string>("dupes-error", (e) => {
        setBusy(false);
        setProg(null);
        if (e !== "cancelled") toast("error", "Поиск дубликатов прерван", e);
      }),
    ];
    return () => offs.forEach((o) => o());
  }, []);

  const start = async () => {
    setBusy(true);
    setRes(null);
    try {
      await call("dupes_start", { root, id: 0, minSize });
    } catch (e) {
      setBusy(false);
      toast("error", "Не удалось начать поиск", String(e));
    }
  };

  const pickAllButOldest = () => {
    const s = new Set<number>();
    res?.groups.forEach((g) => g.files.slice(1).forEach((f) => s.add(f.id)));
    setPicked(s);
  };

  const pickedItems = useMemo(() => {
    const out: { id: number; name: string; size: number }[] = [];
    res?.groups.forEach((g) => g.files.forEach((f) => picked.has(f.id) && out.push({ id: f.id, name: f.path, size: g.size })));
    return out;
  }, [picked, res]);
  const pickedSize = pickedItems.reduce((s, i) => s + i.size, 0);

  const removeDeleted = (ids: number[]) => {
    const gone = new Set(ids);
    setRes((r) => {
      if (!r) return r;
      const groups = r.groups.map((g) => ({ ...g, files: g.files.filter((f) => !gone.has(f.id)) })).filter((g) => g.files.length > 1).map((g) => ({ ...g, wasted: g.size * (g.files.length - 1) }));
      return { ...r, groups, wasted: groups.reduce((s, g) => s + g.wasted, 0) };
    });
    setPicked(new Set());
  };

  return (
    <div className="dupes">
      <div className="dupes-bar">
        <div className="seg">
          {MIN_SIZES.map((m) => (
            <button key={m.v} className={minSize === m.v ? "on" : ""} disabled={busy} onClick={() => setMinSize(m.v)}>
              {m.label}
            </button>
          ))}
        </div>
        {busy ? (
          <button className="btn" onClick={() => void call("dupes_cancel")}>
            Остановить
          </button>
        ) : (
          <button className="btn primary" onClick={() => void start()}>
            <CopyMinus size={15} />
            {res ? "Искать заново" : "Найти дубликаты"}
          </button>
        )}
        <div className="grow" />
        {res && res.groups.length > 0 && (
          <>
            <button className="btn sm ghost" onClick={pickAllButOldest}>
              Выбрать всё, кроме самых старых копий
            </button>
            <button className="btn sm danger" disabled={!pickedItems.length} onClick={() => askDelete({ root, items: pickedItems, permanent: false, onDone: removeDeleted })}>
              <Trash2 size={13} />В Корзину{pickedItems.length > 0 && ` · ${fmtBytes(pickedSize)}`}
            </button>
          </>
        )}
      </div>

      {busy && (
        <div className="dupes-progress">
          <Spinner />
          <div>
            <b>Сравниваю содержимое файлов</b>
            <span>
              проверено {fmtNum(prog?.files ?? 0)} · прочитано {fmtBytes(prog?.done ?? 0)}
              {prog && prog.total > 0 && ` из ≤ ${fmtBytes(prog.total)}`}
            </span>
          </div>
        </div>
      )}

      {!busy && !res && (
        <Empty
          icon={<CopyMinus size={30} />}
          title="Одинаковые файлы в разных местах"
          text="Сначала отбираются файлы одинакового размера, затем сравнивается их содержимое. Жёсткие ссылки, облачные файлы и папка Windows не учитываются."
        />
      )}
      {res && res.groups.length === 0 && <Empty icon={<CopyMinus size={30} />} title="Дубликатов не найдено" text={`Проверено кандидатов: ${fmtNum(res.candidates)}`} />}

      {res && res.groups.length > 0 && (
        <>
          <div className="dupes-summary">
            Найдено {fmtNum(res.groups.length)} {plural(res.groups.length, "группа", "группы", "групп")} · лишние копии занимают <b>{fmtBytes(res.wasted)}</b>
          </div>
          <div className="dup-groups">
            {res.groups.map((g, gi) => (
              <div key={gi} className="dup-group">
                <div className="dup-head">
                  <b>
                    {g.files.length} × {fmtBytes(g.size)}
                  </b>
                  <span>лишнее: {fmtBytes(g.wasted)}</span>
                </div>
                {g.files.map((f, fi) => (
                  <div key={f.id} className="dup-file" onDoubleClick={() => void openFile(f)}>
                    <Check
                      checked={picked.has(f.id)}
                      onChange={(v) =>
                        setPicked((p) => {
                          const n = new Set(p);
                          if (v) n.add(f.id);
                          else n.delete(f.id);
                          return n;
                        })
                      }
                    />
                    <span className="ellipsis">{f.path}</span>
                    {fi === 0 && <em>самая старая</em>}
                    <span className="dim">{fmtAgo(f.mtime)}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function Analysis() {
  const root = useStore((s) => s.activeRoot);
  const scan = useStore((s) => (s.activeRoot ? s.scans[s.activeRoot] : undefined));
  const tab = useStore((s) => s.analysisTab);
  const setTab = useStore((s) => s.setAnalysisTab);
  const byAlloc = useStore((s) => s.byAlloc);
  const setByAlloc = useStore((s) => s.setByAlloc);
  const setView = useStore((s) => s.setView);

  if (!root || !scan) {
    return (
      <div className="page center">
        <Empty
          icon={<ChartColumn size={30} />}
          title="Анализ появится после сканирования"
          text="Крупнейшие файлы, разбивка по типам и поиск дубликатов строятся по результатам сканирования диска."
          action={
            <button className="btn primary" onClick={() => setView("overview")}>
              К выбору диска
            </button>
          }
        />
      </div>
    );
  }

  return (
    <div className="page full">
      <div className="page-head">
        <div>
          <h1>Анализ</h1>
          <p>
            <Folder size={12} /> {root.replace(/\\$/, "")} · {fmtCount(scan.files)} файлов
          </p>
        </div>
        <div className="row gap8">
          <div className="tabs">
            <button className={tab === "top" ? "on" : ""} onClick={() => setTab("top")}>
              Крупнейшие файлы
            </button>
            <button className={tab === "types" ? "on" : ""} onClick={() => setTab("types")}>
              Типы файлов
            </button>
            <button className={tab === "dupes" ? "on" : ""} onClick={() => setTab("dupes")}>
              Дубликаты
            </button>
          </div>
          <VisibilityToggles />
          {tab !== "dupes" && (
            <div className="seg">
              <button className={byAlloc ? "on" : ""} onClick={() => setByAlloc(true)}>
                На диске
              </button>
              <button className={!byAlloc ? "on" : ""} onClick={() => setByAlloc(false)}>
                Размер
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="card flush fill">
        {tab === "top" && <TopFiles root={root} />}
        {tab === "types" && <Types root={root} />}
        {/* Поиск дубликатов долгий — не размонтируем, чтобы не терять ход и результат. */}
        <div className="tab-keep" style={{ display: tab === "dupes" ? "contents" : "none" }}>
          <Dupes root={root} />
        </div>
      </div>
    </div>
  );
}
