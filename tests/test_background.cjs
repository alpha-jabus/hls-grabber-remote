const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");
let onSend, onMessage, onUpdated, onRemoved;
const listeners = (setter) => ({addListener: fn => setter(fn)});
const browser = {
  webRequest: {onSendHeaders: listeners(fn => onSend = fn)},
  runtime: {onMessage: listeners(fn => onMessage = fn)},
  tabs: {
    onUpdated: listeners(fn => onUpdated = fn),
    onRemoved: listeners(fn => onRemoved = fn),
    get: async tab => ({id:tab,url:"https://example.org/watch"})
  },
  permissions: {contains: async () => true, getAll: async () => ({data_collection: []})},
  storage: {local: {get:async()=>({}),set:async()=>{}}},
  browserAction: {
    setBadgeText: async () => {},
    setBadgeBackgroundColor: async () => {}
  }
};
vm.runInNewContext(fs.readFileSync("extension/background.js", "utf8"),
                   {browser, URL, Map, Set, Date, AbortController, fetch, setTimeout, clearTimeout, console});
const sample = {tabId:1,url:"https://cdn.example.net/master.m3u8",requestHeaders:[
    {name:"Cookie",value:"secret"},{name:"Accepts-Controls",value:"a"}]};
(async () => {
  onSend(sample);
  assert.equal((await onMessage({type:"streams",tabId:1})).streams.length,0,"capture off by default");
  assert.equal((await onMessage({type:"enableCapture",tabId:1})).ok,true);
  onSend(sample);
  const result = await onMessage({type:"streams",tabId:1});
  assert.equal(result.streams.length,1);
  assert.equal(result.streams[0].headers[0].value,"secret");
  onUpdated(1,{url:"https://different.site/watch"});
  assert.equal((await onMessage({type:"captureStatus",tabId:1})).enabled,false);
  assert.equal((await onMessage({type:"streams",tabId:1})).streams.length,0);
  console.log("background tab capture tests passed");
})().catch(e => {console.error(e);process.exitCode=1;});
