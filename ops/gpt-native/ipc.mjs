import {createConnection} from 'node:net';
import {randomUUID} from 'node:crypto';
import {lstat, readdir} from 'node:fs/promises';
import {join} from 'node:path';

export const testedBuild = '26.915.31945';
const maxFrame = 8 * 1024 * 1024;

/** Private length-prefixed JSON RPC. No HTTP endpoint or mutation/retry API. */
export function requestFrame(path, message, {timeoutMs = 10000} = {}) {
 return new Promise((resolve, reject) => {
  const payload = Buffer.from(JSON.stringify(message));
  if (payload.length > maxFrame) { reject(Error('NATIVE_REQUEST_TOO_LARGE')); return; }
  const frame = Buffer.alloc(payload.length + 4);
  frame.writeUInt32LE(payload.length); payload.copy(frame, 4);
  const socket = createConnection(path);
  let pending = Buffer.alloc(0), settled = false;
  const finish = (error, result) => {
   if (settled) return;
   settled = true; clearTimeout(timer); socket.destroy();
   error ? reject(error) : resolve(result);
  };
  const timer = setTimeout(() => finish(Error('NATIVE_TIMEOUT')), timeoutMs);
  socket.on('connect', () => socket.write(frame));
  socket.on('error', () => finish(Error('NATIVE_TRANSPORT_UNAVAILABLE')));
  socket.on('close', () => finish(Error('NATIVE_DISCONNECTED')));
  socket.on('data', chunk => {
   if (pending.length + chunk.length > maxFrame + 4) return finish(Error('NATIVE_FRAME_TOO_LARGE'));
   pending = Buffer.concat([pending, chunk]);
   if (pending.length < 4) return;
   const size = pending.readUInt32LE();
   if (size > maxFrame || size === 0) return finish(Error('NATIVE_INVALID_FRAME'));
   if (pending.length < size + 4) return;
   try {
    const value = JSON.parse(pending.subarray(4, size + 4).toString());
    if (value.jsonrpc !== '2.0' || value.id !== message.id) throw Error();
    if (value.error) return finish(Error('NATIVE_REQUEST_REJECTED'));
    if (!Object.hasOwn(value, 'result')) throw Error();
    finish(null, value.result);
   } catch { finish(Error('NATIVE_INVALID_RESPONSE')); }
  });
 });
}

export async function discoverSocket(directory = '/tmp/codex-browser-use') {
 const stat = await lstat(directory);
 if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077))
  throw Error('NATIVE_SOCKET_DIRECTORY_UNSAFE');
 // This exact build also creates a browser-control socket (0700) after login.
 // Its app-tools server explicitly chmods its socket to 0600. Never route a
 // tool request to the browser protocol or guess among multiple app sockets.
 const paths=[];
 for(const name of await readdir(directory)){
  if(!/^[a-f0-9-]{36}\.sock$/.test(name))continue;
  const path=join(directory,name),socket=await lstat(path);
  if(!socket.isSocket()||socket.uid!==stat.uid)throw Error('NATIVE_SOCKET_UNSAFE');
  if((socket.mode&0o777)===0o600)paths.push(path);
 }
 if(paths.length!==1)throw Error('NATIVE_SOCKET_AMBIGUOUS');
 return paths[0];
}

export class NativeReadProbe {
 constructor({path, build, callerThreadId}) {
  if (build !== testedBuild) throw Error('NATIVE_UNSUPPORTED_BUILD');
  this.path = path; this.callerThreadId = callerThreadId;
 }
 async capabilities() {
  const result = await requestFrame(this.path, {jsonrpc:'2.0', id:randomUUID(), method:'tools/list', params:{threadStartKind:'all'}});
  if (!Array.isArray(result?.tools)) throw Error('NATIVE_INCOMPATIBLE');
  const names = result.tools.filter(t => t.namespace === 'codex_app' && t.inputSchema?.type === 'object').map(t => t.name);
  return {build:testedBuild, tools:names, canProbeRead:['list_threads','read_thread'].every(n => names.includes(n)), writesEnabled:false, authenticated:'unverified'};
 }
 async read(tool, args) {
  if (!['list_threads','list_projects','read_thread'].includes(tool)) throw Error('NATIVE_READ_ONLY');
  if (!/^[a-f0-9-]{36}$/.test(this.callerThreadId ?? '')) throw Error('NATIVE_CALLER_REQUIRED');
  const result = await requestFrame(this.path, {jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{namespace:'codex_app',tool,arguments:args,threadId:this.callerThreadId,callId:randomUUID(),turnId:'codex-web-read-probe'}});
  if (result?.success !== true) throw Error('NATIVE_READ_UNAVAILABLE');
  const text = result.contentItems?.find(i => i.type === 'inputText')?.text;
  try { return JSON.parse(text); } catch { throw Error('NATIVE_INCOMPATIBLE'); }
 }
}
