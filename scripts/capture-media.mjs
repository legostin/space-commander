// Снимает скриншоты и короткие ролики (GIF) для README на демо-данных — без чьих-либо
// настоящих файлов. Интерфейс открывается в Edge без окна и управляется по протоколу DevTools.
//
//   npm run dev                       (в другом терминале; нужен http://localhost:1420)
//   node scripts/capture-media.mjs    (результат — в docs/media)
//
// Можно снять только часть: node scripts/capture-media.mjs shots | gifs
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import gifenc from "gifenc";
import { PNG } from "pngjs";

const { GIFEncoder, applyPalette, quantize } = gifenc;

const URL = "http://localhost:1420/";
const OUT = join(import.meta.dirname, "..", "docs", "media");
const PORT = 9440;
const what = process.argv[2] ?? "all";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EDGE = [
  join(process.env["ProgramFiles(x86)"] ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
  join(process.env.ProgramFiles ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
  join(process.env.ProgramFiles ?? "", "Google", "Chrome", "Application", "chrome.exe"),
].find((p) => existsSync(p));
if (!EDGE) throw new Error("Не найден Edge или Chrome");

mkdirSync(OUT, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), "sc-media-"));
const browser = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--hide-scrollbars", "--no-first-run", "--window-size=1440,900", "about:blank"], { stdio: "ignore" });

let target;
for (let i = 0; i < 80 && !target; i++) {
  try {
    target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === "page");
  } catch {}
  if (!target) await sleep(250);
}
if (!target) throw new Error("Браузер не запустился");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const js = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? `ошибка в странице: ${expression.slice(0, 80)}`);
  return r.result.result.value;
};
const waitFor = async (expr, timeout = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await js(`!!(${expr})`)) return;
    await sleep(100);
  }
  throw new Error(`не дождался: ${expr}`);
};

/** Открывает приложение заново с нужным языком, темой и размером окна. */
async function open({ lang = "en", theme = "dark", width, height, scale }) {
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await send("Page.enable");
  await send("Page.navigate", { url: URL });
  await sleep(600);
  await js(`localStorage.setItem("sc.lang", ${JSON.stringify(lang)}); localStorage.setItem("sc.theme", ${JSON.stringify(theme)}); localStorage.setItem("sc.showHidden", "1"); localStorage.setItem("sc.showSystem", "1"); location.reload()`);
  await sleep(800);
  await waitFor("document.querySelector('.drive-card') && !document.querySelector('.card-loading')");
  // Курсора в браузере без окна нет — рисуем свой, чтобы в роликах было видно, куда нажимают.
  await js(`(() => {
    const c = document.createElement("div");
    c.id = "demo-cursor";
    c.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2l15 9-6.5 1.5L9 19z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, { position: "fixed", left: "-40px", top: "-40px", zIndex: 99999, pointerEvents: "none", transition: "left .45s cubic-bezier(.3,.7,.3,1), top .45s cubic-bezier(.3,.7,.3,1)", filter: "drop-shadow(0 2px 3px rgba(0,0,0,.5))", display: "none" });
    document.body.appendChild(c);
  })()`);
}

const point = (selector, text) =>
  js(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const el = ${text ? `els.find(e => e.textContent.includes(${JSON.stringify(text)}))` : "els[0]"};
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);

let mouse = { x: 0, y: 0 };
async function move(p, settle = 480) {
  mouse = p;
  await js(`(() => { const c = document.getElementById("demo-cursor"); c.style.display = "block"; c.style.left = "${p.x - 3}px"; c.style.top = "${p.y - 2}px"; })()`);
  await sleep(settle);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y });
}
async function press(clicks = 1) {
  for (let i = 1; i <= clicks; i++) {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: mouse.x, y: mouse.y, button: "left", clickCount: i });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: mouse.x, y: mouse.y, button: "left", clickCount: i });
  }
}
const clickOn = async (selector, text) => {
  const p = await point(selector, text);
  if (!p) throw new Error(`нет элемента: ${selector} ${text ?? ""}`);
  await move(p);
  await sleep(140);
  await press();
};
const nav = (label) => js(`[...document.querySelectorAll(".nav-item")].find(b => b.textContent.includes(${JSON.stringify(label)})).click()`);

async function shot(name) {
  await sleep(350);
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT, name), Buffer.from(r.result.data, "base64"));
  console.log("снимок", name);
}

/** Демо-сканирование диска C: и ожидание карты. */
async function scan() {
  await js(`[...document.querySelectorAll(".drive-card .btn.primary")][0].click()`);
  await waitFor("document.querySelector('.explorer .list-row')");
  await waitFor("!document.querySelector('.toast')", 12000);
}

// ───────────── Скриншоты ─────────────
async function shots() {
  const size = { width: 1440, height: 900, scale: 1.5 };
  await open({ ...size });
  await scan();

  await nav("Overview");
  await sleep(500);
  await shot("overview.png");

  await nav("Disk map");
  await sleep(700);
  const map = await point(".treemap");
  await move({ x: map.x - 230, y: map.y - 60 }, 100);
  await js(`document.getElementById("demo-cursor").style.display = "none"`);
  await sleep(300);
  await shot("disk-map.png");

  await nav("Analysis");
  await sleep(300);
  await js(`[...document.querySelectorAll(".tabs button")].find(b => b.textContent.includes("Changes")).click()`);
  await sleep(600);
  await shot("changes.png");
  await js(`[...document.querySelectorAll(".tabs button")].find(b => b.textContent.includes("Games")).click()`);
  await sleep(600);
  await shot("games.png");

  await nav("Cleanup");
  await waitFor("document.querySelector('.junk-row')");
  await js(`[...document.querySelectorAll(".junk-main")].find(r => r.textContent.includes("shader")).click()`);
  await shot("cleanup.png");

  await nav("Schedule");
  await sleep(400);
  await js(`[...document.querySelectorAll(".page-head .btn")][0].click()`);
  await sleep(500);
  await shot("schedule.png");
  await js(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);

  await nav("Access rights");
  await sleep(300);
  await js(`[...document.querySelectorAll(".access-hero .btn")][0].click()`);
  await sleep(500);
  await shot("permissions.png");

  await open({ ...size, theme: "light" });
  await scan();
  await shot("disk-map-light.png");

  for (const lang of ["de", "ja"]) {
    await open({ ...size, lang });
    await js(`document.querySelectorAll(".nav-item")[3].click()`);
    await waitFor("document.querySelector('.junk-row')");
    await shot(`cleanup-${lang}.png`);
  }
}

// ───────────── Ролики ─────────────

/** Записывает кадры, пока выполняется сценарий; возвращает [{ png, at }]. */
async function record(scenario) {
  const frames = [];
  let running = true;
  const t0 = Date.now();
  const loop = (async () => {
    while (running) {
      const at = Date.now() - t0;
      const r = await send("Page.captureScreenshot", { format: "png" });
      frames.push({ png: Buffer.from(r.result.data, "base64"), at });
      const spent = Date.now() - t0 - at;
      if (spent < 90) await sleep(90 - spent); // около 11 кадров в секунду
    }
  })();
  await scenario();
  running = false;
  await loop;
  return frames;
}

/** Собирает GIF: общая палитра и запись только изменившихся пикселей каждого кадра. */
function encode(frames, file) {
  // SC_FRAMES=<папка> дополнительно сохраняет каждый 15-й кадр — чтобы проверить ролик глазами.
  if (process.env.SC_FRAMES) {
    frames.forEach((f, i) => i % 15 === 0 && writeFileSync(join(process.env.SC_FRAMES, `${file.replace(".gif", "")}-${String(i).padStart(3, "0")}.png`), f.png));
  }
  const decoded = frames.map((f) => PNG.sync.read(f.png));
  const { width, height } = decoded[0];
  // Палитра строится по выборке пикселей из нескольких кадров.
  const step = Math.max(1, Math.floor(decoded.length / 10));
  const sample = [];
  for (let i = 0; i < decoded.length; i += step) {
    const d = decoded[i].data;
    for (let p = 0; p < d.length; p += 4 * 5) sample.push(d[p], d[p + 1], d[p + 2], 255);
  }
  const colors = quantize(new Uint8Array(sample), 255, { format: "rgb565" });
  const TRANSPARENT = colors.length;
  const palette = [...colors, [0, 0, 0]];
  const gif = GIFEncoder();
  let prev = null;
  decoded.forEach((img, i) => {
    const index = applyPalette(img.data, colors, "rgb565");
    const out = new Uint8Array(index.length);
    if (!prev) out.set(index);
    else for (let p = 0; p < index.length; p++) out[p] = index[p] === prev[p] ? TRANSPARENT : index[p];
    const next = frames[i + 1]?.at ?? frames[i].at + 900; // последний кадр держим дольше
    gif.writeFrame(out, width, height, {
      palette: i === 0 ? palette : undefined,
      delay: Math.max(40, next - frames[i].at),
      transparent: i > 0,
      transparentIndex: TRANSPARENT,
      dispose: 1,
    });
    prev = index;
  });
  gif.finish();
  const bytes = gif.bytes();
  writeFileSync(join(OUT, file), bytes);
  console.log(`ролик ${file}: ${frames.length} кадров, ${(bytes.length / 1024 / 1024).toFixed(1)} МБ`);
}

async function gifs() {
  const size = { width: 1100, height: 690, scale: 1 };

  // 1. Сканирование → карта → вход в папку → подсказки по плиткам.
  await open({ ...size });
  encode(
    await record(async () => {
      await sleep(700);
      await clickOn(".drive-card .btn.primary");
      await waitFor("document.querySelector('.explorer .list-row')");
      await sleep(1300);
      await move(await point(".list-row"));
      await sleep(150);
      await press(2);
      await sleep(1100);
      const map = await point(".treemap");
      for (const [dx, dy] of [[-200, -120], [60, -40], [230, 120], [-120, 150]]) {
        await move({ x: map.x + dx, y: map.y + dy });
        await sleep(850);
      }
      await clickOn(".list-row:nth-child(2)");
      await sleep(900);
    }),
    "scan.gif",
  );

  // 2. Очистка: что именно удалится → подтверждение → результат.
  await open({ ...size });
  encode(
    await record(async () => {
      await sleep(500);
      await clickOn(".nav-item", "Cleanup");
      await waitFor("document.querySelector('.junk-row')");
      await sleep(900);
      await clickOn(".junk-main", "shader");
      await sleep(1700);
      await clickOn(".clean-hero .btn.primary");
      await sleep(1800);
      await clickOn(".modal-foot .btn.primary");
      await waitFor("document.querySelector('.report-hero')");
      await sleep(2200);
      await clickOn(".modal-foot .btn.primary");
      await sleep(900);
    }),
    "cleanup.gif",
  );

  // 3. Темы и языки.
  await open({ ...size });
  await scan();
  await nav("Overview");
  await sleep(400);
  encode(
    await record(async () => {
      await sleep(600);
      const setLang = (code) => js(`(() => { const s = document.querySelector(".modal .select"); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set; set.call(s, "${code}"); s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
      const openSettings = () => clickOn(".titlebar-right .icon-btn");
      const close = () => js(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
      await openSettings();
      await sleep(600);
      await js(`document.querySelectorAll(".modal .seg")[0].querySelectorAll("button")[2].click()`);
      await sleep(900);
      await close();
      await sleep(1400);
      for (const code of ["de", "ja", "es"]) {
        await openSettings();
        await sleep(450);
        await setLang(code);
        await sleep(500);
        await close();
        await sleep(1500);
      }
      await openSettings();
      await sleep(400);
      await setLang("en");
      await sleep(300);
      await js(`document.querySelectorAll(".modal .seg")[0].querySelectorAll("button")[1].click()`);
      await sleep(500);
      await close();
      await sleep(1200);
    }),
    "themes-and-languages.gif",
  );
}

try {
  if (what === "all" || what === "shots") await shots();
  if (what === "all" || what === "gifs") await gifs();
} finally {
  ws.close();
  browser.kill();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
}
