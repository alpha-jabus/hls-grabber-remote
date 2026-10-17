'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
let handler, send, updated, removed, calls = [], disconnects = 0;
let settings = {remoteEnabled:true,remoteMode:'pinned',remoteUrl:'',remoteToken:''};
let nativeResult = {ok:true,service:'hls-grabber'};
const reg = setter => ({addListener:fn=>setter(fn)});
const browser = {
  webRequest:{onSendHeaders:reg(fn=>send=fn)},
  runtime:{
    onMessage:reg(fn=>handler=fn),
    connectNative(name){
      assert.equal(name,'local.hls_grabber');
      let messageHandler, disconnectHandler;
      return {
        onMessage:reg(fn=>messageHandler=fn),
        onDisconnect:reg(fn=>disconnectHandler=fn),
        postMessage(data){
          calls.push(data);
          queueMicrotask(()=>{
            if(nativeResult.multipart){
              const bytes=Buffer.from(JSON.stringify(nativeResult.value));
              const chunk=bytes.subarray(0,600000);
              messageHandler({native_chunk:true,part:0,total:2,data:chunk.toString('base64')});
              messageHandler({native_chunk:true,part:1,total:2,data:bytes.subarray(600000).toString('base64')});
            }else messageHandler(nativeResult);
          });
        },
        disconnect(){disconnects++;disconnectHandler?.();}
      };
    },
    sendNativeMessage: async(name,payload)=> ({ok:true,config:{url:'https://192.168.0.190:8765',token:'x'.repeat(64),fingerprint:'1'.repeat(64)}})
  },
  permissions:{getAll:async()=>({data_collection:['authenticationInfo','browsingActivity','websiteContent']}),contains:async()=>true},
  storage:{local:{get:async keys=>Object.fromEntries(keys.map(k=>[k,settings[k]])),set:async x=>Object.assign(settings,x)}},
  tabs:{onRemoved:reg(fn=>removed=fn),onUpdated:reg(fn=>updated=fn),get:async()=>({url:'https://watch.example.org/'})},
  browserAction:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}}
};
vm.runInNewContext(fs.readFileSync('extension/background.js','utf8'),
 {browser,Map,Set,Date,URL,AbortController,TextDecoder,Uint8Array,atob,console,fetch:()=>{throw new Error('Direct browser fetch must not be used for pinned mode');},setTimeout,clearTimeout});
(async()=>{
  let health=await handler({type:'testRemote'});
  assert.equal(health.ok,true);assert.equal(calls.at(-1).action,'pinned_request');assert.equal(calls.at(-1).path,'health');assert.equal(calls.at(-1).payload,undefined);
  await handler({type:'enableCapture',tabId:99});
  send({tabId:99,url:'https://media.example.org/master.m3u8',requestHeaders:[{name:'Cookie',value:'private'}]});
  let preview=await handler({type:'preview',tabId:99,url:'https://media.example.org/master.m3u8'});
  assert.equal(preview.ok,true);
  assert.equal(calls.at(-1).payload.headers[0].value,'private');
  nativeResult={ok:false,error:'TLS PIN MISMATCH: no data transmitted'};
  health=await handler({type:'testRemote'});
  assert.equal(health.ok,false);assert.match(health.error,/PIN MISMATCH/);
  nativeResult={multipart:true,value:{ok:true,image:'f'.repeat(1300000)}};
  health=await handler({type:'testRemote'});
  assert.equal(health.ok,true);assert.equal(health.image.length,1300000);
  assert(disconnects>=4);
  console.log('pinned native request routing & multipart tests passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
