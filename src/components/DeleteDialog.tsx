import { Copy, FolderOpen, Trash2 } from "lucide-react";
import { call, DeleteReport } from "../api";
import { fmtBytes, plural } from "../format";
import { useStore } from "../store";
import { Confirm, MenuItem } from "./ui";

/** Общий диалог удаления: в Корзину (по умолчанию) или безвозвратно. */
export function DeleteDialog() {
  const ask = useStore((s) => s.deleteAsk);
  const close = useStore((s) => s.askDelete);
  const toast = useStore((s) => s.toast);
  const bump = useStore((s) => s.bumpTree);
  const refreshDrives = useStore((s) => s.refreshDrives);
  const select = useStore((s) => s.select);
  if (!ask) return null;
  const total = ask.items.reduce((s, i) => s + i.size, 0);
  const n = ask.items.length;

  const run = async () => {
    try {
      const r = await call<DeleteReport>("delete_nodes", { root: ask.root, ids: ask.items.map((i) => i.id), permanent: ask.permanent });
      if (r.deleted.length) {
        toast("ok", ask.permanent ? `Удалено: ${fmtBytes(r.freed)}` : `В Корзине: ${fmtBytes(r.freed)}`, ask.permanent ? undefined : "Место освободится после очистки Корзины");
      }
      if (r.errors.length) toast("error", r.deleted.length ? "Часть объектов удалить не удалось" : "Не удалось удалить", r.errors.slice(0, 3).join("\n"));
      select(null);
      bump();
      void refreshDrives();
      ask.onDone?.(r.deleted);
    } catch (e) {
      toast("error", "Не удалось удалить", String(e));
    }
  };

  return (
    <Confirm
      title={ask.permanent ? "Удалить навсегда?" : "Переместить в Корзину?"}
      confirmLabel={ask.permanent ? "Удалить навсегда" : "В Корзину"}
      danger
      onConfirm={() => void run()}
      onClose={() => close(null)}
      text={
        ask.permanent ? (
          <>
            {n} {plural(n, "объект", "объекта", "объектов")} на {fmtBytes(total)} будут удалены без возможности восстановления.
          </>
        ) : (
          <>
            {n} {plural(n, "объект", "объекта", "объектов")} на {fmtBytes(total)} можно будет вернуть из Корзины.
          </>
        )
      }
    >
      <ul className="path-list">
        {ask.items.slice(0, 8).map((i) => (
          <li key={i.id}>
            <span>{i.name}</span>
            <b>{fmtBytes(i.size)}</b>
          </li>
        ))}
        {n > 8 && <li className="more">и ещё {n - 8}</li>}
      </ul>
    </Confirm>
  );
}

/** Пункты контекстного меню для файла или папки. */
export function fileMenu(opts: { root: string; id: number; name: string; path: string; size: number; dir: boolean; onOpen?: () => void }): (MenuItem | null)[] {
  const s = useStore.getState();
  return [
    opts.onOpen ? { label: opts.dir ? "Открыть на карте" : "Показать на карте", icon: <FolderOpen size={14} />, onClick: opts.onOpen } : null,
    {
      label: "Показать в Проводнике",
      icon: <FolderOpen size={14} />,
      onClick: () => void call("reveal", { path: opts.path }).catch((e) => s.toast("error", "Не удалось открыть Проводник", String(e))),
    },
    {
      label: "Скопировать путь",
      icon: <Copy size={14} />,
      onClick: () => void navigator.clipboard.writeText(opts.path).then(() => s.toast("info", "Путь скопирован")),
    },
    null,
    {
      label: "В Корзину",
      icon: <Trash2 size={14} />,
      onClick: () => s.askDelete({ root: opts.root, items: [{ id: opts.id, name: opts.name, size: opts.size }], permanent: false }),
    },
    {
      label: "Удалить навсегда…",
      icon: <Trash2 size={14} />,
      danger: true,
      onClick: () => s.askDelete({ root: opts.root, items: [{ id: opts.id, name: opts.name, size: opts.size }], permanent: true }),
    },
  ].filter((x, i, a) => !(x === null && (i === 0 || a[i - 1] === null))) as (MenuItem | null)[];
}
