import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..'),sandbox=fs.mkdtempSync(path.join(os.tmpdir(),'qiji-user-transfer-'));
fs.mkdirSync(path.join(sandbox,'src'));fs.mkdirSync(path.join(sandbox,'server/scripts'),{recursive:true});
fs.copyFileSync(path.join(root,'src/contract.ts'),path.join(sandbox,'src/contract.ts'));
for(const dir of ['src','skills'])fs.cpSync(path.join(root,'server',dir),path.join(sandbox,'server',dir),{recursive:true});
fs.copyFileSync(path.join(root,'server/package.json'),path.join(sandbox,'server/package.json'));
fs.symlinkSync(path.join(root,'server/node_modules'),path.join(sandbox,'server/node_modules'),'junction');
fs.copyFileSync(path.join(root,'server/scripts/smoke-user-transfer.mjs'),path.join(sandbox,'server/scripts/smoke-user-transfer.mjs'));
const out=path.join(root,'outputs/user-transfer-20260915');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'sandbox.txt'),sandbox);
let log='';
try{
 for(const phase of ['run','restart']){
  const output=execFileSync(process.execPath,['--import','tsx','scripts/smoke-user-transfer.mjs',phase],{cwd:path.join(sandbox,'server'),encoding:'utf8',env:{...process.env,QIJI_TEST_SNAPSHOT:'1',ADMIN_TOKEN:'admin-dev',NODE_ROLE:'source'}});
  log+=output;process.stdout.write(output);fs.writeFileSync(path.join(out,'api-tests.log'),log);
 }
}catch(error){fs.writeFileSync(path.join(out,'api-tests.log'),log+String(error.stdout??'')+String(error.stderr??''));throw error;}
console.log('Sandbox:',sandbox);
