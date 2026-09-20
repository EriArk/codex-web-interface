// Local snapshot of the native response stream. No history/network fetch or mutation.
export async function nativeLive(request,read,runtime=globalThis){
 const fail=code=>{throw Error('NATIVE_'+code);};
 const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x);
 if(!uuid(request.key)||!uuid(request.userMessageId)||
    (request.conversationId!==null&&!uuid(request.conversationId)))fail('INVALID_REQUEST');
 if((await read({operation:'inspectAccount'})).accountFingerprint!==request.accountFingerprint)fail('ACCOUNT_MISMATCH');
 const value=runtime[Symbol.for('codex-web.native-live')]?.get(request.key);
 if(!value||Date.now()-value.at>3600000)return {items:[]};
 if(value.accountFingerprint!==request.accountFingerprint||value.userMessageId!==request.userMessageId||
    (request.conversationId!==null&&value.conversationId!==request.conversationId))fail('SUBMISSION_MISMATCH');
 return {items:value.items};
}
