import {createHash} from 'node:crypto';
import {createReadStream,mkdirSync,readFileSync,writeFileSync,renameSync,openSync,closeSync,fsyncSync,readdirSync,unlinkSync} from 'node:fs';
import {open,stat,statfs,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {privatePath} from './service.mjs';
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x);
const fail=c=>{throw Error('NATIVE_'+c);};
export class NativeStoredUploads {
 constructor(root,limit=4*1024**3){this.limit=limit;this.root=root;mkdirSync(root,{recursive:true,mode:0o700});privatePath(root,'isDirectory');}
 path(r){if(!uuid(r.key)||!uuid(r.file?.id))fail('INVALID_UPLOAD');return join(this.root,r.key+'-'+r.file.id);}
 metadata(r){
  const f=r.file;
  if(!f||typeof f.name!=='string'||!f.name||f.name.length>255||/[\\/\x00-\x1f]/.test(f.name)||!Number.isSafeInteger(f.bytes)||f.bytes<1||f.bytes>512*1024**2||!/^[a-f0-9]{64}$/.test(f.sha256??'')||!/^[-a-z0-9.+]+\/[-a-z0-9.+]+$/i.test(f.mime)||f.mime.startsWith('image/'))fail('INVALID_UPLOAD');
  return {conversationId:r.conversationId,accountFingerprint:r.accountFingerprint,id:f.id,name:f.name,bytes:f.bytes,mime:f.mime,sha256:f.sha256};
 }
 async append(r){
  const path=this.path(r),meta=this.metadata(r),signature=JSON.stringify(meta);
  if(!Number.isSafeInteger(r.offset)||r.offset<0||typeof r.base64!=='string'||r.base64.length>1398104)fail('INVALID_UPLOAD');
  const bytes=Buffer.from(r.base64,'base64');if(!bytes.length||bytes.toString('base64')!==r.base64||r.offset+bytes.length>meta.bytes)fail('INVALID_UPLOAD');
  let state;
  try{privatePath(path+'.json','isFile');state=JSON.parse(readFileSync(path+'.json','utf8'));if(state.signature!==signature)fail('UPLOAD_CHANGED');}
  catch(e){
   if(e.code!=='ENOENT')throw e;if(r.offset!==0)fail('UPLOAD_OFFSET');
   let reserved=0;
   for(const name of readdirSync(this.root)){
    if(!/^[a-f0-9-]{36}-[a-f0-9-]{36}\.json$/i.test(name))continue;
    const entry=join(this.root,name);privatePath(entry,'isFile');
    const old=JSON.parse(readFileSync(entry,'utf8'));
    if(old.updatedAt<Date.now()-86400000){
     for(const ext of ['part','json','tmp'])try{unlinkSync(entry.slice(0,-4)+ext);}catch(e){if(e.code!=='ENOENT')throw e;}
     continue;
    }
    reserved+=JSON.parse(old.signature).bytes;
   }
   if(reserved+meta.bytes>this.limit)fail('UPLOAD_STORAGE_FULL');
   const disk=await statfs(this.root);if(disk.bavail*disk.bsize<reserved+meta.bytes+64*1024**2)fail('UPLOAD_STORAGE_FULL');
   state={signature,offset:0};
  }
  let file;try{file=await open(path+'.part','r+');}catch(e){if(e.code!=='ENOENT'||state.offset!==0)throw e;file=await open(path+'.part','wx+',0o600);}
  try{
   privatePath(path+'.part','isFile');const size=(await file.stat()).size;if(size<state.offset)fail('UPLOAD_CHANGED');if(size>state.offset)await file.truncate(state.offset);
   if(r.offset<state.offset){
    if(r.offset+bytes.length>state.offset)fail('UPLOAD_OFFSET');
    const old=Buffer.alloc(bytes.length),result=await file.read(old,0,old.length,r.offset);if(result.bytesRead!==old.length||!old.equals(bytes))fail('UPLOAD_CHANGED');
    return {offset:state.offset};
   }
   if(r.offset!==state.offset)fail('UPLOAD_OFFSET');let n=0;while(n<bytes.length){const v=await file.write(bytes,n,bytes.length-n,r.offset+n);if(!v.bytesWritten)fail('UPLOAD_WRITE');n+=v.bytesWritten;}
   await file.sync();state.offset+=bytes.length;
   state.updatedAt=Date.now();
   const temp=openSync(path+'.tmp','w',0o600);
   try{writeFileSync(temp,JSON.stringify(state));fsyncSync(temp);}finally{closeSync(temp);}
   renameSync(path+'.tmp',path+'.json');
   const directory=openSync(this.root,'r');try{fsyncSync(directory);}finally{closeSync(directory);}
   return {offset:state.offset};
  }finally{await file.close();}
 }
 async verified(r){
  const path=this.path(r),meta=this.metadata(r);privatePath(path+'.json','isFile');privatePath(path+'.part','isFile');
  const saved=JSON.parse(readFileSync(path+'.json','utf8'));if(saved.signature!==JSON.stringify(meta)||saved.offset!==meta.bytes||(await stat(path+'.part')).size!==meta.bytes)fail('UPLOAD_CHANGED');
  const hash=createHash('sha256');for await(const bytes of createReadStream(path+'.part'))hash.update(bytes);
  if(hash.digest('hex')!==meta.sha256)fail('UPLOAD_CHANGED');return path+'.part';
 }
 async clear(r){const path=this.path(r);await Promise.allSettled([unlink(path+'.part'),unlink(path+'.json')]);}
}
/** The capability never crosses the supervisor's typed public service boundary. */
export async function transferStoredUpload(reader,r,path){
 const prepared=await reader.prepareStoredUpload(r);
 const url=new URL(prepared.url);
 if(url.protocol!=='https:'||url.port||url.username||url.password||url.hash||!url.search||!(/^[a-z0-9]+\.blob\.core\.windows\.net$/.test(url.hostname)||/^[a-z0-9-]+\.oaiusercontent\.com$/.test(url.hostname)))fail('UNSUPPORTED_UPLOAD_TARGET');
 if(Object.keys(prepared.headers??{}).some(k=>!['content-type','x-ms-blob-type','x-ms-version','x-ms-blob-content-type'].includes(k.toLowerCase())))fail('UNSUPPORTED_UPLOAD_HEADERS');
 if((await reader.inspectAccount()).accountFingerprint!==r.accountFingerprint)fail('ACCOUNT_CHANGED');
 const body=createReadStream(path),signal=AbortSignal.timeout(15*60000);
 try{
  const response=await fetch(url,{method:'PUT',headers:{...prepared.headers,'Content-Length':String(r.file.bytes)},body,duplex:'half',redirect:'error',signal});
  if(response.body)await response.body.cancel();if(!response.ok)fail('UPLOAD_TRANSFER_FAILED');
 }catch{fail(signal.aborted?'UPLOAD_TIMEOUT':'UPLOAD_TRANSFER_FAILED');}finally{body.destroy();}
 if((await reader.inspectAccount()).accountFingerprint!==r.accountFingerprint)fail('ACCOUNT_CHANGED');
 return reader.finishStoredUpload({...r,nativeId:prepared.nativeId});
}
