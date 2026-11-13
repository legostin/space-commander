import { invoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { mockCall, mockListen } from "./mock";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface Drive {
  root: string;
  letter: string;
  label: string;
  fs: string;
  kind: string;
  total: number;
  free: number;
  cluster: number;
}
export interface Privilege {
  elevated: boolean;
  elevation_type: number;
  user: string;
}
export interface NodeDto {
  id: number;
  name: string;
  size: number;
  alloc: number;
  files: number;
  dir: boolean;
  mtime: number;
  flags: number;
  cat: number;
}
export interface DirView {
  node: NodeDto;
  path: string;
  crumbs: { id: number; name: string }[];
  children: NodeDto[];
}
export interface SubNode {
  id: number;
  p: number;
  name: string;
  size: number;
  dir: boolean;
  cat: number;
  files: number;
}
export interface FileDto {
  id: number;
  name: string;
  path: string;
  size: number;
  alloc: number;
  mtime: number;
  dir: boolean;
  cat: number;
}
export interface ExtStat {
  ext: string;
  cat: number;
  size: number;
  alloc: number;
  count: number;
}
export interface ScanSummary {
  root: string;
  mode: string;
  duration_ms: number;
  files: number;
  dirs: number;
  size: number;
  alloc: number;
  denied: number;
  scanned_at: number;
  /** Сколько скрыто фильтром «скрытые/системные». */
  hidden_size: number;
  hidden_alloc: number;
  hidden_files: number;
}
export interface SnapMeta {
  id: string;
  root: string;
  mode: string;
  taken_at: number;
  alloc: number;
  files: number;
}
export interface DiffItem {
  path: string;
  dir: boolean;
  old: number;
  new: number;
  delta: number;
  is_new: boolean;
  gone: boolean;
}
export interface Diff {
  base: SnapMeta;
  current: SnapMeta;
  delta: number;
  delta_files: number;
  mixed_modes: boolean;
  items: DiffItem[];
}
export interface InstalledApp {
  name: string;
  source: "steam" | "epic" | "gog" | "program";
  path: string;
  publisher: string;
  reported_size: number;
  last_played: number;
  uninstall: string;
  size: number;
  alloc: number;
  mtime: number;
  node: number | null;
  root: string;
}
export interface ScanProgress {
  root: string;
  mode: string;
  quiet: boolean;
  files: number;
  dirs: number;
  bytes: number;
  done: number;
  total: number;
  elapsed_ms: number;
}
export interface JunkTarget {
  path: string;
  size: number;
  files: number;
}
export interface JunkItem {
  id: string;
  category: string;
  title: string;
  desc: string;
  safety: "safe" | "caution" | "info";
  needs_admin: boolean;
  admin_reason: string;
  accessible: boolean;
  size: number;
  files: number;
  targets: JunkTarget[];
  hint: string;
  action: string;
  running: boolean;
}
export interface CleanReport {
  freed: number;
  files: number;
  failed: number;
  errors: string[];
  skipped: string[];
  items: { id: string; title: string; freed: number; files: number; failed: number }[];
}
export interface Artifact {
  id: number;
  path: string;
  project: string;
  kind: string;
  size: number;
  alloc: number;
  files: number;
  project_mtime: number;
}
export interface DupGroup {
  size: number;
  wasted: number;
  files: { id: number; path: string; mtime: number }[];
}
export interface DupResult {
  groups: DupGroup[];
  wasted: number;
  candidates: number;
}
export interface Task {
  id: string;
  name: string;
  kind: "daily" | "weekly" | "monthly";
  time: string;
  weekday: number;
  monthday: number;
  rules: string[];
  notify: boolean;
  low_space_pct: number;
  elevated: boolean;
  enabled: boolean;
  registered: boolean;
  only_below_pct: number;
  watch_growth_gb: number;
  exe: string;
}
export interface RunLog {
  task_id: string;
  task_name: string;
  at: number;
  freed: number;
  files: number;
  failed: number;
  note: string;
  drives: { root: string; total: number; free: number }[];
}
export interface Sample {
  t: number;
  drives: { root: string; total: number; free: number }[];
}
export interface DeleteReport {
  freed: number;
  deleted: number[];
  errors: string[];
}

export function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return isTauri ? invoke<T>(cmd, args) : mockCall<T>(cmd, args ?? {});
}

export function listen<T>(event: string, handler: (payload: T) => void): () => void {
  if (!isTauri) return mockListen(event, handler as (p: unknown) => void);
  let off: (() => void) | null = null;
  let cancelled = false;
  tauriListen<T>(event, (e) => handler(e.payload)).then((un) => {
    if (cancelled) un();
    else off = un;
  });
  return () => {
    cancelled = true;
    off?.();
  };
}

export async function windowAction(action: "minimize" | "toggleMaximize" | "close") {
  if (!isTauri) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const w = getCurrentWindow();
  if (action === "minimize") await w.minimize();
  else if (action === "toggleMaximize") await w.toggleMaximize();
  else await w.close();
}
