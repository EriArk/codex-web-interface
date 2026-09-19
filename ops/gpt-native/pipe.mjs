// Chromium's inherited debugging pipe stays inside the supervised process tree.
// No TCP listener; only the typed reader/service may call this local transport.
export class NativePipe {
  constructor(input, output) {
    this.input = input;
    this.output = output;
    this.pending = new Map();
    this.nextId = 0;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    input.on('error', () => this.close());
    output.on('error', () => this.close());
    output.on('end', () => this.close());
    output.on('data', chunk => {
      if (this.closed) return;
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > 4 * 1024 * 1024) return this.close();
      for (;;) {
        const end = this.buffer.indexOf(0);
        if (end < 0) break;
        const frame = this.buffer.subarray(0, end);
        this.buffer = this.buffer.subarray(end + 1);
        try {
          const message = JSON.parse(frame.toString('utf8'));
          if (message.id == null) continue;
          const pending = this.pending.get(message.id);
          if (!pending) continue; // A cancelled read may finish later. Never replay it.
          if (message.sessionId !== pending.sessionId) return this.close();
          pending.finish(message.error ? Error('NATIVE_PIPE_REJECTED') : null, message.result);
        } catch { this.close(); return; }
      }
    });
  }
  call(method, params, signal, sessionId) {
    if (this.closed) return Promise.reject(Error('NATIVE_PIPE_CLOSED'));
    if (this.pending.size >= 16) return Promise.reject(Error('NATIVE_BUSY'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const finish = (error, result) => {
        if (!this.pending.delete(id)) return;
        signal.removeEventListener('abort', abort);
        error ? reject(error) : resolve(result);
      };
      const abort = () => finish(Error('NATIVE_CANCELLED'));
      this.pending.set(id, { finish, sessionId });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) return abort();
      const frame = Buffer.from(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
      if (frame.length > 256 * 1024) return finish(Error('NATIVE_REQUEST_TOO_LARGE'));
      this.input.write(frame);
    });
  }
  async evaluateMain(expression, guard, signal) {
    const { targetInfos } = await this.call('Target.getTargets', {}, signal);
    if (!Array.isArray(targetInfos) || targetInfos.length > 32) throw Error('NATIVE_INVALID_TARGETS');
    const sessions = [];
    try {
      const matches = [];
      for (const target of targetInfos.filter(t => t.type === 'page' && t.url === 'app://-/index.html')) {
        const { sessionId } = await this.call('Target.attachToTarget', { targetId: target.targetId, flatten: true }, signal);
        if (typeof sessionId !== 'string') throw Error('NATIVE_INVALID_TARGETS');
        sessions.push(sessionId);
        const result = await this.call('Runtime.evaluate', { expression: guard, returnByValue: true }, signal, sessionId);
        if (result?.result?.value === true) matches.push(sessionId);
      }
      if (matches.length !== 1) throw Error('NATIVE_WINDOW_AMBIGUOUS');
      const result = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, signal, matches[0]);
      if (result?.exceptionDetails || !result?.result) throw Error('NATIVE_INVALID_RESPONSE');
      return result.result.value;
    } finally {
      for (const sessionId of sessions) {
        await this.call('Target.detachFromTarget', { sessionId }, AbortSignal.timeout(1000)).catch(() => {});
      }
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.finish(Error('NATIVE_PIPE_CLOSED'));
    this.input.destroy();
    this.output.destroy();
  }
}
