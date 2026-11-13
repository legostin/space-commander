import { useEffect, useRef, useState } from "react";
import { ArrowUp, ChevronRight, Cloud, EyeOff, File, Folder, FolderOpen, LayoutGrid, Link2, Lock, RefreshCw, Settings, Trash2 } from "lucide-react";
import { call, DirView, NodeDto, SubNode } from "../api";
import { catOf, F_CLOUD, F_DENIED, F_HIDDEN, F_REPARSE, F_SYSTEM, fmtAgo, fmtBytes, fmtCount, fmtPct } from "../format";
import { VisibilityToggles } from "../components/Chrome";
import { useStore } from "../store";
import { Bar, ContextMenu, Empty, MenuItem, Size } from "../components/ui";
import { Treemap } from "../components/Treemap";
import { fileMenu } from "../components/DeleteDialog";

function joinPath(base: string, name: string) {
  return base.endsWith("\\") ? base + name : `${base}\\${name}`;
}

export function Explorer() {
  const root = useStore((s) => s.activeRoot);
  const scan = useStore((s) => (s.activeRoot ? s.scans[s.activeRoot] : undefined));
  const drives = useStore((s) => s.drives);
  const nodeId = useStore((s) => s.nodeId);
  const selected = useStore((s) => s.selected);
  const byAlloc = useStore((s) => s.byAlloc);
  const treeVersion = useStore((s) => s.treeVersion);
  const navigate = useStore((s) => s.navigate);
  const select = useStore((s) => s.select);
  const setByAlloc = useStore((s) => s.setByAlloc);
  const setVisibility = useStore((s) => s.setVisibility);
  const startScan = useStore((s) => s.startScan);
  const scanning = useStore((s) => s.scanning);
  const askDelete = useStore((s) => s.askDelete);
  const toast = useStore((s) => s.toast);

  const [view, setView] = useState<DirView | null>(null);
  const [sub, setSub] = useState<SubNode[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; items: (MenuItem | null)[] } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!root || !scan) return;
    let stale = false;
    Promise.all([call<DirView>("get_dir", { root, id: nodeId, byAlloc }), call<SubNode[]>("get_subtree", { root, id: nodeId, budget: 7000, byAlloc })])
      .then(([v, s]) => {
        if (stale) return;
        setView(v);
        setSub(s);
      })
      .catch(() => {
        // Папку удалили или диск пересканировали — возвращаемся в корень.
        if (!stale && nodeId !== 0) navigate(0);
      });
    return () => {
      stale = true;
    };
  }, [root, scan?.scanned_at, nodeId, byAlloc, treeVersion]);

  const goUp = () => {
    if (view && view.crumbs.length > 1) navigate(view.crumbs[view.crumbs.length - 2].id, view.node.id);
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "Backspace" || (e.altKey && e.key === "ArrowUp")) {
        e.preventDefault();
        goUp();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  // Выбранную строку держим в видимой части списка.
  useEffect(() => {
    if (selected == null) return;
    listRef.current?.querySelector(".list-row.selected")?.scrollIntoView({ block: "nearest" });
  }, [selected, view]);

  if (!root || !scan) {
    const d = drives.find((x) => x.kind === "fixed") ?? drives[0];
    return (
      <div className="page center">
        <Empty
          icon={<LayoutGrid size={30} />}
          title="Карта появится после сканирования"
          text="Сканирование только читает структуру папок — файлы не открываются и не изменяются."
          action={
            d && (
              <button className="btn primary" disabled={!!scanning} onClick={() => void startScan(d.root, "auto")}>
                Сканировать {d.letter}:
              </button>
            )
          }
        />
      </div>
    );
  }
  if (!view) return <div className="page" />;

  const total = byAlloc ? view.node.alloc : view.node.size;
  const metric = (n: NodeDto) => (byAlloc ? n.alloc : n.size);
  const hiddenAmount = byAlloc ? scan.hidden_alloc : scan.hidden_size;

  // Выбранный объект может лежать глубже текущей папки (щелчок по карте): тогда путь
  // собираем по цепочке родителей в данных карты, а в списке подсвечиваем его предка.
  let sel: { id: number; name: string; dir: boolean; cat: number; files: number; size: number; mtime: number; path: string } | null = null;
  let selTop: number | null = null;
  if (selected != null) {
    const child = view.children.find((c) => c.id === selected);
    if (child) {
      sel = { id: child.id, name: child.name, dir: child.dir, cat: child.cat, files: child.files, size: metric(child), mtime: child.mtime, path: joinPath(view.path, child.name) };
      selTop = child.id;
    } else {
      const i = sub.findIndex((n) => n.id === selected);
      if (i > 0) {
        const parts: string[] = [];
        let k = i;
        for (; sub[k].p > 0; k = sub[k].p) parts.push(sub[k].name);
        parts.push(sub[k].name);
        selTop = sub[k].id;
        const n = sub[i];
        sel = { id: n.id, name: n.name, dir: n.dir, cat: n.cat, files: n.files, size: n.size, mtime: 0, path: joinPath(view.path, parts.reverse().join("\\")) };
      }
    }
  }

  const openMenu = (n: { id: number; name: string; dir: boolean; size: number }, path: string, x: number, y: number) => {
    setMenu({
      x,
      y,
      items: fileMenu({ root, id: n.id, name: n.name, path, size: n.size, dir: n.dir, onOpen: n.dir ? () => navigate(n.id) : undefined }),
    });
  };

  return (
    <div className="explorer">
      <div className="toolbar">
        <button className="icon-btn" onClick={goUp} disabled={view.crumbs.length < 2} title="На уровень выше (Backspace)">
          <ArrowUp size={16} />
        </button>
        <div className="crumbs">
          {view.crumbs.map((c, i) => (
            <span key={c.id} className="crumb-wrap">
              {i > 0 && <ChevronRight size={13} />}
              <button className={i === view.crumbs.length - 1 ? "current" : ""} onClick={() => navigate(c.id)}>
                {i === 0 ? c.name.replace(/\\$/, "") : c.name}
              </button>
            </span>
          ))}
        </div>
        <div className="grow" />
        <VisibilityToggles />
        <div className="seg" title="«На диске» учитывает сжатие, разрежённые и облачные файлы">
          <button className={byAlloc ? "on" : ""} onClick={() => setByAlloc(true)}>
            На диске
          </button>
          <button className={!byAlloc ? "on" : ""} onClick={() => setByAlloc(false)}>
            Размер
          </button>
        </div>
        <button className="btn sm" disabled={!!scanning} onClick={() => void startScan(root, "auto")} title={`Просканировано ${fmtAgo(scan.scanned_at)}`}>
          <RefreshCw size={13} />
          Обновить
        </button>
      </div>

      <div className="explorer-body">
        <div className="list-pane">
          <div className="list-head">
            <div>
              <Size bytes={total} className="big" />
              <span>
                {fmtCount(view.node.files)} файлов · {view.children.length} объектов
              </span>
            </div>
            {hiddenAmount > 0 && (
              <button className="hidden-note" onClick={() => void setVisibility(true, true)} title="Показать скрытые и системные объекты">
                <EyeOff size={12} />
                На диске ещё {fmtBytes(hiddenAmount)} — скрыто фильтром
                <span>Показать</span>
              </button>
            )}
          </div>
          <div className="list" ref={listRef}>
            {view.children.map((c) => {
              const m = metric(c);
              return (
                <div
                  key={c.id}
                  data-id={c.id}
                  className={`list-row ${selTop === c.id ? "selected" : ""}`}
                  onClick={() => select(c.id)}
                  onDoubleClick={() => c.dir && navigate(c.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    select(c.id);
                    openMenu({ id: c.id, name: c.name, dir: c.dir, size: m }, joinPath(view.path, c.name), e.clientX, e.clientY);
                  }}
                >
                  <span className="list-icon">{c.dir ? <Folder size={16} className="tone-sun" /> : <File size={16} style={{ color: catOf(c.cat).color }} />}</span>
                  <span className="list-main">
                    <span className="list-name">
                      <span className="ellipsis">{c.name}</span>
                      {c.flags & F_SYSTEM ? (
                        <span title="Системный объект">
                          <Settings size={11} />
                        </span>
                      ) : c.flags & F_HIDDEN ? (
                        <span title="Скрытый объект">
                          <EyeOff size={11} />
                        </span>
                      ) : null}
                      {c.flags & F_DENIED ? (
                        <span title="Нет доступа — размер неизвестен">
                          <Lock size={11} className="tone-warn" />
                        </span>
                      ) : null}
                      {c.flags & F_REPARSE ? (
                        <span title="Ссылка на другое место — не учитывается">
                          <Link2 size={11} />
                        </span>
                      ) : null}
                      {c.flags & F_CLOUD ? (
                        <span title="Облачный файл — на диске занимает меньше">
                          <Cloud size={11} />
                        </span>
                      ) : null}
                    </span>
                    <Bar value={m / (total || 1)} thin color={c.dir ? undefined : catOf(c.cat).color} />
                  </span>
                  <span className="list-pct">{fmtPct(m, total)}</span>
                  <Size bytes={m} />
                </div>
              );
            })}
            {view.children.length === 0 && <div className="list-empty">Папка пуста{view.node.flags & F_DENIED ? " или закрыта для чтения" : ""}</div>}
          </div>
        </div>

        <div className="map-pane">
          <Treemap
            data={sub}
            rootPath={view.path}
            selected={selected}
            onSelect={select}
            onEnter={(id) => navigate(id)}
            onContext={(n, path, x, y) => openMenu({ id: n.id, name: n.name, dir: n.dir, size: n.size }, path, x, y)}
          />
        </div>
      </div>

      <div className="statusbar">
        {sel ? (
          <>
            <span className="dot" style={{ background: sel.dir ? "#ffc46b" : catOf(sel.cat).color }} />
            <b className="ellipsis">{sel.path}</b>
            <span>{fmtBytes(sel.size)}</span>
            {sel.dir ? <span>{fmtCount(sel.files)} файлов</span> : <span>{catOf(sel.cat).name}</span>}
            {sel.mtime > 0 && <span>изменён {fmtAgo(sel.mtime)}</span>}
            <span className="grow" />
            <button className="btn sm ghost" onClick={() => void call("reveal", { path: sel!.path }).catch((e) => toast("error", "Не удалось открыть Проводник", String(e)))}>
              <FolderOpen size={13} />
              В Проводнике
            </button>
            <button className="btn sm ghost danger-text" onClick={() => askDelete({ root, items: [{ id: sel!.id, name: sel!.name, size: sel!.size }], permanent: false })}>
              <Trash2 size={13} />
              В Корзину
            </button>
          </>
        ) : (
          <>
            <span>Щелчок — выбрать · двойной щелчок — войти в папку · правая кнопка — действия</span>
            <span className="grow" />
            <span className="legend">
              {[1, 3, 4, 5, 6, 7, 8, 10, 9, 0].map((c) => (
                <i key={c}>
                  <span className="dot" style={{ background: catOf(c).color }} />
                  {catOf(c).name}
                </i>
              ))}
            </span>
          </>
        )}
      </div>
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
