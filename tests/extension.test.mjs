import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {normalizeBase, permissionFor, captureVideo, resumeVideo, callHandoff} from '../extension/core.js';

test('HA address validation rejects credential/URL payloads', () => {
  assert.equal(permissionFor('http://192.0.2.20:8123'), 'http://192.0.2.20/*');
  assert.equal(normalizeBase(' https://ha.example/ '), 'https://ha.example');
  for (const url of ['https://me:pass@ha.example', 'javascript:alert(1)', 'https://ha.example/a', 'https://ha.example/?secret=1']) assert.throws(() => normalizeBase(url));
});
function capture({url='https://www.youtube.com/watch?v=aqz-KE-bpKQ', ad=false, duration=600, currentTime=90.9}={}) {
  const video = {duration,currentTime,readyState:4,paused:false,pause(){this.paused=true;}};
  const player = {classList:{contains:()=>ad},querySelector:()=>video};
  const context = {URL, location:{href:url},document:{querySelector:()=>player}};
  const result=vm.runInNewContext(`(${captureVideo.toString()})(true)`, context);
  return {result,video};
}
test('captures current playback seconds and pauses the player', () => {
  const {result,video}=capture();
  assert.equal(result.video_id,'aqz-KE-bpKQ'); assert.equal(result.position,90); assert.equal(video.paused,true);
});
test('shorts, SPA URL, ads, live and lookalike domains', () => {
  assert.equal(capture({url:'https://www.youtube.com/shorts/aqz-KE-bpKQ'}).result.video_id,'aqz-KE-bpKQ');
  for (const options of [{ad:true},{duration:Infinity},{url:'https://youtube.com.attacker.test/watch?v=aqz-KE-bpKQ'},{url:'https://www.youtube.com/'},{currentTime:604801}]) assert.throws(()=>capture(options));
});
test('does not resume a different video after failure', () => {
  let played=false;
  const context={URL,location:{href:'https://www.youtube.com/watch?v=bbbbbbbbbbb'},document:{querySelector:()=>({paused:true,currentTime:90,play(){played=true;return Promise.resolve();}})}};
  vm.runInNewContext(`(${resumeVideo.toString()})({video_id:'aqz-KE-bpKQ',position:90,wasPlaying:true})`,context);
  assert.equal(played,false);
});
class FakeSocket {
  constructor(url){this.url=url;this.readyState=1;FakeSocket.latest=this;queueMicrotask(()=>{this.onopen();this.emit({type:'auth_required'});});}
  emit(data){this.onmessage({data:JSON.stringify(data)});}
  send(data){const msg=JSON.parse(data);if(msg.type==='auth')this.emit({type:'auth_ok'});else if(msg.type==='call_service'){this.call=msg;queueMicrotask(()=>this.emit(FakeSocket.reply));}}
  close(){this.readyState=3;}
}
test('authenticated websocket calls the script with seconds and waits for backend response',async()=>{
  FakeSocket.reply={type:'result',id:1,success:true,result:{response:{ok:true,position:90}}};
  const response=await callHandoff('https://ha.example','local-secret','samsung_youtube_handoff',{video_id:'aqz-KE-bpKQ',position:90},{WebSocketClass:FakeSocket});
  assert.equal(response.position,90);assert.equal(FakeSocket.latest.url,'wss://ha.example/api/websocket');assert.equal(FakeSocket.latest.call.return_response,true);assert.equal(FakeSocket.latest.call.service_data.position,90);
});
test('rejects HA script failure and missing response, not false success',async()=>{
  for(const reply of [{type:'result',id:1,success:false,error:{message:'TV unavailable'}},{type:'result',id:1,success:true,result:{response:null}}]){
    FakeSocket.reply=reply;
    await assert.rejects(callHandoff('http://ha.example','x','test',{}, {WebSocketClass:FakeSocket}));
  }
});
test('times out without leaving a socket alive',async()=>{
  FakeSocket.reply={type:'pong',id:42};
  await assert.rejects(callHandoff('http://ha.example','x','test',{}, {WebSocketClass:FakeSocket,timeoutMs:15}),/вовремя/);
  assert.equal(FakeSocket.latest.readyState,3);
});

test('a seek to the beginning captures exactly zero, not the previous position',()=>{
  const {result}=capture({currentTime:0});
  assert.equal(result.position,0);
});
