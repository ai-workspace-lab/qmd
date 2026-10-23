import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const hash = value => createHash('sha256').update(value).digest('hex');
// Same conservative quarantine policy as collect/redact.ts, applied before
// copying any source record. No secrets, commands, or transcript excerpts in logs.
export function sensitive(text) {
  return [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/,
    /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/,
    /\b(?:xox[abprs]-|nvapi-|AIza)[A-Za-z0-9_-]{20,}/,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
    /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
    /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/i,
    /\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY)[A-Z0-9_]*\s*[=:]\s*['"]?[^\s'"$]{8,}/i,
  ].some(re => re.test(text));
}
export function atomic(file, data) {
  fs.mkdirSync(path.dirname(file), {recursive:true,mode:0o700});
  const temp=file+'.tmp-'+process.pid;
  fs.writeFileSync(temp,data,{mode:0o600});
  fs.renameSync(temp,file);
}
function textOf(value) {
  if(typeof value==='string') return value;
  if(Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n');
  if(value && typeof value==='object') return textOf(value.text??value.content??'');
  return '';
}
export async function archive({source, destination, publish=async()=>{}, checkpoint=()=>{}}) {
  source=fs.realpathSync(source); destination=path.resolve(destination);
  if(destination===source || destination.startsWith(source+path.sep)) throw Error('archive must be outside source');
  fs.mkdirSync(destination,{recursive:true,mode:0o700});
  const lock=path.join(destination,'.import.lock');
  const fd=fs.openSync(lock,'wx',0o600);
  fs.writeFileSync(fd,String(process.pid));fs.closeSync(fd);
  try {
    const manifestFile=path.join(destination,'manifest.json');
    const old=fs.existsSync(manifestFile)?JSON.parse(fs.readFileSync(manifestFile,'utf8')):{format:'antigravity-archive/v1',files:{}};
    if(old.format!=='antigravity-archive/v1') throw Error('unsupported manifest version');
    const manifest={format:'antigravity-archive/v1',files:{...old.files},updatedAt:new Date().toISOString()};
    const stats={directories:0,transcripts:0,imported:0,unchanged:0,missing:0,omitted:0,malformed:0,partial:0};
    for(const dir of fs.readdirSync(source,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
      if(!dir.isDirectory() || !/^[a-zA-Z0-9_-]+$/.test(dir.name)) continue;
      stats.directories++;
      const relative=dir.name+'/.system_generated/logs/transcript.jsonl';
      const file=path.join(source,relative);
      if(!fs.existsSync(file)){stats.missing++;continue;}
      const canonical=fs.realpathSync(file);
      if(!canonical.startsWith(source+path.sep)) throw Error('source symlink escapes allowed directory');
      stats.transcripts++;
      const stat=fs.statSync(file), previous=manifest.files[relative];
      const valid=previous && ['document','archive'].every(k=>{
        const p=path.resolve(destination,previous[k]);
        return p.startsWith(destination+path.sep) && fs.existsSync(p) && hash(fs.readFileSync(p))===previous[k+'Sha256'];
      });
      if(valid && previous.size===stat.size && previous.mtimeMs===stat.mtimeMs) {
        await publish(previous); stats.unchanged++; continue;
      }
      let lineNo=0,omitted=0,malformed=0,partial=0,messages=0;
      const events=[],markdown=[],digest=createHash('sha256');
      const input=stat.size?fs.createReadStream(file,{end:stat.size-1}):fs.createReadStream(file);
      let lastByte;
      input.on('data',chunk=>{digest.update(chunk);lastByte=chunk[chunk.length-1];});
      for await(const line of readline.createInterface({input,crlfDelay:Infinity})) {
        lineNo++;
        // Snapshot trailing fragments must be retried rather than promoted.
        let record;try{record=JSON.parse(line);}catch{malformed++;continue;}
        if(sensitive(line)) {
          omitted++; events.push(JSON.stringify({type:'archive_omission',line:lineNo,sha256:hash(line),reason:'credential-pattern'}));continue;
        }
        events.push(line);
        // Do not expose private planner thinking through search documents.
        const content=textOf(record.content);
        if(content && ['USER_INPUT','PLANNER_RESPONSE','GENERIC'].includes(record.type)) {
          messages++;
          markdown.push(`## ${record.type} · source line ${lineNo}\n\n${content}\n`);
        }
        if(Array.isArray(record.tool_calls)) {
          for(const call of record.tool_calls) {
            const name=typeof call.name==='string'?call.name:'unknown';
            markdown.push(`Tool reference: ${name.replace(/[\r\n]/g,' ')} (source line ${lineNo}; invocation only, result unverified)\n`);
          }
        }
      }
      if(stat.size && lastByte!==10) partial=1;
      const sourceSha256=digest.digest('hex');
      const archivePath=`archives/${dir.name}/${sourceSha256}.jsonl`;
      const documentPath=`documents/${dir.name}.md`;
      const archiveBody=events.join('\n')+'\n';
      const documentBody=`# Antigravity history ${dir.name}\n\nSource session: ${dir.name}\nSource SHA256: ${sourceSha256}\nArchive: ../${archivePath}\nFormat: antigravity-archive/v1\nOmitted records: ${omitted}\nMalformed records: ${malformed}\nTrailing partial line: ${partial}\nExecution and acceptance status: unverified\n\n${markdown.join('\n')}`;
      atomic(path.join(destination,archivePath),archiveBody);
      atomic(path.join(destination,documentPath),documentBody);
      const entry={sessionId:dir.name,source:relative,size:stat.size,mtimeMs:stat.mtimeMs,sourceSha256,archive:archivePath,archiveSha256:hash(archiveBody),document:documentPath,documentSha256:hash(documentBody),messages,omitted,malformed,partial,format:manifest.format};
      // Sink failure leaves the last successful checkpoint intact. Re-running
      // republishes even unchanged references; deterministic sinks must upsert.
      await publish(entry);
      manifest.files[relative]=entry;
      atomic(manifestFile,JSON.stringify(manifest,null,2));
      stats.imported++;stats.omitted+=omitted;stats.malformed+=malformed;stats.partial+=partial;
      checkpoint(stats);
    }
    atomic(manifestFile,JSON.stringify(manifest,null,2));
    return {manifest,stats};
  } finally {fs.unlinkSync(lock);}
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  const [source,destination]=process.argv.slice(2);
  if(!source||!destination) throw Error('Usage: bun scripts/archive-antigravity.mjs SOURCE_BRAIN ARCHIVE_DIRECTORY');
  try {console.log(JSON.stringify((await archive({source,destination})).stats));}
  catch {console.error('Archive failed; source files untouched, inspect private diagnostics.');process.exitCode=1;}
}
