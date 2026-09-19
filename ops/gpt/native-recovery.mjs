/** A separately provisioned owner's lab, never an implicit member fallback. */
export function nativeRecoveryBinding(binding, runtime, config) {
 if (runtime === null || runtime === '') return binding;
 if (runtime !== 'native' || !binding?.legacy || !binding.userId ||
     binding.userId !== config.userId || !/^[a-f0-9-]{36}$/.test(config.userId ?? '') ||
     !/^[A-Za-z0-9_-]{8}$/.test(config.password ?? '')) return null;
 return { ...binding, native: true, host: 'codex-web-gpt-native-lab', password: config.password };
}
