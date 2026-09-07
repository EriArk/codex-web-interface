const identifier = /^[a-zA-Z0-9_-]{1,100}$/;
export function libraryRequest(input) {
  const {kind,id,action,value,name,confirm}=input??{};
  if(!["thread","project"].includes(kind)||!identifier.test(id??"")||!["pin","rename","archive","delete"].includes(action))throw Error("GPT_INVALID_ACTION");
  if(["pin","archive"].includes(action)&&typeof value!=="boolean")throw Error("GPT_INVALID_ACTION");
  if(action==="rename"&&(typeof name!=="string"||!name.trim()||name.trim().length>120))throw Error("GPT_INVALID_NAME");
  if(action==="delete"&&confirm!==true)throw Error("GPT_CONFIRM_REQUIRED");
  const encoded=encodeURIComponent(id);
  if(action==="pin")return {path:"/backend-api/pins/"+(kind==="thread"?"conversation":"project")+"/"+encoded,method:value?"POST":"DELETE"};
  if(kind==="project"){
    if(action==="rename")return {path:"/backend-api/projects/"+encoded,method:"PATCH",body:{name:name.trim()},readProject:encoded};
    if(action==="delete")return {path:"/backend-api/gizmos/"+encoded,method:"DELETE"};
    throw Error("GPT_PROJECT_ARCHIVE_LOCAL");
  }
  return {path:"/backend-api/conversation/"+encoded,method:"PATCH",body:action==="rename"?{title:name.trim()}:action==="archive"?{is_archived:value}:{is_visible:false}};
}
export async function mutateLibrary(page, input) {
  const request=libraryRequest(input);
  return page.evaluate(async ({path,method,body,readProject})=>{
    const session=await(await fetch("/api/auth/session",{credentials:"include",cache:"no-store",signal:AbortSignal.timeout(10000)})).json();
    if(typeof session.accessToken!=="string")return {status:401};
    if(readProject){
      const source=await fetch("/backend-api/gizmos/"+readProject,{credentials:"include",headers:{Authorization:"Bearer "+session.accessToken},signal:AbortSignal.timeout(20000)});
      if(!source.ok)return {status:source.status};
      const resource=await source.json(),gizmo=resource.gizmo?.gizmo??resource.gizmo;
      if(!gizmo?.display||typeof gizmo.instructions!=="string")return {status:502};
      body={...body,instructions:gizmo.instructions,emoji:gizmo.display.emoji??null,theme:gizmo.display.theme??null};
    }
    const response=await fetch(path,{method,credentials:"include",headers:{Authorization:"Bearer "+session.accessToken,"Content-Type":"application/json"},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
    // Native error bodies can contain account details; expose only a bounded status.
    if(!response.ok)return {status:response.status};
    const text=await response.text();
    if(text.length>1024*1024)return {status:502};
    if(text){try{const result=JSON.parse(text);if(result.error||result.success===false)return {status:409}}catch{return {status:502}}}
    return {status:200,ok:true};
  },request);
}
