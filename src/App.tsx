import { useEffect } from "react";
import { call, listen, Privilege, ScanProgress, ScanSummary } from "./api";
import { fmtCount, fmtDuration } from "./format";
import { useStore } from "./store";
import { ScanOverlay, Sidebar, Titlebar } from "./components/Chrome";
import { DeleteDialog } from "./components/DeleteDialog";
import { ElevationDialog } from "./components/ElevationDialog";
import { Toasts } from "./components/ui";
import { Access } from "./views/Access";
import { Analysis } from "./views/Analysis";
import { Cleanup } from "./views/Cleanup";
import { Explorer } from "./views/Explorer";
import { Overview } from "./views/Overview";
import { Schedule } from "./views/Schedule";

export default function App() {
  const view = useStore((s) => s.view);

  useEffect(() => {
    const s = useStore.getState();
    // Сохранённый выбор «скрытые/системные» сообщаем ядру до первого сканирования.
    void call("set_visibility", { showHidden: s.showHidden, showSystem: s.showSystem });
    void s.refreshDrives();
    void s.loadJunk();
    void call<Privilege>("privilege_info").then((priv) => useStore.setState({ priv }));
    void call<ScanSummary[]>("scan_summaries").then((list) => {
      if (!list.length) return;
      const scans = Object.fromEntries(list.map((x) => [x.root, x]));
      useStore.setState((st) => ({ scans, activeRoot: st.activeRoot ?? list[0].root }));
    });
    // После перезапуска с правами администратора сразу продолжаем то, ради чего их просили.
    void call<string | null>("startup_scan").then((root) => {
      if (root) void useStore.getState().startScan(root, "auto");
    });

    const offs = [
      listen<ScanProgress>("scan-progress", (progress) => useStore.setState((st) => (st.scanning ? { scanning: { root: progress.root, progress } } : {}))),
      listen<{ summary: ScanSummary; note: string | null }>("scan-done", ({ summary, note }) => {
        useStore.setState((st) => ({
          scanning: null,
          scans: { ...st.scans, [summary.root]: summary },
          activeRoot: summary.root,
          nodeId: 0,
          selected: null,
          view: "explorer",
          treeVersion: st.treeVersion + 1,
        }));
        const st = useStore.getState();
        void st.refreshDrives();
        if (note) st.toast("info", "Быстрый режим не сработал — выполнен обычный обход", note);
        else st.toast("ok", `Готово за ${fmtDuration(summary.duration_ms)}`, `${fmtCount(summary.files)} файлов${summary.mode === "mft" ? " · быстрый режим" : ""}`);
      }),
      listen<{ root: string; message: string; cancelled: boolean }>("scan-error", (e) => {
        useStore.setState({ scanning: null });
        if (!e.cancelled) useStore.getState().toast("error", "Сканирование не удалось", e.message);
      }),
    ];
    const noMenu = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("input, textarea")) e.preventDefault();
    };
    window.addEventListener("contextmenu", noMenu);
    return () => {
      offs.forEach((o) => o());
      window.removeEventListener("contextmenu", noMenu);
    };
  }, []);

  return (
    <div className="app">
      <Titlebar />
      <div className="body">
        <Sidebar />
        <main className="main">
          {view === "overview" && <Overview />}
          {view === "explorer" && <Explorer />}
          {view === "analysis" && <Analysis />}
          {view === "cleanup" && <Cleanup />}
          {view === "schedule" && <Schedule />}
          {view === "access" && <Access />}
          <ScanOverlay />
        </main>
      </div>
      <ElevationDialog />
      <DeleteDialog />
      <Toasts />
    </div>
  );
}
