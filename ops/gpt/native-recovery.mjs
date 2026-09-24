/** A separately provisioned owner's lab, never an implicit member fallback. */
export async function beginNativeRecovery(adapter, leaseId, cancelled = () => false, wait = ms => new Promise(resolve => setTimeout(resolve, ms))) {
 for(let attempt=0;attempt<50;attempt++){
  if(cancelled())throw Error('NATIVE_CANCELLED');
  try{return await adapter.manual('beginManual',leaseId);}
  catch(error){if(error?.message!=='NATIVE_BUSY'||attempt===49)throw error;}
  // Busy is a confirmed rejection before the exact idempotent lease is stored.
  // A slow history read must not make the recovery screen randomly unavailable.
  await wait(400);
 }
}
export function nativeRecoveryBinding(binding, runtime, config) {
 if (binding?.native && !binding.legacy) return runtime === null || runtime === '' || runtime === 'native' ? binding : null;
 if (runtime === null || runtime === '') return binding;
 if (runtime !== 'native' || !binding?.legacy || !binding.userId ||
     binding.userId !== config.userId || !/^[a-f0-9-]{36}$/.test(config.userId ?? '') ||
     !/^[A-Za-z0-9_-]{8}$/.test(config.password ?? '')) return null;
 return { ...binding, native: true, host: 'codex-web-gpt-native-lab', password: config.password };
}
