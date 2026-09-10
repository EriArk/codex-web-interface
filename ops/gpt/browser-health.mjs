import {doctorObstruction} from './browser-doctor.mjs';
import {inspectObstructions} from './browser-obstructions.mjs';
import {storageLimits} from './retained-files.mjs';
import { lstatSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
export const bridgeRevision = "96802cc0d2ea0b7449cf465f8adb3c228decd297";
export function privateState() {
 let permissions=false,locked=false;
 try { permissions=["/data","/data/profile","/data/service-token","/data/bridge-token"].every(path=>{const s=lstatSync(path);return !s.isSymbolicLink()&&(s.mode&0o077)===0&&s.uid===process.getuid();}); }catch{}
 try { locked=spawnSync("flock",["--nonblock","/data/browser.lock","true"],{timeout:1500}).status===1; }catch{}
 return {permissions,locked};
}
export async function inspectComposer(page, optionalPromotion = false) {
 return page.evaluate(optionalPromotion=>{
  const visible=node=>!!node?.getClientRects().length;
  const editor=document.querySelector("#prompt-textarea"),form=editor?.closest("form");
  const models=[...(form?.querySelectorAll('button[aria-haspopup="menu"]:not([data-testid="composer-plus-btn"])')??[])].filter(visible);
  return {composer:visible(editor)&&(editor.isContentEditable||(optionalPromotion&&editor.getAttribute("contenteditable")==="true")),attachments:[...document.querySelectorAll('[data-testid="composer-plus-btn"]')].filter(visible).length===1,models:models.length===1,generating:!!document.querySelector('[data-testid="stop-button"]')};
 },optionalPromotion);
}
export function connectorReport({health,login,controls,privateState:storage,challenge=false,obstruction='clear'}) {
 const client=health?.activeClient,compatibility=client?.compatibility;
 const compatible=health?.ok===true && client?.compatible===true && compatibility?.bridgeVersion==="6.3.14" && client?.extensionProtocolVersion===5;
 const capabilities={composer:controls?.composer===true&&client?.capabilities?.promptInput===true,attachments:controls?.attachments===true&&client?.capabilities?.fileUpload===true,models:controls?.models===true&&client?.capabilities?.modelSelection===true,effort:client?.capabilities?.effortSelection===true,settingsReadback:true};
 let state=login==="required"?"login_required":challenge?"starting":!client?"starting":!compatible?"incompatible":login!=="authenticated"?"unavailable":obstruction==='attention'?"attention":!client.ready||!client.pageReady?"starting":!Object.values(capabilities).every(Boolean)?"degraded":health.activeRequests?.length||controls?.generating?"busy":"healthy";
 if(!storage.permissions||!storage.locked)state="degraded";
 return {contract:1,bridgeRevision:process.env.GPT_BRIDGE_REVISION??bridgeRevision,bridgeVersion:compatibility?.bridgeVersion??"6.3.14",extensionProtocol:client?.extensionProtocolVersion??5,state,login,capabilities,privateState:storage};
}
export async function readConnectorHealth({health,pages,privateState:storage}) {
 const state=await health();
 const candidates=pages().filter(page=>{try{return new URL(page.url()).origin==="https://chatgpt.com"}catch{return false}});
 const target=candidates.find(page=>page.url()===state.activeClient?.url)??(candidates.length===1?candidates[0]:null);
 if(!target)return connectorReport({health:state,login:"unknown",challenge:true,privateState:storage});
 const challenge=/just a moment|verify.*human/i.test(await target.title().catch(()=>""));
 const login=challenge?"unknown":await target.evaluate(async()=>{
  try {const response=await fetch("/api/auth/session",{credentials:"include",cache:"no-store",signal:AbortSignal.timeout(8000)});if(response.status===401||response.status===403)return "required";if(!response.ok)return "unknown";const session=await response.json();return typeof session.accessToken==="string"?"authenticated":"required";}catch{return "unknown";}
 });
 const obstruction=await inspectObstructions(target);
 return {...connectorReport({health:state,login,challenge,controls:await inspectComposer(target,obstruction==='promotion'),obstruction,privateState:storage}),storage:bridgeStorage(),doctorObstruction:await doctorObstruction(target)};
}

export function bridgeStorage() {
 const limits=storageLimits();
 const value={uploadBytes:0,artifactBytes:0,uploadLimit:limits.uploadBytes,artifactLimit:limits.artifactBytes,partial:false};
 try {
  const path="/data/bridge/index.json",info=lstatSync(path);
  if(!info.isFile()||info.isSymbolicLink()||info.size>32*1024**2)throw Error();
  const index=JSON.parse(readFileSync(path,"utf8"));
  for(const [kind,key] of [["files","uploadBytes"],["artifacts","artifactBytes"]]) {
   const entries=Object.values(index[kind]??{});
   if(entries.length>100000)throw Error();
   for(const item of entries){const bytes=Number(item?.size);if(!Number.isSafeInteger(bytes)||bytes<0)throw Error();value[key]+=bytes;}
  }
 }catch{value.partial=true;}
 return value;
}
