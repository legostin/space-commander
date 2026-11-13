import { useEffect, useMemo, useState } from "react";
import { ChartColumn, CopyMinus, Download, File, Folder, FolderOpen, Gamepad2, History, LayoutGrid, Trash2, TriangleAlert } from "lucide-react";
import { call, Diff, DupResult, ExtStat, FileDto, InstalledApp, listen, SnapMeta } from "../api";
import { catOf, fmtAgo, fmtBytes, fmtCount, fmtDateTime, fmtDelta, fmtNum, fmtPct, plural } from "../format";
import { t } from "../i18n";
import { AnalysisTab, isDriveRoot, useStore } from "../store";
import { Bar, Check, ContextMenu, Empty, MenuItem, Size, Spinner } from "../components/ui";
import { exportCsv, fileMenu } from "../components/DeleteDialog";
import { VisibilityToggles } from "../components/Chrome";
import { pickBaseline } from "./Overview";

function useOpenFile(root: string | null) {
  const open = useStore((s) => s.openInExplorer);
  return async (f: { id: number; dir?: boolean }) => {
    if (!root) return;
    if (f.dir) return open(root, f.id);
    const parent = await call<number>("parent_of", { root, id: f.id });
    open(root, parent, f.id);
  };
}

const AGES = [
  { days: 0, label: "Любые" },
  { days: 180, label: "Старше полугода" },
  { days: 365, label: "Старше года" },
  { days: 730, label: "Старше двух лет" },
];

function TopFiles({ root }: { root: string }) {
  const byAlloc = useStore((s) => s.byAlloc);
  const treeVersion = useStore((s) => s.treeVersion);
  const [files, setFiles] = useState<FileDto[] | null>(null);
  const [age, setAge] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number; items: (MenuItem | null)[] } | null>(null);
  const openFile = useOpenFile(root);

  useEffect(() => {
    void call<FileDto[]>("top_files", { root, id: 0, limit: 300, byAlloc, olderThanDays: age }).then(setFiles);
  }, [root, byAlloc, treeVersion, age]);

  const max = files?.[0] ? (byAlloc ? files[0].alloc : files[0].size) : 1;
  const sum = (files ?? []).reduce((s, f) => s + (byAlloc ? f.alloc : f.size), 0);
  return (
    <div className="table">
      <div className="tab-bar">
        <div className="seg" title={t("По дате последнего изменения файла")}>
          {AGES.map((a) => (
            <button key={a.days} className={age === a.days ? "on" : ""} onClick={() => setAge(a.days)}>
              {t(a.label)}
            </button>
          ))}
        </div>
        {files && age > 0 && (
          <span className="dim">
            {t("{0} крупнейших занимают {1}", files.length, fmtBytes(sum))}
          </span>
        )}
        <div className="grow" />
        <button className="btn sm ghost" onClick={() => void exportCsv(root, "top", 0, age)}>
          <Download size={13} />
          CSV
        </button>
      </div>
      <div className="tr th">
        <span className="c-n">#</span>
        <span className="c-name">{t("Файл")}</span>
        <span className="c-cat">{t("Тип")}</span>
        <span className="c-date">{t("Изменён")}</span>
        <span className="c-bar" />
        <span className="c-size">{byAlloc ? t("На диске") : t("Размер")}</span>
      </div>
      <div className="tbody">
        {!files && (
          <div className="pad center-row">
            <Spinner />
          </div>
        )}
        {files?.length === 0 && <div className="pad dim">{t("Таких файлов нет.")}</div>}
        {files?.map((f, i) => {
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

  if (!stats)
    return (
      <div className="pad center-row">
        <Spinner />
      </div>
    );
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
                <small>
                  {fmtCount(c.count)} {t("файлов")}
                </small>
              </span>
              <span className="cat-pct">{fmtPct(c.size, total)}</span>
              <Size bytes={c.size} />
            </button>
          ))}
        </div>
        <button className="btn sm ghost export" onClick={() => void exportCsv(root, "types", 0)}>
          <Download size={13} />
          CSV
        </button>
      </div>
      <div className="table">
        <div className="tr th">
          <span className="c-ext">{t("Расширение")}</span>
          <span className="c-cat">{t("Категория")}</span>
          <span className="c-count">{t("Файлов")}</span>
          <span className="c-bar" />
          <span className="c-size">{byAlloc ? t("На диске") : t("Размер")}</span>
        </div>
        <div className="tbody">
          {rows.map((e) => (
            <div key={e.ext} className="tr">
              <span className="c-ext">
                <span className="dot" style={{ background: catOf(e.cat).color }} />
                <b>{e.ext ? `.${e.ext}` : t("без расширения")}</b>
              </span>
              <span className="c-cat">{catOf(e.cat).name}</span>
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

function Changes({ root }: { root: string }) {
  const scannedAt = useStore((s) => s.scans[root]?.scanned_at);
  const openPath = useStore((s) => s.openPath);
  const [snaps, setSnaps] = useState<SnapMeta[] | null>(null);
  const [baseId, setBaseId] = useState<string>("");
  const [diff, setDiff] = useState<Diff | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void call<SnapMeta[]>("snapshots_list", { root }).then((list) => {
      setSnaps(list);
      setBaseId((cur) => (list.slice(1).some((m) => m.id === cur) ? cur : (pickBaseline(list)?.id ?? "")));
    });
  }, [root, scannedAt]);

  useEffect(() => {
    if (!baseId) return setDiff(null);
    setBusy(true);
    void call<Diff>("snapshot_diff", { root, baseId, limit: 200 })
      .then(setDiff)
      .catch(() => setDiff(null))
      .finally(() => setBusy(false));
  }, [root, baseId, scannedAt]);

  if (!snaps)
    return (
      <div className="pad center-row">
        <Spinner />
      </div>
    );
  if (snaps.length < 2) {
    return (
      <Empty
        icon={<History size={30} />}
        title={t("Пока не с чем сравнивать")}
        text={t("После каждого сканирования приложение запоминает размеры папок. Со второго сканирования здесь будет видно, что выросло и что уменьшилось.")}
      />
    );
  }
  const max = diff?.items[0] ? Math.abs(diff.items[0].delta) : 1;
  return (
    <div className="table">
      <div className="tab-bar">
        <span className="dim">{t("Сравнить со сканированием")}</span>
        <select className="select" value={baseId} onChange={(e) => setBaseId(e.target.value)}>
          {snaps.slice(1).map((m) => (
            <option key={m.id} value={m.id}>
              {fmtDateTime(m.taken_at)} · {fmtBytes(m.alloc)} · {m.mode === "mft" ? t("быстрый режим") : t("обычный режим")}
            </option>
          ))}
        </select>
        {busy && <Spinner size={13} />}
        <div className="grow" />
        {diff && (
          <span className="diff-total">
            {t("Всего:")} <b className={diff.delta > 0 ? "tone-bad" : "tone-ok"}>{fmtDelta(diff.delta)}</b> · {t("файлов")} {diff.delta_files >= 0 ? "+" : "−"}
            {fmtNum(Math.abs(diff.delta_files))}
          </span>
        )}
      </div>
      {diff?.mixed_modes && (
        <div className="inline-note">
          <TriangleAlert size={13} /> {t("Сканирования сделаны в разных режимах. Быстрый режим видит закрытые системой папки, поэтому часть разницы — не настоящий рост.")}
        </div>
      )}
      <div className="tr th">
        <span className="c-name">{t("Папка или файл")}</span>
        <span className="c-size wide">{t("Было")}</span>
        <span className="c-size wide">{t("Стало")}</span>
        <span className="c-bar" />
        <span className="c-size wide">{t("Изменение")}</span>
      </div>
      <div className="tbody">
        {diff?.items.length === 0 && <div className="pad dim">{t("Заметных изменений нет: ни одна папка не изменилась больше чем на 8 МБ.")}</div>}
        {diff?.items.map((it) => (
          <div key={it.path} className="tr clickable" onClick={() => void openPath(it.path, it.dir)} title={t("Открыть на карте")}>
            <span className="c-name">
              {it.dir ? <Folder size={15} className="tone-sun" /> : <File size={15} />}
              <span className="ellipsis rtl mono">{it.path}</span>
              {it.is_new && <em className="tag-new">{t("новое")}</em>}
              {it.gone && <em className="tag-gone">{t("исчезло")}</em>}
            </span>
            <span className="c-size wide dim">{it.old > 0 ? fmtBytes(it.old) : "—"}</span>
            <span className="c-size wide dim">{it.new > 0 ? fmtBytes(it.new) : "—"}</span>
            <span className="c-bar">
              <Bar value={Math.abs(it.delta) / max} thin color={it.delta > 0 ? "var(--bad)" : "var(--ok)"} />
            </span>
            <span className={`c-size wide ${it.delta > 0 ? "tone-bad" : "tone-ok"}`}>
              <b>{fmtDelta(it.delta)}</b>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

const SOURCES: Record<string, string> = { steam: "Steam", epic: "Epic Games", gog: "GOG", program: "Программа" };

function Apps() {
  const treeVersion = useStore((s) => s.treeVersion);
  const scans = useStore((s) => s.scans);
  const byAlloc = useStore((s) => s.byAlloc);
  const open = useStore((s) => s.openInExplorer);
  const toast = useStore((s) => s.toast);
  const [apps, setApps] = useState<InstalledApp[] | null>(null);
  const [kind, setKind] = useState<"all" | "games" | "programs">("all");

  useEffect(() => {
    void call<InstalledApp[]>("installed_apps").then(setApps);
  }, [treeVersion, Object.keys(scans).length]);

  if (!apps)
    return (
      <div className="pad center-row">
        <Spinner />
      </div>
    );
  const isGame = (a: InstalledApp) => a.source !== "program";
  const rows = apps.filter((a) => kind === "all" || (kind === "games" ? isGame(a) : !isGame(a)));
  const m = (a: InstalledApp) => (byAlloc ? a.alloc : a.size);
  const sum = rows.reduce((s, a) => s + m(a), 0);
  const max = Math.max(1, ...rows.map(m));
  const unscanned = rows.filter((a) => a.node == null).length;
  const reveal = (path: string) => void call("reveal", { path }).catch((e) => toast("error", t("Не удалось открыть Проводник"), String(e)));
  const uninstall = (a: InstalledApp) => void call("open_settings", { uri: a.uninstall || "tool:apps" }).catch((e) => toast("error", t("Не удалось открыть"), String(e)));

  return (
    <div className="table">
      <div className="tab-bar">
        <div className="seg">
          <button className={kind === "all" ? "on" : ""} onClick={() => setKind("all")}>
            {t("Все")}
          </button>
          <button className={kind === "games" ? "on" : ""} onClick={() => setKind("games")}>
            {t("Игры")}
          </button>
          <button className={kind === "programs" ? "on" : ""} onClick={() => setKind("programs")}>
            {t("Программы")}
          </button>
        </div>
        <span className="dim">
          {rows.length} · {fmtBytes(sum)}
        </span>
        <div className="grow" />
        {unscanned > 0 && <span className="dim small">{t("Размер без сканирования — по данным магазина или реестра; у {0} он неизвестен точно", unscanned)}</span>}
      </div>
      <div className="tr th">
        <span className="c-name">{t("Название")}</span>
        <span className="c-cat">{t("Откуда")}</span>
        <span className="c-date wide">{t("Активность")}</span>
        <span className="c-bar" />
        <span className="c-size">{byAlloc ? t("На диске") : t("Размер")}</span>
        <span className="c-actions" />
      </div>
      <div className="tbody">
        {rows.length === 0 && <div className="pad dim">{t("Ничего не найдено.")}</div>}
        {rows.map((a) => (
          <div key={a.path} className="tr">
            <span className="c-name">
              {isGame(a) ? <Gamepad2 size={15} className="tone-sky" /> : <LayoutGrid size={15} />}
              <span className="two-line">
                <b>{a.name}</b>
                <small>{a.path}</small>
              </span>
            </span>
            <span className="c-cat">{a.source === "program" ? a.publisher || t(SOURCES.program) : SOURCES[a.source]}</span>
            <span className="c-date wide">
              {a.last_played > 0 ? t("запускали {0}", fmtAgo(a.last_played)) : a.mtime > 0 ? t("файлы менялись {0}", fmtAgo(a.mtime)) : "—"}
            </span>
            <span className="c-bar">
              <Bar value={m(a) / max} thin color={isGame(a) ? "var(--sky)" : undefined} />
            </span>
            <span className="c-size">{m(a) > 0 ? <Size bytes={m(a)} /> : <span className="dim">—</span>}</span>
            <span className="c-actions">
              {a.node != null && (
                <button className="icon-btn sm" title={t("Открыть на карте")} onClick={() => open(a.root, a.node!)}>
                  <LayoutGrid size={13} />
                </button>
              )}
              <button className="icon-btn sm" title={t("Показать в Проводнике")} onClick={() => reveal(a.path)}>
                <FolderOpen size={13} />
              </button>
              <button className="icon-btn sm" title={a.source === "steam" ? t("Удалить через Steam") : t("Открыть «Параметры → Приложения» для удаления")} onClick={() => uninstall(a)}>
                <Trash2 size={13} />
              </button>
            </span>
          </div>
        ))}
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
        if (e !== "cancelled") toast("error", t("Поиск дубликатов прерван"), e);
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
      toast("error", t("Не удалось начать поиск"), String(e));
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
      const groups = r.groups
        .map((g) => ({ ...g, files: g.files.filter((f) => !gone.has(f.id)) }))
        .filter((g) => g.files.length > 1)
        .map((g) => ({ ...g, wasted: g.size * (g.files.length - 1) }));
      return { ...r, groups, wasted: groups.reduce((s, g) => s + g.wasted, 0) };
    });
    setPicked(new Set());
  };

  return (
    <div className="dupes">
      <div className="dupes-bar">
        <div className="seg">
          {MIN_SIZES.map((x) => (
            <button key={x.v} className={minSize === x.v ? "on" : ""} disabled={busy} onClick={() => setMinSize(x.v)}>
              {t(x.label)}
            </button>
          ))}
        </div>
        {busy ? (
          <button className="btn" onClick={() => void call("dupes_cancel")}>
            {t("Остановить")}
          </button>
        ) : (
          <button className="btn primary" onClick={() => void start()}>
            <CopyMinus size={15} />
            {res ? t("Искать заново") : t("Найти дубликаты")}
          </button>
        )}
        <div className="grow" />
        {res && res.groups.length > 0 && (
          <>
            <button className="btn sm ghost" onClick={pickAllButOldest}>
              {t("Выбрать всё, кроме самых старых копий")}
            </button>
            <button className="btn sm danger" disabled={!pickedItems.length} onClick={() => askDelete({ root, items: pickedItems, permanent: false, onDone: removeDeleted })}>
              <Trash2 size={13} />
              {t("В Корзину")}
              {pickedItems.length > 0 && ` · ${fmtBytes(pickedSize)}`}
            </button>
          </>
        )}
      </div>

      {busy && (
        <div className="dupes-progress">
          <Spinner />
          <div>
            <b>{t("Сравниваю содержимое файлов")}</b>
            <span>
              {t("проверено {0} · прочитано {1}", fmtNum(prog?.files ?? 0), fmtBytes(prog?.done ?? 0))}
              {prog && prog.total > 0 && ` ${t("из ≤ {0}", fmtBytes(prog.total))}`}
            </span>
          </div>
        </div>
      )}

      {!busy && !res && (
        <Empty
          icon={<CopyMinus size={30} />}
          title={t("Одинаковые файлы в разных местах")}
          text={t("Сначала отбираются файлы одинакового размера, затем сравнивается их содержимое. Жёсткие ссылки, облачные файлы и папка Windows не учитываются.")}
        />
      )}
      {res && res.groups.length === 0 && <Empty icon={<CopyMinus size={30} />} title={t("Дубликатов не найдено")} text={t("Проверено кандидатов: {0}", fmtNum(res.candidates))} />}

      {res && res.groups.length > 0 && (
        <>
          <div className="dupes-summary">
            {t("Найдено {0}", `${fmtNum(res.groups.length)} ${plural(res.groups.length, "группа", "группы", "групп")}`)} · {t("лишние копии занимают")} <b>{fmtBytes(res.wasted)}</b>
          </div>
          <div className="dup-groups">
            {res.groups.map((g, gi) => (
              <div key={gi} className="dup-group">
                <div className="dup-head">
                  <b>
                    {g.files.length} × {fmtBytes(g.size)}
                  </b>
                  <span>{t("лишнее: {0}", fmtBytes(g.wasted))}</span>
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
                    {fi === 0 && <em>{t("самая старая")}</em>}
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

const TABS: { id: AnalysisTab; label: string }[] = [
  { id: "top", label: "Крупнейшие файлы" },
  { id: "types", label: "Типы файлов" },
  { id: "changes", label: "Изменения" },
  { id: "apps", label: "Игры и программы" },
  { id: "dupes", label: "Дубликаты" },
];

export function Analysis() {
  const root = useStore((s) => s.activeRoot);
  const scan = useStore((s) => (s.activeRoot ? s.scans[s.activeRoot] : undefined));
  const tab = useStore((s) => s.analysisTab);
  const setTab = useStore((s) => s.setAnalysisTab);
  const byAlloc = useStore((s) => s.byAlloc);
  const setByAlloc = useStore((s) => s.setByAlloc);
  const setView = useStore((s) => s.setView);

  // Список игр и программ не зависит от сканирования — он доступен всегда.
  if ((!root || !scan) && tab !== "apps") {
    return (
      <div className="page center">
        <Empty
          icon={<ChartColumn size={30} />}
          title={t("Анализ появится после сканирования")}
          text={t("Крупнейшие файлы, разбивка по типам, изменения и поиск дубликатов строятся по результатам сканирования диска.")}
          action={
            <div className="row gap8">
              <button className="btn primary" onClick={() => setView("overview")}>
                {t("К выбору диска")}
              </button>
              <button className="btn" onClick={() => setTab("apps")}>
                <Gamepad2 size={15} />
                {t("Игры и программы")}
              </button>
            </div>
          }
        />
      </div>
    );
  }

  return (
    <div className="page full">
      <div className="page-head">
        <div>
          <h1>{t("Анализ")}</h1>
          <p>
            {root && scan ? (
              <>
                <Folder size={12} /> {isDriveRoot(root) ? root.replace(/\\$/, "") : root} · {fmtCount(scan.files)} {t("файлов")}
              </>
            ) : (
              t("Диск ещё не просканирован")
            )}
          </p>
        </div>
        <div className="row gap8 wrap-end">
          <div className="tabs">
            {TABS.map((x) => (
              <button key={x.id} className={tab === x.id ? "on" : ""} disabled={x.id !== "apps" && (!root || !scan)} onClick={() => setTab(x.id)}>
                {t(x.label)}
              </button>
            ))}
          </div>
          {(tab === "top" || tab === "types") && <VisibilityToggles />}
          {tab !== "dupes" && tab !== "changes" && (
            <div className="seg">
              <button className={byAlloc ? "on" : ""} onClick={() => setByAlloc(true)}>
                {t("На диске")}
              </button>
              <button className={!byAlloc ? "on" : ""} onClick={() => setByAlloc(false)}>
                {t("Размер")}
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="card flush fill">
        {tab === "top" && root && <TopFiles root={root} />}
        {tab === "types" && root && <Types root={root} />}
        {tab === "changes" && root && <Changes root={root} />}
        {tab === "apps" && <Apps />}
        {/* Поиск дубликатов долгий — не размонтируем, чтобы не терять ход и результат. */}
        {root && scan && (
          <div className="tab-keep" style={{ display: tab === "dupes" ? "contents" : "none" }}>
            <Dupes root={root} />
          </div>
        )}
      </div>
    </div>
  );
}
