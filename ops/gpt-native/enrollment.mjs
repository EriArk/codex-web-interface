import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { privatePath } from './service.mjs';

/** One empty, host-provisioned profile; activation is an explicit authenticated user action. */
export class NativeEnrollment {
 get canary(){return this.service?.canary;}
 constructor(root, reader, createService) {
  this.root=root;this.reader=reader;this.createService=createService;
  privatePath(root,'isDirectory');privatePath(join(root,'enrollment.json'),'isFile');
  const value=JSON.parse(readFileSync(join(root,'enrollment.json'),'utf8'));
  if(Object.keys(value).some(k=>k!=='userId')||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.userId))throw Error('NATIVE_INVALID_BINDING');
  this.userId=value.userId;this.leases=new Set();this.instanceId=randomUUID();
  if(existsSync(join(root,'binding.json'))) {
   privatePath(join(root,'binding.json'),'isFile');
   const binding=JSON.parse(readFileSync(join(root,'binding.json'),'utf8'));
   if(binding.userId!==this.userId)throw Error('NATIVE_WRONG_OWNER');
   this.binding=binding;
   this.service=createService(binding);
  }
 }
 async request(input) {
  if(input?.userId!==this.userId)throw Error('NATIVE_WRONG_OWNER');
  if(input.operation==='activate') {
   if(Object.keys(input).some(k=>!['userId','operation'].includes(k)))throw Error('NATIVE_INVALID_REQUEST');
   if(this.activating)throw Error('NATIVE_BUSY');
   this.activating=true;
   try {
    const account=await this.reader.inspectAccount();
    if(account.build!=='26.915.31945'||!/^[a-f0-9]{64}$/.test(account.accountFingerprint))throw Error('NATIVE_INVALID_BINDING');
    const binding={build:account.build,userId:this.userId,accountFingerprint:account.accountFingerprint};
    if(this.binding&&this.binding.accountFingerprint!==binding.accountFingerprint)throw Error('NATIVE_ACCOUNT_MISMATCH');
    if(this.service) {
     return {activated:true};
    }
    const path=join(this.root,'binding.json'),temp=path+'.'+randomUUID()+'.tmp';
    writeFileSync(temp,JSON.stringify(binding),{mode:0o600,flag:'wx'});renameSync(temp,path);
    this.binding=binding;
    this.service=this.createService(binding);
    for(const leaseId of this.leases)await this.service.request({userId:this.userId,operation:'beginManual',leaseId});
    return {activated:true};
   } finally {this.activating=false;}
  }
  if(this.service)return this.service.request(input);
  if(Object.keys(input).some(k=>!['userId','operation','leaseId'].includes(k)))throw Error('NATIVE_INVALID_REQUEST');
  if(input.operation==='status')return {instanceId:this.instanceId,manual:this.leases.size>0,busy:false,writesEnabled:false};
  if(['beginManual','endManual','resumeManual'].includes(input.operation)) {
   if(input.operation==='resumeManual')this.leases.clear();
   else {
    if(!/^[a-f0-9-]{36}$/.test(input.leaseId??''))throw Error('NATIVE_INVALID_REQUEST');
    if(input.operation==='beginManual') {
     if(this.leases.size>=8&&!this.leases.has(input.leaseId))throw Error('NATIVE_BUSY');
     this.leases.add(input.leaseId);
    }else this.leases.delete(input.leaseId);
   }
   return {manual:this.leases.size>0,writesEnabled:false};
  }
  throw Error('NATIVE_LOGIN_REQUIRED');
 }
}
