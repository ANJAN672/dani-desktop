import{createHash}from"node:crypto";
export interface TriggerRule{id:string;eventType:string;predicate?:Record<string,string|number|boolean>;dedupeWindowMs:number;enabled:boolean}
export interface ScheduleRule{id:string;timezone:string;nextRunAt:string;intervalMs?:number;enabled:boolean}
export interface ExecutionBudget{turns:number;toolCalls:number;costUsd:number;deadlineAt?:string}
export const stableTriggerKey=(ruleId:string,event:{sourceId:string;type:string;payload:unknown})=>createHash("sha256").update(JSON.stringify([ruleId,event.sourceId,event.type,event.payload])).digest("hex");
export function triggerMatches(rule:TriggerRule,event:{type:string;payload:unknown}){if(!rule.enabled||rule.eventType!==event.type)return false;if(!rule.predicate)return true;if(!event.payload||typeof event.payload!=="object")return false;return Object.entries(rule.predicate).every(([k,v])=>(event.payload as Record<string,unknown>)[k]===v)}
export function withinQuietHours(at:Date,quiet:{timezone:string;start:string;end:string}){const parts=new Intl.DateTimeFormat("en-GB",{timeZone:quiet.timezone,hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(at);const mins=Number(parts.find(x=>x.type==="hour")?.value)*60+Number(parts.find(x=>x.type==="minute")?.value);const parse=(s:string)=>{const[h,m]=s.split(":").map(Number);return h!*60+m!},start=parse(quiet.start),end=parse(quiet.end);return start<=end?mins>=start&&mins<end:mins>=start||mins<end}
export function budgetAllows(budget:ExecutionBudget,usage:{turns:number;toolCalls:number;costUsd:number},now=new Date()){if(budget.deadlineAt&&now>=new Date(budget.deadlineAt))return{ok:false as const,reason:"deadline"};if(usage.turns>=budget.turns)return{ok:false as const,reason:"turns"};if(usage.toolCalls>=budget.toolCalls)return{ok:false as const,reason:"tool_calls"};if(usage.costUsd>=budget.costUsd)return{ok:false as const,reason:"cost"};return{ok:true as const}}
export function retryDelay(attempt:number,baseMs=1000,maxMs=60_000){return Math.min(maxMs,baseMs*2**Math.max(0,attempt-1))}

/** Typed proactive initiative levels. `act` still requires broker authorization downstream; a high initiative score never bypasses grants or approvals. */
export type InitiativeLevel = "silent" | "inform" | "prepare" | "act";
export interface InitiativeInput {
  consent: boolean;
  novelty: number; confidence: number; urgency: number;
  risk?: "read" | "write" | "representation" | "money" | "destructive";
  notificationsInWindow: number; notificationBudget: number;
  relevantToCurrentTask: boolean;
  quietHoursActive: boolean; urgentOverride?: boolean;
  preparable?: boolean;
}
export interface InitiativeDecision { level: InitiativeLevel; reasons: string[]; deferred: boolean; requiresBrokerApproval: boolean }

export const NOVELTY_MIN = 0.2, CONFIDENCE_INFORM = 0.5, CONFIDENCE_ACT = 0.8, URGENCY_INFORM = 0.4, URGENCY_ACT = 0.8;

export function decideInitiative(input: InitiativeInput): InitiativeDecision {
  const reasons: string[] = [];
  const done = (level: InitiativeLevel, deferred = false): InitiativeDecision => ({ level, reasons, deferred, requiresBrokerApproval: level === "act" });
  if (!input.consent) { reasons.push("no-consent"); return done("silent"); }
  if (input.notificationsInWindow >= input.notificationBudget) { reasons.push("rate-budget"); return done("silent"); }
  if (input.novelty < NOVELTY_MIN) { reasons.push("low-novelty"); return done("silent"); }
  if (input.quietHoursActive && !input.urgentOverride) { reasons.push("quiet-hours"); return done("silent", true); }
  if (input.quietHoursActive && input.urgentOverride) reasons.push("urgent-override");
  if (!input.relevantToCurrentTask && input.urgency < URGENCY_ACT) { reasons.push("not-relevant"); return done("silent"); }
  const highRisk = input.risk === "representation" || input.risk === "money" || input.risk === "destructive";
  if (input.urgency >= URGENCY_ACT && input.confidence >= CONFIDENCE_ACT && input.relevantToCurrentTask) {
    if (highRisk) { reasons.push("high-risk-capped-at-inform"); return done("inform"); }
    reasons.push("urgent-and-confident"); return done("act");
  }
  if (input.preparable && input.confidence >= CONFIDENCE_INFORM && input.urgency >= URGENCY_INFORM) { reasons.push("preparable"); return done("prepare"); }
  if (input.urgency >= URGENCY_INFORM || input.confidence >= CONFIDENCE_INFORM) { reasons.push("worth-informing"); return done("inform"); }
  reasons.push("below-threshold");
  return done("silent");
}

export function validateQuietHours(quiet: { timezone: string; start: string; end: string }): { ok: true } | { ok: false; reason: string } {
  try { new Intl.DateTimeFormat("en-GB", { timeZone: quiet.timezone }); } catch { return { ok: false, reason: "invalid-timezone" }; }
  const time = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!time.test(quiet.start) || !time.test(quiet.end)) return { ok: false, reason: "invalid-time" };
  if (quiet.start === quiet.end) return { ok: false, reason: "empty-window" };
  return { ok: true };
}

const tzParts = (timezone: string, at: Date) => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const g = (t: string) => Number(parts.find(x => x.type === t)?.value);
  return { y: g("year"), mo: g("month"), d: g("day"), h: g("hour"), mi: g("minute"), s: g("second") };
};
/** Convert a wall-clock time in an IANA zone to a UTC instant, converging across DST transitions. */
export function localToUtc(timezone: string, y: number, mo: number, d: number, h: number, mi: number) {
  let guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  for (let i = 0; i < 3; i++) {
    const p = tzParts(timezone, new Date(guess));
    const diff = Date.UTC(y, mo - 1, d, h, mi, 0) - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}
/** Next instant at which quiet hours end, or `at` itself when already outside quiet hours. DST-safe. */
export function nextQuietEnd(at: Date, quiet: { timezone: string; start: string; end: string }): Date {
  if (!withinQuietHours(at, quiet)) return at;
  const p = tzParts(quiet.timezone, at);
  const [eh, em] = quiet.end.split(":").map(Number);
  const today = localToUtc(quiet.timezone, p.y, p.mo, p.d, eh!, em!);
  if (today > at) return today;
  return localToUtc(quiet.timezone, p.y, p.mo, p.d + 1, eh!, em!);
}
