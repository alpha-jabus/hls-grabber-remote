"use strict";
const $ = id => document.getElementById(id);
const CONSENT = ["authenticationInfo", "browsingActivity", "websiteContent"];
const controls = ["remoteEnabled","remoteUrl","remoteToken","fingerprint"];
let current = null;
let isRawVisible = false;
function mode(){return document.querySelector('input[name="mode"]:checked').value;}
function status(message){$("status").textContent=message;}
function formConfig(){return {url:$("remoteUrl").value.trim(),token:$("remoteToken").value,
  fingerprint:$("fingerprint").value.trim()};}
function updateVisibility(){
  $("pinSection").hidden = mode() !== "pinned";
  $("configPath").textContent = mode() === "pinned" ? (current?.configPath || "~/.config/hls-grabber/client.json") :
    "Обычный режим: настройки в профиле Firefox; JSON на диске применяется только к pinned HTTPS";
}
async function load(){
  const response = await browser.runtime.sendMessage({type:"getSettings"});
  if (!response?.ok) throw new Error(response?.error || "Не могу получить настройки");
  current=response.settings;
  $("remoteEnabled").checked = current.enabled;
  $("remoteUrl").value = current.url || "";
  $("remoteToken").value = current.token || "";
  $("fingerprint").value = current.fingerprint || "";
  document.querySelector(`input[name="mode"][value="${current.mode === "pinned" ? "pinned" : "direct"}"]`).checked = true;
  updateVisibility();
  if(current.error) status(current.error);
  if(isRawVisible) await reloadRaw();
}
async function reloadRaw(){
  if(mode() !== "pinned") {$("configRaw").value="Только для pinned HTTPS. Выбери закреплённый HTTPS.";return;}
  const response=await browser.runtime.sendMessage({type:"getSettings"});
  if(response.settings?.error) throw new Error(response.settings.error);
  // The native host reads the local client.json, never an arbitrary file path.
  const cfg={url:response.settings.url,token:response.settings.token,fingerprint:response.settings.fingerprint};
  $("configRaw").value=JSON.stringify(cfg,null,2);
}
async function ensureAccess(){
  if(!$("remoteEnabled").checked) return;
  if(mode()==="direct") {
    const u=new URL($("remoteUrl").value.trim());
    const origin=u.origin+"/*";
    if(!await browser.permissions.contains({origins:[origin]})){
      if(!await browser.permissions.request({origins:[origin]}))throw new Error("Firefox отклонил доступ к адресу API");
    }
  }
  const granted=(await browser.permissions.getAll()).data_collection || [];
  if(!CONSENT.every(x=>granted.includes(x))){
    if(!await browser.permissions.request({data_collection:CONSENT}))throw new Error("Для удалённой передачи нужен доступ Firefox");
  }
}
async function save(cfg){
  const response=await browser.runtime.sendMessage({type:"saveSettings",
    enabled:$("remoteEnabled").checked,mode:mode(),...cfg});
  if(!response.ok)throw new Error(response.error || "Ошибка сохранения");
  await load(); status("Настройки сохранены. " + (mode()==="pinned" ? "Локальный client.json обновлён." : "Настройки Firefox обновлены."));
}
$("save").addEventListener("click",async()=>{
  try { await ensureAccess(); await save(formConfig()); }
  catch(e){status("Ошибка: "+e.message);}
});
$("check").addEventListener("click",async()=>{
  try { const result=await browser.runtime.sendMessage({type:"testRemote"});
    if(!result.ok)throw new Error(result.error || "Проверка не прошла");
    status(mode()==="pinned" ? "TLS pin совпадает, API-токен принят сервером." : "Сервер доступен, токен принят (без pinning)."); }
  catch(e){status("Ошибка проверки: "+e.message);}
});
$("showToken").addEventListener("click",()=>{$("remoteToken").type=$("remoteToken").type==="password"?"text":"password";});
$("toggleRaw").addEventListener("click",async()=>{
  isRawVisible=!isRawVisible;
  $("rawArea").hidden=!isRawVisible;
  $("toggleRaw").textContent=isRawVisible?"Скрыть JSON":"Показать JSON";
  if(isRawVisible)try{await reloadRaw();}catch(e){status(e.message);}
});
$("resetRaw").addEventListener("click",async()=>{try{await reloadRaw();status("Перечитано с диска.");}catch(e){status(e.message);}});
$("saveRaw").addEventListener("click",async()=>{
  try {
    if(mode()!=="pinned")throw new Error("Выбери закреплённый HTTPS");
    const cfg=JSON.parse($("configRaw").value);
    if(Object.keys(cfg).sort().join(",")!=="fingerprint,token,url")throw new Error("Нужны ровно url, token, fingerprint");
    await ensureAccess();
    await save(cfg);
  }catch(e){status("Ошибка JSON: "+e.message);}
});
$("reload").addEventListener("click",()=>load().then(()=>status("Конфигурация перечитана.")).catch(e=>status(e.message)));
document.querySelectorAll('input[name="mode"]').forEach(e=>e.addEventListener("change",updateVisibility));
load().catch(e=>status("Не удалось открыть настройки: "+e.message));
