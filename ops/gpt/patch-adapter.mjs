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
