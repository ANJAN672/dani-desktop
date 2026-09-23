import { describe, expect, it, vi } from "vitest";
import { buildOpenCodePrompt, rejectNativePermissions } from "../scripts/opencode-bridge/request-shaping.mjs";
describe("managed OpenCode request shaping",()=>{
 it("preserves the official request identity without per-request tool overrides",()=>{
  const r=buildOpenCodePrompt({providerID:"opencode",modelID:"big-pickle",system:"system",transcript:"USER: hello"});
  expect(r).toEqual({model:{providerID:"opencode",modelID:"big-pickle"},system:"system",parts:[{type:"text",text:"USER: hello"}]});
  expect(r).not.toHaveProperty("tools");
 });
 it("rejects only the active bridge session's native permissions",async()=>{
  let finished=false;const reject=vi.fn(async()=>{});let reads=0;
  await rejectNativePermissions({sessionID:"ses_target",intervalMs:0,done:()=>finished,list:async()=>{reads++;finished=true;return [{id:"per_target",sessionID:"ses_target"},{id:"per_other",sessionID:"ses_other"}]},reject});
  expect(reads).toBe(1);expect(reject).toHaveBeenCalledOnce();expect(reject).toHaveBeenCalledWith("per_target");
 });
});
