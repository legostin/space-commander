import { useEffect, useState } from "react";
import { Bell, CalendarClock, Lock, Pencil, Play, Plus, Trash2, TrendingUp, TriangleAlert } from "lucide-react";
import { call, JunkItem, RunLog, Task } from "../api";
import { fmtBytes, fmtDateTime, fmtNum } from "../format";
import { getLang, t } from "../i18n";
import { useStore } from "../store";
import { Check, Confirm, Empty, Modal, Size, Spinner, Toggle } from "../components/ui";

const WEEKDAYS_RU = ["понедельник", "вторник", "среду", "четверг", "пятницу", "субботу", "воскресенье"];
const WEEKDAYS_EN = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const WEEKDAYS_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

export function describeSchedule(task: Task): string {
  if (getLang() === "en") {
    if (task.kind === "daily") return `Every day at ${task.time}`;
    if (task.kind === "weekly") return `Every ${WEEKDAYS_EN[task.weekday - 1] ?? ""} at ${task.time}`;
    return `On day ${task.monthday} of every month at ${task.time}`;
  }
  if (task.kind === "daily") return `Каждый день в ${task.time}`;
  if (task.kind === "weekly") {
    const every = task.weekday === 3 || task.weekday === 5 || task.weekday === 6 ? "Каждую" : task.weekday === 7 ? "Каждое" : "Каждый";
    return `${every} ${WEEKDAYS_RU[task.weekday - 1] ?? ""} в ${task.time}`;
  }
  return `${task.monthday}-го числа каждого месяца в ${task.time}`;
}

/** Время следующего запуска, unix-секунды. */
export function nextRun(task: Task, from = new Date()): number {
  const [h, m] = task.time.split(":").map(Number);
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setHours(h || 0, m || 0);
  if (task.kind === "daily") {
    if (d <= from) d.setDate(d.getDate() + 1);
  } else if (task.kind === "weekly") {
    const want = task.weekday % 7; // JS: 0 — воскресенье
    let add = (want - d.getDay() + 7) % 7;
    if (add === 0 && d <= from) add = 7;
    d.setDate(d.getDate() + add);
  } else {
    d.setDate(task.monthday);
    if (d <= from) d.setMonth(d.getMonth() + 1, task.monthday);
  }
  return Math.floor(d.getTime() / 1000);
}

const blank = (): Task => ({
  id: "",
  name: t("Регулярная уборка"),
  kind: "weekly",
  time: "03:00",
  weekday: 7,
  monthday: 1,
  rules: [],
  notify: true,
  low_space_pct: 10,
  elevated: false,
  enabled: true,
  registered: false,
  only_below_pct: 0,
  watch_growth_gb: 0,
  exe: "",
});

function Editor({ initial, junk, onClose, onSaved }: { initial: Task; junk: JunkItem[]; onClose: () => void; onSaved: () => void }) {
  const priv = useStore((s) => s.priv);
  const toast = useStore((s) => s.toast);
  const askElevation = useStore((s) => s.askElevation);
  const [task, setTask] = useState<Task>(initial);
  const [saving, setSaving] = useState(false);
  const elevated = !!priv?.elevated;
  const rules = junk.filter((j) => j.safety !== "info" && j.id !== "old-installers" && j.id !== "recycle-bin");
  const set = (patch: Partial<Task>) => setTask((p) => ({ ...p, ...patch }));
  const toggleRule = (id: string, v: boolean) => set({ rules: v ? [...task.rules, id] : task.rules.filter((r) => r !== id) });
  const needsAdmin = rules.some((j) => j.needs_admin && task.rules.includes(j.id));
  const groups = ["system", "browsers", "apps", "dev"].map((c) => ({ c, rows: rules.filter((j) => j.category === c) })).filter((g) => g.rows.length);
  const groupName: Record<string, string> = { system: "Система", browsers: "Браузеры", apps: "Приложения", dev: "Разработка" };

  const save = async () => {
    setSaving(true);
    try {
      await call<Task>("task_save", { task: { ...task, elevated: needsAdmin } });
      toast("ok", t("Задача сохранена"), t("Она добавлена в Планировщик Windows"));
      onSaved();
      onClose();
    } catch (e) {
      toast("error", t("Не удалось сохранить задачу"), String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={initial.id ? t("Изменить задачу") : t("Новая задача")}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            {t("Отмена")}
          </button>
          <button className="btn primary" disabled={saving || !task.name.trim()} onClick={() => void save()}>
            {saving && <Spinner size={13} />}
            {t("Сохранить")}
          </button>
        </>
      }
    >
      <div className="form">
        <label className="field">
          <span>{t("Название")}</span>
          <input value={task.name} onChange={(e) => set({ name: e.target.value })} maxLength={60} />
        </label>
        <div className="field-row">
          <div className="field">
            <span>{t("Как часто")}</span>
            <div className="seg">
              {(["daily", "weekly", "monthly"] as const).map((k) => (
                <button key={k} className={task.kind === k ? "on" : ""} onClick={() => set({ kind: k })}>
                  {k === "daily" ? t("Каждый день") : k === "weekly" ? t("Раз в неделю") : t("Раз в месяц")}
                </button>
              ))}
            </div>
          </div>
          {task.kind === "weekly" && (
            <div className="field">
              <span>{t("День")}</span>
              <div className="seg">
                {WEEKDAYS_SHORT.map((d, i) => (
                  <button key={d} className={task.weekday === i + 1 ? "on" : ""} onClick={() => set({ weekday: i + 1 })}>
                    {t(d)}
                  </button>
                ))}
              </div>
            </div>
          )}
          {task.kind === "monthly" && (
            <label className="field narrow">
              <span>{t("Число")}</span>
              <input type="number" min={1} max={28} value={task.monthday} onChange={(e) => set({ monthday: Math.max(1, Math.min(28, Number(e.target.value) || 1)) })} />
            </label>
          )}
          <label className="field narrow">
            <span>{t("Время")}</span>
            <input type="time" value={task.time} onChange={(e) => set({ time: e.target.value || "03:00" })} />
          </label>
        </div>

        <div className="field">
          <span>{t("Что очищать")}</span>
          <div className="rule-pick">
            {groups.map((g) => (
              <div key={g.c}>
                <div className="rule-group">{t(groupName[g.c])}</div>
                {g.rows.map((j) => {
                  const locked = j.needs_admin && !elevated;
                  return (
                    <div key={j.id} className={`rule ${locked ? "locked" : ""}`} onClick={() => (locked ? askElevation({ reason: "task" }) : toggleRule(j.id, !task.rules.includes(j.id)))}>
                      {locked ? <Lock size={13} className="tone-warn" /> : <Check checked={task.rules.includes(j.id)} onChange={(v) => toggleRule(j.id, v)} />}
                      <span>{j.title}</span>
                      {j.safety === "caution" && <span className="badge caution">{t("С оговорками")}</span>}
                      {j.needs_admin && <span className="badge admin">{t("Администратор")}</span>}
                      <span className="grow" />
                      <span className="dim">{j.size > 0 ? t("сейчас {0}", fmtBytes(j.size)) : ""}</span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <small className="field-note">{t("Кеши приложений, которые в момент запуска открыты, задача пропускает.")}</small>
        </div>

        {needsAdmin && (
          <div className="note warn">
            <Lock size={13} /> {t("Выбраны системные папки — Планировщик будет запускать задачу с правами администратора. Такую задачу можно сохранить, только пока приложение само запущено с ними.")}
          </div>
        )}

        <div className="field-row">
          <div className="field">
            <span>{t("Когда чистить")}</span>
            <div className="seg">
              {[0, 10, 15, 20, 30].map((p) => (
                <button key={p} className={task.only_below_pct === p ? "on" : ""} onClick={() => set({ only_below_pct: p })}>
                  {p === 0 ? t("Всегда") : t("Свободно < {0}%", p)}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="field-row">
          <div className="field">
            <span>{t("Предупреждать, когда свободно меньше")}</span>
            <div className="seg">
              {[0, 5, 10, 15, 20].map((p) => (
                <button key={p} className={task.low_space_pct === p ? "on" : ""} onClick={() => set({ low_space_pct: p })}>
                  {p === 0 ? t("Выкл") : `${p}%`}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <span>{t("Сообщать, если папка выросла больше чем на")}</span>
            <div className="seg" title={t("Задача просканирует системный диск и сравнит с прошлым запуском. Это занимает до минуты.")}>
              {[0, 5, 10, 20, 50].map((g) => (
                <button key={g} className={task.watch_growth_gb === g ? "on" : ""} onClick={() => set({ watch_growth_gb: g })}>
                  {g === 0 ? t("Выкл") : fmtBytes(g * 1024 ** 3)}
                </button>
              ))}
            </div>
          </div>
        </div>

        <label className="switch-row">
          <Toggle checked={task.notify} onChange={(v) => set({ notify: v })} />
          <span>
            <Bell size={13} /> {t("Уведомление с результатом очистки")}
          </span>
        </label>
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
  const newTask = () => setEdit({ ...blank(), rules: (junk ?? []).filter((j) => j.safety === "safe" && !j.needs_admin && j.category !== "downloads").map((j) => j.id) });

  const toggle = async (task: Task, enabled: boolean) => {
    try {
      await call("task_save", { task: { ...task, enabled } });
      reload();
    } catch (e) {
      toast("error", t("Не удалось изменить задачу"), String(e));
    }
  };

  const runNow = async (task: Task) => {
    try {
      await call("task_run", { id: task.id });
      toast("ok", t("Задача запущена"), t("Результат появится в журнале через несколько секунд"));
      window.setTimeout(reload, task.watch_growth_gb > 0 ? 60000 : 6000);
    } catch (e) {
      toast("error", t("Не удалось запустить"), String(e));
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t("Расписание")}</h1>
          <p>{t("Задачи выполняет Планировщик Windows — приложению не нужно быть запущенным и висеть в трее")}</p>
        </div>
        <button className="btn primary" onClick={newTask} disabled={!junk}>
          <Plus size={15} />
          {t("Новая задача")}
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
            title={t("Пока нет задач")}
            text={t("Создайте задачу — и кеши будут очищаться сами: например, каждое воскресенье ночью. Можно включить предупреждение, когда место подходит к концу или какая-то папка быстро растёт.")}
            action={
              <button className="btn primary" onClick={newTask} disabled={!junk}>
                <Plus size={15} />
                {t("Создать задачу")}
              </button>
            }
          />
        </div>
      ) : (
        <div className="task-list">
          {tasks.map((task) => (
            <div key={task.id} className={`card task ${task.enabled ? "" : "off"}`}>
              <Toggle checked={task.enabled} onChange={(v) => void toggle(task, v)} />
              <div className="task-main">
                <div className="task-title">
                  <b>{task.name}</b>
                  {task.elevated && (
                    <span className="badge admin">
                      <Lock size={10} /> {t("Администратор")}
                    </span>
                  )}
                  {!task.registered && (
                    <span className="badge caution" title={t("Задачи нет в Планировщике Windows — сохраните её заново")}>
                      <TriangleAlert size={10} /> {t("Нет в Планировщике")}
                    </span>
                  )}
                </div>
                <div className="task-when">
                  {describeSchedule(task)}
                  {task.only_below_pct > 0 && ` · ${t("чистит, когда свободно меньше {0}%", task.only_below_pct)}`}
                  {task.enabled && ` · ${t("следующий запуск {0}", fmtDateTime(nextRun(task)))}`}
                </div>
                <div className="task-rules">
                  {task.rules.slice(0, 6).map((r) => (
                    <span key={r} className="tag">
                      {titles.get(r) ?? r}
                    </span>
                  ))}
                  {task.rules.length > 6 && <span className="tag more">+{task.rules.length - 6}</span>}
                  {task.rules.length === 0 && <span className="dim">{t("Без очистки — только наблюдение")}</span>}
                  {task.low_space_pct > 0 && (
                    <span className="tag warn">
                      <Bell size={10} /> {t("меньше {0}%", task.low_space_pct)}
                    </span>
                  )}
                  {task.watch_growth_gb > 0 && (
                    <span className="tag warn">
                      <TrendingUp size={10} /> {t("рост от {0}", fmtBytes(task.watch_growth_gb * 1024 ** 3))}
                    </span>
                  )}
                </div>
              </div>
              <div className="task-actions">
                <button className="btn sm" onClick={() => void runNow(task)} disabled={!task.registered}>
                  <Play size={12} />
                  {t("Запустить")}
                </button>
                <button className="icon-btn" title={t("Изменить")} onClick={() => setEdit(task)}>
                  <Pencil size={14} />
                </button>
                <button className="icon-btn" title={t("Удалить")} onClick={() => setDel(task)}>
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="card flush">
        <div className="card-head pad">
          <span>{t("Журнал запусков")}</span>
        </div>
        {runs.length === 0 ? (
          <div className="pad dim">{t("Запусков ещё не было.")}</div>
        ) : (
          <div className="table">
            <div className="tr th">
              <span className="c-date wide">{t("Когда")}</span>
              <span className="c-name">{t("Задача")}</span>
              <span className="c-count">{t("Файлов")}</span>
              <span className="c-count">{t("Пропущено")}</span>
              <span className="c-size">{t("Освобождено")}</span>
            </div>
            {runs.slice(0, 30).map((r, i) => (
              <div key={i} className="tr" title={r.note}>
                <span className="c-date wide">{fmtDateTime(r.at)}</span>
                <span className="c-name">
                  <span className="two-line">
                    <b>{r.task_name}</b>
                    {r.note && <small>{r.note}</small>}
                  </span>
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
          title={t("Удалить задачу?")}
          text={t("«{0}» будет удалена из Планировщика Windows. Журнал прошлых запусков сохранится.", del.name)}
          confirmLabel={t("Удалить")}
          danger
          onClose={() => setDel(null)}
          onConfirm={() =>
            void call("task_delete", { id: del.id })
              .then(reload)
              .catch((e) => toast("error", t("Не удалось удалить задачу"), String(e)))
          }
        />
      )}
    </div>
  );
}
