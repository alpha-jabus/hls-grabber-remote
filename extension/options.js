"use strict";
// JSON is an editable *view* of the current form; it is not a local file.
// Failed saves/tests keep the exact user-entered drafts on screen.
const $ = id => document.getElementById(id);
const CONSENT = ["authenticationInfo", "browsingActivity", "websiteContent"];
let lastSaved = null;
let dirty = false;
let rawDirty = false;
let rawVisible = false;
function mode() { return document.querySelector('input[name="mode"]:checked').value; }
function status(message) { $("status").textContent = message; }
function setError(field, message) {
  const input = $(field);
  const hint = $(field + "Error");
  if (input) {
    input.setAttribute("aria-invalid", "true");
    input.focus();
  }
  if (hint) hint.textContent = message;
  status(message);
}
function clearErrors() {
  for (const id of ["remoteUrl", "remoteToken", "fingerprint", "configRaw"]) {
    $(id).removeAttribute("aria-invalid");
    const hint = $(id + "Error");
    if (hint) hint.textContent = "";
  }
}
function fieldFailure(field, message) {
  const e = new Error(message);
  e.field = field;
  throw e;
}
function formatFailure(error, fallback = "Ошибка") {
  const msg = error?.message || String(error);
  const field = error?.field || (/PIN MISMATCH|SHA-256|сертификат/i.test(msg) ? "fingerprint" :
    /API-токен|401|Unauthorized/i.test(msg) ? "remoteToken" :
    /Адрес API|NetworkError|TLS|соединени|DNS|подключени/i.test(msg) ? "remoteUrl" : "");
  if (field) setError(field, `${fallback}: ${msg}`);
  else status(`${fallback}: ${msg}`);
}
function formState() {
  return {
    enabled: $("remoteEnabled").checked,
    mode: mode(),
    url: $("remoteUrl").value.trim(),
    token: $("remoteToken").value,
    fingerprint: $("fingerprint").value.trim()
  };
}
function applyState(cfg) {
  $("remoteEnabled").checked = cfg.enabled === true;
  $("remoteUrl").value = cfg.url || "";
  $("remoteToken").value = cfg.token || "";
  $("fingerprint").value = cfg.fingerprint || "";
  document.querySelector(`input[name="mode"][value="${cfg.mode === "pinned" ? "pinned" : "direct"}"]`).checked = true;
  updateVisibility();
}
function updateVisibility() { $("pinSection").hidden = mode() !== "pinned"; }
function normalizeDraft(cfg) {
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) fieldFailure("configRaw", "JSON: ожидается объект настроек");
  for (const k of ["enabled", "mode", "url", "token", "fingerprint"]) {
    if (!Object.prototype.hasOwnProperty.call(cfg, k)) fieldFailure("configRaw", `JSON: отсутствует поле «${k}»`);
  }
  for (const key of Object.keys(cfg)) {
    if (!["enabled", "mode", "url", "token", "fingerprint"].includes(key)) fieldFailure("configRaw", `JSON: неизвестное поле «${key}»`);
  }
  if (typeof cfg.enabled !== "boolean") fieldFailure("configRaw", "JSON: enabled должно быть true или false");
  if (!["pinned", "direct"].includes(cfg.mode)) fieldFailure("configRaw", "JSON: mode должен быть pinned или direct");
  for (const field of ["url", "token", "fingerprint"]) {
    if (typeof cfg[field] !== "string") fieldFailure("configRaw", `JSON: ${field} должно быть строкой`);
  }
  const draft = {...cfg, url:cfg.url.trim(), fingerprint:cfg.fingerprint.trim()};
  const pin = draft.fingerprint.replace(/[:\s]/g, "");
  if (draft.enabled || draft.url) {
    let u;
    try {u = new URL(draft.url);} catch (_) {fieldFailure("remoteUrl", "Адрес API: укажи полный адрес, например https://192.168.0.190:8765");}
    if (!u.hostname || u.username || u.password || u.pathname !== "/" || u.search || u.hash ||
        !["http:", "https:"].includes(u.protocol)) {
      fieldFailure("remoteUrl", "Адрес API: нужен адрес без пути, логина, параметров или #якоря");
    }
    if (draft.mode === "pinned" && u.protocol !== "https:") {
      fieldFailure("remoteUrl", "Адрес API: для TLS pinning нужен https://");
    }
    if (draft.mode === "direct" && u.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) {
      fieldFailure("remoteUrl", "Адрес API: обычный HTTP допустим только для localhost через SSH-туннель");
    }
  }
  if (draft.token.length > 1024 || (draft.enabled && (draft.token.length < 32 || /[^\x21-\x7e]/.test(draft.token)))) {
    fieldFailure("remoteToken", "API-токен: нужно 32–1024 ASCII-символа без пробелов");
  }
  if ((draft.mode === "pinned" && draft.enabled || pin) && !/^[a-fA-F0-9]{64}$/.test(pin)) {
    fieldFailure("fingerprint", "SHA-256: 64 шестнадцатеричных символа (двоеточия допустимы)");
  }
  return draft;
}
function syncJsonFromForm() {
  if (rawVisible && !rawDirty) $("configRaw").value = JSON.stringify(formState(), null, 2);
}
function updateDirty() {dirty = true; syncJsonFromForm();}
async function load(force = false) {
  const response = await browser.runtime.sendMessage({type:"getSettings"});
  if (!response?.ok) throw new Error(response?.error || "Не удалось получить настройки");
  if (!response.settings) throw new Error("Firefox не вернул настройки");
  // Only initial load or a deliberate user-triggered reload changes inputs.
  if (force || lastSaved === null) {
    applyState(response.settings);
    lastSaved = {...response.settings};
    dirty = false;
    rawDirty = false;
    syncJsonFromForm();
  }
  if (response.settings.error) status(response.settings.error);
}
async function ensureAccess(cfg) {
  if (!cfg.enabled) return;
  if (cfg.mode === "direct") {
    const origin = new URL(cfg.url).origin + "/*";
    if (!await browser.permissions.contains({origins:[origin]})) {
      if (!await browser.permissions.request({origins:[origin]})) throw new Error("Firefox: доступ к адресу API не выдан");
    }
  }
  const allowed = (await browser.permissions.getAll()).data_collection || [];
  if (!CONSENT.every(x => allowed.includes(x))) {
    if (!await browser.permissions.request({data_collection:CONSENT})) {
      throw new Error("Firefox: разрешение на передачу ссылок и HTTP-заголовков отклонено");
    }
  }
}
async function commit(cfg) {
  const valid = normalizeDraft(cfg); // Validate *before* permission requests or persistent changes.
  await ensureAccess(valid);
  const response = await browser.runtime.sendMessage({type:"saveSettings", ...valid});
  if (!response?.ok) throw new Error(response?.error || "Firefox не сохранил настройки");
  lastSaved = {...valid};
  dirty = false;
  return valid;
}
async function fromRaw() {
  let parsed;
  try {parsed = JSON.parse($("configRaw").value);} catch (e) {fieldFailure("configRaw", "JSON: " + e.message);}
  return normalizeDraft(parsed);
}
$("save").addEventListener("click", async () => {
  clearErrors();
  try {
    const cfg = await commit(formState());
    status(rawDirty ? "Поля сохранены в Firefox. Текст JSON содержит отдельные неприменённые изменения." :
      "Настройки сохранены в профиле Firefox. Отдельного client.json нет.");
    if (!rawDirty) syncJsonFromForm();
  } catch (e) { formatFailure(e, "Ошибка сохранения; предыдущие настройки не изменены"); }
});
$("check").addEventListener("click", async () => {
  clearErrors();
  try {
    const cfg = normalizeDraft(formState());
    if (!cfg.enabled) fieldFailure("remoteUrl", "Сначала включи удалённый сервер");
    await ensureAccess(cfg);
    // Test the *draft* config in memory, without saving or wiping it on failure.
    const response = await browser.runtime.sendMessage({type:"testRemoteDraft",...cfg});
    if (!response?.ok) throw new Error(response?.error || "Нет ответа от API");
    status(cfg.mode === "pinned" ? "TLS pin совпадает, API-токен принят. Настройки ещё не сохранены." :
      "API доступен. Настройки ещё не сохранены.");
  } catch (e) { formatFailure(e, "Ошибка проверки; поля и сохранённые настройки не изменены"); }
});
$("showToken").addEventListener("click", () => {$("remoteToken").type = $("remoteToken").type === "password" ? "text" : "password";});
$("toggleRaw").addEventListener("click", () => {
  rawVisible = !rawVisible;
  $("rawArea").hidden = !rawVisible;
  $("toggleRaw").textContent = rawVisible ? "Скрыть JSON" : "Показать JSON";
  syncJsonFromForm();
});
$("configRaw").addEventListener("input", () => {rawDirty = true; dirty = true;});
$("resetRaw").addEventListener("click", () => {
  clearErrors();
  if (rawDirty && !window.confirm("Заменить несохранённый JSON текущими полями формы?")) return;
  rawDirty = false;
  syncJsonFromForm();
  status("JSON обновлён из полей формы (на диск ничего не записано).");
});
$("saveRaw").addEventListener("click", async () => {
  clearErrors();
  try {
    const draft = await fromRaw();
    await commit(draft);
    // Apply values only after successful validation and storage write.
    applyState(draft);
    rawDirty = false;
    syncJsonFromForm();
    status("JSON применён и сохранён в профиле Firefox.");
  } catch (e) {
    formatFailure(e, "Ошибка JSON; текст не изменён, старые настройки сохранены");
    if (e.field && e.field !== "configRaw") {
      $("configRaw").setAttribute("aria-invalid", "true");
      $("configRawError").textContent = `Поле JSON «${e.field}»: ${e.message}`;
    }
  }
});
$("reload").addEventListener("click", async () => {
  if ((dirty || rawDirty) && !window.confirm("Отменить несохранённые изменения и загрузить сохранённые настройки?")) return;
  clearErrors();
  try { await load(true);status("Сохранённые настройки загружены из профиля Firefox."); }
  catch(e) {formatFailure(e, "Не удалось перечитать настройки");}
});
for (const id of ["remoteEnabled", "remoteUrl", "remoteToken", "fingerprint"]) {
  $(id).addEventListener(id === "remoteEnabled" ? "change" : "input", updateDirty);
}
document.querySelectorAll('input[name="mode"]').forEach(e => e.addEventListener("change", () => {updateVisibility();updateDirty();}));
load().catch(e => formatFailure(e, "Не удалось открыть настройки"));
