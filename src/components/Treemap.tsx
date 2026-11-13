import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SubNode } from "../api";
import { catOf, fmtBytes, fmtCount, fmtPct, REST_ID } from "../format";
import { buildTree, HEADER_H, hitTest, layout, pathOfNode, Rect, TNode } from "../treemap";

interface Props {
  data: SubNode[];
  rootPath: string;
  selected: number | null;
  onSelect: (id: number | null) => void;
  /** Двойной щелчок: войти в папку. */
  onEnter: (dirId: number) => void;
  onContext: (node: TNode, path: string, x: number, y: number) => void;
}

function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(k >= 0 ? c + (255 - c) * k : c * (1 + k))));
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

function clip(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth < 14) return "";
  // Быстрая оценка по средней ширине символа, точное измерение — только когда текст на грани.
  const approx = Math.floor(maxWidth / 6.1);
  if (text.length <= approx - 2) return text;
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = Math.min(text.length, approx + 2);
  while (cut > 1 && ctx.measureText(text.slice(0, cut) + "…").width > maxWidth) cut--;
  return cut > 1 ? text.slice(0, cut) + "…" : "";
}

function restLabel(n: TNode): string {
  return `ещё ${fmtCount(Number(n.name) || n.files)} мелких`;
}

export function Treemap({ data, rootPath, selected, onSelect, onEnter, onContext }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const base = useRef<HTMLCanvasElement>(null);
  const over = useRef<HTMLCanvasElement>(null);
  const [dim, setDim] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<Rect | null>(null);
  const [tip, setTip] = useState({ x: 0, y: 0 });

  useLayoutEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(() => setDim({ w: Math.floor(el.clientWidth), h: Math.floor(el.clientHeight) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const root = useMemo(() => buildTree(data), [data]);
  const rects = useMemo(() => (root && dim.w > 0 && dim.h > 0 ? layout(root, dim.w, dim.h) : []), [root, dim]);

  useEffect(() => {
    const cv = base.current;
    if (!cv || !dim.w) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = dim.w * dpr;
    cv.height = dim.h * dpr;
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, dim.w, dim.h);
    ctx.textBaseline = "middle";

    for (const r of rects) {
      if (!r.leaf) {
        if (r.depth === 0) continue;
        // Рамка папки: чем глубже, тем светлее подложка.
        const l = Math.min(26, 11 + r.depth * 3);
        ctx.fillStyle = `hsl(228 18% ${l}%)`;
        ctx.fillRect(r.x, r.y, r.w, r.h);
        if (r.header) {
          ctx.font = "600 11px 'Segoe UI Variable Text','Segoe UI',sans-serif";
          const size = fmtBytes(r.node.size);
          const sw = ctx.measureText(size).width;
          const name = clip(ctx, r.node.name, r.w - 12 - (r.w > 150 ? sw + 10 : 0));
          ctx.fillStyle = "rgba(232,235,246,.82)";
          ctx.fillText(name, r.x + 6, r.y + HEADER_H / 2 + 0.5);
          if (r.w > 150) {
            ctx.font = "11px 'Segoe UI Variable Text','Segoe UI',sans-serif";
            ctx.fillStyle = "rgba(232,235,246,.42)";
            ctx.fillText(size, r.x + r.w - sw - 6, r.y + HEADER_H / 2 + 0.5);
          }
        }
        continue;
      }
      const gap = r.w > 4 && r.h > 4 ? 1 : 0;
      const x = r.x + gap / 2;
      const y = r.y + gap / 2;
      const w = r.w - gap;
      const h = r.h - gap;
      if (w <= 0 || h <= 0) continue;
      const color = catOf(r.node.cat).color;
      if (w * h > 900) {
        const g = ctx.createLinearGradient(x, y, x + w, y + h);
        g.addColorStop(0, shade(color, 0.1));
        g.addColorStop(1, shade(color, -0.3));
        ctx.fillStyle = g;
      } else {
        ctx.fillStyle = shade(color, -0.12);
      }
      ctx.fillRect(x, y, w, h);
      if (w > 10 && h > 10) {
        ctx.fillStyle = "rgba(255,255,255,.10)";
        ctx.fillRect(x, y, w, 1);
      }
      if (w > 48 && h > 18) {
        const isRest = r.node.id === REST_ID;
        ctx.font = "600 11.5px 'Segoe UI Variable Text','Segoe UI',sans-serif";
        const label = clip(ctx, isRest ? restLabel(r.node) : r.node.name, w - 12);
        const two = h > 36;
        ctx.fillStyle = "rgba(8,9,14,.88)";
        ctx.fillText(label, x + 6, y + (two ? 13 : h / 2 + 0.5));
        if (two && label) {
          ctx.font = "11px 'Segoe UI Variable Text','Segoe UI',sans-serif";
          ctx.fillStyle = "rgba(8,9,14,.62)";
          ctx.fillText(fmtBytes(r.node.size), x + 6, y + 27);
        }
      }
    }
  }, [rects, dim]);

  // Слой подсветки: наведённая и выбранная плитки. Основной холст не перерисовывается.
  useEffect(() => {
    const cv = over.current;
    if (!cv || !dim.w) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== dim.w * dpr || cv.height !== dim.h * dpr) {
      cv.width = dim.w * dpr;
      cv.height = dim.h * dpr;
    }
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, dim.w, dim.h);
    const sel = selected != null ? rects.find((r) => r.node.id === selected) : null;
    if (sel) {
      ctx.strokeStyle = "#ffc46b";
      ctx.lineWidth = 2;
      ctx.strokeRect(sel.x + 1, sel.y + 1, sel.w - 2, sel.h - 2);
    }
    if (hover) {
      ctx.fillStyle = "rgba(255,255,255,.14)";
      ctx.fillRect(hover.x, hover.y, hover.w, hover.h);
      ctx.strokeStyle = "rgba(255,255,255,.95)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(hover.x + 0.75, hover.y + 0.75, hover.w - 1.5, hover.h - 1.5);
    }
  }, [hover, selected, rects, dim]);

  const at = (e: React.MouseEvent) => {
    const b = wrap.current!.getBoundingClientRect();
    const x = e.clientX - b.left;
    const y = e.clientY - b.top;
    const r = hitTest(rects, x, y);
    return { r: r && r.depth > 0 ? r : null, x, y };
  };

  const hoverPath = hover && root ? pathOfNode(hover.node.id === REST_ID ? hover.node.parent! : hover.node, rootPath) : "";
  const total = root?.size ?? 0;

  return (
    <div
      ref={wrap}
      className="treemap"
      onMouseMove={(e) => {
        const { r, x, y } = at(e);
        if (r !== hover) setHover(r);
        setTip({ x, y });
      }}
      onMouseLeave={() => setHover(null)}
      onClick={(e) => {
        const { r } = at(e);
        onSelect(r && r.node.id !== REST_ID ? r.node.id : null);
      }}
      onDoubleClick={(e) => {
        const { r } = at(e);
        if (!r) return;
        const target = r.node.dir ? r.node : r.node.parent;
        if (target && target.parent) onEnter(target.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        const { r } = at(e);
        if (!r || r.node.id === REST_ID) return;
        onSelect(r.node.id);
        onContext(r.node, pathOfNode(r.node, rootPath), e.clientX, e.clientY);
      }}
    >
      <canvas ref={base} style={{ width: dim.w, height: dim.h }} />
      <canvas ref={over} style={{ width: dim.w, height: dim.h }} />
      {hover && (
        <div
          className="tm-tip"
          style={{
            left: Math.min(tip.x + 16, Math.max(0, dim.w - 330)),
            top: tip.y + 22 + 96 > dim.h ? Math.max(0, tip.y - 100) : tip.y + 22,
          }}
        >
          <div className="tm-tip-head">
            <span className="dot" style={{ background: catOf(hover.node.cat).color }} />
            <b>{hover.node.id === REST_ID ? restLabel(hover.node) : hover.node.name}</b>
          </div>
          <div className="tm-tip-row">
            <span className="tm-tip-size">{fmtBytes(hover.node.size)}</span>
            <span>{fmtPct(hover.node.size, total)} этой папки</span>
            {hover.node.dir && <span>{fmtCount(hover.node.files)} файлов</span>}
            {!hover.node.dir && hover.node.id !== REST_ID && <span>{catOf(hover.node.cat).name}</span>}
          </div>
          <div className="tm-tip-path">{hoverPath}</div>
        </div>
      )}
    </div>
  );
}
