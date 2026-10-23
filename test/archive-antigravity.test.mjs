import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {archive,hash} from '../scripts/archive-antigravity.mjs';

test('archive filters credentials and thinking, checkpoints after sink, retries, and retains versions',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qmd-history-test-'));
  const source=path.join(root,'brain'),destination=path.join(root,'archive');
  const session=path.join(source,'fixture-session','.system_generated','logs');
  fs.mkdirSync(session,{recursive:true});
  const file=path.join(session,'transcript.jsonl');
  const secret='sk-'+ 'x'.repeat(30);
  const original=[{type:'USER_INPUT',content:'QMD fixture goal'},{type:'PLANNER_RESPONSE',thinking:'private planning fixture',content:'fixture result',tool_calls:[{name:'run_command',args:{CommandLine:'echo fixture'}}]},{type:'GENERIC',content:secret}].map(JSON.stringify).join('\n')+'\n{';
  fs.writeFileSync(file,original);
  let fail=true;
  const publish=async()=>{if(fail)throw Error('fixture PG offline');};
  await assert.rejects(archive({source,destination,publish}),/fixture PG offline/);
  assert.equal(fs.existsSync(path.join(destination,'manifest.json')),false);
  fail=false;
  const first=await archive({source,destination,publish});
  for(const [key,value] of Object.entries({imported:1,omitted:1,malformed:1,partial:1})) assert.equal(first.stats[key],value);
  const entry=Object.values(first.manifest.files)[0];
  const doc=fs.readFileSync(path.join(destination,entry.document),'utf8');
  assert.ok(doc.includes('QMD fixture goal'));assert.ok(!doc.includes(secret));assert.ok(!doc.includes('private planning fixture'));
  assert.equal(hash(fs.readFileSync(path.join(destination,entry.archive))),entry.archiveSha256);
  assert.equal((await archive({source,destination,publish})).stats.unchanged,1);
  fs.writeFileSync(path.join(destination,entry.document),'corrupt');
  assert.equal((await archive({source,destination,publish})).stats.imported,1);
  fs.appendFileSync(file,'}\n');
  assert.equal((await archive({source,destination,publish})).stats.imported,1);
  assert.equal(fs.readdirSync(path.join(destination,'archives','fixture-session')).length,2);
  assert.equal(fs.readFileSync(file,'utf8'),original+'}\n');
  fs.writeFileSync(path.join(destination,'.import.lock'),'fixture');
  await assert.rejects(archive({source,destination,publish}));
  // Test-only directories created above, never source user data.
  fs.rmSync(root,{recursive:true});
});
