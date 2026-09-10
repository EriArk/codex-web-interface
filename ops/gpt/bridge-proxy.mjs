export async function readJson(req,limit=128*1024){
 let size=0;const chunks=[];
 for await(const chunk of req){size+=chunk.length;if(size>limit)throw Error('GPT_REQUEST_TOO_LARGE');chunks.push(chunk)}
 return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
}
export async function proxyBridge(req,res,path,token,{beforeChat}={}){
 const method=req.method,route=path.slice('/bridge'.length);
 const allowed=method==='POST'
  ? ['/chat','/files','/sessions/new','/sessions/select','/browser/stop','/composer/attachments/clear'].includes(route)||/^\/requests\/[a-zA-Z0-9_-]{1,160}\/steer$/.test(route)
  : method==='GET'&&(['/health','/artifacts','/files'].includes(route)||/^\/(?:files|artifacts)\/[a-zA-Z0-9_-]{1,160}\/download$/.test(route));
 if(!allowed){res.writeHead(404).end();return}
 const controller=new AbortController();
 const cancel=()=>{if(!res.writableEnded)controller.abort()};
 res.once('close',cancel);
 try{
  const body=method==='POST'?await readJson(req,route==='/files'?36*1024*1024:128*1024):undefined;
  if(route==='/chat'){
   if(body.projectId){
    if(typeof body.projectId!=='string'||!/^g-p-[a-zA-Z0-9-]{8,90}$/.test(body.projectId)||!beforeChat||!await beforeChat(body)){
     res.writeHead(400,{'Content-Type':'application/json','X-Codex-Gpt-Dispatch':'not-submitted'}).end(JSON.stringify({error:'GPT_PROJECT_COMPOSER_CHANGED'}));return;
    }
    delete body.projectId;
   }
   // Model/power selection is performed and verified through the current UI before submission.
   delete body.model;delete body.effort;delete body.reasoning_effort;
   if(!Array.isArray(body.attachments))body.attachments=[];
   if(body.attachments.some(id=>typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,160}$/.test(id)))throw Error('GPT_INVALID_ATTACHMENT');
   body.stream=true;
  }
  const response=await fetch('http://127.0.0.1:8080'+route,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:controller.signal});
  // This exact error is emitted by the pinned route before streamChatResponse/sendRequest.
  // Do not infer non-submission from arbitrary HTTP failures or a missing prompt.sent event.
  if(route==='/chat'&&response.status===400){
   let bytes='',size=0;
   for await(const chunk of response.body){size+=chunk.length;if(size>4096)throw Error('GPT_ERROR_TOO_LARGE');bytes+=Buffer.from(chunk).toString('utf8')}
   let rejected=false;try{rejected=JSON.parse(bytes).detail==='No message provided'}catch{}
   res.writeHead(400,{'Content-Type':'application/json',...(rejected?{'X-Codex-Gpt-Dispatch':'not-submitted'}:{})});
   res.end(JSON.stringify({error:rejected?'GPT_CHAT_NOT_SUBMITTED':'GPT_CHAT_FAILED'}));return;
  }
  res.statusCode=response.status;
  for(const name of ['content-type','content-length','content-disposition']){const value=response.headers.get(name);if(value)res.setHeader(name,value)}
  for await(const chunk of response.body){
   if(!res.write(chunk))await new Promise(resolve=>{const done=()=>{res.removeListener('drain',done);res.removeListener('close',done);resolve()};res.once('drain',done);res.once('close',done)});
   if(res.destroyed)break;
  }
  res.end();
 }catch{
  if(!res.headersSent)res.writeHead(502,{'Content-Type':'application/json'}).end(JSON.stringify({error:'GPT_TRANSPORT_FAILED'}));
  else res.destroy();
 }finally{res.removeListener('close',cancel)}
}
