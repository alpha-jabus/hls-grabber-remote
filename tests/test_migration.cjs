'use strict';
const fs=require('node:fs');const vm=require('node:vm');const assert=require('node:assert/strict');
const registered={};
const reg=(key)=>({addListener:fn=>registered[key]=fn});
let saved={remoteEnabled:true,remoteMode:'pinned',remoteUrl:'',remoteToken:''};
const legacy={url:'https://192.168.0.190:8765',token:'p'.repeat(64),fingerprint:'AA:'.repeat(31)+'AA'};
const ops=[];
let failSave=true;
const browser={
 runtime:{onMessage:reg('msg'),sendNativeMessage:async(name,payload)=>{ops.push(payload.action);return payload.action==='pinned_config_get'?{ok:true,config:legacy}:{ok:true,removed:true};}},
 storage:{local:{get:async keys=>Object.fromEntries(keys.map(k=>[k,saved[k]])),set:async values=>{if(failSave)throw Error('disk full');Object.assign(saved,values);}}},
 webRequest:{onSendHeaders:reg('send'),onHeadersReceived:reg('received'),onErrorOccurred:reg('networkError')},
 tabs:{onRemoved:reg('removed'),onUpdated:reg('updated')},
 browserAction:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}}
};
vm.runInNewContext(fs.readFileSync('extension/background.js','utf8'),
 {browser,Map,Set,Date,URL,AbortController,TextDecoder,Uint8Array,atob,setTimeout,clearTimeout});
(async()=>{
 let r=await registered.msg({type:'getSettings'});
 assert.match(r.settings.error,/disk full/);
 assert.equal(r.settings.token,'');
 assert.equal(ops.includes('pinned_config_cleanup'),false,'Never delete file before successful storage');
 failSave=false;
 r=await registered.msg({type:'getSettings'});
 assert.equal(r.settings.token,'p'.repeat(64));
 assert.equal(r.settings.fingerprint,'aa'.repeat(32));
 assert.equal(saved.remoteSettingsVersion,231);
 assert(ops.includes('pinned_config_cleanup'));
 const count=ops.length;
 await registered.msg({type:'getSettings'});
 assert.equal(ops.length,count,'Should not import again after successful migration');
 console.log('legacy pinned config migration safety tests passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
