import { Copy, FolderOpen, Trash2 } from "lucide-react";
import { call, DeleteReport } from "../api";
import { fmtBytes, plural } from "../format";
import { t } from "../i18n";
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
        if (ask.permanent) toast("ok", t("Удалено: {0}", fmtBytes(r.freed)));
        else toast("ok", t("В Корзине: {0}", fmtBytes(r.freed)), t("Место освободится после очистки Корзины"));
      }
      if (r.errors.length) toast("error", r.deleted.length ? t("Часть объектов удалить не удалось") : t("Не удалось удалить"), r.errors.slice(0, 3).join("\n"));
      select(null);
      bump();
      void refreshDrives();
      ask.onDone?.(r.deleted);
    } catch (e) {
      toast("error", t("Не удалось удалить"), String(e));
    }
  };

  const count = `${n} ${plural(n, "объект", "объекта", "объектов")}`;
  return (
    <Confirm
      title={ask.permanent ? t("Удалить навсегда?") : t("Переместить в Корзину?")}
      confirmLabel={ask.permanent ? t("Удалить навсегда") : t("В Корзину")}
      danger
      onConfirm={() => void run()}
      onClose={() => close(null)}
      text={
        ask.permanent
          ? t("{0} на {1} будут удалены без возможности восстановления.", count, fmtBytes(total))
          : t("{0} на {1} можно будет вернуть из Корзины.", count, fmtBytes(total))
      }
    >
      <ul className="path-list paths">
        {ask.items.slice(0, 8).map((i) => (
          <li key={i.id}>
            <span>{i.name}</span>
            <b>{fmtBytes(i.size)}</b>
          </li>
        ))}
        {n > 8 && <li className="more">{t("и ещё {0}", n - 8)}</li>}
      </ul>
    </Confirm>
  );
}

/** Пункты контекстного меню для файла или папки. */
export function fileMenu(opts: { root: string; id: number; name: string; path: string; size: number; dir: boolean; onOpen?: () => void }): (MenuItem | null)[] {
  const s = useStore.getState();
  return [
    opts.onOpen ? { label: opts.dir ? t("Открыть на карте") : t("Показать на карте"), icon: <FolderOpen size={14} />, onClick: opts.onOpen } : null,
    {
      label: t("Показать в Проводнике"),
      icon: <FolderOpen size={14} />,
      onClick: () => void call("reveal", { path: opts.path }).catch((e) => s.toast("error", t("Не удалось открыть Проводник"), String(e))),
    },
    {
      label: t("Скопировать путь"),
      icon: <Copy size={14} />,
      onClick: () => void navigator.clipboard.writeText(opts.path).then(() => s.toast("info", t("Путь скопирован"))),
    },
    null,
    {
      label: t("В Корзину"),
      icon: <Trash2 size={14} />,
      onClick: () => s.askDelete({ root: opts.root, items: [{ id: opts.id, name: opts.name, size: opts.size }], permanent: false }),
    },
    {
      label: t("Удалить навсегда…"),
      icon: <Trash2 size={14} />,
      danger: true,
      onClick: () => s.askDelete({ root: opts.root, items: [{ id: opts.id, name: opts.name, size: opts.size }], permanent: true }),
    },
  ].filter((x, i, a) => !(x === null && (i === 0 || a[i - 1] === null))) as (MenuItem | null)[];
}

/** Сохраняет отчёт в CSV через системный диалог. */
export async function exportCsv(root: string, kind: "dir" | "top" | "types", id: number, olderThanDays = 0) {
  const s = useStore.getState();
  try {
    const path = await call<string | null>("export_csv", { root, kind, id, byAlloc: s.byAlloc, olderThanDays });
    if (path) s.toast("ok", t("Отчёт сохранён"), path);
  } catch (e) {
    s.toast("error", t("Не удалось сохранить отчёт"), String(e));
  }
}
