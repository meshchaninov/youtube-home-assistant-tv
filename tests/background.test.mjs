import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {normalizeBase,permissionFor,REMOTE_COMMANDS,remotePayload,captureVideo,resumeVideo} from '../extension/core.js';

async function worker({fail=false,delay=0}={}) {
  const source=(await fs.readFile(new URL('../extension/background.js',import.meta.url),'utf8')).replace(/^import .*;\n/,'');
  let listener;
  const values={haUrl:'https://ha.example',token:'test-secret',script:'samsung_youtube_handoff',pause:true};
  const calls=[]; const injections=[];
  const chrome={
    storage:{local:{setAccessLevel:async()=>{},get:async()=>values,set:async value=>Object.assign(values,value)}},
    action:{setBadgeBackgroundColor:async()=>{},setBadgeText:async()=>{},setTitle:async()=>{}},
    tabs:{query:async()=>[{id:7,url:'https://www.youtube.com/watch?v=aqz-KE-bpKQ'}]},
    scripting:{executeScript:async args=>{injections.push(args);return [{result:{video_id:'aqz-KE-bpKQ',position:values.videoPosition ?? 90,wasPlaying:true}}];}},
    runtime:{id:'test-extension',getURL:p=>`chrome-extension://test-extension/${p}`,onInstalled:{addListener(){}},onMessage:{addListener(fn){listener=fn;}}},
  };
  const context={chrome,normalizeBase,permissionFor,REMOTE_COMMANDS,remotePayload,AbortSignal,captureVideo,resumeVideo,
    callHandoff:async(...args)=>{calls.push(args);if(fail)throw new Error("Test network failure");return {ok:true};},
    callScript:async(...args)=>{calls.push(args);if(delay)await new Promise(resolve=>setTimeout(resolve,delay));if(fail)throw new Error('Test network failure');return {ok:true};},
    fetch:async()=>({ok:true,json:async()=>({state:'on',attributes:{volume_level:0.25,is_volume_muted:false}})})};
  chrome.permissions={contains:async()=>true};
  vm.runInNewContext(source,context);
  const sender={id:'test-extension',url:'chrome-extension://test-extension/popup.html'};
  function request(message,from=sender){return new Promise(resolve=>{const keep=listener(message,from,resolve);if(!keep)resolve(undefined);});}
  return {request,calls,values,injections};
}
test('remote accepts only the fixed command allowlist',()=>{
  assert.deepEqual(remotePayload('pause'),{command:'pause'});
  for(const command of ['turn_on','__proto__','constructor','script.delete',''])assert.throws(()=>remotePayload(command));
});
test('background routes pause through only the HA remote script',async()=>{
  const w=await worker();const reply=await w.request({type:'remote',command:'pause'});
  assert.equal(reply.ok,true);
  assert.equal(w.calls[0][2],'samsung_youtube_remote');assert.equal(w.calls[0][3].command,'pause');
  assert.equal(w.values.lastStatus.state,'success');
});
test('foreign pages cannot invoke a remote command',async()=>{
  const w=await worker();
  assert.equal(await w.request({type:'remote',command:'power_off'},{id:'test-extension',url:'https://www.youtube.com/'}),undefined);
  assert.equal(w.calls.length,0);
});
test('unknown commands fail before making service requests',async()=>{
  const w=await worker();const reply=await w.request({type:'remote',command:'delete'});
  assert.equal(reply.ok,false);assert.equal(w.calls.length,0);
});
test('network failure is visible and releases the command lock',async()=>{
  const w=await worker({fail:true});
  assert.equal((await w.request({type:'remote',command:'play'})).ok,false);
  assert.equal(w.values.lastStatus.state,'error');
  assert.equal((await w.request({type:'tv_status'})).result.busy,false);
});
test('status reports actual HA volume and power state without a YouTube tab',async()=>{
  const w=await worker();const result=(await w.request({type:'tv_status'})).result;
  assert.equal(result.tv.volume,0.25);assert.equal(result.tv.state,'on');assert.equal(result.tv.muted,false);
  assert.equal(w.calls.length,0);
});

test('handoff from popup captures the active video and calls the original HA script',async()=>{
  const w=await worker();const response=await w.request({type:'handoff'});
  assert.equal(response.ok,true);assert.equal(w.calls[0][2],'samsung_youtube_handoff');
  assert.equal(w.calls[0][3].position,90);assert.equal(w.injections[0].func,captureVideo);
  assert.equal(w.values.lastVideo.video_id,'aqz-KE-bpKQ');
});
test('failed popup handoff attempts to resume only the captured video',async()=>{
  const w=await worker({fail:true});const response=await w.request({type:'handoff'});
  assert.equal(response.ok,false);assert.equal(w.injections[1].func,resumeVideo);
  assert.equal(w.injections[1].args[0].video_id,'aqz-KE-bpKQ');
});
test('commands cannot overlap while a request is in flight',async()=>{
  const w=await worker({delay:20});const first=w.request({type:'remote',command:'volume_up'});
  const second=await w.request({type:'remote',command:'pause'});
  assert.equal(second.ok,false);assert.match(second.error,/предыдущей/);
  await first;assert.equal(w.calls.length,1);
});

test('sending the same video again reads the new computer position including zero',async()=>{
  const w=await worker();
  assert.equal((await w.request({type:'handoff'})).ok,true);
  w.values.videoPosition=0;
  assert.equal((await w.request({type:'handoff'})).ok,true);
  assert.equal(w.calls[0][3].video_id,w.calls[1][3].video_id);
  assert.equal(w.calls[0][3].position,90);
  assert.equal(w.calls[1][3].position,0);
});

test('volume slider accepts zero and 100 but rejects missing or out-of-range values',()=>{
  assert.deepEqual(remotePayload('volume_set',0),{command:'volume_set',volume:0});
  assert.deepEqual(remotePayload('volume_set',100),{command:'volume_set',volume:100});
  for(const value of [undefined,-1,101,NaN,Infinity,0.5,'20'])assert.throws(()=>remotePayload('volume_set',value));
});
test('background sends slider percentage to the HA remote script',async()=>{
  const w=await worker();
  const response=await w.request({type:'remote',command:'volume_set',volume:0});
  assert.equal(response.ok,true);
  assert.equal(w.calls[0][3].volume,0);
  assert.equal(w.values.lastStatus.message,'Громкость 0% · команда отправлена');
});
