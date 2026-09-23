// OpenCode is the supporting model route. The official free route rejects
// per-request `tools` overrides, so preserve its normal request identity and
// fail closed by rejecting any native permission request for this session.
export function buildOpenCodePrompt({ providerID, modelID, system, transcript }) {
  return {
    model: { providerID, modelID },
    ...(system ? { system } : {}),
    parts: [{ type: 'text', text: transcript }],
  };
}

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function rejectNativePermissions({ sessionID, list, reject, done, intervalMs=100 }) {
  while(!done()) {
    let requests=[];
    try { requests=await list(); } catch { /* prompt result owns route failure */ }
    for(const request of Array.isArray(requests)?requests:[]) {
      if(request?.sessionID!==sessionID||typeof request?.id!=='string')continue;
      try { await reject(request.id); } catch { /* retry while prompt remains active */ }
    }
    if(!done())await delay(intervalMs);
  }
}
