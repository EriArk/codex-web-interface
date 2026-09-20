import {NativeEnrollment} from './enrollment.mjs';
import {NativeOperationReceipts} from './operation-receipts.mjs';
import {NativeWorkspaceReceipts} from './workspace-receipts.mjs';
import {NativeProjectReceipts} from './project-receipts.mjs';
import {NativeLibraryReceipts} from './library-receipts.mjs';
import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, existsSync } from 'node:fs';
import { NativePipe } from './pipe.mjs';
import { NativeRendererReader } from './renderer.mjs';
import { listenNative, NativeReadService, privatePath } from './service.mjs';
import { NativeDispatchReceipts } from './dispatch-receipts.mjs';

process.umask(0o077);
const root = '/data/native-adapter';
privatePath(root, 'isDirectory');
function createService(binding,reader) {
if (binding.build !== '26.915.31945') throw Error('NATIVE_UNSUPPORTED_BUILD');
if (Object.keys(binding).some(k => !['build', 'userId', 'accountFingerprint'].includes(k))) throw Error('NATIVE_INVALID_BINDING');
const service = new NativeReadService({ reader, ...binding, statePath: `${root}/manual.json` });
// Host-provisioned admission; absent by default. Public APIs cannot change this binding.
try {
  privatePath(`${root}/canary.json`,'isFile');
  const canary=JSON.parse(readFileSync(`${root}/canary.json`,'utf8'));
  if(Object.keys(canary).some(k=>!['conversationIds','creationKeys','projectIds','projectCreationKeys','ownerMode'].includes(k))||!Array.isArray(canary.conversationIds))throw Error('NATIVE_INVALID_CANARY');
  service.canary=new NativeDispatchReceipts({...binding,...canary,path:`${root}/dispatch.sqlite`});
  service.operations=new NativeOperationReceipts(service.canary);
  service.workspace=new NativeWorkspaceReceipts(service.canary);
  service.library=new NativeLibraryReceipts(service.canary,canary.projectIds??[]);
  service.projects=new NativeProjectReceipts(service.canary,canary.projectIds??[],canary.projectCreationKeys??[]);
  for(const id of service.projects.allowed)service.library.projects.add(id);
}catch(error){if(error.code!=='ENOENT')throw error;}
return service;
}
const log = openSync('/data/logs/app.log', 'a', 0o600);
const child = spawn('/usr/bin/chatgpt', ['--disable-gpu', '--remote-debugging-pipe', ...(process.env.HTTPS_PROXY?['--proxy-server='+process.env.HTTPS_PROXY]:[])], {
  stdio: ['ignore', log, log, 'pipe', 'pipe'],
});
closeSync(log);
const transport = new NativePipe(child.stdio[3], child.stdio[4]);
const reader=new NativeRendererReader({transport});
const service=existsSync(`${root}/enrollment.json`)?new NativeEnrollment(root,reader,b=>createService(b,reader)):(privatePath(`${root}/binding.json`,'isFile'),createService(JSON.parse(readFileSync(`${root}/binding.json`,'utf8')),reader));
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
  else console.log(service.canary?.ownerMode ? 'Native owner adapter ready' : 'Native limited adapter ready');
} catch { console.error('NATIVE_SUPERVISOR_UNAVAILABLE'); stop(1); }
