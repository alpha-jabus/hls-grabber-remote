"use strict";
let activeTabId = null;
let activeStreams = [];
let remoteEnabled = false;
let captureEnabled = false;
let latestJobs = [];
const streamButtons = new Map();
let statusGeneration = 0;
const DATA_TYPES = ["authenticationInfo", "browsingActivity", "websiteContent"];

async function requestDataConsent() {
  // Only ask once. Consent can also be revoked in Firefox add-on settings.
  const granted = (await browser.permissions.getAll()).data_collection || [];
  if (DATA_TYPES.every(x => granted.includes(x))) return;
  const grant = await browser.permissions.request({data_collection: DATA_TYPES});
  if (!grant) throw new Error("Передача адресов и заголовков не разрешена");
}
async function requestServerHostAccess() {
  const u = new URL(el("remoteUrl").value.trim());
  const pattern = u.origin + "/*";
  if (await browser.permissions.contains({origins:[pattern]})) return;
  const accepted = await browser.permissions.request({origins:[pattern]});
  if (!accepted) throw new Error("Firefox не разрешил подключение к адресу API " + u.origin);
}

let lastSignature = "";
const previews = new Map();
let generation = 0;
const el = id => document.getElementById(id);
const make = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
function notify(message) { el("message").textContent = message; }
function shellQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
function headerArgs(headers) {
  const normalized = (headers || []).filter(h => h && h.name && typeof h.value === "string");
  const userAgent = normalized.find(h => h.name.toLowerCase() === "user-agent");
  const referer = normalized.find(h => h.name.toLowerCase() === "referer");
  const extra = normalized.filter(h => !["user-agent", "referer"].includes(h.name.toLowerCase()));
  const args = [];
  if (userAgent) args.push("-user_agent", userAgent.value);
  if (referer) args.push("-referer", referer.value);
  if (extra.length) args.push("-headers", extra.map(h => `${h.name}: ${h.value}\r\n`).join(""));
  return args;
}
function commandFor(stream, isPlayer) {
  const filename = (el("filename").value || "video").replace(/[\\/\r\n]/g, "_") + "." + el("format").value;
  let args = [isPlayer ? "ffplay" : "ffmpeg", "-hide_banner"];
  if (!isPlayer) args.push("-nostdin", "-n");
  args.push(...headerArgs(stream.headers), "-i", stream.url);
  if (isPlayer) args.push("-autoexit");
  else {
    if (el("format").value === "mp4") args.push("-c", "copy", "-movflags", "+faststart");
    else args.push("-map", "0", "-c", "copy");
    args.push(filename);
  }
  return args.map(shellQuote).join(" ");
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); }
  catch (_) {
    const area = make("textarea"); area.value = text;
    document.body.appendChild(area); area.select();
    document.execCommand("copy"); area.remove();
  }
  notify("Команда скопирована. Она может содержать приватные токены и cookies — не публикуй её.");
}
function safeTitle(tab) {
  return (tab.title || "video").replace(/[\\/\x00-\x1f:*?"<>|]/g, "_").trim().slice(0,95) || "video";
}
function streamLabel(stream, index) {
  try { return new URL(stream.url).hostname + " · поток " + (index + 1); }
  catch (_) { return "HLS поток " + (index + 1); }
}
function readableSeconds(x) {
  if (typeof x !== "number" || !Number.isFinite(x)) return "";
  const total = Math.floor(x);
  return `${Math.floor(total/3600)}:${String(Math.floor(total%3600/60)).padStart(2,"0")}:${String(total%60).padStart(2,"0")}`;
}
function decoratePreview(stream, stage, meta, mode, button) {
  const data = previews.get(mode + ":" + stream.url);
  if (!stage.isConnected) return;
  stage.replaceChildren();
  if (!data || !data.ok || !data.image) {
    stage.appendChild(make("div", "previewPlaceholder", data?.error || "Предпросмотр недоступен"));
    return;
  }
  const image = make("img", "preview");
  image.alt = "Кадр из видеопотока";
  image.src = "data:" + (data.mime === "image/gif" ? "image/gif" : "image/jpeg") + ";base64," + data.image;
  stage.appendChild(image);
  const d = data.info?.duration;
  const w = data.info?.width, h = data.info?.height;
  meta.textContent = [w && h ? `${w}×${h}` : null, d ? readableSeconds(d) : null,
    mode === "gif" ? "GIF, 3 секунды" : "Кадр"].filter(Boolean).join(" · ");
  if (button) button.disabled = false;
}
async function loadPreview(stream, mode, stage, meta, button) {
  const key = mode + ":" + stream.url;
  let data = previews.get(key);
  if (!data) {
    try {
      data = await browser.runtime.sendMessage({type:"preview", tabId:activeTabId, url:stream.url, mode});
    } catch (_) { data = {ok:false,error:"Нет соединения с сервером"}; }
    previews.set(key, data);
  }
  decoratePreview(stream, stage, meta, mode, button);
}
async function preload(items, token) {
  for (const item of items.slice(0, 6)) {
    if (token !== generation || !remoteEnabled) break;
    await loadPreview(item.stream, "image", item.stage, item.meta, null);
  }
}
function renderStreams() {
  const container = el("streams"); container.replaceChildren();
  streamButtons.clear();
  generation += 1;
  const token = generation;
  el("summary").textContent = activeStreams.length
    ? `Найдено потоков: ${activeStreams.length}. ${remoteEnabled ? "Загружаю предпросмотры с сервера…" : "Для миниатюр подключи сервер в настройках."}`
    : "Пока нет .m3u8. Обнови страницу и запусти воспроизведение.";
  const preloadItems = [];
  activeStreams.forEach((stream, index) => {
    const wrapper = make("article", "stream");
    wrapper.appendChild(make("div", "name", streamLabel(stream, index)));
    const stage = make("div");
    wrapper.appendChild(stage);
    const meta = make("div", "previewMeta");
    wrapper.appendChild(meta);
    if (remoteEnabled) {
      stage.appendChild(make("div", "previewPlaceholder", "Получаю кадр…"));
      preloadItems.push({stream,stage,meta});
      const gif = make("button", "", "▶ GIF 3 с");
      gif.addEventListener("click", async () => {
        gif.disabled = true;
        stage.replaceChildren(make("div", "previewPlaceholder", "Создаю GIF…"));
        await loadPreview(stream, "gif", stage, meta, gif);
      });
      const image = make("button", "", "Кадр");
      image.addEventListener("click", async () => {
        image.disabled = true;
        stage.replaceChildren(make("div", "previewPlaceholder", "Загружаю кадр…"));
        await loadPreview(stream, "image", stage, meta, image);
      });
      const previewActions = make("div", "actions");
      previewActions.append(gif, image);
      wrapper.appendChild(previewActions);
    } else {
      stage.appendChild(make("div", "previewPlaceholder", "Предпросмотр доступен через сервер"));
    }
    const headerNames = (stream.headers || []).map(h => h.name).join(", ");
    wrapper.appendChild(make("div", "detail", headerNames || "Нет дополнительных HTTP-заголовков"));
    const actions = make("div", "actions");
    const download = make("button", "primary", remoteEnabled ? "↓ На сервер" : "↓ На ПК");
    download.addEventListener("click", async () => {
      download.disabled = true;
      notify("Запускаю скачивание…");
      try {
        await requestDataConsent();
        const response = await browser.runtime.sendMessage({
          type:"download", tabId:activeTabId, url:stream.url,
          name:el("filename").value, format:el("format").value
        });
        if (response.ok) { notify(response.existing ? "Этот поток уже в очереди / скачан: " + response.path : "Добавлено в очередь: " + response.path); await reloadJobs(); }
        else notify(response.error || "Ошибка запуска");
      } catch (e) { notify(e.message); }
      finally { download.disabled = false; }
    });
    actions.appendChild(download);
    if (remoteEnabled) {
      const status = make("div", "streamState", "Проверяю очередь…");
      wrapper.appendChild(status);
      streamButtons.set(stream.url, {button:download, label:status});
    }
    for (const [label,player] of [["ffmpeg",false],["ffplay",true]]) {
      const btn = make("button", "", "Копировать " + label);
      btn.addEventListener("click", () => copy(commandFor(stream, player)));
      actions.appendChild(btn);
    }
    wrapper.appendChild(actions);
    container.appendChild(wrapper);
  });
  if (remoteEnabled) {
    preload(preloadItems, token).catch(() => {});
    updateStreamStatuses().catch(() => {});
  }
}
async function reloadStreams() {
  if (activeTabId === null) return;
  const response = await browser.runtime.sendMessage({type:"streams", tabId:activeTabId});
  const streams = response.streams || [];
  const signature = JSON.stringify(streams.map(s => s.url)) + ":" + remoteEnabled;
  activeStreams = streams;
  if (signature !== lastSignature) {
    lastSignature = signature;
    renderStreams();
  }
}
async function sourceId(url) {
  const bytes = new TextEncoder().encode(url);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, "0")).join("");
}
async function updateStreamStatuses() {
  const run = ++statusGeneration;
  if (!remoteEnabled) return;
  const jobs = latestJobs;
  for (const [url, controls] of streamButtons) {
    const id = await sourceId(url);
    if (run !== statusGeneration) return;
    const matches = jobs.filter(j => j.source_id === id && ["queued", "running", "done"].includes(j.status));
    const job = matches.sort((a,b) => (b.created || 0) - (a.created || 0))[0];
    controls.button.disabled = Boolean(job);
    const queuePosition = job?.status === "queued"
      ? jobs.filter(j => j.status === "queued" && (j.created || 0) <= (job.created || 0)).length : 0;
    controls.button.textContent = !job ? "↓ На сервер" :
      job.status === "queued" ? `В очереди #${queuePosition}` :
      job.status === "running" ? "Скачивается…" : "Уже скачано ✓";
    controls.label.textContent = !job ? "" :
      job.status === "done" ? "AES-256-GCM · уже сохранено на сервере" :
      job.status === "queued" ? "Ожидает свободного слота" : "Шифруется и сохраняется на сервер";
  }
}
async function reloadJobs() {
  const response = await browser.runtime.sendMessage({type:"jobs"});
  latestJobs = response.ok ? (response.jobs || []) : [];
  await updateStreamStatuses();
}

async function loadSettings() {
  const r = await browser.runtime.sendMessage({type:"getSettings"});
  const settings = r.settings || {};
  remoteEnabled = settings.enabled === true;
  el("remoteEnabled").checked = remoteEnabled;
  el("remoteUrl").value = settings.url || "";
  el("remoteToken").value = settings.token || "";
  el("modeLabel").textContent = remoteEnabled ? "· на сервере" : "· на компьютере";
}
async function initialize() {
  try {
    const [tab] = await browser.tabs.query({active:true,currentWindow:true});
    if (!tab) throw new Error("Нет активной вкладки");
    activeTabId = tab.id;
    el("filename").value = safeTitle(tab);
    await loadSettings();
    await loadCapture();
    await Promise.all([reloadStreams(), reloadJobs()]);
  } catch (e) { notify(e.message); }
}
async function loadCapture() {
  if (activeTabId === null) return;
  const r = await browser.runtime.sendMessage({type:"captureStatus", tabId:activeTabId});
  captureEnabled = r.enabled === true;
  el("captureToggle").textContent = captureEnabled ? "Остановить перехват" : "Включить перехват на вкладке";
  el("captureState").textContent = captureEnabled ? "Перехват включён на этой вкладке" : "Перехват выключен";
}
el("captureToggle").addEventListener("click", async () => {
  try {
    if (!captureEnabled) {
      const granted = await browser.permissions.request({origins:["<all_urls>"]});
      if (!granted) throw new Error("Firefox не разрешил доступ к потокам");
    }
    const r = await browser.runtime.sendMessage({type:captureEnabled ? "disableCapture" : "enableCapture",tabId:activeTabId});
    if (!r.ok) throw new Error(r.error || "Не удалось изменить режим");
    await loadCapture();
    lastSignature = ""; previews.clear();
    await reloadStreams();
    notify(captureEnabled ? "Перехват включён. Запусти видео или обнови страницу." : "Перехват остановлен, список очищен.");
  } catch (e) { notify(e.message); }
});
el("downloadsPage").addEventListener("click", () => browser.tabs.create({url:browser.runtime.getURL("downloads.html")}));
el("settingsToggle").addEventListener("click", () => el("settings").classList.toggle("hidden"));
el("saveSettings").addEventListener("click", async () => {
  try {
    if (el("remoteEnabled").checked) {
      await requestServerHostAccess();
      await requestDataConsent();
    }
  } catch (e) { notify(e.message); return; }
  const response = await browser.runtime.sendMessage({
    type:"saveSettings", enabled:el("remoteEnabled").checked,
    url:el("remoteUrl").value.trim(), token:el("remoteToken").value
  });
  if (!response.ok) return notify(response.error || "Не удалось сохранить");
  await loadSettings();
  lastSignature = ""; previews.clear();
  notify("Настройки сохранены. " + (remoteEnabled ? "Используется сервер." : "Используется локальный помощник."));
  await Promise.all([reloadStreams(),reloadJobs()]);
});
el("testRemote").addEventListener("click", async () => {
  const response = await browser.runtime.sendMessage({type:"testRemote"});
  notify(response.ok ? "Сервер доступен, авторизация успешна." : "Ошибка соединения: " + (response.error || "неизвестно"));
});
el("clear").addEventListener("click", async () => {
  if (activeTabId !== null) {
    await browser.runtime.sendMessage({type:"clear",tabId:activeTabId});
    previews.clear(); lastSignature = "";
    await reloadStreams();
  }
});
initialize();
setInterval(() => { reloadStreams().catch(() => {}); reloadJobs().catch(() => {}); }, 4000);
