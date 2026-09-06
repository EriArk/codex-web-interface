
import assert from "node:assert/strict";
import {readFile,mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {configSchema} from "../packages/shared/dist/index.js";
import {Store} from "../apps/hub/dist/store.js";
import {Sessions} from "../apps/hub/dist/sessions.js";
const raw=JSON.parse(await readFile(process.argv[2],"utf8")),root=await mkdtemp(join(tmpdir(),"codex-catalog-smoke-"));
raw.hub.databasePath=":memory:";raw.hub.resultsPath=root;
const config=configSchema.parse(raw),store=new Store(":memory:"),sessions=new Sessions(config,store);
try {
 await sessions.catalog.refresh(true);assert.equal(sessions.catalog.errors.size,0);
 const projects=sessions.catalog.projects();assert(projects.length>0);
 for(const machine of config.machines)await sessions.catalog.syncThreads(machine.id,true);
 const counts=projects.map(p=>({name:p.name,threads:store.threads(p.id).length}));
 const candidates=store.threads(config.projects[0].id);
 const imported=process.argv[3]?store.threadByCodex(process.argv[3]):candidates.find(t=>t.origin==="desktop"&&t.historyMode==="paginated");
 assert(imported,"Pass an existing native thread ID with more than 40 chat messages as the third argument");
 const first=await sessions.catalog.history(imported);
 assert.equal(first.messages.length,20);assert(first.hasMore);
 const second=await sessions.catalog.history(imported,first.nextBefore);
 assert.equal(second.messages.length,20);
 assert(!second.messages.some(m=>first.messages.some(p=>p.id===m.id)));
 console.log(JSON.stringify({projects:counts,latestMessages:20,olderMessages:20,nonOverlapping:true,nativeSettings:store.thread(imported.id).settings,readOnly:true}));
}finally{await sessions.close();store.close();await rm(root,{recursive:true});}
