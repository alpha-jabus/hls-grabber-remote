"use strict";

// Session-only. URLs and bearer/cookie values are not persisted in extension storage.
// Explicit per-tab capture: never observe HLS traffic until the user enables a tab.
const enabledTabs = new Map();
const streamsByTab = new Map();
const MAX_PER_TAB = 30;
const MAX_AGE_MS = 2 * 60 * 60 * 1000;
const previewCache = new Map();

const keepNames = new Set([
  "origin", "referer", "authorization", "authorizations",
  "accepts-controls", "cookie", "user-agent", "accept", "accept-language"
]);

function relevantHeader(name) {
  const lower = name.toLowerCase();
  return keepNames.has(lower) || /^x-[a-z0-9-]+$/.test(lower);
}

function freshStreams(tabId) {
  const data = streamsByTab.get(tabId) || [];
  const fresh = data.filter(s => Date.now() - s.seen < MAX_AGE_MS);
  if (fresh.length !== data.length) streamsByTab.set(tabId, fresh);
  return fresh;
}

function setBadge(tabId) {
  const count = freshStreams(tabId).length;
  browser.browserAction.setBadgeText({tabId, text: count ? String(count) : ""})
    .catch(() => {});
  browser.browserAction.setBadgeBackgroundColor({tabId, color: "#2e8b80"})
    .catch(() => {});
}

browser.webRequest.onSendHeaders.addListener(details => {
  if (details.tabId < 0 || !enabledTabs.has(details.tabId) || !/^https?:\/\//i.test(details.url)) return;
  // Match signed URLs with query arguments as well.
  if (!/\.m3u8(?:[?#]|$)/i.test(details.url)) return;

  const headers = [];
  for (const item of details.requestHeaders || []) {
    if (!item.name || !relevantHeader(item.name)) continue;
    if (typeof item.value !== "string") continue;
    if (/[\r\n\0]/.test(item.value)) continue;
    headers.push({ name: item.name, value: item.value });
  }

  const now = Date.now();
  const data = freshStreams(details.tabId).filter(s => s.url !== details.url);
  data.unshift({
    url: details.url,
    headers,
    seen: now,
    source: details.originUrl || details.documentUrl || ""
  });
  streamsByTab.set(details.tabId, data.slice(0, MAX_PER_TAB));
  setBadge(details.tabId);
}, {urls: ["<all_urls>"]}, ["requestHeaders"]);

function dropTab(tabId) {
  streamsByTab.delete(tabId);
  previewCache.delete(tabId);
}
browser.tabs.onRemoved.addListener(tabId => { enabledTabs.delete(tabId); dropTab(tabId); });
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url && enabledTabs.has(tabId)) {
    try {
      if (new URL(changeInfo.url).origin !== enabledTabs.get(tabId)) {
        enabledTabs.delete(tabId); dropTab(tabId); setBadge(tabId);
      }
    } catch (_) { enabledTabs.delete(tabId); dropTab(tabId); setBadge(tabId); }
  }
  if (changeInfo.status === "loading" && streamsByTab.has(tabId)) {
    dropTab(tabId);
    setBadge(tabId);
  }
});

function normalizeEndpoint(endpoint) {
  if (typeof endpoint !== "string" || endpoint.length > 300) throw new Error("Некорректный адрес сервера");
  const u = new URL(endpoint.trim());
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if ((u.protocol !== "https:" && !(u.protocol === "http:" && local)) ||
      u.username || u.password || u.pathname !== "/" || u.search || u.hash) {
    throw new Error("Используй https://server.example или http://127.0.0.1:8765 (для локального теста)");
  }
  return u.origin;
}
// All client settings live in Firefox storage.local. No standalone client.json is written.
// On upgrade from 2.3.0, import the old file once before removing it.
let legacyImport = null;
function validateRemoteSettings(message) {
  const enabled = message.enabled === true;
  const mode = message.mode === "pinned" ? "pinned" : "direct";
  const rawUrl = typeof message.url === "string" ? message.url.trim() : "";
  const token = message.token;
  const fingerprint = typeof message.fingerprint === "string" ? message.fingerprint.replace(/[:\s]/g, "").toLowerCase() : "";
  if (typeof token !== "string" || token.length > 1024) throw new Error("API-токен: недопустимое значение (максимум 1024 символа)");
  if (enabled && (token.length < 32 || /[^\x21-\x7e]/.test(token))) {
    throw new Error("API-токен: требуется 32–1024 ASCII-символа без пробелов");
  }
  let url = rawUrl;
  if (enabled || rawUrl) {
    try { url = normalizeEndpoint(rawUrl); }
    catch (e) { throw new Error("Адрес API: " + e.message); }
    if (mode === "pinned" && !url.startsWith("https://")) {
      throw new Error("Адрес API: режим TLS pinning требует https://");
    }
  }
  if (enabled && mode === "pinned" && !/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new Error("SHA-256: нужен отпечаток сертификата из 64 hex-символов");
  }
  if (fingerprint && !/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new Error("SHA-256: в отпечатке допустимы только 64 hex-символа и двоеточия");
  }
  return {enabled,mode,url,token,fingerprint};
}
async function importLegacyPinned() {
  const state = await browser.storage.local.get(["remoteEnabled", "remoteMode", "remoteUrl", "remoteToken", "remoteFingerprint", "remoteSettingsVersion"]);
  if (state.remoteSettingsVersion === 231) return;
  if (state.remoteMode !== "pinned" || state.remoteToken || state.remoteUrl || state.remoteFingerprint) return;
  const imported = await browser.runtime.sendNativeMessage("local.hls_grabber", {action:"pinned_config_get"});
  if (!imported?.ok || !imported.config) {
    throw new Error(imported?.error || "Старый client.json не найден. Введи настройки заново.");
  }
  const cfg = validateRemoteSettings({enabled:true,mode:"pinned",...imported.config});
  await browser.storage.local.set({remoteUrl:cfg.url, remoteToken:cfg.token, remoteFingerprint:cfg.fingerprint,remoteSettingsVersion:231});
  // Only remove the legacy file if it still contains exactly the saved configuration.
  try { await browser.runtime.sendNativeMessage("local.hls_grabber", {action:"pinned_config_cleanup",config:imported.config}); }
  catch (_) { /* Stored settings remain valid if cleanup is unavailable. */ }
}
async function getSettings() {
  const state = await browser.storage.local.get(["remoteEnabled", "remoteMode", "remoteUrl", "remoteToken", "remoteFingerprint"]);
  let error = "";
  if (state.remoteMode === "pinned" && !state.remoteUrl && !state.remoteToken && !state.remoteFingerprint) {
    try {
      if (!legacyImport) legacyImport = importLegacyPinned().finally(() => { legacyImport = null; });
      await legacyImport;
    } catch (e) { error = "Импорт старой конфигурации: " + e.message; }
  }
  const saved = await browser.storage.local.get(["remoteEnabled", "remoteMode", "remoteUrl", "remoteToken", "remoteFingerprint"]);
  return {enabled:saved.remoteEnabled === true,mode:saved.remoteMode === "pinned" ? "pinned" : "direct",
    url:saved.remoteUrl || "",token:saved.remoteToken || "",fingerprint:saved.remoteFingerprint || "",error};
}
async function pinnedNativeRequest(path, payload, config) {
  // connectNative, unlike sendNativeMessage, accepts multiple <=1 MB responses.
  return new Promise((resolve, reject) => {
    const port = browser.runtime.connectNative("local.hls_grabber");
    const chunks = []; let total = -1, completed = false;
    port.onMessage.addListener(message => {
      if (completed) return;
      if (!message?.native_chunk) {
        completed = true; port.disconnect();
        return message?.ok ? resolve(message) : reject(new Error(message?.error || "Ошибка локального TLS-помощника"));
      }
      if (!Number.isInteger(message.total) || message.total <= 0 || message.total > 25 ||
          !Number.isInteger(message.part) || message.part < 0 || message.part >= message.total ||
          typeof message.data !== "string") {
        completed = true; port.disconnect(); reject(new Error("Некорректный ответ Native Messaging")); return;
      }
      if (total === -1) total = message.total;
      if (total !== message.total || chunks[message.part] !== undefined) {
        completed = true; port.disconnect(); reject(new Error("Нарушена целостность ответа Native Messaging")); return;
      }
      chunks[message.part] = message.data;
      if (chunks.filter(x => x !== undefined).length === total) {
        try {
          const arrays = chunks.map(x => Uint8Array.from(atob(x), c => c.charCodeAt(0)));
          const merged = new Uint8Array(arrays.reduce((sum,x) => sum + x.length,0));
          let at = 0; for (const bytes of arrays) { merged.set(bytes,at); at += bytes.length; }
          const decoded = JSON.parse(new TextDecoder().decode(merged));
          completed = true; port.disconnect();
          return decoded?.ok ? resolve(decoded) : reject(new Error(decoded?.error || "Ошибка запроса"));
        } catch (e) { completed = true; port.disconnect(); reject(e); }
      }
    });
    port.onDisconnect.addListener(() => {
      if (!completed) { completed = true; reject(new Error(browser.runtime.lastError?.message || "Native Messaging прерван")); }
    });
    port.postMessage({action:"pinned_request",path,payload,config});
  });
}
async function assertRemoteConsent() {
  const permissions = await browser.permissions.getAll();
  const accepted = permissions.data_collection || [];
  if (!["authenticationInfo", "browsingActivity", "websiteContent"].every(p => accepted.includes(p))) {
    throw new Error("Разрешения Firefox: разреши передачу ссылок и заголовков в настройках дополнения");
  }
}
async function directRemoteRequest(path, payload, settings) {
  const endpoint = normalizeEndpoint(settings.url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), path === "preview" ? 52000 : 15000);
  try {
    const response = await fetch(endpoint + "/api/v1/" + path, {
      method: payload === undefined ? "GET" : "POST",
      headers: {"Authorization":"Bearer " + settings.token, ...(payload === undefined ? {} : {"Content-Type":"application/json"})},
      ...(payload === undefined ? {} : {body:JSON.stringify(payload)}),
      cache:"no-store", credentials:"omit", redirect:"error", signal:controller.signal
    });
    const obj = await response.json();
    if (!response.ok || !obj.ok) throw new Error(obj.error || "HTTP " + response.status);
    return obj;
  } finally { clearTimeout(timer); }
}
async function remoteCall(path, payload, draft) {
  await assertRemoteConsent();
  const s = draft || await getSettings();
  if (!s.enabled) throw new Error("Включи сервер в настройках");
  const valid = validateRemoteSettings(s);
  if (valid.mode === "pinned") {
    return pinnedNativeRequest(path, payload, {url:valid.url,token:valid.token,fingerprint:valid.fingerprint});
  }
  return directRemoteRequest(path, payload, valid);
}
async function remoteOrLocalDownload(found, message) {
  const settings = await getSettings();
  if (settings.enabled) {
    return remoteCall("download", {url:found.url, headers:found.headers,
      name:message.name, format:message.format});
  }
  try {
    return await browser.runtime.sendNativeMessage("local.hls_grabber", {
      action:"download", url:found.url, headers:found.headers,
      name:message.name, format:message.format
    });
  } catch (error) {
    return {ok:false,error:"Нет локального помощника. Запусти ./install.sh. " + error.message};
  }
}
async function streamPreview(message) {
  const found = freshStreams(message.tabId).find(s => s.url === message.url);
  if (!found) throw new Error("Поток устарел — обнови страницу");
  const mode = message.mode === "gif" ? "gif" : "image";
  const cache = previewCache.get(message.tabId) || new Map();
  const key = mode + ":" + found.url;
  const item = cache.get(key);
  if (item && Date.now() - item.time < 10 * 60 * 1000) return item.result;
  const result = await remoteCall("preview", {url:found.url, headers:found.headers, mode});
  cache.set(key, {time:Date.now(), result});
  // Limit cache size (GIF frames are particularly expensive in memory).
  if (cache.size > 14) cache.delete(cache.keys().next().value);
  previewCache.set(message.tabId, cache);
  return result;
}

browser.runtime.onMessage.addListener(async (message) => {
  if (!message || typeof message !== "object") return {ok:false, error:"Invalid request"};
  if (message.type === "captureStatus") {
    return {ok:true, enabled:enabledTabs.has(message.tabId)};
  }
  if (message.type === "enableCapture") {
    try {
      const tab = await browser.tabs.get(message.tabId);
      const origin = new URL(tab.url).origin;
      if (!/^https?:\/\//.test(origin)) throw new Error("Это не HTTP(S)-страница");
      if (!await browser.permissions.contains({origins:["<all_urls>"]})) {
        throw new Error("Сначала разреши доступ к сайтам в Firefox");
      }
      enabledTabs.set(message.tabId, origin);
      dropTab(message.tabId); setBadge(message.tabId);
      return {ok:true,enabled:true};
    } catch (error) { return {ok:false,error:error.message}; }
  }
  if (message.type === "disableCapture") {
    enabledTabs.delete(message.tabId);
    dropTab(message.tabId); setBadge(message.tabId);
    return {ok:true,enabled:false};
  }
  if (message.type === "streams") {
    return {ok:true, streams:freshStreams(message.tabId)};
  }
  if (message.type === "clear") {
    streamsByTab.delete(message.tabId);
    setBadge(message.tabId);
    return {ok:true};
  }
  if (message.type === "getSettings") return {ok:true, settings:await getSettings()};
  if (message.type === "saveSettings") {
    try {
      const cfg = validateRemoteSettings(message);
      // One atomic storage operation: invalid drafts never replace last good settings.
      await browser.storage.local.set({remoteEnabled:cfg.enabled, remoteMode:cfg.mode,
        remoteUrl:cfg.url, remoteToken:cfg.token, remoteFingerprint:cfg.fingerprint,remoteSettingsVersion:231});
      previewCache.clear();
      return {ok:true};
    } catch (error) { return {ok:false,error:error.message}; }
  }
  if (message.type === "testRemoteDraft") {
    try { return await remoteCall("health", undefined, message); }
    catch (error) { return {ok:false,error:error.message}; }
  }
  if (message.type === "preview") {
    try { return await streamPreview(message); }
    catch (error) { return {ok:false,error:error.message}; }
  }
  if (message.type === "testRemote") {
    try { return await remoteCall("health"); }
    catch (error) { return {ok:false,error:error.message}; }
  }
  if (message.type === "download") {
    const found = freshStreams(message.tabId).find(s => s.url === message.url);
    if (!found) return {ok:false, error:"Поток не найден — обнови страницу и запусти видео"};
    try { return await remoteOrLocalDownload(found, message); }
    catch (error) { return {ok:false,error:error.message}; }
  }
  if (message.type === "jobs") {
    if ((await getSettings()).enabled) {
      try { return await remoteCall("jobs"); }
      catch (error) { return {ok:false,jobs:[],error:error.message}; }
    }
    try { return await browser.runtime.sendNativeMessage("local.hls_grabber", {action:"jobs"}); }
    catch (error) { return {ok:false, jobs:[], error:error.message}; }
  }
  return {ok:false, error:"Unknown action"};
});
