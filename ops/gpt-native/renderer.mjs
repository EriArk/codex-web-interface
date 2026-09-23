import {nativeOperation} from './renderer-operation.mjs';
import {nativeWorkspace} from './renderer-workspace.mjs';
import {nativeMedia} from './renderer-media.mjs';
import {nativeDictation} from './renderer-dictation.mjs';
import {nativeProject} from './renderer-project.mjs';
import {nativeLibrary} from './renderer-library.mjs';
import {nativeRead} from './renderer-read.mjs';
import {nativeRequestGate} from './request-gate.mjs';
import {nativeControl} from './renderer-control.mjs';
import {nativeSettings} from './renderer-settings.mjs';
import {nativeComposer} from './renderer-composer.mjs';
import {nativeArtifacts} from './renderer-artifacts.mjs';
import {nativeDispatch} from './renderer-dispatch.mjs';
import {nativeLive} from './renderer-live.mjs';
import {nativeActivity} from './public-activity.mjs';
import {nativeUpload} from './renderer-upload.mjs';
import {nativeUploadStage} from './renderer-upload-stage.mjs';
import {nativeStoredUpload} from './renderer-upload-session.mjs';
import {randomUUID} from 'node:crypto';

const endpoint = 'http://127.0.0.1:9222';
const maxBytes = 2 * 1024 * 1024;
const guard = '!!document.querySelector("[data-testid=app-shell-header-context-menu-surface]")';

async function evaluate(url, expression, signal) {
 const target = new URL(url);
 if (target.protocol !== 'ws:' || target.hostname !== '127.0.0.1' || target.port !== '9222' ||
     target.username || target.password || target.search || target.hash ||
     !/^\/devtools\/page\/[a-zA-Z0-9-]+$/.test(target.pathname)) throw Error('NATIVE_UNSAFE_TARGET');
 return new Promise((resolve, reject) => {
  const ws = new WebSocket(url);
  let done = false;
  const finish = (error, value) => {
   if (done) return;
   done = true; signal.removeEventListener('abort', abort);
   ws.close(); error ? reject(error) : resolve(value);
  };
  const abort = () => finish(Error('NATIVE_CANCELLED'));
  signal.addEventListener('abort', abort, {once:true});
  ws.onopen = () => {
   if (!done) ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));
  };
  ws.onerror = () => finish(Error('NATIVE_DISCONNECTED'));
  ws.onclose = () => finish(Error('NATIVE_DISCONNECTED'));
  ws.onmessage = event => {
   if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > maxBytes) return finish(Error('NATIVE_RESPONSE_TOO_LARGE'));
   try {
    const response = JSON.parse(event.data);
    if (response.id == null) return;
    if (response.id !== 1 || response.error || response.result?.exceptionDetails || !response.result?.result) return finish(Error('NATIVE_INVALID_RESPONSE'));
    finish(null, response.result.result.value);
   } catch { finish(Error('NATIVE_INVALID_RESPONSE')); }
  };
  if (signal.aborted) abort();
 });
}

/** Loopback-only lab transport. No HTTP server, generic action or send API. */
export class NativeRendererReader {
 constructor({transport}={}) { this.transport=transport; }
 async prepareStoredUpload(request,options){return this.#read({...request,operation:'prepareStoredUpload'},options,'stored-upload');}
 async finishStoredUpload(request,options){return this.#read({...request,operation:'finishStoredUpload'},options,'stored-upload');}
 async uploadFile(request,options){
  if(typeof request.file?.base64!=='string'||request.file.base64.length>34952536)throw Error('NATIVE_INVALID_UPLOAD');
  if(request.file.base64.length<=65536)return this.#read(request,options,'upload');
  const stageId=randomUUID(),file=request.file,signal=AbortSignal.any([AbortSignal.timeout(90000),...(options?.signal?[options.signal]:[])]);
  const stage=input=>this.#read({...input,stageId,accountFingerprint:request.accountFingerprint},{signal},'upload-stage');
  try{
   await stage({operation:'beginUpload',bytes:file.bytes,sha256:file.sha256});
   let offset=0;
   for(let i=0;i<file.base64.length;i+=131072){
    const base64=file.base64.slice(i,i+131072),next=await stage({operation:'appendUpload',offset,base64});
    offset+=Buffer.from(base64,'base64').length;if(next.offset!==offset)throw Error('NATIVE_UPLOAD_CHANGED');
   }
   const {base64:unused,...metadata}=file;
   return await this.#read({...request,file:{...metadata,stageId}},{signal},'upload');
  }finally{await this.#read({operation:'clearUpload',stageId},{},'upload-stage').catch(()=>{});}
 }

 async transcribe(r,options){
  if(typeof r.audio!=='string'||r.audio.length>8*1024**2||!/^[-a-z0-9.]+\/[-a-z0-9.]+$/i.test(r.mime??''))throw Error('NATIVE_INVALID_AUDIO');
  const bytes=Buffer.from(r.audio,'base64');if(!bytes.length||bytes.length>6*1024**2||bytes.toString('base64')!==r.audio)throw Error('NATIVE_INVALID_AUDIO');
  const stageId=randomUUID(),signal=AbortSignal.timeout(110000),stage=input=>this.#read({...input,stageId,accountFingerprint:r.accountFingerprint},{signal},'upload-stage');
  try{
   await stage({operation:'beginUpload',bytes:bytes.length,sha256:r.sha256});
   let offset=0;for(let i=0;i<r.audio.length;i+=131072){const base64=r.audio.slice(i,i+131072),next=await stage({operation:'appendUpload',offset,base64});offset+=Buffer.from(base64,'base64').length;if(next.offset!==offset)throw Error('NATIVE_UPLOAD_CHANGED');}
   return await this.#read({stageId,bytes:bytes.length,sha256:r.sha256,mime:r.mime,accountFingerprint:r.accountFingerprint},{signal},'dictation');
  }finally{await this.#read({operation:'clearUpload',stageId},{},'upload-stage').catch(()=>{});}
 }
 async mutateOperation(r,o){return this.#read(r,o,'operation');}
 async workspace(r,o){return this.#read(r,o,'workspace');}
 async openMedia(r,o){return this.#read({...r,operation:'openMedia'},o,'media');}
 async readMedia(r,o){return this.#read({...r,operation:'readMedia'},o,'media');}
 async closeMedia(r,o){return this.#read({...r,operation:'closeMedia'},o,'media');}
 async createProject(r,o){return this.#read({...r,operation:'createProject'},o,'project');}
 async inspectProject(r,o){return this.#read({...r,operation:'inspectProject'},o,'project');}
 async mutateProject(r,o){return this.#read({...r,operation:'mutateProject'},o,'project');}
 async readLibrary(request,options){return this.#read({...request,operation:'readLibrary'},options,'library');}
 async mutateLibrary(request,options){return this.#read({...request,operation:'mutateLibrary'},options,'library');}
 async dispatchText(request,options){return this.#read({...request,operation:'dispatchText'},options,'dispatch');}
 async readLive(request,options){return this.#read(request,options,'live');}
 async prepareDispatch(request,options){return this.#read({...request,operation:'prepareDispatch'},options,'dispatch');}
 async readSubmission(request,options){return this.#read({...request,operation:'readSubmission'},options);}
 async resolveCreation(request,options){return this.#read({...request,operation:'resolveCreation'},options,'dispatch');}
 async findCreation(request,options){return this.#read({...request,operation:'findCreation'},options);}
 async readConversationGraph(request,options){return this.#read({...request,operation:'readConversationGraph'},options);}
 async readProjects(request,options){return this.#read({...request,operation:'readProjects'},options);}
 async readProject(request,options){return this.#read({...request,operation:'readProject'},options);}
 async readProjectConversations(request,options){return this.#read({...request,operation:'readProjectConversations'},options);}
 async readCatalog(request,options){return this.#read({...request,operation:'readCatalog'},options);}
 async readPins(request,options){return this.#read({...request,operation:'readPins'},options);}
 async listArtifacts({conversationId,accountFingerprint,before},options){return this.#read({operation:'listArtifacts',conversationId,accountFingerprint,before},options,'artifacts');}
 async readArtifact({conversationId,accountFingerprint,messageId,artifactId},options){return this.#read({operation:'readArtifact',conversationId,accountFingerprint,messageId,artifactId},options,'artifacts');}
 async disposableComposer({operation,key,accountFingerprint,disposable,text,files,intentPersisted},options){
  return this.#read({operation,key,accountFingerprint,disposable,text,files,intentPersisted},options,'composer');
 }
 async inspectAccount(options) { return this.#read({operation:'inspectAccount'}, options); }
 async readModels({accountFingerprint}, options) { return this.#read({operation:'readModels',accountFingerprint},options); }
 async inspectSettings({conversationId,accountFingerprint}, options) {
  return this.#read({operation:'inspectSettings',conversationId,accountFingerprint},options,'settings');
 }
 async selectSettings({conversationId,accountFingerprint,versionId,presetId}, options) {
  return this.#read({operation:'selectSettings',conversationId,accountFingerprint,versionId,presetId},options,'settings');
 }
 async readConversation({conversationId, accountFingerprint, before}, options) {
  return this.#read({operation:'readConversation',conversationId,accountFingerprint,before}, options);
 }
 async selectConversation({conversationId,accountFingerprint}, options) {
  return this.#read({operation:'selectConversation',conversationId,accountFingerprint}, options, true);
 }
 async inspectConversation({conversationId,accountFingerprint}, options) {
  return this.#read({operation:'inspectConversation',conversationId,accountFingerprint}, options, true);
 }
 async stopResponse({conversationId,accountFingerprint,userMessageId}, options) {
  return this.#read({operation:'stopResponse',conversationId,accountFingerprint,userMessageId}, options, true);
 }
 async #read(request, {signal:callerSignal} = {}, control = false) {
  const deadline = AbortSignal.timeout(control==='dictation'?100000:['upload','stored-upload','operation','media'].includes(control)?65000:20000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
  try {
   const read = `(request => (${nativeRead.toString()})(request,undefined,globalThis,${nativeActivity.toString()}))`;
   const call = control === 'live' ? `(${nativeLive.toString()})(${JSON.stringify(request)},${nativeRead.toString()})` : control === 'operation' ? `(${nativeOperation.toString()})(${JSON.stringify(request)},${read},${nativeControl.toString()})` : control === 'workspace' ? `(${nativeWorkspace.toString()})(${JSON.stringify(request)},${nativeRead.toString()})` : control === 'media' ? `(${nativeMedia.toString()})(${JSON.stringify(request)},${read},${nativeArtifacts.toString()})` : control === 'dictation' ? `(${nativeDictation.toString()})(${JSON.stringify(request)},${nativeRead.toString()})` : control === 'project' ? `(${nativeProject.toString()})(${JSON.stringify(request)},${nativeRead.toString()})` : control === 'library' ? `(${nativeLibrary.toString()})(${JSON.stringify(request)},${nativeRead.toString()})` : control === 'stored-upload' ? `(${nativeStoredUpload.toString()})(${JSON.stringify(request)},${nativeRead.toString()})` : control === 'upload-stage' ? `(${nativeUploadStage.toString()})(${JSON.stringify(request)})` : control === 'upload' ? `(${nativeUpload.toString()})(${JSON.stringify(request)},${nativeRead.toString()})` : control === 'dispatch' ? `(${nativeDispatch.toString()})(${JSON.stringify(request)},${read},${nativeControl.toString()},undefined,globalThis,undefined,${nativeActivity.toString()})` : control === 'artifacts' ? `(${nativeArtifacts.toString()})(${JSON.stringify(request)},${nativeRead.toString()})` : control === 'composer' ? `(${nativeComposer.toString()})(${JSON.stringify(request)},${nativeRead.toString()})` : control === 'settings' ? `(${nativeSettings.toString()})(${JSON.stringify(request)},${read},${nativeControl.toString()})` : control ? `(${nativeControl.toString()})(${JSON.stringify(request)},${nativeRead.toString()})` : `(${read})(${JSON.stringify(request)})`;
   const expression = `(async()=>{const nativeRequestGate=${nativeRequestGate.toString()};try{if(!(${guard}))throw Error('NATIVE_WINDOW_CHANGED');return {ok:true,value:await ${call}}}catch(e){return {ok:false,code:/^NATIVE_[A-Z_]+$/.test(e?.message)?e.message:'NATIVE_READ_UNAVAILABLE'}}})()`;
   const unwrap=result=>{if(result?.ok!==true)throw Error(/^NATIVE_[A-Z_]+$/.test(result?.code??'')?result.code:'NATIVE_INVALID_RESPONSE');return result.value;};
   if(this.transport)return unwrap(await this.transport.evaluateMain(expression,guard,signal));
   const response = await fetch(`${endpoint}/json/list`, {signal, redirect:'error'});
   if (!response.ok) throw Error('NATIVE_UNAVAILABLE');
   // Stream and bound discovery too; do not trust an unbounded response.json().
   let raw = '';
   for await (const part of response.body) {
    raw += Buffer.from(part).toString('utf8');
    if (Buffer.byteLength(raw) > 65536) throw Error('NATIVE_INVALID_TARGETS');
   }
   const pages = JSON.parse(raw);
   if (!Array.isArray(pages) || pages.length > 32) throw Error('NATIVE_INVALID_TARGETS');
   const matches = [];
   for (const page of pages.filter(p => p.type === 'page' && p.url === 'app://-/index.html')) {
    if (await evaluate(page.webSocketDebuggerUrl, guard, signal) === true) matches.push(page);
   }
   if (matches.length !== 1) throw Error('NATIVE_WINDOW_AMBIGUOUS');
   const result = await evaluate(matches[0].webSocketDebuggerUrl, expression, signal);
   return unwrap(result);
  } catch (error) {
   if (signal.aborted) throw Error(callerSignal?.aborted ? 'NATIVE_CANCELLED' : 'NATIVE_TIMEOUT');
   throw Error(/^NATIVE_[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'NATIVE_UNAVAILABLE');
  }
 }
}
