import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {readMachineImage} from '../packages/machines/dist/image.js';
test('existing native image URLs with /D:/ read the same Windows file through SSH',async(t)=>{
 const paths=[];
 t.mock.method(childProcess,'spawn',(_command,args)=>{
  const script=Buffer.from(args.at(-1),'base64').toString('utf16le');paths.push(script);
  const proc=new EventEmitter();proc.stdout=new PassThrough();proc.stderr=new PassThrough();proc.stdin={end(){queueMicrotask(()=>{proc.stdout.write(Buffer.from('image').toString('base64'));proc.emit('close',0);});}};proc.kill=()=>{};return proc;
 });syncBuiltinESMExports();
 try{
  const machine={id:'owner',type:'ssh-windows',ssh:{target:'owner-lan'}};
  for(const path of ['/D:/Projects/CodexWeb/.local/wizard.png','D:/Projects/CodexWeb/.local/wizard.png'])assert.equal((await readMachineImage(machine,path)).toString(),'image');
  assert.equal(paths.length,2);assert.equal(paths[0],paths[1]);assert.match(paths[0],/Open\('D:\/Projects/);
  await assert.rejects(readMachineImage(machine,'/etc/test.png'),{code:'INVALID_IMAGE_PATH'});
 }finally{t.mock.restoreAll();syncBuiltinESMExports();}
});
