const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");
let onSend, onResponse, onNetworkError, onMessage, onUpdated, onRemoved;
const listeners = (setter) => ({addListener: fn => setter(fn)});
const browser = {
  webRequest: {
    onSendHeaders: listeners(fn => onSend = fn),
    onHeadersReceived: listeners(fn => onResponse = fn),
    onErrorOccurred: listeners(fn => onNetworkError = fn)
  },
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
  // .mpd with signed query parameters: DASH is detected before the response.
  onSend({tabId:1,requestId:'mpd1',url:'https://cdn.example.net/dash/main.MPD?sig=123',
    requestHeaders:[{name:'Authorization',value:'Bearer signed'}]});
  let dash = (await onMessage({type:'streams',tabId:1})).streams;
  assert.equal(dash[0].kind,'dash');
  assert.equal(dash[0].headers[0].value,'Bearer signed');

  // Extensionless manifest: response MIME identifies MPEG-DASH without a body read.
  onSend({tabId:1,requestId:'mpd2',url:'https://cdn.example.net/api/playback?id=100',
    requestHeaders:[{name:'Cookie',value:'signed-cookie'}]});
  onResponse({tabId:1,requestId:'mpd2',url:'https://cdn.example.net/api/playback?id=100',
    statusCode:200,responseHeaders:[{name:'Content-Type',value:'application/dash+xml; charset=UTF-8'}]});
  dash = (await onMessage({type:'streams',tabId:1})).streams;
  assert.equal(dash[0].kind,'dash');
  assert.equal(dash[0].headers[0].value,'signed-cookie');
  // Ordinary JSON or a rejected request must NOT be offered as media.
  onSend({tabId:1,requestId:'json1',url:'https://cdn.example.net/api/hello',requestHeaders:[]});
  onResponse({tabId:1,requestId:'json1',url:'https://cdn.example.net/api/hello',statusCode:200,
    responseHeaders:[{name:'Content-Type',value:'application/json'}]});
  onSend({tabId:1,requestId:'mpd3',url:'https://cdn.example.net/api/fail',requestHeaders:[]});
  onResponse({tabId:1,requestId:'mpd3',url:'https://cdn.example.net/api/fail',statusCode:403,
    responseHeaders:[{name:'Content-Type',value:'application/dash+xml'}]});
  assert.equal((await onMessage({type:'streams',tabId:1})).streams.length,3);
  onSend({tabId:1,requestId:'aborted',url:'https://cdn.example.net/api/truncated',requestHeaders:[]});
  onNetworkError({tabId:1,requestId:'aborted'});
  onResponse({tabId:1,requestId:'aborted',url:'https://cdn.example.net/api/truncated',statusCode:200,
    responseHeaders:[{name:'Content-Type',value:'application/dash+xml'}]});
  assert.equal((await onMessage({type:'streams',tabId:1})).streams.length,3);
  onUpdated(1,{url:"https://different.site/watch"});
  assert.equal((await onMessage({type:"captureStatus",tabId:1})).enabled,false);
  assert.equal((await onMessage({type:"streams",tabId:1})).streams.length,0);
  console.log("background tab capture tests passed");
})().catch(e => {console.error(e);process.exitCode=1;});
