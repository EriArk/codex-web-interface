import {NativeLibraryReceipts} from './library-receipts.mjs';
import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { NativePipe } from './pipe.mjs';
import { NativeRendererReader } from './renderer.mjs';
import { listenNative, NativeReadService, privatePath } from './service.mjs';
import { NativeDispatchReceipts } from './dispatch-receipts.mjs';

process.umask(0o077);
const root = '/data/native-adapter';
privatePath(root, 'isDirectory');
privatePath(`${root}/binding.json`, 'isFile');
const binding = JSON.parse(readFileSync(`${root}/binding.json`, 'utf8'));
if (binding.build !== '26.915.31945') throw Error('NATIVE_UNSUPPORTED_BUILD');
if (Object.keys(binding).some(k => !['build', 'userId', 'accountFingerprint'].includes(k))) throw Error('NATIVE_INVALID_BINDING');
const service = new NativeReadService({ reader: null, ...binding, statePath: `${root}/manual.json` });
// Separate explicit allowlist, absent by default. Never enables a public send route.
try {
  privatePath(`${root}/canary.json`,'isFile');
  const canary=JSON.parse(readFileSync(`${root}/canary.json`,'utf8'));
  if(Object.keys(canary).some(k=>!['conversationIds','creationKeys','projectIds'].includes(k))||!Array.isArray(canary.conversationIds))throw Error('NATIVE_INVALID_CANARY');
  service.canary=new NativeDispatchReceipts({...binding,...canary,path:`${root}/dispatch.sqlite`});
  service.library=new NativeLibraryReceipts(service.canary,canary.projectIds??[]);
}catch(error){if(error.code!=='ENOENT')throw error;}
const log = openSync('/data/logs/app.log', 'a', 0o600);
const child = spawn('/usr/bin/chatgpt', ['--no-sandbox', '--disable-gpu', '--remote-debugging-pipe'], {
  stdio: ['ignore', log, log, 'pipe', 'pipe'],
});
closeSync(log);
const transport = new NativePipe(child.stdio[3], child.stdio[4]);
service.reader = new NativeRendererReader({ transport });
let server, stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  server?.close(); transport.close(); child.kill('SIGTERM');
  setTimeout(() => { child.kill('SIGKILL'); process.exit(code); }, 2000);
}
child.on('error', () => stop(1));
child.on('exit', () => stop(1));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => stop(0));
try {
  server = await listenNative(service, `${root}/adapter.sock`);
  if (stopping) server.close();
  else console.log('Native read adapter ready; writes disabled');
} catch { console.error('NATIVE_SUPERVISOR_UNAVAILABLE'); stop(1); }
