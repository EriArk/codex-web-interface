import { createServer } from 'node:http';
import { chmodSync, closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const fail = code => { throw Error(`NATIVE_${code}`); };
export function privatePath(path, type) {
  const stat = lstatSync(path);
  if (stat.uid !== process.getuid() || (stat.mode & 0o077) || !stat[type]()) fail('UNSAFE_PRIVATE_PATH');
}
export class NativeReadService {
  constructor({ reader, userId, accountFingerprint, statePath, canary }) {
    if (!uuid(userId) || !/^[a-f0-9]{64}$/.test(accountFingerprint)) fail('INVALID_BINDING');
    this.reader = reader;
    this.canary = canary;
    this.userId = userId;
    this.accountFingerprint = accountFingerprint;
    this.statePath = statePath;
    this.busy = false;
    this.instanceId = randomUUID();
    this.leases = new Set();
    privatePath(dirname(statePath), 'isDirectory');
    try {
      privatePath(statePath, 'isFile');
      const value = JSON.parse(readFileSync(statePath, 'utf8'));
      if (value.userId !== userId || !Array.isArray(value.leases) || value.leases.length > 8 || !value.leases.every(uuid)) fail('INVALID_RECOVERY_STATE');
      this.leases = new Set(value.leases);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  persist() {
    const temp = `${this.statePath}.${randomUUID()}.tmp`;
    const fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ userId: this.userId, leases: [...this.leases] })); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temp, this.statePath);
    const directory = openSync(dirname(this.statePath), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  async request(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || input.userId !== this.userId) fail('WRONG_OWNER');
    const canaryFields = this.canary ? {
      uploadFile: ['key','conversationId','file'],
      prepareDispatch: ['key','conversationId','userMessageId','text','versionId','presetId'],
      dispatchText: ['key','conversationId','userMessageId','text','versionId','presetId','parentId','model','effort','intentPersisted','attachments'],
      reconcileDispatch: ['key','conversationId'],
    } : {};
    const fields = {
      ...canaryFields,
      status: [], beginManual: ['leaseId'], endManual: ['leaseId'], resumeManual: [],
      readModels: [], readCatalog:['offset'], readConversation: ['conversationId', 'before'],
      listArtifacts: ['conversationId', 'before'], readArtifact: ['conversationId', 'messageId', 'artifactId'],
    }[input.operation];
    if (!Array.isArray(fields) || Object.keys(input).some(k => !['userId', 'operation', ...fields].includes(k))) fail('INVALID_REQUEST');
    if (input.operation === 'status') return { instanceId: this.instanceId, manual: this.leases.size > 0, busy: this.busy, writesEnabled: false };
    if (this.busy) fail('BUSY');
    if (['beginManual', 'endManual', 'resumeManual'].includes(input.operation)) {
      if (input.operation !== 'resumeManual' && !uuid(input.leaseId)) fail('INVALID_REQUEST');
      const previous = new Set(this.leases);
      if (input.operation === 'beginManual') {
        if(this.canary?.pending())fail('PENDING_DISPATCH');
        if (this.leases.size >= 8 && !this.leases.has(input.leaseId)) fail('BUSY');
        this.leases.add(input.leaseId);
      } else if (input.operation === 'endManual') this.leases.delete(input.leaseId);
      else this.leases.clear(); // Trusted recovery gateway first closes all its native tunnels.
      try { this.persist(); } catch { this.leases = previous; fail('RECOVERY_STATE_UNAVAILABLE'); }
      return { manual: this.leases.size > 0, writesEnabled: false };
    }
    if (this.leases.size) fail('MANUAL_RECOVERY');
    this.busy = true;
    try {
      const { operation, userId: ignored, ...args } = input;
      const bound={...args,accountFingerprint:this.accountFingerprint};
      if(Object.hasOwn(canaryFields,operation)){
        if(operation==='uploadFile')return await this.canary.upload(bound,this.reader);
        if(operation==='prepareDispatch')return await this.canary.prepare(bound,this.reader);
        if(operation==='dispatchText')return await this.canary.dispatch(bound,this.reader);
        return await this.canary.reconcile(bound,this.reader);
      }
      return await this.reader[operation]({ ...args, accountFingerprint: this.accountFingerprint });
    } finally { this.busy = false; }
  }
}

export async function listenNative(service, socketPath) {
  privatePath(dirname(socketPath), 'isDirectory');
  // A supervisor holds the container-wide flock. Only its previous socket is removable.
  try { privatePath(socketPath, 'isSocket'); unlinkSync(socketPath); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (req.method !== 'POST' || req.url !== '/v1' || req.headers['content-type'] !== 'application/json') fail('INVALID_REQUEST');
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > (service.canary ? 1500000 : 4096)) fail('REQUEST_TOO_LARGE'); chunks.push(chunk); }
      const result = await service.request(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const body = JSON.stringify({ ok: true, result });
      if (Buffer.byteLength(body) > 2 * 1024 * 1024) fail('RESPONSE_TOO_LARGE');
      res.end(body);
    } catch (error) {
      res.statusCode = 503;
      res.end(JSON.stringify({ ok: false, code: /^NATIVE_[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'NATIVE_UNAVAILABLE' }));
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.timeout = 25000;
  server.maxConnections = 16;
  server.on('timeout', socket => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  chmodSync(socketPath, 0o600);
  return server;
}
