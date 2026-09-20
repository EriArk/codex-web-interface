import {request} from 'node:http';

/** Only the local gateway can read credentials from the owner-only engine socket. */
export function teamConnection(socketPath,cookie,origin,workspace){
 return new Promise((resolve,reject)=>{
  if(!socketPath?.startsWith('/')||!cookie|| (workspace&&!/^[a-f0-9-]{36}$/.test(workspace))){reject(Error('GPT_SESSION_UNAVAILABLE'));return;}
  const req=request({socketPath,path:'/internal/gpt/connection'+(workspace?'?workspace='+workspace:''),method:'GET',headers:{cookie,origin}},res=>{
   let size=0;const chunks=[];
   res.on('data',chunk=>{size+=chunk.length;if(size>2048){res.destroy();reject(Error('GPT_SESSION_UNAVAILABLE'));return;}chunks.push(chunk);});
   res.on('error',()=>reject(Error('GPT_SESSION_UNAVAILABLE')));
   res.on('end',()=>{
    try{
     if(res.statusCode!==200)throw Error();
     const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
     if(!/^[a-f0-9-]{36}$/.test(value.userId)|| (workspace&&workspace!==value.userId))throw Error();
     if(value.legacy===true){resolve({userId:value.userId,legacy:true});return;}
     if(value.legacy!==false||value.host!=='codex-web-gpt-'+value.userId||!/^[A-Za-z0-9_-]{8}$/.test(value.password)||!Number.isInteger(value.gatewayPort)||value.gatewayPort<9000||value.gatewayPort>65109)throw Error();
     resolve({userId:value.userId,legacy:false,native:value.native===true,host:value.host,password:value.password,gatewayPort:value.gatewayPort});
    }catch{reject(Error('GPT_SESSION_UNAVAILABLE'));}
   });
  });
  req.setTimeout(5000,()=>req.destroy());req.on('error',()=>reject(Error('GPT_SESSION_UNAVAILABLE')));req.end();
 });
}
