import {stat} from "node:fs/promises";
export function storageLimits() {
 const value=(name,fallback)=>{const n=Number(process.env[name]??fallback);if(!Number.isSafeInteger(n)||n<1||n>1024**4)throw Error("GPT_STORAGE_LIMIT_INVALID");return n;};
 return {uploadBytes:value("GPT_UPLOAD_MAX_BYTES",2*1024**3),artifactBytes:value("GPT_ARTIFACT_MAX_BYTES",8*1024**3)};
}
export function retainedFileStore(Base,{uploadBytes,artifactBytes}=storageLimits()) {
 return class extends Base {
  storageQueue=Promise.resolve();
  async storageWrite(kind,size,write,replacing) {
   const task=this.storageQueue.catch(()=>{}).then(async()=>{
    await this.ready;
    const records=kind==="upload"?this.index.files:this.index.artifacts;
    const used=Object.values(records).reduce((sum,file)=>sum+(Number(file.size)||0),0)-(Number(records[replacing]?.size)||0);
    if(!Number.isSafeInteger(size)||size<0||used+size>(kind==="upload"?uploadBytes:artifactBytes))throw Error("GPT_FILE_STORAGE_FULL");
    return write();
   });
   this.storageQueue=task.catch(()=>{});
   return task;
  }
  async putUpload(input) {
   const size=typeof input.contentBase64==="string"&&input.contentBase64?Buffer.from(input.contentBase64,"base64").length:Buffer.byteLength(input.content??"");
   return this.storageWrite("upload",size,()=>super.putUpload(input));
  }
  async putArtifact(input) {
   const size=typeof input.contentBase64==="string"&&input.contentBase64?Buffer.from(input.contentBase64,"base64").length:Buffer.byteLength(input.content??"");
   return this.storageWrite("artifact",size,()=>super.putArtifact(input),input.artifactId);
  }
  async importLocalPath(input) {return this.storageWrite("upload",(await stat(input.filePath)).size,()=>super.importLocalPath(input));}
  async importArtifactPath(input) {return this.storageWrite("artifact",(await stat(input.filePath)).size,()=>super.importArtifactPath(input),input.artifactId);}
  async pruneArtifacts() { return []; }
 };
}
