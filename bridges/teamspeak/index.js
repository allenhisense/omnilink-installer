import fs from "node:fs";
import net from "node:net";
import dgram from "node:dgram";
import http from "node:http";
import WebSocket from "ws";
import wrtcPackage from "@roamhq/wrtc";
import { performance } from "node:perf_hooks";

const wrtc = wrtcPackage.default || wrtcPackage;
const { RTCPeerConnection, nonstandard } = wrtc;
const { RTCAudioSource, RTCAudioSink } = nonstandard;

const HOME = process.env.OMNILINK_HOME || "/opt/omnilink";
const TS_CONFIG = HOME + "/data/teamspeak.json";
const STATE_FILE = HOME + "/data/state.json";
const fallbackConfig = {
  enabled:true, serverHost:"ts3.my.id", voicePort:9987, queryPort:10011,
  serverPassword:"", nickname:"Omnilink server", channelName:"MABES 408",
  channelPassword:"mabes5758", channelId:0,
  omnilinkRoomId:"11", omnilinkRoomName:"teamspeak", omnilinkCallsign:"TEST1",
  pcmRxPort:19101, pcmTxPort:19102, bridgeHealthPort:18891, joinPort:19103
};
function resolveRoomId(cfg){
  try{
    const raw=JSON.parse(fs.readFileSync(STATE_FILE,"utf8"));
    const rooms=Array.isArray(raw.rooms)?raw.rooms:[];
    const wanted=String(cfg.omnilinkRoomName||"").trim().toLowerCase();
    if(wanted){
      const byName=rooms.find(r=>String(r.name||"").trim().toLowerCase()===wanted&&r.enabled!==false);
      if(byName)return String(byName.id);
    }
    const id=String(cfg.omnilinkRoomId||"").trim();
    if(id&&rooms.some(r=>String(r.id)===id&&r.enabled!==false))return id;
  }catch{}
  return String(cfg.omnilinkRoomId||"");
}
function loadTSConfig(){
  try{return {...fallbackConfig,...JSON.parse(fs.readFileSync(TS_CONFIG,"utf8"))};}
  catch{return fallbackConfig;}
}
const tsCfg=loadTSConfig();
const WS_URL = process.env.OMNILINK_URL || "ws://127.0.0.1:8787/ws";
const CALLSIGN = tsCfg.omnilinkCallsign;
const ROOM_ID = resolveRoomId(tsCfg);
const TS_CHANNEL_ID = String(tsCfg.channelId);
const TS_SERVER_HOST = String(tsCfg.serverHost||"127.0.0.1");
const TS_QUERY_PORT = Number(tsCfg.queryPort||10011);
const RX_PORT = Number(tsCfg.pcmRxPort);
const TX_PORT = Number(tsCfg.pcmTxPort);
const TS_CMD_PORT = Number(tsCfg.joinPort || 19103);
const HEALTH_PORT = Number(tsCfg.bridgeHealthPort || 18891);
const RECONNECT_MS = 2000;
let lastConfigMtime=0;
function bridgeConfigSignature(){
  try{
    const c=JSON.parse(fs.readFileSync(TS_CONFIG,"utf8"));
    for(const k of ["connectRequested","autoReconnect","reconnectDelaySec"]) delete c[k];
    return JSON.stringify(c);
  }catch{return "";}
}
let lastConfigSignature="";

const state = {
  wsConnected:false, authed:false, roomJoined:false, tsQuery:false,
  peers:0, audioIn:0, audioOut:0, lastAudioIn:0, lastAudioOut:0,
  lastAudioInPeak:0, lastAudioInMeanPower:0, audioInNonZero:0,
  tsPlaybackMutedCount:0, omniTxActive:false, lastOmniTxVoiceAt:0,
  echoCancelledFrames:0,
  lastError:"", startedAt:Date.now()
};
const peers = new Map();
let socket = null;
let ws = null;
let wsReconnectTimer = null;
let wsReconnectAttempt = 0;
let wsConnecting = false;
let wsHeartbeatTimer = null;
let wsAlive = false;
let user = null;
let omniPttActive = false;
const source = new RTCAudioSource();
const sourceTrack = source.createTrack();

function now(){ return new Date().toISOString(); }
function log(...a){ console.log(new Date().toISOString(), ...a); }
function fail(e){ state.lastError=String(e?.message||e); log("ERROR",state.lastError); }

function getToken(){
  const raw=JSON.parse(fs.readFileSync(HOME + "/data/state.json","utf8"));
  const u=(raw.users||[]).find(x=>x.callsign?.toUpperCase()===CALLSIGN.toUpperCase() && x.enabled!==false);
  if(!u?.token) throw new Error("OMNILINK_USER_TOKEN_NOT_FOUND");
  return {callsign:u.callsign,token:u.token};
}
function send(obj){
  if(ws && ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

const OMNI_TX_HANGOVER_MS = 260;
const OMNI_TX_RMS_THRESHOLD = 300;
const OMNI_TX_PEAK_THRESHOLD = 900;
const ECHO_REF_CAP = 48000;
const ECHO_MAX_DELAY = 24000;
const ECHO_SEARCH_STEP = 240;
const ECHO_CORR_THRESHOLD = 0.70;
const ECHO_MIN_GAIN = 0.10;
const ECHO_MAX_GAIN = 1.25;
const ECHO_HANGOVER_MS = 900;
const echoReference = new Int16Array(ECHO_REF_CAP);
let echoReferenceWrite = 0;
let echoReferenceSeq = 0;
let echoActiveUntil = 0;
let omniTxActiveUntil = 0;

function detectOmniVoice(samples, channels){
  const ch=Math.max(1,Number(channels||1));
  const count=Math.floor(samples.length/ch);
  if(!count)return false;
  let sumSq=0,peak=0;
  for(let i=0;i<count;i++){
    let mix=0;
    for(let c=0;c<ch;c++) mix+=Math.abs(Number(samples[i*ch+c]||0));
    const v=mix/ch;
    if(v>peak)peak=v;
    sumSq+=v*v;
  }
  const rms=Math.sqrt(sumSq/count);
  return rms>=OMNI_TX_RMS_THRESHOLD || (peak>=OMNI_TX_PEAK_THRESHOLD && rms>=150);
}

function noteOmniTransmit(samples, channels){
  if(detectOmniVoice(samples,channels)){
    omniTxActiveUntil=Date.now()+OMNI_TX_HANGOVER_MS;
    state.lastOmniTxVoiceAt=Date.now();
  }
  const active=Date.now()<omniTxActiveUntil;
  if(active!==state.omniTxActive){
    state.omniTxActive=active;
    log("OMNILINK TX audio gate",active?"MUTE_TS_PLAYBACK":"TS_PLAYBACK_NORMAL");
  }
}

function sendTSCommand(command){
  if(!socket)return;
  const b=Buffer.from(String(command),"utf8");
  socket.send(b,0,b.length,TS_CMD_PORT,"127.0.0.1");
}
function applyTeamSpeakPTTQuery(active){
  const key=getClientQueryApiKey();
  if(!key){state.tsQuery=false;log("TeamSpeak PTT query",active?"ACTIVE":"DEACTIVE","FAIL API key missing");return;}
  const q=net.createConnection({host:"127.0.0.1",port:25639});
  let buf="",authed=false,done=false;
  const finish=(ok,detail="")=>{
    if(done)return;
    done=true;
    state.tsQuery=ok;
    log("TeamSpeak PTT query",active?"ACTIVE":"DEACTIVE",ok?"OK":("FAIL "+detail));
    try{q.destroy();}catch{}
  };
  q.setTimeout(3000,()=>finish(false,"timeout"));
  q.on("connect",()=>{
    log("TeamSpeak Query AUTH SEND");
    q.write("auth apikey="+key+"\\r\\n");
  });
  q.on("data",d=>{
    buf+=d.toString();
    if(/error id=0/.test(buf)){
      if(!authed){
        authed=true;
        log("TeamSpeak Query AUTH OK");
        buf=buf.replace(/error id=0[^\\r\\n]*/,"");
        q.write("clientupdate client_input_deactivated="+(active?0:1)+"\\r\\n");
        log("TeamSpeak PTT UPDATE SEND",active?"ACTIVE":"DEACTIVE");
      }else{
        finish(true);
      }
    }else if(/error id=(?!0)\\d+/.test(buf)){
      const m=buf.match(/error id=(\\d+)/);finish(false,"error "+(m?m[1]:"unknown"));
    }
  });
  q.on("error",e=>finish(false,String(e?.message||e)));
}
function setTeamSpeakPTT(active){
  const next=!!active;
  omniPttActive=next;
  sendTSCommand(next?"PTT|ACTIVE":"PTT|DEACTIVE");
  log("TeamSpeak PTT relay event",next?"ACTIVE":"DEACTIVE");
}

function pushEchoReference(mono){
  const n=mono.length;
  if(!n)return;
  for(let i=0;i<n;i++){
    echoReference[echoReferenceWrite]=mono[i];
    echoReferenceWrite=(echoReferenceWrite+1)%ECHO_REF_CAP;
    echoReferenceSeq++;
  }
}
function echoReferenceSample(seq){
  if(seq<0 || echoReferenceSeq-seq>ECHO_REF_CAP)return 0;
  const pos=((seq%ECHO_REF_CAP)+ECHO_REF_CAP)%ECHO_REF_CAP;
  return echoReference[pos]||0;
}
function noteEchoReference(mono){
  let peak=0;
  let sumSq=0;
  for(let i=0;i<mono.length;i++){
    const v=Math.abs(Number(mono[i]||0));
    if(v>peak)peak=v;
    sumSq+=v*v;
  }
  const rms=mono.length?Math.sqrt(sumSq/mono.length):0;
  if(peak>=ECHO_MIN_GAIN*900 && rms>=120) echoActiveUntil=Date.now()+ECHO_HANGOVER_MS;
}
function cancelEchoInPlace(samples){
  if(!samples.length || Date.now()>echoActiveUntil || echoReferenceSeq<samples.length)return false;
  let inEnergy=0;
  const probeLen=Math.min(samples.length,480);
  for(let i=0;i<probeLen;i++){
    const v=Number(samples[i]||0);
    inEnergy+=v*v;
  }
  if(inEnergy<probeLen*120*120)return false;

  let bestCorr=0;
  let bestGain=0;
  let bestDelay=0;
  const latest=echoReferenceSeq;
  const maxDelay=Math.min(ECHO_MAX_DELAY,latest-probeLen);
  for(let delay=ECHO_SEARCH_STEP;delay<=maxDelay;delay+=ECHO_SEARCH_STEP){
    const start=latest-delay-probeLen;
    let dot=0,refEnergy=0;
    for(let i=0;i<probeLen;i++){
      const ref=echoReferenceSample(start+i);
      const x=Number(samples[i]||0);
      dot+=x*ref;
      refEnergy+=ref*ref;
    }
    if(refEnergy<probeLen*1000)continue;
    const corr=dot/Math.sqrt(refEnergy*inEnergy);
    if(corr>bestCorr){
      bestCorr=corr;
      bestGain=dot/refEnergy;
      bestDelay=delay;
    }
  }
  if(bestCorr<ECHO_CORR_THRESHOLD || bestGain<ECHO_MIN_GAIN || bestGain>ECHO_MAX_GAIN)return false;

  const start=latest-bestDelay-samples.length;
  for(let i=0;i<samples.length;i++){
    const ref=echoReferenceSample(start+i);
    const v=Math.round(Number(samples[i]||0)-bestGain*ref);
    samples[i]=Math.max(-32768,Math.min(32767,v));
  }
  state.echoCancelledFrames++;
  if((state.echoCancelledFrames%100)===0)
    log("TS->OMNI echo suppression","frames="+state.echoCancelledFrames,"corr="+bestCorr.toFixed(2),
        "gain="+bestGain.toFixed(2),"delayMs="+Math.round(bestDelay/48));
  return true;
}

function sendPCM(samples, channels, sampleRate){
  const udp=socket;
  if(!udp)return;
  noteOmniTransmit(samples, channels);
  const ch=Math.max(1,Number(channels||1));
  const sr=Math.max(8000,Number(sampleRate||48000));
  // Fast path: normal OMNILINK audio is mono/48 kHz. Avoid per-sample
  // conversion and Buffer writes that can starve the source clock.
  if(ch===1 && sr===48000){
    noteEchoReference(samples);
    pushEchoReference(samples);
    for(let off=0;off<samples.length;off+=960){
      const n=Math.min(960,samples.length-off);
      const b=Buffer.allocUnsafe(8+n*2);
      b.writeUInt32BE(0x4f4d5043,0);
      b.writeUInt16BE(n,4);
      b[6]=1; b[7]=16;
      Buffer.from(samples.buffer,samples.byteOffset+off*2,n*2).copy(b,8);
      if(udp) udp.send(b,0,b.length,TX_PORT,"127.0.0.1");
      state.audioOut++; state.lastAudioOut=Date.now();
    }
    return;
  }
  const frames=Math.floor(samples.length/ch);
  const mono=new Int16Array(frames);
  for(let i=0;i<frames;i++){
    let sum=0;
    for(let c=0;c<ch;c++)sum+=Number(samples[i*ch+c]||0);
    mono[i]=Math.max(-32768,Math.min(32767,Math.round(sum/ch)));
  }
  const outFrames=sr===48000?frames:Math.max(1,Math.round(frames*48000/sr));
  const out=new Int16Array(outFrames);
  if(outFrames===frames) out.set(mono);
  else for(let i=0;i<outFrames;i++){
    const pos=outFrames<=1?0:i*(frames-1)/(outFrames-1);
    const aa=Math.floor(pos),bb=Math.min(frames-1,aa+1),f=pos-aa;
    const v=frames?mono[aa]*(1-f)+mono[bb]*f:0;
    out[i]=Math.max(-32768,Math.min(32767,Math.round(v)));
  }
  noteEchoReference(out);
  pushEchoReference(out);
  for(let off=0;off<out.length;off+=960){
    const n=Math.min(960,out.length-off);
    const b=Buffer.allocUnsafe(8+n*2);
    b.writeUInt32BE(0x4f4d5043,0);
    b.writeUInt16BE(n,4);
    b[6]=1; b[7]=16;
    Buffer.from(out.buffer,out.byteOffset+off*2,n*2).copy(b,8);
    if(udp) udp.send(b,0,b.length,TX_PORT,"127.0.0.1");
    state.audioOut++; state.lastAudioOut=Date.now();
  }
}

const SOURCE_FRAME_SAMPLES=480;
const SOURCE_START_BUFFER=960;
const SOURCE_MAX_BUFFER=4800;
const SOURCE_RING_CAP=32768;
const sourceQueue=new Int16Array(SOURCE_RING_CAP);
let sourceReadPos=0;
let sourceWritePos=0;
let sourceQueueLen=0;
let sourceStarted=false;
let sourceUnderflows=0;
let sourceOverruns=0;
let sourcePacketsIn=0;
let sourceSamplesIn=0;
let sourceSamplesDropped=0;
let sourceFramesOut=0;
let sourceRatio=1;

function queueDropOldest(n){
  if(n<=0)return;
  n=Math.min(n,sourceQueueLen);
  sourceReadPos=(sourceReadPos+n)%SOURCE_RING_CAP;
  sourceQueueLen-=n;
  sourceSamplesDropped+=n;
}

function queuePushFromPacket(buf,n){
  if(n<=0)return;
  const excess=sourceQueueLen+n-SOURCE_MAX_BUFFER;
  if(excess>0){
    const drop=Math.min(sourceQueueLen,Math.ceil(excess/SOURCE_FRAME_SAMPLES)*SOURCE_FRAME_SAMPLES);
    if(drop>0){
      queueDropOldest(drop);
      sourceOverruns++;
    }
  }
  let left=n;
  let src=8;
  while(left>0){
    const chunk=Math.min(left,SOURCE_RING_CAP-sourceWritePos);
    for(let i=0;i<chunk;i++)
      sourceQueue[sourceWritePos+i]=buf.readInt16LE(src+i*2);
    sourceWritePos=(sourceWritePos+chunk)%SOURCE_RING_CAP;
    sourceQueueLen+=chunk;
    src+=chunk*2;
    left-=chunk;
  }
}

function feedSource(buf){
  if(buf.length<8 || buf.readUInt32BE(0)!==0x4f4d5043) return;
  const n=Math.min(buf.readUInt16BE(4),1920);
  if(8+n*2>buf.length) return;

  let sum=0, peak=0;
  for(let i=0;i<n;i++){
    const v=Math.abs(buf.readInt16LE(8+i*2));
    if(v>peak) peak=v;
    sum+=v*v;
  }
  const meanPower=n?Math.floor(sum/n):0;
  state.lastAudioInPeak=peak;
  state.lastAudioInMeanPower=meanPower;
  if(peak>20) state.audioInNonZero++;

  const frame=new Int16Array(n);
  for(let i=0;i<n;i++) frame[i]=buf.readInt16LE(8+i*2);
  const echoSuppressed=cancelEchoInPlace(frame);
  if(echoSuppressed){
    for(let i=0;i<n;i++)buf.writeInt16LE(frame[i],8+i*2);
  }
  queuePushFromPacket(buf,n);
  sourcePacketsIn++;
  sourceSamplesIn+=n;
  state.audioIn++;
  state.lastAudioIn=Date.now();

  if((state.audioIn % 500)===0)
    log("TS->OMNI PCM", "packets="+state.audioIn, "peak="+peak, "meanPower="+meanPower,
        "queue="+sourceQueueLen, "peers="+state.peers);
}

function pumpSource(){
  if(!sourceStarted){
    if(sourceQueueLen<SOURCE_START_BUFFER){
      source.onData({
        samples:new Int16Array(SOURCE_FRAME_SAMPLES),
        sampleRate:48000,bitsPerSample:16,channelCount:1,
        numberOfFrames:SOURCE_FRAME_SAMPLES
      });
      return;
    }
    sourceStarted=true;
  }

  sourceRatio=1;
  const frame=new Int16Array(SOURCE_FRAME_SAMPLES);
  if(sourceQueueLen<SOURCE_FRAME_SAMPLES){
    sourceUnderflows++;
  }else{
    const first=Math.min(SOURCE_FRAME_SAMPLES,SOURCE_RING_CAP-sourceReadPos);
    frame.set(sourceQueue.subarray(sourceReadPos,sourceReadPos+first),0);
    if(first<SOURCE_FRAME_SAMPLES)
      frame.set(sourceQueue.subarray(0,SOURCE_FRAME_SAMPLES-first),first);
    sourceReadPos=(sourceReadPos+SOURCE_FRAME_SAMPLES)%SOURCE_RING_CAP;
    sourceQueueLen-=SOURCE_FRAME_SAMPLES;
  }

  const muted=Date.now()<omniTxActiveUntil;
  if(muted){
    frame.fill(0);
    state.tsPlaybackMutedCount++;
  }
  sourceFramesOut++;
  source.onData({
    samples:frame,
    sampleRate:48000,
    bitsPerSample:16,
    channelCount:1,
    numberOfFrames:SOURCE_FRAME_SAMPLES
  });
}
const SOURCE_TICK_MS=10;
let sourceNextDeadline=performance.now()+SOURCE_TICK_MS;
function scheduleSourcePump(){
  pumpSource();
  sourceNextDeadline+=SOURCE_TICK_MS;
  const delay=Math.max(0,sourceNextDeadline-performance.now());
  setTimeout(scheduleSourcePump,delay);
}
setTimeout(scheduleSourcePump,SOURCE_TICK_MS);

function initPCMSocket(){
  if(socket)return;
  socket=dgram.createSocket("udp4");
  socket.on("error",e=>log("PCM UDP error",String(e?.message||e)));
  socket.on("close",()=>{socket=null;});
  socket.on("message",feedSource);
  socket.bind(RX_PORT,"127.0.0.1",()=>log("PCM RX",RX_PORT));
}
initPCMSocket();

function bridgeRTCConfig(){
  try{
    const cfg=JSON.parse(fs.readFileSync(HOME+"/data/server-settings.json","utf8"));
    const w=cfg.webrtc||{};
    const ice=[];
    for(const urls of (w.stunUrls||[])) ice.push({urls});
    for(const urls of (w.turnUrls||[])) if(w.turnUsername&&w.turnCredential) ice.push({urls,username:w.turnUsername,credential:w.turnCredential});
    return {iceServers:ice};
  }catch{
    return {iceServers:[{urls:"stun:stun.l.google.com:19302"}]};
  }
}
function createPeer(peerId,callsign){
  let p=peers.get(peerId);
  if(p) return p;
  const pc=new RTCPeerConnection(bridgeRTCConfig());
  p={pc,callsign,sink:null};
  peers.set(peerId,p); state.peers=peers.size;

  pc.addTrack(sourceTrack);
  pc.onicecandidate=e=>{
    if(e.candidate) send({type:"rtc.ice",roomId:ROOM_ID,peerId,candidate:e.candidate});
  };
  pc.onconnectionstatechange=()=>{
    log("RTC",callsign,pc.connectionState);
    if(pc.connectionState==="connected") state.lastError="";
    if(["failed","closed"].includes(pc.connectionState)){
      try{p.sink?.stop?.();}catch{}
      if(peers.get(peerId)?.pc===pc) peers.delete(peerId);
      state.peers=peers.size;
    }
  };
  pc.ontrack=e=>{
    try{p.sink?.stop?.();}catch{}
    p.sink=new RTCAudioSink(e.track);
    p.sink.ondata=data=>sendPCM(data.samples,data.channelCount||1,data.sampleRate||48000);
  };
  return p;
}

async function makeOffer(peerId,p){
  const offer=await p.pc.createOffer();
  await p.pc.setLocalDescription(offer);
  send({type:"rtc.offer",roomId:ROOM_ID,peerId,description:p.pc.localDescription});
}

async function handleRTC(m){
  const peerId=String(m.fromUserId||"");
  if(!peerId || peerId===String(user?.id||"")) return;
  const p=createPeer(peerId,m.from);
  if(m.type==="rtc.offer"){
    await p.pc.setRemoteDescription(m.description);
    const answer=await p.pc.createAnswer();
    await p.pc.setLocalDescription(answer);
    send({type:"rtc.answer",roomId:ROOM_ID,peerId:peerId,description:p.pc.localDescription});
  }else if(m.type==="rtc.answer"){
    if(p.pc.signalingState!=="have-local-offer")return;
    await p.pc.setRemoteDescription(m.description);
  }else if(m.type==="rtc.ice"){
    try{
      if(m.candidate && !["closed","failed"].includes(p.pc.connectionState)) await p.pc.addIceCandidate(m.candidate);
    }catch(e){
      if(!["closed","failed"].includes(p.pc.connectionState)) fail(e);
    }
  }
}
function clearWSHeartbeat(){
  if(wsHeartbeatTimer){clearInterval(wsHeartbeatTimer);wsHeartbeatTimer=null;}
}
function scheduleWSReconnect(){
  if(wsReconnectTimer || !tsCfg.enabled)return;
  const delay=Math.min(30000,2000*Math.pow(2,Math.min(wsReconnectAttempt++,4)));
  log("OMNILINK WS reconnect scheduled",delay+"ms");
  wsReconnectTimer=setTimeout(()=>{wsReconnectTimer=null;connectWS();},delay);
}
function connectWS(){
  if(wsConnecting)return;
  if(ws && [WebSocket.OPEN,WebSocket.CONNECTING].includes(ws.readyState))return;
  wsConnecting=true;
  let creds;
  try{creds=getToken();}catch(e){wsConnecting=false;state.lastError=String(e?.message||e);scheduleWSReconnect();return;}
  const conn=new WebSocket(WS_URL);
  ws=conn;
  wsAlive=true;
  conn.on("open",()=>{
    wsConnecting=false; wsReconnectAttempt=0; wsAlive=true;
    state.wsConnected=true; state.lastError="";
    send({type:"auth",token:creds.token,callsign:creds.callsign,role:"bridge"});
    clearWSHeartbeat();
    wsHeartbeatTimer=setInterval(()=>{
      if(conn.readyState!==WebSocket.OPEN)return;
      if(!wsAlive){try{conn.terminate();}catch{};return;}
      wsAlive=false; try{conn.ping();}catch{}
    },15000);
  });
  conn.on("pong",()=>{wsAlive=true;});
  conn.on("message",async data=>{
    if(conn!==ws)return;
    let m; try{m=JSON.parse(data.toString());}catch{return;}
    try{
      if(m.type==="auth.ok"){user=m.user;state.authed=true;send({type:"room.join",roomId:ROOM_ID});return;}
      if(m.type==="room.joined"){state.roomJoined=true;setTeamSpeakPTT(false);return;}
      if(m.type==="ptt.grant"){const rid=String(m.active?.roomId||"");if(!rid||rid===String(ROOM_ID))setTeamSpeakPTT(true);return;}
      if(m.type==="ptt.release"){const rid=String(m.roomId||"");if(!rid||rid===String(ROOM_ID))setTeamSpeakPTT(false);return;}
      if(m.type==="auth.error"){fail(new Error(m.error||"auth.error"));try{conn.close();}catch{};return;}
      if(m.type==="presence"){
        if(String(m.userId)===String(user?.id))return;
        if(m.online){const p=createPeer(String(m.userId),m.callsign);if(String(user?.id)<String(m.userId))await makeOffer(String(m.userId),p);}
        else{const p=peers.get(String(m.userId));try{p?.sink?.stop?.();p?.pc?.close?.();}catch{};peers.delete(String(m.userId));state.peers=peers.size;}
        return;
      }
      if(m.type==="rtc.offer"||m.type==="rtc.answer"||m.type==="rtc.ice")if(String(m.peerId)===String(user?.id))await handleRTC(m);
    }catch(e){fail(e);}
  });
  conn.on("error",e=>{if(conn===ws)state.lastError=String(e?.message||e);});
  conn.on("close",()=>{
    if(conn!==ws)return;
    clearWSHeartbeat(); ws=null; wsConnecting=false;
    state.wsConnected=false; state.authed=false; state.roomJoined=false; setTeamSpeakPTT(false);
    for(const p of peers.values())try{p.sink?.stop?.();p.pc.close();}catch{}
    peers.clear(); state.peers=0; scheduleWSReconnect();
  });
}

function getClientQueryApiKey(){
  try{
    const m=fs.readFileSync(HOME+"/.ts3client/clientquery.ini","utf8").match(/^api_key=(.+)$/m);
    return m?m[1].trim():"";
  }catch{return "";}
}
function probeTS(){
  const key=getClientQueryApiKey();
  if(!key){state.tsQuery=false;return;}
  const q=net.createConnection({host:"127.0.0.1",port:25639});
  let buf="",step=0,done=false;
  const finish=ok=>{
    if(done)return;
    done=true; state.tsQuery=ok;
    log("TeamSpeak Voice Probe",ok?"OK":"FAIL");
    try{q.destroy();}catch{}
  };
  q.setTimeout(2500,()=>finish(false));
  q.on("connect",()=>q.write("auth apikey="+key+"\r\n"));
  q.on("data",d=>{
    buf+=d.toString();
    if(!/error id=0/.test(buf)&&!/error id=\d+/.test(buf))return;
    if(step===0){
      if(/error id=(?!0)\d+/.test(buf)){finish(false);return;}
      buf=""; step=1; q.write("use 1\r\n"); return;
    }
    if(step===1){
      if(/error id=(?!0)\d+/.test(buf)){finish(false);return;}
      buf=""; step=2; q.write("whoami\r\n"); return;
    }
    if(step===2){
      const connected=/\bcid=\d+\b/.test(buf)&&/\bclid=\d+\b/.test(buf)&&!/error id=1794/.test(buf);
      finish(connected);
    }
  });
  q.on("error",()=>finish(false));
}

if(!tsCfg.enabled) log("TeamSpeak bridge disabled in admin configuration");
if(tsCfg.enabled) {
  connectWS();
  setTimeout(probeTS,2000);
  setInterval(probeTS,10000);
}
try{lastConfigMtime=fs.statSync(TS_CONFIG).mtimeMs;lastConfigSignature=bridgeConfigSignature();}catch{}
setInterval(()=>{
  try{
    const m=fs.statSync(TS_CONFIG).mtimeMs;
    const sig=bridgeConfigSignature();
    if(lastConfigSignature && sig && sig!==lastConfigSignature){
      log("TeamSpeak bridge settings changed; restarting bridge");
      process.exit(0);
    }
    lastConfigMtime=m;
    if(sig)lastConfigSignature=sig;
  }catch{}
},2000);

http.createServer((req,res)=>{
  if(req.url==="/health"){
    res.writeHead(200,{"content-type":"application/json; charset=utf-8"});
    res.end(JSON.stringify({
      ok:state.wsConnected&&state.authed&&state.roomJoined,
      service:"omnilink-teamspeak-bridge",
      callsign:CALLSIGN,roomId:ROOM_ID,tsChannelId:TS_CHANNEL_ID,
      ...state,
      omniPttActive,
      sourceStarted,
      sourceQueueSamples:sourceQueueLen,
      sourceUnderflows,
      sourceOverruns,
      sourcePacketsIn,
      sourceSamplesIn,
      sourceSamplesDropped,
      sourceFramesOut,
      sourceRatio,
      omniTxGateRemainingMs:Math.max(0,omniTxActiveUntil-Date.now()),
      uptimeSec:Math.floor((Date.now()-state.startedAt)/1000),
      timestamp:now()
    }));
    return;
  }
  res.writeHead(404); res.end();
}).listen(HEALTH_PORT,"127.0.0.1",()=>log("health",HEALTH_PORT));
process.on("SIGTERM",()=>{try{socket?.close?.();for(const p of peers.values())p.pc.close();ws?.close();}catch{}process.exit(0);});
