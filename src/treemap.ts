import { SubNode } from "./api";

export interface TNode {
  id: number;
  name: string;
  size: number;
  dir: boolean;
  cat: number;
  files: number;
  parent: TNode | null;
  children: TNode[];
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  node: TNode;
  depth: number;
  /** Рисуется сплошной плиткой (файл или нераскрытая папка). */
  leaf: boolean;
  /** У рамки папки есть полоса с названием. */
  header: boolean;
}

export const HEADER_H = 17;
const PAD = 2;

export function buildTree(flat: SubNode[]): TNode | null {
  if (!flat.length) return null;
  const all: TNode[] = flat.map((n) => ({ id: n.id, name: n.name, size: n.size, dir: n.dir, cat: n.cat, files: n.files, parent: null, children: [] }));
  flat.forEach((n, i) => {
    if (n.p >= 0) {
      all[i].parent = all[n.p];
      all[n.p].children.push(all[i]);
    }
  });
  return all[0];
}

function worst(sum: number, min: number, max: number, side: number): number {
  const s2 = side * side;
  const sum2 = sum * sum;
  return Math.max((s2 * max) / sum2, sum2 / (s2 * min));
}

/** Классический squarified treemap: плитки получаются близкими к квадратам. */
function squarify(nodes: TNode[], x: number, y: number, w: number, h: number, place: (n: TNode, x: number, y: number, w: number, h: number) => void) {
  let total = 0;
  for (const n of nodes) total += n.size;
  if (total <= 0 || w <= 0 || h <= 0) return;
  const scale = (w * h) / total;
  let i = 0;
  const n = nodes.length;
  while (i < n) {
    const side = Math.min(w, h);
    if (side <= 0) return;
    const first = nodes[i].size * scale;
    let sum = first;
    let min = first;
    let max = first;
    let cur = worst(sum, min, max, side);
    let j = i + 1;
    while (j < n) {
      const a = nodes[j].size * scale;
      if (a <= 0) break;
      const nsum = sum + a;
      const nmin = Math.min(min, a);
      const nmax = Math.max(max, a);
      const nw = worst(nsum, nmin, nmax, side);
      if (nw > cur) break;
      sum = nsum;
      min = nmin;
      max = nmax;
      cur = nw;
      j++;
    }
    if (w >= h) {
      const rw = sum / h;
      let cy = y;
      for (let k = i; k < j; k++) {
        const rh = (nodes[k].size * scale) / rw;
        place(nodes[k], x, cy, rw, rh);
        cy += rh;
      }
      x += rw;
      w -= rw;
    } else {
      const rh = sum / w;
      let cx = x;
      for (let k = i; k < j; k++) {
        const rw = (nodes[k].size * scale) / rh;
        place(nodes[k], cx, y, rw, rh);
        cx += rw;
      }
      y += rh;
      h -= rh;
    }
    i = j;
  }
}

export function layout(root: TNode, width: number, height: number): Rect[] {
  const out: Rect[] = [];
  const visit = (node: TNode, x: number, y: number, w: number, h: number, depth: number) => {
    if (w < 1 || h < 1) return;
    const expandable = node.dir && node.children.length > 0 && w >= 6 && h >= 6;
    if (!expandable) {
      out.push({ x, y, w, h, node, depth, leaf: true, header: false });
      return;
    }
    const isRoot = depth === 0;
    const header = !isRoot && w >= 58 && h >= 34;
    out.push({ x, y, w, h, node, depth, leaf: false, header });
    const pad = isRoot ? 0 : w > 14 && h > 14 ? PAD : 1;
    const top = header ? HEADER_H : pad;
    const ix = x + pad;
    const iy = y + top;
    const iw = w - pad * 2;
    const ih = h - top - pad;
    if (iw < 2 || ih < 2) return;
    squarify(node.children, ix, iy, iw, ih, (c, cx, cy, cw, ch) => visit(c, cx, cy, cw, ch, depth + 1));
  };
  visit(root, 0, 0, width, height, 0);
  return out;
}

/** Самая глубокая плитка под точкой. Рамки идут в массиве раньше своих детей. */
export function hitTest(rects: Rect[], x: number, y: number): Rect | null {
  for (let i = rects.length - 1; i >= 0; i--) {
    const r = rects[i];
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return r;
  }
  return null;
}

export function pathOfNode(node: TNode, rootPath: string): string {
  const parts: string[] = [];
  for (let n: TNode | null = node; n && n.parent; n = n.parent) parts.push(n.name);
  const base = rootPath.endsWith("\\") ? rootPath : rootPath + "\\";
  return parts.length ? base + parts.reverse().join("\\") : rootPath;
}
