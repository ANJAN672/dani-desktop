import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProviderAdapter, ProviderInstance, RuntimeEvent, SendTurnInput } from "./contracts.ts";
import type { DaniRuntimeSession } from "../shared/dani-runtime.ts";

export class DaniSessionStore {
  private readonly db: DatabaseSync;
  constructor(path:string){mkdirSync(dirname(path),{recursive:true});this.db=new DatabaseSync(path);this.db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS dani_sessions(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,bot_id TEXT NOT NULL,provider TEXT NOT NULL,thread_id TEXT NOT NULL UNIQUE,native_cursor TEXT,state TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS dani_sessions_state ON dani_sessions(state,updated_at);`)}
  close(){this.db.close()}
  get(threadId:string):DaniRuntimeSession|null{const r=this.db.prepare("SELECT * FROM dani_sessions WHERE thread_id=?").get(threadId) as any;if(!r)return null;return{id:r.id,ownerId:r.owner_id,botId:r.bot_id,provider:"hermes",threadId:r.thread_id,nativeCursor:r.native_cursor?JSON.parse(r.native_cursor):null,state:r.state,updatedAt:r.updated_at}}
  listActive(){return(this.db.prepare("SELECT thread_id FROM dani_sessions WHERE state='running' ORDER BY updated_at").all() as {thread_id:string}[]).map(r=>this.get(r.thread_id)!)}
  recoverInterrupted(){const at=new Date().toISOString();this.db.prepare("UPDATE dani_sessions SET state='interrupted',updated_at=? WHERE state='running'").run(at);return this.db.prepare("SELECT changes() count").get() as {count:number}}
  save(s:DaniRuntimeSession){this.db.prepare(`INSERT INTO dani_sessions VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(thread_id) DO UPDATE SET native_cursor=excluded.native_cursor,state=excluded.state,updated_at=excluded.updated_at`).run(s.id,s.ownerId,s.botId,s.provider,s.threadId,JSON.stringify(s.nativeCursor),s.state,s.updatedAt);return s}
}

/** Dani-owned session lifecycle over the canonical Hermes ACP adapter. */
export class HermesRuntime {
  private readonly pending = new Map<string,{resolve:(e:RuntimeEvent)=>void;reject:(e:Error)=>void}>();
  private readonly unsubscribe:()=>void;
  constructor(private readonly instance:ProviderInstance,private readonly sessions:DaniSessionStore){if(instance.driverKind!=="hermesAgent")throw new Error(`Dani default runtime requires hermesAgent, received ${instance.driverKind}`);this.sessions.recoverInterrupted();this.unsubscribe=instance.adapter.onEvent(e=>this.onEvent(e));}
  private onEvent(event:RuntimeEvent){const existing=this.sessions.get(event.threadId);if(existing){if(event.type==="session.started")this.sessions.save({...existing,nativeCursor:event.sessionId,state:"running",updatedAt:event.createdAt});if(event.type==="turn.completed"||event.type==="session.exited")this.sessions.save({...existing,state:event.type==="turn.completed"&&event.ok?"idle":"failed",updatedAt:event.createdAt});}if(event.type==="turn.completed"){const p=this.pending.get(event.threadId);if(p){this.pending.delete(event.threadId);p.resolve(event)}}if(event.type==="runtime.error"){const p=this.pending.get(event.threadId);if(p){this.pending.delete(event.threadId);p.reject(new Error(event.message))}}}
  async run(input:Omit<SendTurnInput,"resumeCursor"> & {ownerId:string;botId:string;signal?:AbortSignal}){let session=this.sessions.get(input.threadId);if(!session)session=this.sessions.save({id:randomUUID(),ownerId:input.ownerId,botId:input.botId,provider:"hermes",threadId:input.threadId,nativeCursor:null,state:"idle",updatedAt:new Date().toISOString()});if(this.pending.has(input.threadId))throw new Error("thread already has a running Hermes turn");const completion=new Promise<RuntimeEvent>((resolve,reject)=>this.pending.set(input.threadId,{resolve,reject}));const {ownerId:_,botId:__,signal,...turn}=input;void _;void __;this.sessions.save({...session,state:"running",updatedAt:new Date().toISOString()});if(signal?.aborted){this.sessions.save({...session,state:"interrupted",updatedAt:new Date().toISOString()});throw signal.reason??new Error("turn cancelled")}const abort=()=>{void this.interrupt(input.threadId);const p=this.pending.get(input.threadId);if(p)p.reject(signal?.reason instanceof Error?signal.reason:new Error("turn cancelled"))};signal?.addEventListener("abort",abort,{once:true});try{const started=await this.instance.adapter.sendTurn({...turn,resumeCursor:session.nativeCursor});const terminal=await completion;return{turnId:started.turnId,terminal,session:this.sessions.get(input.threadId)!};}finally{signal?.removeEventListener("abort",abort);this.pending.delete(input.threadId)}}
  async interrupt(threadId:string){await this.instance.adapter.interruptTurn(threadId);const s=this.sessions.get(threadId);if(s)this.sessions.save({...s,state:"interrupted",updatedAt:new Date().toISOString()})}
  dispose(){this.unsubscribe()}
}
export const isHermesAdapter=(adapter:ProviderAdapter)=>adapter.provider==="hermesAgent";
