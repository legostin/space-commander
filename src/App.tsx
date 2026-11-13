import { useEffect } from "react";
import { call, listen, Privilege, ScanProgress, ScanSummary } from "./api";
import { fmtCount, fmtDuration } from "./format";
import { t } from "./i18n";
import { applyTheme, useStore } from "./store";
import { ScanOverlay, Sidebar, Titlebar } from "./components/Chrome";
import { DeleteDialog } from "./components/DeleteDialog";
import { ElevationDialog } from "./components/ElevationDialog";
import { SettingsDialog } from "./components/Settings";
import { Toasts } from "./components/ui";
import { Access } from "./views/Access";
import { Analysis } from "./views/Analysis";
import { Cleanup } from "./views/Cleanup";
import { Explorer } from "./views/Explorer";
import { Overview } from "./views/Overview";
import { Schedule } from "./views/Schedule";

export default function App() {
  const view = useStore((s) => s.view);
  const lang = useStore((s) => s.lang);

  useEffect(() => {
    const s = useStore.getState();
    applyTheme(s.theme);
    document.documentElement.lang = s.lang;
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const onScheme = () => {
      const st = useStore.getState();
      if (st.theme === "system") st.setTheme("system");
    };
    media.addEventListener("change", onScheme);

    // Сохранённые настройки сообщаем ядру до первого сканирования.
    void call("set_language", { lang: s.lang });
    void call("set_visibility", { showHidden: s.showHidden, showSystem: s.showSystem });
    void s.refreshDrives();
    void s.loadJunk();
    void call<Privilege>("privilege_info").then((priv) => useStore.setState({ priv }));

    const adopt = (list: ScanSummary[]) => {
      if (!list.length) return;
      const scans = Object.fromEntries(list.map((x) => [x.root, x]));
      const preferred = list.find((x) => x.root.toUpperCase() === "C:\\") ?? list[0];
      useStore.setState((st) => ({ scans: { ...scans, ...st.scans }, activeRoot: st.activeRoot ?? preferred.root }));
    };
    void call<ScanSummary[]>("scan_summaries").then(adopt);
    // После перезапуска с правами администратора сразу продолжаем то, ради чего их просили.
    void call<string | null>("startup_scan").then((root) => {
      if (root) void useStore.getState().startScan(root, "auto");
    });

    const offs = [
      // Результаты прошлого запуска подняты из кеша: показываем их сразу и обновляем в фоне.
      listen<ScanSummary[]>("scan-restored", (list) => {
        adopt(list);
        const st = useStore.getState();
        if (st.activeRoot && !st.scanning) void st.startScan(st.activeRoot, "auto", true);
      }),
      listen<ScanProgress>("scan-progress", (progress) =>
        useStore.setState((st) => (st.scanning ? { scanning: { root: progress.root, quiet: progress.quiet, progress } } : {})),
      ),
      listen<{ summary: ScanSummary; quiet: boolean; note: string | null }>("scan-done", async ({ summary, quiet, note }) => {
        const before = useStore.getState();
        void before.refreshDrives();
        if (quiet) {
          // Номера узлов в новом дереве другие — возвращаемся в ту же папку по пути.
          let nodeId = 0;
          const same = before.activeRoot === summary.root;
          if (same && before.currentPath) {
            nodeId = (await call<number | null>("find_path", { root: summary.root, path: before.currentPath }).catch(() => null)) ?? 0;
          }
          useStore.setState((st) => ({
            scanning: null,
            scans: { ...st.scans, [summary.root]: summary },
            ...(same ? { nodeId, selected: null } : {}),
            treeVersion: st.treeVersion + 1,
          }));
          return;
        }
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
        if (note) st.toast("info", t("Быстрый режим не сработал — выполнен обычный обход"), note);
        else st.toast("ok", t("Готово за {0}", fmtDuration(summary.duration_ms)), `${fmtCount(summary.files)} ${t("файлов")}${summary.mode === "mft" ? ` · ${t("быстрый режим")}` : ""}`);
      }),
      listen<{ root: string; message: string; cancelled: boolean; quiet: boolean }>("scan-error", (e) => {
        useStore.setState({ scanning: null });
        if (!e.cancelled && !e.quiet) useStore.getState().toast("error", t("Сканирование не удалось"), e.message);
      }),
    ];
    const noMenu = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("input, textarea")) e.preventDefault();
    };
    window.addEventListener("contextmenu", noMenu);
    return () => {
      offs.forEach((o) => o());
      window.removeEventListener("contextmenu", noMenu);
      media.removeEventListener("change", onScheme);
    };
  }, []);

  return (
    // Смена языка перерисовывает всё дерево: строки берутся из словаря в момент отрисовки.
    <div className="app" key={lang}>
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
      <SettingsDialog />
      <Toasts />
    </div>
  );
}
