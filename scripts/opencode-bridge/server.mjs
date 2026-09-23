#!/usr/bin/env node
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { isIP } from 'node:net';
import { buildOpenCodePrompt, rejectNativePermissions } from './request-shaping.mjs';

const HOST=process.env.OPENCODE_BRIDGE_HOST||'127.0.0.1';
const PORT=Number(process.env.OPENCODE_BRIDGE_PORT||4110);
const UPSTREAM_TIMEOUT_MS=Number(process.env.OPENCODE_BRIDGE_TIMEOUT_MS||120000);
const READY_TIMEOUT_MS=Math.min(10000,UPSTREAM_TIMEOUT_MS);
const MAX_BODY=1024*1024, MAX_MESSAGES=200, MAX_TEXT=256000;
const MODEL=process.env.OPENCODE_FREE_MODEL||'opencode/big-pickle';
const [providerID,modelID]=MODEL.split(/\/(.+)/);
const upstream=new URL(process.env.OPENCODE_SERVER_URL||'http://127.0.0.1:4100');
const loopback=h=>h==='localhost'||h==='127.0.0.1'||h==='::1'||(isIP(h)===4&&h.startsWith('127.'));
if(!loopback(HOST)||!loopback(upstream.hostname)||upstream.protocol!=='http:') throw Error('bridge and OpenCode upstream must be loopback HTTP');
if(!Number.isInteger(PORT)||PORT<1||PORT>65535||!providerID||!modelID) throw Error('invalid bridge configuration');
let child=null, childExited=false, childExit=null;
if(!process.env.OPENCODE_SERVER_URL){
 child=spawn(process.env.OPENCODE_BIN||'opencode',['serve','--pure','--hostname','127.0.0.1','--port',upstream.port||'4100'],{stdio:['ignore','ignore','inherit']});
 child.once('exit',(code,signal)=>{childExited=true;childExit={code,signal};});
 child.once('error',()=>{childExited=true;childExit={code:null,signal:null};});
}
const safeError=(message,status=502,kind='upstream_error')=>Object.assign(Error(message),{status,kind});
const fetchUp=(path,options={},timeout=UPSTREAM_TIMEOUT_MS)=>fetch(new URL(path,upstream),{...options,signal:AbortSignal.timeout(timeout)});
const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
async function readBody(req){let s='';for await(const c of req){s+=c;if(Buffer.byteLength(s)>MAX_BODY)throw safeError('request too large',413,'invalid_request')}try{return JSON.parse(s||'{}')}catch{throw safeError('invalid JSON',400,'invalid_request')}}
function textOf(m){const c=m?.content;if(typeof c==='string')return c;if(Array.isArray(c))return c.filter(x=>x?.type==='text'&&typeof x.text==='string').map(x=>x.text).join('\n');return ''}
function validate(input){if(!input||typeof input!=='object'||input.model!==MODEL||!Array.isArray(input.messages)||input.messages.length>MAX_MESSAGES)throw safeError('invalid request or model',400,'invalid_request');let n=0;for(const m of input.messages){if(!['system','user','assistant','tool'].includes(m?.role))throw safeError('invalid message role',400,'invalid_request');n+=textOf(m).length;}if(n>MAX_TEXT)throw safeError('message content too large',413,'invalid_request');}
async function readiness(){
 if(childExited)return {ok:false,reason:'opencode_child_exited',childExit};
 try{const health=await fetchUp('/global/health',{},READY_TIMEOUT_MS);if(!health.ok)return {ok:false,reason:'opencode_unhealthy',status:health.status};
  const p=await fetchUp('/provider',{},READY_TIMEOUT_MS);if(!p.ok)return {ok:false,reason:'provider_inventory_unavailable',status:p.status};const inventory=await p.json();const provider=(inventory.all||[]).find(x=>x.id===providerID);const model=provider?.models?.[modelID];
  const cost=model?.cost;const zero=cost&&cost.input===0&&cost.output===0&&cost.cache?.read===0&&cost.cache?.write===0;
  if(!model||model.status!=='active'||!zero)return {ok:false,reason:'exact_free_model_not_ready'};
  return {ok:true,model:MODEL,cost,paidFallback:false};
 }catch(e){return {ok:false,reason:e?.name==='TimeoutError'?'upstream_timeout':'upstream_unavailable'};}
}
async function completion(input){
 validate(input);const ready=await readiness();if(!ready.ok)throw safeError(`model route unavailable: ${ready.reason}`,503,'model_not_ready');
 let create;try{create=await fetchUp('/session',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})}catch(e){throw safeError(e?.name==='TimeoutError'?'OpenCode session timeout':'OpenCode session unavailable',502)}
 if(!create.ok)throw safeError(`OpenCode session failed (${create.status})`,502);const session=await create.json();if(typeof session.id!=='string')throw safeError('OpenCode session response invalid',502);
 const system=input.messages.filter(m=>m.role==='system').map(textOf).join('\n\n');const transcript=input.messages.filter(m=>m.role!=='system').map(m=>`${m.role.toUpperCase()}: ${textOf(m)}`).join('\n\n');
 let r,settled=false;
 const permissionGuard=rejectNativePermissions({sessionID:session.id,done:()=>settled,
  list:async()=>{const x=await fetchUp('/permission',{},1000);return x.ok?x.json():[]},
  reject:async id=>{await fetchUp(`/permission/${encodeURIComponent(id)}/reply`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({reply:'reject',message:'Hermes is the sole tool and permission harness for this managed route.'})},1000)}});
 try{r=await fetchUp(`/session/${encodeURIComponent(session.id)}/message`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(buildOpenCodePrompt({providerID,modelID,system,transcript}))})}catch(e){throw safeError(e?.name==='TimeoutError'?'OpenCode prompt timeout':'OpenCode prompt unavailable',502)}finally{settled=true;await permissionGuard}
 if(!r.ok)throw safeError(`OpenCode prompt failed (${r.status})`,502);const out=await r.json();
 if(out.info?.error)throw safeError('OpenCode free route rejected the request',502,'provider_error');
 if(out.info?.providerID!==providerID||out.info?.modelID!==modelID||out.info?.cost!==0||out.info?.finish!=='stop')throw safeError('free-route invariant failed',502,'route_invariant');
 return {text:(out.parts||[]).filter(p=>p.type==='text'&&typeof p.text==='string').map(p=>p.text).join(''),info:out.info};
}
const server=http.createServer(async(req,res)=>{try{
 if(req.method==='GET'&&req.url==='/health')return json(res,childExited?503:200,{ok:!childExited,service:'opencode-free-bridge',child:child?'managed':'external'});
 if(req.method==='GET'&&req.url==='/ready'){const r=await readiness();return json(res,r.ok?200:503,r)}
 if(req.method==='GET'&&req.url==='/v1/models'){const r=await readiness();if(!r.ok)return json(res,503,{error:{type:'model_not_ready',message:'exact model route unavailable'}});return json(res,200,{object:'list',data:[{id:MODEL,object:'model',owned_by:'opencode',pricing:{input:0,output:0}}]})}
 if(req.method==='POST'&&req.url==='/v1/chat/completions'){const input=await readBody(req),out=await completion(input),id='chatcmpl-'+crypto.randomUUID(),created=Math.floor(Date.now()/1000),usage={prompt_tokens:out.info.tokens?.input||0,completion_tokens:out.info.tokens?.output||0,total_tokens:out.info.tokens?.total||0};
  if(input.stream){res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'});res.write(`data: ${JSON.stringify({id,object:'chat.completion.chunk',created,model:MODEL,choices:[{index:0,delta:{role:'assistant',content:out.text},finish_reason:null}]})}\n\n`);res.write(`data: ${JSON.stringify({id,object:'chat.completion.chunk',created,model:MODEL,choices:[{index:0,delta:{},finish_reason:'stop'}],usage})}\n\n`);return res.end('data: [DONE]\n\n')}
  return json(res,200,{id,object:'chat.completion',created,model:MODEL,choices:[{index:0,message:{role:'assistant',content:out.text},finish_reason:'stop'}],usage,x_opencode:{providerID:out.info.providerID,modelID:out.info.modelID,cost:out.info.cost,sessionID:out.info.sessionID}})}
 return json(res,404,{error:{type:'not_found',message:'not found'}});
}catch(e){return json(res,e.status||502,{error:{type:e.kind||'bridge_error',message:e.message||'bridge failure'}})}});
server.requestTimeout=UPSTREAM_TIMEOUT_MS+5000;server.headersTimeout=10000;
server.listen(PORT,HOST,()=>console.error(`OpenCode free-model bridge ready on loopback port ${PORT}; exact route ${MODEL}; no fallback`));
function stop(){const timer=setTimeout(()=>process.exit(1),5000).unref();server.close(()=>{clearTimeout(timer);process.exit(0)});if(child&&!child.killed)child.kill('SIGTERM');}
for(const s of ['SIGINT','SIGTERM'])process.once(s,stop);
