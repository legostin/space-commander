import { useEffect, useState } from "react";
import { Bell, CalendarClock, Lock, Pencil, Play, Plus, Trash2, TriangleAlert } from "lucide-react";
import { call, JunkItem, RunLog, Task } from "../api";
import { fmtBytes, fmtDateTime, fmtNum } from "../format";
import { useStore } from "../store";
import { Check, Confirm, Empty, Modal, Size, Spinner, Toggle } from "../components/ui";

const WEEKDAYS = ["понедельник", "вторник", "среду", "четверг", "пятницу", "субботу", "воскресенье"];
const WEEKDAYS_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

export function describeSchedule(t: Task): string {
  if (t.kind === "daily") return `Каждый день в ${t.time}`;
  if (t.kind === "weekly") {
    const every = t.weekday === 3 || t.weekday === 5 || t.weekday === 6 ? "Каждую" : t.weekday === 7 ? "Каждое" : "Каждый";
    return `${every} ${WEEKDAYS[t.weekday - 1] ?? ""} в ${t.time}`;
  }
  return `${t.monthday}-го числа каждого месяца в ${t.time}`;
}

/** Время следующего запуска, unix-секунды. */
export function nextRun(t: Task, from = new Date()): number {
  const [h, m] = t.time.split(":").map(Number);
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setHours(h || 0, m || 0);
  if (t.kind === "daily") {
    if (d <= from) d.setDate(d.getDate() + 1);
  } else if (t.kind === "weekly") {
    const want = t.weekday % 7; // JS: 0 — воскресенье
    let add = (want - d.getDay() + 7) % 7;
    if (add === 0 && d <= from) add = 7;
    d.setDate(d.getDate() + add);
  } else {
    d.setDate(t.monthday);
    if (d <= from) d.setMonth(d.getMonth() + 1, t.monthday);
  }
  return Math.floor(d.getTime() / 1000);
}

const BLANK: Task = { id: "", name: "Регулярная уборка", kind: "weekly", time: "03:00", weekday: 7, monthday: 1, rules: [], notify: true, low_space_pct: 10, elevated: false, enabled: true, registered: false };

function Editor({ initial, junk, onClose, onSaved }: { initial: Task; junk: JunkItem[]; onClose: () => void; onSaved: () => void }) {
  const priv = useStore((s) => s.priv);
  const toast = useStore((s) => s.toast);
  const askElevation = useStore((s) => s.askElevation);
  const [t, setT] = useState<Task>(initial);
  const [saving, setSaving] = useState(false);
  const elevated = !!priv?.elevated;
  const rules = junk.filter((j) => j.safety !== "info" && j.id !== "old-installers" && j.id !== "recycle-bin");
  const set = (patch: Partial<Task>) => setT((p) => ({ ...p, ...patch }));
  const toggleRule = (id: string, v: boolean) => set({ rules: v ? [...t.rules, id] : t.rules.filter((r) => r !== id) });
  const needsAdmin = rules.some((j) => j.needs_admin && t.rules.includes(j.id));
  const groups = ["system", "browsers", "apps", "dev"].map((c) => ({ c, rows: rules.filter((j) => j.category === c) })).filter((g) => g.rows.length);
  const groupName: Record<string, string> = { system: "Система", browsers: "Браузеры", apps: "Приложения", dev: "Разработка" };

  const save = async () => {
    setSaving(true);
    try {
      await call<Task>("task_save", { task: { ...t, elevated: needsAdmin } });
      toast("ok", "Задача сохранена", "Она добавлена в Планировщик Windows");
      onSaved();
      onClose();
    } catch (e) {
      toast("error", "Не удалось сохранить задачу", String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={initial.id ? "Изменить задачу" : "Новая задача"}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Отмена
          </button>
          <button className="btn primary" disabled={saving || !t.name.trim()} onClick={() => void save()}>
            {saving && <Spinner size={13} />}
            Сохранить
          </button>
        </>
      }
    >
      <div className="form">
        <label className="field">
          <span>Название</span>
          <input value={t.name} onChange={(e) => set({ name: e.target.value })} maxLength={60} />
        </label>
        <div className="field-row">
          <div className="field">
            <span>Как часто</span>
            <div className="seg">
              {(["daily", "weekly", "monthly"] as const).map((k) => (
                <button key={k} className={t.kind === k ? "on" : ""} onClick={() => set({ kind: k })}>
                  {k === "daily" ? "Каждый день" : k === "weekly" ? "Раз в неделю" : "Раз в месяц"}
                </button>
              ))}
            </div>
          </div>
          {t.kind === "weekly" && (
            <div className="field">
              <span>День</span>
              <div className="seg">
                {WEEKDAYS_SHORT.map((d, i) => (
                  <button key={d} className={t.weekday === i + 1 ? "on" : ""} onClick={() => set({ weekday: i + 1 })}>
                    {d}
                  </button>
                ))}
              </div>
            </div>
          )}
          {t.kind === "monthly" && (
            <label className="field narrow">
              <span>Число</span>
              <input type="number" min={1} max={28} value={t.monthday} onChange={(e) => set({ monthday: Math.max(1, Math.min(28, Number(e.target.value) || 1)) })} />
            </label>
          )}
          <label className="field narrow">
            <span>Время</span>
            <input type="time" value={t.time} onChange={(e) => set({ time: e.target.value || "03:00" })} />
          </label>
        </div>

        <div className="field">
          <span>Что очищать</span>
          <div className="rule-pick">
            {groups.map((g) => (
              <div key={g.c}>
                <div className="rule-group">{groupName[g.c]}</div>
                {g.rows.map((j) => {
                  const locked = j.needs_admin && !elevated;
                  return (
                    <div key={j.id} className={`rule ${locked ? "locked" : ""}`} onClick={() => (locked ? askElevation({ reason: "task" }) : toggleRule(j.id, !t.rules.includes(j.id)))}>
                      {locked ? <Lock size={13} className="tone-warn" /> : <Check checked={t.rules.includes(j.id)} onChange={(v) => toggleRule(j.id, v)} />}
                      <span>{j.title}</span>
                      {j.safety === "caution" && <span className="badge caution">С оговорками</span>}
                      {j.needs_admin && <span className="badge admin">Администратор</span>}
                      <span className="grow" />
                      <span className="dim">{j.size > 0 ? `сейчас ${fmtBytes(j.size)}` : ""}</span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {needsAdmin && (
          <div className="note warn">
            <Lock size={13} /> Выбраны системные папки — Планировщик будет запускать задачу с правами администратора. Такую задачу можно сохранить, только пока приложение само запущено с ними.
          </div>
        )}

        <div className="field-row">
          <label className="switch-row">
            <Toggle checked={t.notify} onChange={(v) => set({ notify: v })} />
            <span>
              <Bell size={13} /> Уведомление с результатом
            </span>
          </label>
          <div className="field">
            <span>Предупреждать, когда свободно меньше</span>
            <div className="seg">
              {[0, 5, 10, 15, 20].map((p) => (
                <button key={p} className={t.low_space_pct === p ? "on" : ""} onClick={() => set({ low_space_pct: p })}>
                  {p === 0 ? "Выкл" : `${p}%`}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}

export function Schedule() {
  const junk = useStore((s) => s.junk);
  const loadJunk = useStore((s) => s.loadJunk);
  const toast = useStore((s) => s.toast);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [runs, setRuns] = useState<RunLog[]>([]);
  const [edit, setEdit] = useState<Task | null>(null);
  const [del, setDel] = useState<Task | null>(null);

  const reload = () => {
    void call<Task[]>("tasks_list").then(setTasks);
    void call<RunLog[]>("task_runs").then(setRuns);
  };
  useEffect(() => {
    reload();
    if (!junk) void loadJunk();
  }, []);

  const titles = new Map((junk ?? []).map((j) => [j.id, j.title]));
  const newTask = () => setEdit({ ...BLANK, rules: (junk ?? []).filter((j) => j.safety === "safe" && !j.needs_admin && j.category !== "downloads").map((j) => j.id) });

  const toggle = async (t: Task, enabled: boolean) => {
    try {
      await call("task_save", { task: { ...t, enabled } });
      reload();
    } catch (e) {
      toast("error", "Не удалось изменить задачу", String(e));
    }
  };

  const runNow = async (t: Task) => {
    try {
      await call("task_run", { id: t.id });
      toast("ok", "Задача запущена", "Результат появится в журнале через несколько секунд");
      window.setTimeout(reload, 6000);
    } catch (e) {
      toast("error", "Не удалось запустить", String(e));
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Расписание</h1>
          <p>Задачи выполняет Планировщик Windows — приложению не нужно быть запущенным и висеть в трее</p>
        </div>
        <button className="btn primary" onClick={newTask} disabled={!junk}>
          <Plus size={15} />
          Новая задача
        </button>
      </div>

      {!tasks ? (
        <div className="card center-row pad">
          <Spinner />
        </div>
      ) : tasks.length === 0 ? (
        <div className="card">
          <Empty
            icon={<CalendarClock size={30} />}
            title="Пока нет задач"
            text="Создайте задачу — и кеши будут очищаться сами: например, каждое воскресенье ночью. Можно включить предупреждение, когда место подходит к концу."
            action={
              <button className="btn primary" onClick={newTask} disabled={!junk}>
                <Plus size={15} />
                Создать задачу
              </button>
            }
          />
        </div>
      ) : (
        <div className="task-list">
          {tasks.map((t) => (
            <div key={t.id} className={`card task ${t.enabled ? "" : "off"}`}>
              <Toggle checked={t.enabled} onChange={(v) => void toggle(t, v)} />
              <div className="task-main">
                <div className="task-title">
                  <b>{t.name}</b>
                  {t.elevated && (
                    <span className="badge admin">
                      <Lock size={10} /> Администратор
                    </span>
                  )}
                  {!t.registered && (
                    <span className="badge caution" title="Задачи нет в Планировщике Windows — сохраните её заново">
                      <TriangleAlert size={10} /> Нет в Планировщике
                    </span>
                  )}
                </div>
                <div className="task-when">
                  {describeSchedule(t)}
                  {t.enabled && <> · следующий запуск {fmtDateTime(nextRun(t))}</>}
                </div>
                <div className="task-rules">
                  {t.rules.slice(0, 6).map((r) => (
                    <span key={r} className="tag">
                      {titles.get(r) ?? r}
                    </span>
                  ))}
                  {t.rules.length > 6 && <span className="tag more">+{t.rules.length - 6}</span>}
                  {t.rules.length === 0 && <span className="dim">Только наблюдение за свободным местом</span>}
                  {t.low_space_pct > 0 && (
                    <span className="tag warn">
                      <Bell size={10} /> меньше {t.low_space_pct}%
                    </span>
                  )}
                </div>
              </div>
              <div className="task-actions">
                <button className="btn sm" onClick={() => void runNow(t)} disabled={!t.registered}>
                  <Play size={12} />
                  Запустить
                </button>
                <button className="icon-btn" title="Изменить" onClick={() => setEdit(t)}>
                  <Pencil size={14} />
                </button>
                <button className="icon-btn" title="Удалить" onClick={() => setDel(t)}>
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="card flush">
        <div className="card-head pad">
          <span>Журнал запусков</span>
        </div>
        {runs.length === 0 ? (
          <div className="pad dim">Запусков ещё не было.</div>
        ) : (
          <div className="table">
            <div className="tr th">
              <span className="c-date wide">Когда</span>
              <span className="c-name">Задача</span>
              <span className="c-count">Файлов</span>
              <span className="c-count">Пропущено</span>
              <span className="c-size">Освобождено</span>
            </div>
            {runs.slice(0, 30).map((r, i) => (
              <div key={i} className="tr" title={r.note}>
                <span className="c-date wide">{fmtDateTime(r.at)}</span>
                <span className="c-name">
                  <b>{r.task_name}</b>
                </span>
                <span className="c-count">{fmtNum(r.files)}</span>
                <span className="c-count">{r.failed ? fmtNum(r.failed) : "—"}</span>
                <span className="c-size">
                  <Size bytes={r.freed} />
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {edit && junk && <Editor initial={edit} junk={junk} onClose={() => setEdit(null)} onSaved={reload} />}
      {del && (
        <Confirm
          title="Удалить задачу?"
          text={
            <>
              «{del.name}» будет удалена из Планировщика Windows. Журнал прошлых запусков сохранится.
            </>
          }
          confirmLabel="Удалить"
          danger
          onClose={() => setDel(null)}
          onConfirm={() =>
            void call("task_delete", { id: del.id })
              .then(reload)
              .catch((e) => toast("error", "Не удалось удалить задачу", String(e)))
          }
        />
      )}
    </div>
  );
}
