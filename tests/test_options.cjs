'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const els = new Map();
const pending = [];
let state = {enabled:true,mode:'pinned',url:'https://192.168.0.190:8765',token:'a'.repeat(64),fingerprint:'1'.repeat(64)};
let saved = 0, tested = 0, networkResult = {ok:false,error:'TLS PIN MISMATCH: сертификат не совпадает'};
class Element {
  constructor(id) {this.id=id;this.value='';this.checked=false;this.hidden=false;this.textContent='';this.type='text';this.attrs={};this.handlers={};}
  addEventListener(event,handler){this.handlers[event]=handler;}
  async trigger(event){if(this.handlers[event])await this.handlers[event]();}
  setAttribute(k,v){this.attrs[k]=v;}
  removeAttribute(k){delete this.attrs[k];}
  focus(){this.focused=true;}
}
const ids=['remoteEnabled','remoteUrl','remoteToken','fingerprint','pinSection','configRaw','rawArea','status','save','check','showToken','toggleRaw','resetRaw','saveRaw','reload','remoteUrlError','remoteTokenError','fingerprintError','configRawError'];
ids.forEach(id=>els.set(id,new Element(id)));
const radios=[new Element('pinned'),new Element('direct')];radios[0].value='pinned';radios[1].value='direct';
const browser={
  runtime:{async sendMessage(msg){
    if(msg.type==='getSettings')return {ok:true,settings:{...state}};
    if(msg.type==='saveSettings'){saved++;state={enabled:msg.enabled,mode:msg.mode,url:msg.url,token:msg.token,fingerprint:msg.fingerprint};return {ok:true};}
    if(msg.type==='testRemoteDraft'){tested++;return networkResult;}
    throw new Error(msg.type);
  }},
  permissions:{getAll:async()=>({data_collection:['authenticationInfo','browsingActivity','websiteContent']})}
};
const document={getElementById:id=>els.get(id),querySelector:()=>radios.find(x=>x.checked),querySelectorAll:()=>radios};
vm.runInNewContext(fs.readFileSync('extension/options.js','utf8'),{document,browser,URL,window:{confirm:()=>true},console});
const el=id=>els.get(id);
async function flush(){await new Promise(resolve=>setImmediate(resolve));}
(async()=>{
 await flush();
 assert.equal(el('remoteUrl').value,state.url);
 radios[0].checked=true;radios[1].checked=false;
 el('toggleRaw').handlers.click();
 let raw=JSON.parse(el('configRaw').value);
 assert.equal(raw.url,state.url);
 assert.equal(raw.enabled,true);
 // Editing and save error must not modify any previously committed setting or draft.
 el('configRaw').value='{\n  "url":';
 await el('configRaw').trigger('input');
 const invalidRaw=el('configRaw').value;
 await el('saveRaw').trigger('click');
 assert.equal(el('configRaw').value,invalidRaw);
 assert.equal(saved,0);
 assert.match(el('status').textContent,/JSON:/);
 assert.equal(el('configRaw').attrs['aria-invalid'],'true');
 // Form test failure highlights fingerprint and does not destroy form edits.
 el('remoteToken').value='b'.repeat(64);
 await el('remoteToken').trigger('input');
 await el('check').trigger('click');
 assert.equal(tested,1);
 assert.equal(el('remoteToken').value,'b'.repeat(64));
 assert.equal(el('fingerprint').attrs['aria-invalid'],'true');
 assert.equal(state.token,'a'.repeat(64));
 assert.equal(el('configRaw').value,invalidRaw);
 // Valid JSON is saved once and updates fields only afterwards.
 el('configRaw').value=JSON.stringify({...state,token:'c'.repeat(64)});
 await el('configRaw').trigger('input');
 await el('saveRaw').trigger('click');
 assert.equal(saved,1);
 assert.equal(state.token,'c'.repeat(64));
 assert.equal(el('remoteToken').value,'c'.repeat(64));
 assert.equal(el('status').textContent,'JSON применён и сохранён в профиле Firefox.');
 console.log('options draft JSON/errors/transactional save tests passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
