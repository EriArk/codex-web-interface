import { createServer } from 'node:http';
import { chmodSync, closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {NativeStoredUploads,transferStoredUpload} from './stored-uploads.mjs';

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
    this.uploads=new NativeStoredUploads(dirname(statePath)+'/uploads');
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
      createProject: ['key','name'],
      executeOperation:['key','conversationId','messageId','currentNode','action','text','targetMessageId','model','effort'], checkOperation:['key','conversationId','messageId','currentNode','action','text','targetMessageId','model','effort','review'],
      executeWorkspace:['key','input'], checkWorkspace:['key','input','review'],
      transcribe: ['audio','mime','sha256'],
      abandonProjectCreation: ['key','acceptPossibleOrphan'],
      projectMutation: ['key','projectId','revision','action','text','fileId','confirm','file'],
      stageProjectUpload: ['key','projectId','file','offset','base64'],
      reconcileProject: ['key','projectId'],
      libraryMutation: ['key','kind','id','action','name','value','confirm'],
      reconcileLibrary: ['key','kind','id','action','name','value','confirm'],
      uploadFile: ['key','conversationId','file'],
      stageUpload: ['key','conversationId','file','offset','base64'],
      uploadStoredFile: ['key','conversationId','file'],
      prepareDispatch: ['key','conversationId','userMessageId','text','versionId','presetId','projectId'],
      dispatchText: ['key','conversationId','userMessageId','text','versionId','presetId','parentId','model','effort','intentPersisted','attachments','projectId'],
      reconcileDispatch: ['key','conversationId'],
      readLive: ['key','conversationId'],
      reviewDispatch: ['key','conversationId'],
      stopDispatch: ['key','conversationId'],
    } : {};
    const fields = {
      ...canaryFields,
      openMedia:['transferId','conversationId','messageId','fileId','projectId'], readMedia:['transferId','offset'], closeMedia:['transferId'],
      workspace:['action','id','conversationId','version','cursor'],
      status: [], beginManual: ['leaseId'], endManual: ['leaseId'], resumeManual: [],
      inspectProject: ['projectId'], readModels: [], readPins: [], readConversationGraph:['conversationId'], readProjects:['cursor'], readProject:['projectId'], readProjectConversations:['projectId','cursor'], readCatalog:['offset','archived'], readConversation: ['conversationId', 'before'],
      listArtifacts: ['conversationId', 'before'], readArtifact: ['conversationId', 'messageId', 'artifactId'],
    }[input.operation];
    if (!Array.isArray(fields) || Object.keys(input).some(k => !['userId', 'operation', ...fields].includes(k))) fail('INVALID_REQUEST');
    if (input.operation === 'status') return { instanceId: this.instanceId, manual: this.leases.size > 0, busy: this.busy, writesEnabled: this.canary?.ownerMode===true };
    // A read of already received text must not queue behind a writer/history read.
    if(input.operation==='readLive'){
      if(this.leases.size)fail('MANUAL_RECOVERY');
      if(this.livePending)return {items:[]};
      this.livePending=true;
      try{return await this.canary.live(input,this.reader);}finally{this.livePending=false;}
    }
    if (this.busy) fail('BUSY');
    if (['beginManual', 'endManual', 'resumeManual'].includes(input.operation)) {
      if (input.operation !== 'resumeManual' && !uuid(input.leaseId)) fail('INVALID_REQUEST');
      const previous = new Set(this.leases);
      if (input.operation === 'beginManual') {
        // Recovery must remain reachable when a receipt cannot be reconciled.
        // The service writer lock above excludes an in-flight adapter operation;
        // the lease blocks new ones without clearing receipts or stopping responses.
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
        if(['executeOperation','checkOperation'].includes(operation))return await this.operations.run(bound,this.reader,operation==='checkOperation');
        if(['executeWorkspace','checkWorkspace'].includes(operation))return await this.workspace.run(bound,this.reader,operation==='checkWorkspace');
        if(operation==='transcribe')return await this.reader.transcribe(bound);
        if(operation==='abandonProjectCreation')return await this.projects.abandon(bound,this.reader);
        if(operation==='createProject'){const v=await this.projects.create(bound,this.reader);if(v.projectId)this.library.projects.add(v.projectId);return v;}
        if(operation==='stageProjectUpload'){this.projects.admit(bound);if(this.canary.pending())fail('PENDING_DISPATCH');return await this.uploads.append(bound);}
        if(operation==='projectMutation'){const v=await this.projects.execute(bound,this.reader,this.uploads,transferStoredUpload);if(v.state!=='unknown'&&bound.action==='upload')await this.uploads.clear(bound);return v;}
        if(operation==='reconcileProject')return await this.projects.check(bound,this.reader);
        if(['libraryMutation','reconcileLibrary'].includes(operation)){if(!this.library)fail('INVALID_CANARY');return await this.library.run(bound,this.reader,operation==='reconcileLibrary');}
        if(operation==='stageUpload'){this.canary.admitUpload(bound);if(this.canary.blocksDispatch(bound.conversationId))fail('PENDING_DISPATCH');return await this.uploads.append(bound);}
        if(operation==='uploadStoredFile'){
          this.canary.admitUpload(bound);
          const reader={uploadStoredFile:(r,path)=>transferStoredUpload(this.reader,r,path)};
          const value=await this.canary.upload(bound,reader,this.uploads);await this.uploads.clear(bound);return value;
        }
        if(operation==='uploadFile')return await this.canary.upload(bound,this.reader);
        if(operation==='prepareDispatch')return await this.canary.prepare(bound,this.reader);
        if(operation==='dispatchText')return await this.canary.dispatch(bound,this.reader);
        if(operation==='reviewDispatch')return await this.canary.review(bound,this.reader);
        if(operation==='stopDispatch')return await this.canary.stop(bound,this.reader);
        return await this.canary.reconcile(bound,this.reader);
      }
      if(operation==='workspace')return await this.reader.workspace({...bound,operation:args.action});
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
      for await (const chunk of req) { bytes += chunk.length; if (bytes > (service.canary ? 35000000 : 4096)) fail('REQUEST_TOO_LARGE'); chunks.push(chunk); }
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
  server.timeout = 1000000;
  server.maxConnections = 16;
  server.on('timeout', socket => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  chmodSync(socketPath, 0o600);
  return server;
}
