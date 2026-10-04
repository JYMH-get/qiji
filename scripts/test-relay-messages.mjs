import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..'),sandbox=fs.mkdtempSync(path.join(os.tmpdir(),'qiji-relay-messages-'));
fs.mkdirSync(path.join(sandbox,'src')); fs.copyFileSync(path.join(root,'src/contract.ts'),path.join(sandbox,'src/contract.ts'));
for(const name of ['source-server','relay-server']){
  fs.mkdirSync(path.join(sandbox,name,'scripts'),{recursive:true});
  for(const dir of ['src','skills']) fs.cpSync(path.join(root,'server',dir),path.join(sandbox,name,dir),{recursive:true});
  fs.copyFileSync(path.join(root,'server/package.json'),path.join(sandbox,name,'package.json'));
  fs.symlinkSync(path.join(root,'server/node_modules'),path.join(sandbox,name,'node_modules'),'junction');
}
fs.copyFileSync(path.join(root,'server/scripts/smoke-relay-messages.mjs'),path.join(sandbox,'source-server/scripts/smoke-relay-messages.mjs'));
const out=path.join(root,'outputs/agent-portal-20260915'); fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,'relay-sandbox.txt'),sandbox);
try{
  const output=execFileSync(process.execPath,['--import','tsx','scripts/smoke-relay-messages.mjs'],{cwd:path.join(sandbox,'source-server'),encoding:'utf8',env:{...process.env,QIJI_TEST_SNAPSHOT:'1',NODE_ROLE:'source',SOURCE_URL:'',SOURCE_NODE_KEY:''}});
  fs.writeFileSync(path.join(out,'relay-messages-tests.log'),output); process.stdout.write(output);
}catch(error){fs.writeFileSync(path.join(out,'relay-messages-tests.log'),String(error.stdout??'')+String(error.stderr??''));throw error;}
console.log('Sandbox:',sandbox);
