import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
const Fastify=createRequire(new URL('../apps/hub/package.json',import.meta.url))('fastify');
import {TeamAuth} from '../apps/hub/dist/team-auth.js';
import {Store} from '../apps/hub/dist/store.js';
import {registerDeploymentStatus} from '../apps/hub/dist/deployment-status.js';
test('only original owner can force exact pending release; confirmations and CSRF remain required',async()=>{
 const root=mkdtempSync(join(tmpdir(),'owner-update-')),old=process.env.HUB_RELEASE_ROOT;
 process.env.HUB_RELEASE_ROOT=root;
 const store=new Store(join(root,'app.db')); const app=Fastify();
 let user='member',csrf=true;
 const auth=Object.assign(Object.create(TeamAuth.prototype),{registry:{ownerId:'owner'},session:()=>({user:{id:user,role:'admin'}}),csrf:()=>{if(!csrf)throw Error('CSRF');}});
 const release={state:'waiting',revision:'abcdef1',startedAt:123,ownerForce:1};
 writeFileSync(join(root,'maintenance.json'),JSON.stringify(release));
 registerDeploymentStatus(app,store,undefined,{auth,databasePath:join(root,'app.db')});
 const send=(extra={})=>app.inject({method:'POST',url:'/api/deployment/apply',payload:{revision:'abcdef1',startedAt:123,force:true,confirm:true,...extra}});
 try{
  assert.equal((await app.inject('/api/deployment')).json().ownerForceAllowed,false);
  assert.notEqual((await send()).statusCode,200);
  user='owner';assert.equal((await app.inject('/api/deployment')).json().ownerForceAllowed,true);
  assert.notEqual((await send({confirm:false})).statusCode,200);
  assert.notEqual((await send({revision:'abcdef2'})).statusCode,200);
  assert.notEqual((await send({startedAt:122})).statusCode,200);
  csrf=false;assert.notEqual((await send()).statusCode,200);csrf=true;
  assert.equal((await send()).statusCode,200);
  assert.equal(JSON.parse(readFileSync(join(root,'owner-update-request.json'))).force,true);
  writeFileSync(join(root,'maintenance.json'),JSON.stringify({...release,ownerForce:0}));
  assert.notEqual((await send()).statusCode,200);
 }finally{await app.close();store.close();if(old===undefined)delete process.env.HUB_RELEASE_ROOT;else process.env.HUB_RELEASE_ROOT=old;rmSync(root,{recursive:true,force:true});}
});

