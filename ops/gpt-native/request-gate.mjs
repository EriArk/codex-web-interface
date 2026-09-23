/** Account-local upstream cooldown, shared by history and background library work.
 * Self-contained because the pinned renderer receives this function by value.
 * Never retries a request and never changes an uncertain mutation receipt. */
export function nativeRequestGate(fingerprint, runtime = globalThis) {
 const states=runtime[Symbol.for('codex-web.native-request-gate')]??=new Map();
 if(!states.has(fingerprint)){
  while(states.size>=4)states.delete(states.keys().next().value);
  states.set(fingerprint,{until:0,failures:0});
 }
 const state=states.get(fingerprint),now=()=>runtime.Date?.now?.()??Date.now();
 return {
  check(){if(now()<state.until)throw Error('NATIVE_RATE_LIMITED');},
  success(){if(now()>=state.until)state.failures=0;},
  limited(retryAfter){
   const at=now(),raw=String(retryAfter??'').trim();
   const requested=/^\d+(?:\.\d+)?$/.test(raw)?Number(raw)*1000:Date.parse(raw)-at;
   state.failures=Math.min(5,state.failures+1);
   state.until=Math.max(state.until,at+Math.max(Math.min(300000,60000*2**(state.failures-1)),Number.isFinite(requested)?Math.max(0,Math.min(86400000,requested)):0));
   throw Error('NATIVE_RATE_LIMITED');
  },
 };
}
