import assert from 'node:assert/strict';
import test from 'node:test';
import {deploymentBlockers} from '../apps/hub/dist/deployment-status.js';
import {handoffFixture} from './handoff-fixture.mjs';

test('an unavailable existing doctor chat does not block updates; real creations and uncertain sends still do',async()=>{
 const f=await handoffFixture();
 try{
  const set=value=>f.store.db.prepare('INSERT OR REPLACE INTO bridge_doctor_config VALUES(1,?)').run(JSON.stringify(value));
  const blocked=kind=>deploymentBlockers(f.store,{busy:0,unknown:0}).some(b=>b.kind===kind);
  set({state:'unknown',threadId:f.thread.id});assert.equal(blocked('doctor_creation'),false);
  set({state:'unknown',threadId:null});assert.equal(blocked('doctor_creation'),true);
  set({state:'creating',threadId:f.thread.id});assert.equal(blocked('doctor_creation'),true);
  set({state:'unknown',threadId:f.thread.id});
  f.store.db.prepare('INSERT INTO bridge_doctor_incidents VALUES(?,?,?,?,?)').run('incident','fixture','open',Date.now(),JSON.stringify({delivery:'unknown',threadId:f.thread.id}));
  assert.equal(blocked('doctor_creation'),false);assert.equal(blocked('doctor'),true);
 }finally{await f.close();}
});
