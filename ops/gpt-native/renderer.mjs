import {nativeRead} from './renderer-read.mjs';
import {nativeControl} from './renderer-control.mjs';
import {nativeSettings} from './renderer-settings.mjs';
import {nativeComposer} from './renderer-composer.mjs';

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
  const deadline = AbortSignal.timeout(20000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
  try {
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
   const call = control === 'composer' ? `(${nativeComposer.toString()})(${JSON.stringify(request)},${nativeRead.toString()})` : control === 'settings' ? `(${nativeSettings.toString()})(${JSON.stringify(request)},${nativeRead.toString()},${nativeControl.toString()})` : control ? `(${nativeControl.toString()})(${JSON.stringify(request)},${nativeRead.toString()})` : `(${nativeRead.toString()})(${JSON.stringify(request)})`;
   const expression = `(async()=>{try{if(!(${guard}))throw Error('NATIVE_WINDOW_CHANGED');return {ok:true,value:await ${call}}}catch(e){return {ok:false,code:/^NATIVE_[A-Z_]+$/.test(e?.message)?e.message:'NATIVE_READ_UNAVAILABLE'}}})()`;
   const result = await evaluate(matches[0].webSocketDebuggerUrl, expression, signal);
   if (result?.ok !== true) throw Error(/^NATIVE_[A-Z_]+$/.test(result?.code ?? '') ? result.code : 'NATIVE_INVALID_RESPONSE');
   return result.value;
  } catch (error) {
   if (signal.aborted) throw Error(callerSignal?.aborted ? 'NATIVE_CANCELLED' : 'NATIVE_TIMEOUT');
   throw Error(/^NATIVE_[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'NATIVE_UNAVAILABLE');
  }
 }
}
