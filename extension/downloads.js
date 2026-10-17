"use strict";
const $ = id => document.getElementById(id);
const label = {queued:"В очереди",running:"Скачивается",done:"Скачано ✓",failed:"Ошибка"};
const make = (tag, cls, value) => {
  const x = document.createElement(tag); if (cls) x.className=cls;
  if (value !== undefined) x.textContent=value; return x;
};
function update(jobs) {
  const counts = Object.fromEntries(["queued","running","done","failed"].map(x => [x, jobs.filter(j=>j.status===x).length]));
  $("stats").replaceChildren(...Object.entries(counts).map(([k,v]) => {
    const item=make("div","stat");item.append(make("strong","",String(v)), make("span","",label[k]));return item;
  }));
  const all=make("div");
  if (!jobs.length) all.appendChild(make("p","","Загрузок ещё не было."));
  const waiting = jobs.filter(j=>j.status==="queued").sort((a,b)=>(a.created||0)-(b.created||0));
  for (const job of jobs) {
    const row=make("article","job"),info=make("div");
    info.appendChild(make("strong","",job.name||"video"));
    info.appendChild(make("div","path",job.path||""));
    const detail= [job.encrypted ? "AES-256-GCM" : "", job.bytes ? `${(job.bytes/1048576).toFixed(1)} MiB` : "", job.status==="failed" ? job.error : ""].filter(Boolean).join(" · ");
    info.appendChild(make("div","detail",detail));
    let status=label[job.status]||job.status||"Неизвестно";
    if (job.status==="queued") status+=` #${waiting.findIndex(j=>j.id===job.id)+1}`;
    row.append(info,make("span","status "+job.status,status));all.appendChild(row);
  }
  $("jobs").replaceChildren(all);
}
async function refresh() {
  try {
    const response=await browser.runtime.sendMessage({type:"jobs"});
    if (!response.ok) throw new Error(response.error || "Сервис недоступен");
    $("connection").textContent="";
    update(response.jobs || []);
  } catch (e) { $("connection").textContent="Не удалось получить задачи: " + e.message; }
}
$("refresh").addEventListener("click",refresh);
refresh();
setInterval(refresh,2500);
