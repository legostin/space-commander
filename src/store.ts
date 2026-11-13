import { create } from "zustand";
import { call, Drive, JunkItem, Privilege, ScanProgress, ScanSummary } from "./api";
import { getLang, Lang, setLang, t } from "./i18n";

export type View = "overview" | "explorer" | "analysis" | "cleanup" | "schedule" | "access";
export type Theme = "system" | "dark" | "light";
export type AnalysisTab = "top" | "types" | "changes" | "apps" | "dupes";

export interface Toast {
  id: number;
  kind: "ok" | "error" | "info";
  text: string;
  detail?: string;
}

/** Зачем запрашивается повышение прав — от этого зависит объяснение в диалоге. */
export interface ElevationAsk {
  reason: "scan" | "clean" | "task" | "general";
  root?: string;
  what?: string;
}

export interface DeleteAsk {
  root: string;
  items: { id: number; name: string; size: number }[];
  permanent: boolean;
  onDone?: (deleted: number[]) => void;
}

interface State {
  deleteAsk: DeleteAsk | null;
  askDelete: (a: DeleteAsk | null) => void;
  view: View;
  drives: Drive[];
  priv: Privilege | null;
  scans: Record<string, ScanSummary>;
  activeRoot: string | null;
  /** `quiet` — фоновое обновление: индикатор в боковой панели вместо экрана сканирования. */
  scanning: { root: string; quiet: boolean; progress: ScanProgress | null } | null;
  byAlloc: boolean;
  nodeId: number;
  selected: number | null;
  /** Путь открытой на карте папки — чтобы вернуться в неё после фонового обновления. */
  currentPath: string;
  /** Увеличивается после удаления — экраны перечитывают данные. */
  treeVersion: number;
  junk: JunkItem[] | null;
  junkLoading: boolean;
  toasts: Toast[];
  elevation: ElevationAsk | null;
  analysisTab: AnalysisTab;
  /** Показывать объекты с атрибутами «скрытый» и «системный». */
  showHidden: boolean;
  showSystem: boolean;
  theme: Theme;
  lang: Lang;
  settingsOpen: boolean;

  setVisibility: (showHidden: boolean, showSystem: boolean) => Promise<void>;
  setTheme: (t: Theme) => void;
  setLanguage: (l: Lang) => void;
  openSettings: (open: boolean) => void;
  setView: (v: View) => void;
  refreshDrives: () => Promise<void>;
  startScan: (root: string, mode?: "auto" | "walk" | "mft", quiet?: boolean) => Promise<void>;
  scanFolder: () => Promise<void>;
  forgetScan: (root: string) => void;
  cancelScan: () => void;
  navigate: (nodeId: number, selected?: number | null) => void;
  select: (id: number | null) => void;
  openInExplorer: (root: string, nodeId: number, selected?: number | null) => void;
  /** Открывает на карте папку по полному пути (ищет диск, на котором она лежит). */
  openPath: (path: string, isDir: boolean) => Promise<void>;
  setByAlloc: (v: boolean) => void;
  bumpTree: () => void;
  loadJunk: () => Promise<void>;
  toast: (kind: Toast["kind"], text: string, detail?: string) => void;
  dismissToast: (id: number) => void;
  askElevation: (ask: ElevationAsk | null) => void;
  setAnalysisTab: (t: AnalysisTab) => void;
}

let toastId = 1;

function saved(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* настройка не сохранится между запусками */
  }
}

/** Применяет тему к документу; «system» следует за настройкой Windows. */
export function applyTheme(theme: Theme) {
  const light = theme === "light" || (theme === "system" && window.matchMedia("(prefers-color-scheme: light)").matches);
  document.documentElement.dataset.theme = light ? "light" : "dark";
}

const savedTheme = saved("sc.theme");

export const useStore = create<State>((set, get) => ({
  deleteAsk: null,
  askDelete: (deleteAsk) => set({ deleteAsk }),
  view: "overview",
  drives: [],
  priv: null,
  scans: {},
  activeRoot: null,
  scanning: null,
  byAlloc: true,
  nodeId: 0,
  selected: null,
  currentPath: "",
  treeVersion: 0,
  junk: null,
  junkLoading: false,
  toasts: [],
  elevation: null,
  analysisTab: "top",
  showHidden: saved("sc.showHidden") !== "0",
  showSystem: saved("sc.showSystem") !== "0",
  theme: savedTheme === "light" || savedTheme === "dark" ? savedTheme : "system",
  lang: getLang(),
  settingsOpen: false,

  setVisibility: async (showHidden, showSystem) => {
    set({ showHidden, showSystem });
    save("sc.showHidden", showHidden ? "1" : "0");
    save("sc.showSystem", showSystem ? "1" : "0");
    try {
      const list = await call<ScanSummary[]>("set_visibility", { showHidden, showSystem });
      // Суммы папок пересчитаны — все экраны перечитывают данные.
      set((s) => ({ scans: { ...s.scans, ...Object.fromEntries(list.map((x) => [x.root, x])) }, selected: null, treeVersion: s.treeVersion + 1 }));
    } catch (e) {
      get().toast("error", t("Не удалось применить фильтр"), String(e));
    }
  },
  setTheme: (theme) => {
    save("sc.theme", theme);
    applyTheme(theme);
    set((s) => ({ theme, treeVersion: s.treeVersion + 1 }));
  },
  setLanguage: (lang) => {
    setLang(lang);
    void call("set_language", { lang });
    // Тексты правил очистки приходят из ядра — перечитываем на новом языке.
    set({ lang, junk: null });
    void get().loadJunk();
  },
  openSettings: (settingsOpen) => set({ settingsOpen }),

  setView: (view) => set({ view }),
  refreshDrives: async () => set({ drives: await call<Drive[]>("list_drives") }),
  startScan: async (root, mode = "auto", quiet = false) => {
    if (get().scanning) return;
    set({ scanning: { root, quiet, progress: null } });
    try {
      await call("start_scan", { root, mode, quiet });
    } catch (e) {
      set({ scanning: null });
      if (!quiet) get().toast("error", t("Не удалось начать сканирование"), String(e));
    }
  },
  scanFolder: async () => {
    const path = await call<string | null>("pick_folder");
    if (path) await get().startScan(path, "walk");
  },
  forgetScan: (root) => {
    void call("forget_scan", { root });
    set((s) => {
      const scans = { ...s.scans };
      delete scans[root];
      const activeRoot = s.activeRoot === root ? (Object.keys(scans)[0] ?? null) : s.activeRoot;
      return { scans, activeRoot, nodeId: s.activeRoot === root ? 0 : s.nodeId, selected: null };
    });
  },
  cancelScan: () => void call("cancel_scan"),
  navigate: (nodeId, selected = null) => set({ nodeId, selected }),
  select: (selected) => set({ selected }),
  openInExplorer: (root, nodeId, selected = null) => set({ activeRoot: root, nodeId, selected, view: "explorer" }),
  openPath: async (path, isDir) => {
    const lower = path.toLowerCase();
    // Самый длинный подходящий корень: папка, отсканированная отдельно, точнее диска.
    const root = Object.keys(get().scans)
      .filter((r) => lower.startsWith(r.toLowerCase()))
      .sort((a, b) => b.length - a.length)[0];
    if (!root) return get().toast("info", t("Сначала просканируйте этот диск"));
    try {
      const id = await call<number | null>("find_path", { root, path });
      if (id == null) return get().toast("info", t("Этого объекта нет в последнем сканировании"), path);
      if (isDir) get().openInExplorer(root, id);
      else get().openInExplorer(root, await call<number>("parent_of", { root, id }), id);
    } catch (e) {
      get().toast("error", t("Не удалось открыть на карте"), String(e));
    }
  },
  setByAlloc: (byAlloc) => set({ byAlloc }),
  bumpTree: () => set((s) => ({ treeVersion: s.treeVersion + 1 })),
  loadJunk: async () => {
    if (get().junkLoading) return;
    set({ junkLoading: true });
    try {
      set({ junk: await call<JunkItem[]>("junk_scan") });
    } finally {
      set({ junkLoading: false });
    }
  },
  toast: (kind, text, detail) => {
    const id = toastId++;
    set((s) => ({ toasts: [...s.toasts, { id, kind, text, detail }] }));
    window.setTimeout(() => get().dismissToast(id), kind === "error" ? 9000 : 5000);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
  askElevation: (elevation) => set({ elevation }),
  setAnalysisTab: (analysisTab) => set({ analysisTab }),
}));

/** То, что можно очистить прямо сейчас без оговорок и без повышения прав. */
export function reclaimable(junk: JunkItem[] | null, elevated: boolean): JunkItem[] {
  return (junk ?? []).filter((j) => j.safety === "safe" && j.accessible && j.size > 0 && (!j.needs_admin || elevated));
}

/** Корень — диск целиком (`C:\`), а не отдельно отсканированная папка. */
export function isDriveRoot(root: string): boolean {
  return /^[A-Za-z]:\\?$/.test(root);
}
