import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {discoverSocket,NativeReadProbe} from './ipc.mjs';

// Execute inside the isolated container. Never returns private chat text or auth.
try {
 const build = execFileSync('dpkg-query',['-W','-f=${Version}','chatgpt'],{encoding:'utf8'}).trim();
 let callerThreadId;
 try { callerThreadId = JSON.parse(await readFile('/data/carrier.json','utf8')).threadId; } catch {}
 const probe = new NativeReadProbe({build, path:await discoverSocket(), callerThreadId});
 const capabilities = await probe.capabilities();
 const report = { ...capabilities };
 if (process.argv.includes('--read')) {
  try {
   const list = await probe.read('list_threads',{limit:1});
   const threads = [...(list.pinnedThreads ?? []), ...(list.threads ?? [])];
   const chat = threads.find(t => t.kind === 'chatgpt');
   report.catalog = {ok:true,kinds:[...new Set(threads.map(t => t.kind))]};
   if (chat) {
    const history = await probe.read('read_thread',{threadId:chat.id,turnLimit:1,maxOutputCharsPerItem:20000});
    report.history = {ok:history.thread?.kind==='chatgpt',turns:history.turns?.length??0};
    if(report.history.ok)report.authenticated='read-confirmed';
   }
  } catch(error) { report.readFailure = error.message; }
 }
 console.log(JSON.stringify(report));
} catch(error) { console.log(JSON.stringify({state:error.message,writesEnabled:false}));process.exitCode=1; }
