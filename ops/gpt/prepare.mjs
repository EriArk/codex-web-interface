import {randomBytes} from "node:crypto";
import {mkdirSync,writeFileSync} from "node:fs";
import {isAbsolute,join} from "node:path";
const state=process.argv[2];
if(!state||!isAbsolute(state))throw Error("Usage: node ops/gpt/prepare.mjs /absolute/private/state");
const root=join(state,"gpt");
mkdirSync(root,{recursive:true,mode:0o700});
for(const [name,size] of [["service-token",32],["bridge-token",32],["vnc-password",6]]){
 try{writeFileSync(join(root,name),randomBytes(size).toString("base64url"),{mode:0o600,flag:"wx"})}
 catch(error){if(error.code!=="EEXIST")throw error}
}
console.log("Private GPT browser state prepared. Existing credentials were preserved.");
