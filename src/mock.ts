// Демо-данные для предпросмотра интерфейса в обычном браузере (без Tauri).
// В собранном приложении этот модуль не вызывается.

import { getLang } from "./i18n";

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/** Русские подписи демо-данных → английские, когда интерфейс не на русском. */
const DEMO_EN: [string, string][] = [
  ["Еженедельная уборка", "Weekly cleanup"],
  ["Корзина на всех дисках", "Recycle Bin on all drives"],
  ["Система", "System"],
  ["Архив", "Archive"],
  ["Флешка", "USB drive"],
  ["Записи", "Recordings"],
  ["файл занят другим процессом", "the file is in use by another process"],
];

function localize<T>(value: T): T {
  if (getLang() === "ru" || value == null) return value;
  let json = JSON.stringify(value);
  for (const [ru, en] of DEMO_EN) json = json.split(ru).join(en);
  return JSON.parse(json) as T;
}

interface MNode {
  id: number;
  name: string;
  dir: boolean;
  size: number;
  files: number;
  mtime: number;
  parent: number;
  children: number[];
  cat: number;
}

let seed = 42;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const now = Math.floor(Date.now() / 1000);
const nodes: MNode[] = [];

function add(parent: number, name: string, dir: boolean, size = 0, cat = 0): number {
  const id = nodes.length;
  nodes.push({ id, name, dir, size, files: dir ? 0 : 1, mtime: now - Math.floor(rnd() * 86400 * 700), parent, children: [], cat: dir ? 100 : cat });
  if (id !== parent) nodes[parent].children.push(id);
  return id;
}

const EXT: [string, number][] = [
  ["mp4", 1], ["mkv", 1], ["flac", 2], ["jpg", 3], ["png", 3], ["zip", 4], ["7z", 4], ["pdf", 5], ["docx", 5],
  ["rs", 6], ["js", 6], ["dll", 7], ["exe", 7], ["iso", 8], ["vhdx", 8], ["log", 9], ["pak", 10], ["db", 10], ["bin", 0],
];
const WORDS = ["assets", "data", "core", "runtime", "shaders", "textures", "audio", "levels", "cache", "lib", "docs", "src", "build", "media", "saves", "plugins", "locale", "models"];

function fill(parent: number, budget: number, depth: number) {
  const n = 3 + Math.floor(rnd() * (depth > 2 ? 5 : 9));
  let left = budget;
  for (let i = 0; i < n && left > 4096; i++) {
    const share = i === n - 1 ? left : left * (0.15 + rnd() * 0.5);
    left -= share;
    if (depth < 4 && rnd() < 0.45) {
      const d = add(parent, `${WORDS[Math.floor(rnd() * WORDS.length)]}${rnd() < 0.3 ? "_" + Math.floor(rnd() * 20) : ""}`, true);
      fill(d, share, depth + 1);
    } else {
      const [ext, cat] = EXT[Math.floor(rnd() * EXT.length)];
      add(parent, `${WORDS[Math.floor(rnd() * WORDS.length)]}_${Math.floor(rnd() * 900 + 100)}.${ext}`, false, Math.floor(share), cat);
    }
  }
}

function build() {
  add(0, "C:\\", true);
  const top: [string, number][] = [
    ["Program Files (x86)", 710], ["Users", 392], ["Program Files", 102], ["Windows", 42], ["GOG Games", 29], ["games", 25], ["ProgramData", 10.5],
  ];
  for (const [name, gb] of top) {
    const d = add(0, name, true);
    if (name === "Users") {
      const me = add(d, "commander", true);
      for (const [sub, g] of [["AppData", 180], ["Videos", 74], ["source", 55], ["Downloads", 38], ["Documents", 22], [".ollama", 18], ["Pictures", 5]] as [string, number][]) {
        const s = add(me, sub, true);
        fill(s, g * GB, 1);
      }
    } else if (name === "Program Files (x86)") {
      const steam = add(d, "Steam", true);
      const common = add(add(steam, "steamapps", true), "common", true);
      for (const [g, s] of [["METAPHOR", 96], ["PRAGMATA", 74], ["Cyber Odyssey", 120], ["Starfield Tactics", 88], ["Hollow Forge", 61], ["Rally Legends", 140], ["Deep Rock", 44]] as [string, number][]) {
        fill(add(common, g, true), s * GB, 2);
      }
      fill(add(d, "Common Files", true), 12 * GB, 2);
      fill(add(d, "Microsoft", true), 9 * GB, 2);
    } else fill(d, gb * GB, 1);
  }
  add(0, "hiberfil.sys", false, 24.65 * GB, 9);
  add(0, "pagefile.sys", false, 3.9 * GB, 9);
  for (let i = nodes.length - 1; i > 0; i--) {
    const n = nodes[i];
    nodes[n.parent].size += n.size;
    nodes[n.parent].files += n.files;
  }
}
build();

const pathOf = (id: number): string => {
  const parts: string[] = [];
  for (let c = id; c !== 0; c = nodes[c].parent) parts.push(nodes[c].name);
  return "C:\\" + parts.reverse().join("\\");
};
const dto = (n: MNode) => ({ id: n.id, name: n.name, size: n.size, alloc: n.size, files: n.files, dir: n.dir, mtime: n.mtime, flags: n.dir ? 1 : 0, cat: n.cat });
const fileDto = (n: MNode) => ({ ...dto(n), path: pathOf(n.id) });
const alive = (id: number) => nodes[id].size >= 0;

const listeners = new Map<string, Set<(p: unknown) => void>>();
const emit = (event: string, payload: unknown) => listeners.get(event)?.forEach((h) => h(payload));
export function mockListen(event: string, handler: (p: unknown) => void): () => void {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(handler);
  return () => listeners.get(event)?.delete(handler);
}

const drives = [
  { root: "C:\\", letter: "C", label: "Система", fs: "NTFS", kind: "fixed", total: 1862 * GB, free: 480 * GB, cluster: 4096 },
  { root: "D:\\", letter: "D", label: "Архив", fs: "NTFS", kind: "fixed", total: 3726 * GB, free: 2210 * GB, cluster: 4096 },
  { root: "E:\\", letter: "E", label: "Флешка", fs: "exFAT", kind: "removable", total: 119 * GB, free: 11 * GB, cluster: 131072 },
];

let scanned = false;
let scanTimer: number | null = null;
let mockHidden = 0;
const summary = () => ({ root: "C:\\", mode: "walk", duration_ms: 4333, files: nodes[0].files * 480, dirs: 462605, size: nodes[0].size, alloc: nodes[0].size, denied: 634, scanned_at: now, hidden_size: mockHidden, hidden_alloc: mockHidden, hidden_files: mockHidden ? 48211 : 0 });

const junk = [
  ["user-temp", "system", "Временные файлы пользователя", "Файлы, которые программы создают на время работы и часто забывают убрать. Удаляется только то, что старше суток; занятые файлы пропускаются.", "safe", false, 3.17 * GB, 24554, "C:\\Users\\commander\\AppData\\Local\\Temp"],
  ["shader-cache", "system", "Кеш шейдеров видеокарты", "Скомпилированные шейдеры DirectX, NVIDIA и AMD. Пересобираются при следующем запуске игр — первый запуск может быть чуть дольше.", "safe", false, 26.15 * GB, 988, "C:\\Users\\commander\\AppData\\Local\\NVIDIA\\DXCache"],
  ["win-temp", "system", "Временные файлы Windows", "Общая временная папка системы и установщиков. Удаляется только то, что старше суток.", "safe", true, 0, 0, ""],
  ["win-update", "system", "Загруженные обновления Windows", "Пакеты обновлений, которые уже установлены. Если обновление ещё понадобится, Windows скачает его заново.", "safe", true, 1.4 * GB, 212, "C:\\Windows\\SoftwareDistribution\\Download"],
  ["crash-dumps", "system", "Дампы памяти программ", "Снимки памяти упавших программ. Нужны только разработчикам для разбора сбоя.", "safe", false, 0.38 * GB, 10, "C:\\Users\\commander\\AppData\\Local\\CrashDumps"],
  ["recycle-bin", "system", "Корзина", "Удалённые файлы, которые всё ещё занимают место. После очистки восстановить их будет нельзя.", "caution", false, 0.08 * GB, 18, "Корзина на всех дисках"],
  ["chromium:google\\chrome", "browsers", "Google Chrome", "Кеш страниц, скриптов и графики. Закладки, пароли, история и открытые вкладки не затрагиваются. Лучше закрыть браузер перед очисткой.", "safe", false, 1.9 * GB, 14200, "C:\\Users\\commander\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache\\Cache_Data"],
  ["chromium:microsoft\\edge", "browsers", "Microsoft Edge", "Кеш страниц, скриптов и графики. Закладки, пароли, история и открытые вкладки не затрагиваются. Лучше закрыть браузер перед очисткой.", "safe", false, 0.48 * GB, 4347, "C:\\Users\\commander\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Cache\\Cache_Data"],
  ["firefox", "browsers", "Firefox", "Кеш страниц. Закладки, пароли и история не затрагиваются.", "safe", false, 1.01 * GB, 8851, "C:\\Users\\commander\\AppData\\Local\\Mozilla\\Firefox\\Profiles\\x.default\\cache2"],
  ["chromium:discord", "apps", "Discord", "Кеш встроенного браузера приложения: загруженные картинки, скрипты, шейдеры. Настройки и переписка не затрагиваются. Лучше закрыть приложение перед очисткой.", "safe", false, 0.74 * GB, 6100, "C:\\Users\\commander\\AppData\\Roaming\\discord\\Cache\\Cache_Data"],
  ["chromium:claude", "apps", "Claude", "Кеш встроенного браузера приложения: загруженные картинки, скрипты, шейдеры. Настройки и переписка не затрагиваются. Лучше закрыть приложение перед очисткой.", "safe", false, 0.56 * GB, 25460, "C:\\Users\\commander\\AppData\\Roaming\\Claude\\Cache\\Cache_Data"],
  ["steam", "apps", "Steam", "Кеш встроенного браузера, шейдеров и незавершённые загрузки. Игры и сохранения не затрагиваются.", "caution", false, 0.73 * GB, 8594, "C:\\Program Files (x86)\\Steam\\steamapps\\shadercache"],
  ["npm-cache", "dev", "Кеш npm", "Скачанные пакеты npm. При следующей установке загрузятся заново.", "safe", false, 1.79 * GB, 6235, "C:\\Users\\commander\\AppData\\Local\\npm-cache\\_cacache"],
  ["pip-cache", "dev", "Кеш pip и uv", "Скачанные и собранные пакеты Python.", "safe", false, 2.81 * GB, 5427, "C:\\Users\\commander\\AppData\\Local\\pip\\Cache"],
  ["cargo-cache", "dev", "Кеш Cargo", "Архивы и распакованные исходники зависимостей Rust. Cargo скачает нужное при следующей сборке.", "caution", false, 0.76 * GB, 31373, "C:\\Users\\commander\\.cargo\\registry\\src"],
  ["hf-cache", "dev", "Модели Hugging Face и PyTorch", "Скачанные нейросетевые модели. Могут занимать десятки гигабайт; при следующем использовании скачаются заново.", "caution", false, 5.18 * GB, 32, "C:\\Users\\commander\\.cache\\huggingface\\hub"],
  ["old-installers", "downloads", "Старые установщики в «Загрузках»", "Установщики и образы дисков, которые лежат в «Загрузках» больше 90 дней. Скорее всего, программы уже установлены.", "caution", false, 6.4 * GB, 23, "C:\\Users\\commander\\Downloads"],
  ["hiberfil", "info", "Файл гибернации", "Сюда Windows сохраняет память при гибернации и быстром запуске. Размер — около 40% оперативной памяти.", "info", false, 24.65 * GB, 1, "C:\\hiberfil.sys"],
  ["docker-wsl", "info", "Виртуальные диски Docker и WSL", "Файлы .vhdx растут по мере использования и сами не уменьшаются, даже если внутри всё удалить.", "info", false, 43.68 * GB, 1, "C:\\Users\\commander\\AppData\\Local\\wsl\\{2e5d6add}\\ext4.vhdx"],
  ["winsxs", "info", "Хранилище компонентов Windows (WinSxS)", "Все версии системных файлов для обновлений и восстановления. Большая часть — жёсткие ссылки на файлы в самой Windows, поэтому реально занято меньше, чем показано.", "info", false, 19.2 * GB, 148000, "C:\\Windows\\WinSxS"],
  ["restore-points", "info", "Точки восстановления и теневые копии", "Снимки системы для отката после неудачных обновлений и драйверов. Хранятся в закрытой папке System Volume Information.", "info", true, 0, 0, "C:\\System Volume Information"],
].map(([id, category, title, desc, safety, needs_admin, size, files, path]) => ({
  id, category, title, desc, safety, needs_admin,
  admin_reason: needs_admin ? "Папка принадлежит системе: читать и удалять в ней могут только администраторы и сама Windows." : "",
  accessible: !(needs_admin && size === 0), size, files,
  targets: path ? [{ path, size, files }, ...(id === "shader-cache" ? [{ path: "C:\\Users\\commander\\AppData\\Local\\D3DSCache", size: 12 * MB, files: 218 }] : [])] : [],
  hint: id === "hiberfil" ? "Отключается командой powercfg /h off в терминале администратора. Пропадут гибернация и быстрый запуск." : id === "docker-wsl" ? "Сначала docker system prune -a, затем wsl --shutdown и сжатие диска: Optimize-VHD или diskpart → compact vdisk." : id === "winsxs" ? "Старые версии компонентов убирает «Очистка диска» → «Очистить системные файлы»." : id === "restore-points" ? "Лимит места и удаление старых точек: «Защита системы» → выберите диск → «Настроить»." : "",
  action: id === "restore-points" ? "tool:system-protection" : id === "winsxs" ? "tool:disk-cleanup" : "",
  running: id === "chromium:google\\chrome" || id === "chromium:claude",
}));

let tasks: any[] = [
  { id: "task-demo", name: "Еженедельная уборка", kind: "weekly", time: "03:00", weekday: 7, monthday: 1, rules: ["user-temp", "shader-cache", "npm-cache", "chromium:google\\chrome"], notify: true, low_space_pct: 10, elevated: false, enabled: true, registered: true, only_below_pct: 0, watch_growth_gb: 10, exe: "" },
];

const history = Array.from({ length: 60 }, (_, i) => ({
  t: now - (59 - i) * 86400,
  drives: [{ root: "C:\\", total: 1862 * GB, free: (560 - i * 1.6 + Math.sin(i / 3) * 14 + (i > 40 ? 22 : 0)) * GB }],
}));

function subtree(id: number, budget: number) {
  const root = nodes[id];
  const min = root.size / 40000;
  const out: any[] = [{ id, p: -1, name: id === 0 ? "C:\\" : root.name, size: root.size, dir: root.dir, cat: root.cat, files: root.files }];
  const queue: [number, number][] = [[id, 0]];
  while (queue.length && out.length < budget) {
    queue.sort((a, b) => nodes[b[0]].size - nodes[a[0]].size);
    const [nid, oi] = queue.shift()!;
    let rest = 0, restN = 0;
    for (const c of [...nodes[nid].children].sort((a, b) => nodes[b].size - nodes[a].size)) {
      const n = nodes[c];
      if (!alive(c) || n.size <= 0) continue;
      if (n.size < min) { rest += n.size; restN++; continue; }
      out.push({ id: c, p: oi, name: n.name, size: n.size, dir: n.dir, cat: n.cat, files: n.files });
      if (n.dir && n.children.length) queue.push([c, out.length - 1]);
    }
    if (rest > 0) out.push({ id: 4294967295, p: oi, name: String(restN), size: rest, dir: false, cat: 255, files: restN });
  }
  return out;
}

function remove(id: number) {
  const n = nodes[id];
  for (let c = n.parent; ; c = nodes[c].parent) {
    nodes[c].size -= n.size;
    nodes[c].files -= n.files;
    if (c === 0) break;
  }
  nodes[n.parent].children = nodes[n.parent].children.filter((c) => c !== id);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function mockCall<T>(cmd: string, a: Record<string, any>): Promise<T> {
  await wait(30);
  const r = ((): unknown => {
    switch (cmd) {
      case "list_drives": return drives;
      case "privilege_info": return { elevated: false, elevation_type: 3, user: "PC\\commander" };
      case "startup_scan": return null;
      case "scan_summaries": return scanned ? [summary()] : [];
      case "set_visibility":
        mockHidden = (a.showHidden ? 0 : 152 * GB) + (a.showSystem ? 0 : 29 * GB);
        return scanned ? [summary()] : [];
      case "start_scan": {
        let t = 0;
        scanTimer = window.setInterval(() => {
          t += 90;
          const k = Math.min(1, t / 2600);
          emit("scan-progress", { root: a.root, mode: a.mode === "mft" ? "mft" : "walk", files: Math.floor(1928468 * k), dirs: Math.floor(462605 * k), bytes: nodes[0].size * k, done: 0, total: 0, elapsed_ms: t });
          if (k >= 1) {
            window.clearInterval(scanTimer!);
            scanned = true;
            emit("scan-done", { summary: summary(), note: null });
          }
        }, 90);
        return null;
      }
      case "cancel_scan":
        if (scanTimer) window.clearInterval(scanTimer);
        emit("scan-error", { root: "C:\\", message: "cancelled", cancelled: true });
        return null;
      case "get_dir": {
        const n = nodes[a.id];
        const crumbs: any[] = [];
        for (let c = a.id; ; c = nodes[c].parent) { crumbs.unshift({ id: c, name: c === 0 ? "C:\\" : nodes[c].name }); if (c === 0) break; }
        return { node: { ...dto(n), name: a.id === 0 ? "C:\\" : n.name }, path: pathOf(a.id), crumbs, children: n.children.map((c) => dto(nodes[c])).sort((x, y) => y.size - x.size) };
      }
      case "get_subtree": return subtree(a.id, a.budget);
      case "top_files":
        return nodes
          .filter((n) => !n.dir && alive(n.id) && (!a.olderThanDays || n.mtime < now - a.olderThanDays * 86400))
          .sort((x, y) => y.size - x.size)
          .slice(0, a.limit)
          .map(fileDto);
      case "pick_folder": return null;
      case "export_csv": return "C:\\Users\\commander\\Documents\\space-commander-report.csv";
      case "snapshots_list": {
        const meta = (i: number, mode: string, alloc: number) => ({ id: `C___${i}`, root: "C:\\", mode, taken_at: now - i * 86400 * 4, alloc, files: 1928468 - i * 4100 });
        return scanned ? [meta(0, "walk", nodes[0].size), meta(1, "walk", nodes[0].size - 23 * GB), meta(3, "mft", nodes[0].size - 41 * GB), meta(7, "walk", nodes[0].size - 58 * GB)] : [];
      }
      case "snapshot_diff": {
        const item = (path: string, dir: boolean, old: number, nw: number, extra = {}) => ({ path, dir, old: old * GB, new: nw * GB, delta: (nw - old) * GB, is_new: false, gone: false, ...extra });
        const items = [
          item("C:\\Users\\commander\\AppData\\Local\\NVIDIA\\DXCache", true, 14.2, 26.1),
          item("C:\\Users\\commander\\AppData\\Local\\wsl\\{2e5d6add}\\ext4.vhdx", false, 36.5, 43.7),
          item("C:\\Program Files (x86)\\Steam\\steamapps\\common\\Hollow Forge", true, 0, 6.1, { is_new: true }),
          item("C:\\Users\\commander\\Videos\\Записи", true, 8.3, 12.9),
          item("C:\\Users\\commander\\Downloads", true, 41.0, 37.6),
          item("C:\\Users\\commander\\source\\engine\\target", true, 6.4, 9.8),
          item("C:\\Program Files (x86)\\Steam\\steamapps\\common\\Old Racer", true, 5.2, 0, { gone: true }),
          item("C:\\Users\\commander\\.ollama\\models", true, 16.1, 18.0),
        ].sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
        const snaps = [0, 1, 3, 7].map((i) => ({ id: `C___${i}`, root: "C:\\", mode: i === 3 ? "mft" : "walk", taken_at: now - i * 86400 * 4, alloc: nodes[0].size, files: 1928468 }));
        const base = snaps.find((x) => x.id === a.baseId) ?? snaps[1];
        return { base, current: snaps[0], delta: 23 * GB, delta_files: 4100, mixed_modes: base.mode !== "walk", items: items.slice(0, a.limit) };
      }
      case "installed_apps": {
        const app = (name: string, source: string, path: string, gb: number, played: number, publisher = "") => ({
          name, source, path, publisher, reported_size: gb * GB, last_played: played ? now - played * 86400 : 0,
          uninstall: source === "steam" ? "steam://uninstall/1" : "", size: gb * GB, alloc: gb * GB, mtime: now - (played || 200) * 86400, node: scanned ? 1 : null, root: "C:\\",
        });
        return [
          app("Rally Legends", "steam", "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Rally Legends", 140, 2),
          app("Cyber Odyssey", "steam", "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Cyber Odyssey", 120, 410),
          app("METAPHOR", "steam", "C:\\Program Files (x86)\\Steam\\steamapps\\common\\METAPHOR", 96, 35),
          app("Starfield Tactics", "steam", "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Starfield Tactics", 88, 0),
          app("DEATHLOOP", "epic", "C:\\Program Files\\Epic Games\\DEATHLOOP", 31, 0),
          app("No Man's Sky", "gog", "C:\\GOG Games\\No Man's Sky", 24.9, 0),
          app("Unreal Engine", "epic", "C:\\Program Files\\Epic Games\\UE_5.7", 66, 0),
          app("Microsoft Visual Studio 2026", "program", "C:\\Program Files\\Microsoft Visual Studio\\2026", 28.4, 0, "Microsoft Corporation"),
          app("Blender", "program", "C:\\Program Files\\Blender Foundation\\Blender 4.5", 1.3, 0, "Blender Foundation"),
          app("Git", "program", "C:\\Program Files\\Git", 0.34, 0, "The Git Development Community"),
        ];
      }
      case "ext_stats": {
        const m = new Map<string, any>();
        for (const n of nodes) {
          if (n.dir) continue;
          const ext = n.name.includes(".") ? n.name.split(".").pop()! : "";
          const e = m.get(ext) ?? { ext, cat: n.cat, size: 0, alloc: 0, count: 0 };
          e.size += n.size; e.alloc += n.size; e.count += 137;
          m.set(ext, e);
        }
        return [...m.values()].sort((x, y) => y.alloc - x.alloc);
      }
      case "search": {
        const q = String(a.query).toLowerCase();
        const hits = nodes.filter((n) => n.id !== 0 && n.name.toLowerCase().includes(q));
        return { total: hits.length, items: hits.sort((x, y) => y.size - x.size).slice(0, a.limit).map(fileDto) };
      }
      case "find_path": return 0;
      case "parent_of": return nodes[a.id].parent;
      case "denied_paths": return ["C:\\Windows\\CSC", "C:\\Windows\\System32\\LogFiles\\WMI\\RtBackup", "C:\\Windows\\Temp", "C:\\ProgramData\\Microsoft\\Windows Defender\\Scans", "C:\\System Volume Information", "C:\\Users\\commander\\AppData\\Local\\ElevatedDiagnostics"];
      case "dev_artifacts": return [
        { id: 30, path: "C:\\Users\\commander\\source\\old-shop\\node_modules", project: "C:\\Users\\commander\\source\\old-shop", kind: "Node.js", size: 1.4 * GB, alloc: 1.6 * GB, files: 84211, project_mtime: now - 86400 * 410 },
        { id: 31, path: "C:\\Users\\commander\\source\\engine\\target", project: "C:\\Users\\commander\\source\\engine", kind: "Rust", size: 9.8 * GB, alloc: 9.9 * GB, files: 31200, project_mtime: now - 86400 * 3 },
        { id: 32, path: "C:\\Users\\commander\\source\\ml-lab\\.venv", project: "C:\\Users\\commander\\source\\ml-lab", kind: "Python venv", size: 5.2 * GB, alloc: 5.3 * GB, files: 40122, project_mtime: now - 86400 * 95 },
      ];
      case "delete_nodes": {
        const freed = (a.ids as number[]).reduce((s, id) => s + nodes[id].size, 0);
        (a.ids as number[]).forEach(remove);
        return { freed, deleted: a.ids, errors: [] };
      }
      case "junk_scan": return junk;
      case "junk_clean": {
        const items = junk.filter((j) => (a.ids as string[]).includes(j.id as string));
        const freed = items.reduce((s, j) => s + (j.size as number), 0);
        items.forEach((j) => { (j as any).size = 0; (j as any).files = 0; });
        const skipped = a.skipRunning ? items.filter((j) => (j as any).running).map((j) => j.title as string) : [];
        return { freed, files: 1234, failed: 3, errors: ["C:\\Users\\commander\\AppData\\Local\\Temp\\~DF1.TMP — файл занят другим процессом"], items: [], skipped };
      }
      case "dupes_start": {
        let t = 0;
        const timer = window.setInterval(() => {
          t += 120;
          emit("dupes-progress", { files: t * 3, done: t * 40 * MB, total: 2400 * 40 * MB });
          if (t >= 2400) {
            window.clearInterval(timer);
            const files = nodes.filter((n) => !n.dir).sort((x, y) => y.size - x.size).slice(4, 16);
            const groups = [0, 1, 2, 3].map((g) => ({
              size: files[g * 3].size / 20, wasted: (files[g * 3].size / 20) * 2,
              files: [0, 1, 2].map((k) => ({ id: files[g * 3 + k].id, path: pathOf(files[g * 3 + k].id), mtime: files[g * 3 + k].mtime })),
            }));
            emit("dupes-done", { groups, wasted: groups.reduce((s, g) => s + g.wasted, 0), candidates: 4812 });
          }
        }, 120);
        return null;
      }
      case "tasks_list": return tasks;
      case "task_save": {
        const t = { ...a.task, id: a.task.id || `task-${Date.now()}`, registered: true };
        tasks = [...tasks.filter((x) => x.id !== t.id), t];
        return t;
      }
      case "task_delete": tasks = tasks.filter((x) => x.id !== a.id); return null;
      case "task_runs": return [
        { task_id: "task-demo", task_name: "Еженедельная уборка", at: now - 86400 * 2, freed: 4.2 * GB, files: 18400, failed: 12, note: "", drives: [] },
        { task_id: "task-demo", task_name: "Еженедельная уборка", at: now - 86400 * 9, freed: 2.9 * GB, files: 11200, failed: 4, note: "", drives: [] },
      ];
      case "history_get": return history;
      default: return null;
    }
  })();
  return localize(r as T);
}
