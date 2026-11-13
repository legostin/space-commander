import { create } from "zustand";
import { call, Drive, JunkItem, Privilege, ScanProgress, ScanSummary } from "./api";

export type View = "overview" | "explorer" | "analysis" | "cleanup" | "schedule" | "access";

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
  scanning: { root: string; progress: ScanProgress | null } | null;
  byAlloc: boolean;
  nodeId: number;
  selected: number | null;
  /** Увеличивается после удаления — экраны перечитывают данные. */
  treeVersion: number;
  junk: JunkItem[] | null;
  junkLoading: boolean;
  toasts: Toast[];
  elevation: ElevationAsk | null;
  analysisTab: "top" | "types" | "dupes";
  /** Показывать объекты с атрибутами «скрытый» и «системный». */
  showHidden: boolean;
  showSystem: boolean;
  setVisibility: (showHidden: boolean, showSystem: boolean) => Promise<void>;

  setView: (v: View) => void;
  refreshDrives: () => Promise<void>;
  startScan: (root: string, mode?: "auto" | "walk" | "mft") => Promise<void>;
  cancelScan: () => void;
  navigate: (nodeId: number, selected?: number | null) => void;
  select: (id: number | null) => void;
  openInExplorer: (root: string, nodeId: number, selected?: number | null) => void;
  setByAlloc: (v: boolean) => void;
  bumpTree: () => void;
  loadJunk: () => Promise<void>;
  toast: (kind: Toast["kind"], text: string, detail?: string) => void;
  dismissToast: (id: number) => void;
  askElevation: (ask: ElevationAsk | null) => void;
  setAnalysisTab: (t: State["analysisTab"]) => void;
}

let toastId = 1;

function savedFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) !== "0";
  } catch {
    return true;
  }
}

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
  treeVersion: 0,
  junk: null,
  junkLoading: false,
  toasts: [],
  elevation: null,
  analysisTab: "top",
  showHidden: savedFlag("sc.showHidden"),
  showSystem: savedFlag("sc.showSystem"),

  setVisibility: async (showHidden, showSystem) => {
    set({ showHidden, showSystem });
    try {
      localStorage.setItem("sc.showHidden", showHidden ? "1" : "0");
      localStorage.setItem("sc.showSystem", showSystem ? "1" : "0");
    } catch {
      /* настройка просто не сохранится между запусками */
    }
    try {
      const list = await call<ScanSummary[]>("set_visibility", { showHidden, showSystem });
      // Суммы папок пересчитаны — все экраны перечитывают данные.
      set((s) => ({ scans: { ...s.scans, ...Object.fromEntries(list.map((x) => [x.root, x])) }, selected: null, treeVersion: s.treeVersion + 1 }));
    } catch (e) {
      get().toast("error", "Не удалось применить фильтр", String(e));
    }
  },

  setView: (view) => set({ view }),
  refreshDrives: async () => set({ drives: await call<Drive[]>("list_drives") }),
  startScan: async (root, mode = "auto") => {
    if (get().scanning) return;
    set({ scanning: { root, progress: null } });
    try {
      await call("start_scan", { root, mode });
    } catch (e) {
      set({ scanning: null });
      get().toast("error", "Не удалось начать сканирование", String(e));
    }
  },
  cancelScan: () => void call("cancel_scan"),
  navigate: (nodeId, selected = null) => set({ nodeId, selected }),
  select: (selected) => set({ selected }),
  openInExplorer: (root, nodeId, selected = null) => set({ activeRoot: root, nodeId, selected, view: "explorer" }),
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
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  askElevation: (elevation) => set({ elevation }),
  setAnalysisTab: (analysisTab) => set({ analysisTab }),
}));

/** То, что можно очистить прямо сейчас без оговорок и без повышения прав. */
export function reclaimable(junk: JunkItem[] | null, elevated: boolean): JunkItem[] {
  return (junk ?? []).filter((j) => j.safety === "safe" && j.accessible && j.size > 0 && (!j.needs_admin || elevated));
}

/** Сводка сканирования для выбранного диска (или undefined, если ещё не сканировали). */
export function useActiveScan(): ScanSummary | undefined {
  return useStore((s) => (s.activeRoot ? s.scans[s.activeRoot] : undefined));
}
