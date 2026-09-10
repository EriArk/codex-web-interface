import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const path='/opt/bridge/tools/chrome-bridge-extension/content/attachmentCommands.js';
let source=readFileSync(path,'utf8');
function replace(from,to){if(!source.includes(from))throw Error('Pinned attachment adapter changed');source=source.replace(from,to)}
const warning="emitChatEvent(request, 'files.attach.warning', { message: err.message });";
replace(warning,warning+"\n    throw err;");
replace("fetch(url, { credentials: 'include' })","fetch(url, { credentials: 'include', signal: AbortSignal.timeout(15000) })");
replace("const visibleNames = names.filter((name) => rootText.includes(name) || visibleText(document.body).includes(name));",String.raw`
const tiles = Array.from((root || document.body).querySelectorAll('[role="group"][aria-label]')).filter(isVisible);
    const normalize = name => name.replace(/\(\d+\)(?=\.[^.]+$)/, '');
    const remaining = tiles.map(tile => normalize(tile.getAttribute('aria-label') || ''));
    const visibleNames = names.filter(name => {
      const index = remaining.indexOf(normalize(name));
      if (index < 0) return false;
      remaining.splice(index, 1);
      return true;
    });
`);
replace("if (!isUsableButton(element)) return false;","if (element.disabled || element.getAttribute('aria-disabled') === 'true') return false;");
replace("if (!/(remove|delete|clear|close|dismiss|attachment|file|удал|убрать|очист|закры)/i.test(attrs)) return false;",String.raw`if (!element.closest('[role="group"][aria-label]') || !/^(remove file|remove attachment|delete file|удалить файл|удалить вложение)(?:\s|:|$)/i.test(attrs)) return false;`);
writeFileSync(path,source);
execFileSync(process.execPath,['--check',path],{stdio:'inherit'});

// The extension accepts attachment-only prompts, but the pinned HTTP routes reject them.
// Patch only the two native chat entry points; fail closed if the pinned source changes.
const routesPath='/opt/bridge/src/routes.js';
const routes=readFileSync(routesPath,'utf8');
const guard="if (!request.message.trim()) throw new HttpError(400, 'No message provided');";
if(routes.split(guard).length!==3)throw Error('Pinned chat validation changed');
writeFileSync(routesPath,routes.replaceAll(guard,"if (!request.message.trim() && !request.attachments.length) throw new HttpError(400, 'No message provided');"));
execFileSync(process.execPath,['--check',routesPath],{stdio:'inherit'});

// Native image processing can take tens of seconds after the one and only click.
// Keep observing that submission, without changing the no-replay policy.
const runtimePath='/opt/bridge/tools/chrome-bridge-extension/content/runtimeConfig.js';
const runtime=readFileSync(runtimePath,'utf8');
const ack='promptSubmitAckTimeoutMs: 4_000,';
if(runtime.split(ack).length!==2)throw Error('Pinned submission acknowledgement timeout changed');
writeFileSync(runtimePath,runtime.replace(ack,'promptSubmitAckTimeoutMs: 60_000,'));
execFileSync(process.execPath,['--check',runtimePath],{stdio:'inherit'});


// A new ChatGPT URL can become canonical before image processing establishes
// the submitted user-turn boundary. Keep observing the same lease without
// adopting that URL or marking this as navigation to another conversation.
const observationPath='/opt/bridge/src/bridge/adapters/tabObservationAdapter.js';
let observationSource=readFileSync(observationPath,'utf8');
function patchObservation(from,to){if(observationSource.split(from).length!==2)throw Error('Pinned conversation binding adapter changed');observationSource=observationSource.replace(from,to)}
observationSource="import {pendingConversationBinding} from '/opt/gpt/conversation-binding.mjs';\n"+observationSource;
patchObservation('  const conversationChanged = conversationIdChanged && !conversationCanonicalized;',`  const pendingCanonicalization = pendingConversationBinding({state:currentState,observation,requestId,clientId,submittedUserTurnKey});
  const conversationChanged = conversationIdChanged && !conversationCanonicalized && !pendingCanonicalization;`);
patchObservation("    conversationId: bindingEstablished ? observation.conversationId || payload.session?.id || '' : '',",`    conversationId: pendingCanonicalization ? expectedConversationId : bindingEstablished ? observation.conversationId || payload.session?.id || '' : '',
    pendingConversationId: pendingCanonicalization ? observedConversationId : '',`);
writeFileSync(observationPath,observationSource);
execFileSync(process.execPath,['--check',observationPath],{stdio:'inherit'});
