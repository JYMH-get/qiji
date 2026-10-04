import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..'),sandbox=fs.mkdtempSync(path.join(os.tmpdir(),'qiji-source-settings-'));
fs.mkdirSync(path.join(sandbox,'src'));fs.mkdirSync(path.join(sandbox,'server/scripts'),{recursive:true});
fs.copyFileSync(path.join(root,'src/contract.ts'),path.join(sandbox,'src/contract.ts'));
for(const dir of ['src','skills'])fs.cpSync(path.join(root,'server',dir),path.join(sandbox,'server',dir),{recursive:true});
fs.copyFileSync(path.join(root,'server/package.json'),path.join(sandbox,'server/package.json'));
fs.symlinkSync(path.join(root,'server/node_modules'),path.join(sandbox,'server/node_modules'),'junction');
fs.copyFileSync(path.join(root,'server/scripts/smoke-source-settings.mjs'),path.join(sandbox,'server/scripts/smoke-source-settings.mjs'));
const out=path.join(root,'outputs/source-settings-20260915');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'sandbox.txt'),sandbox);
try{
 const output=execFileSync(process.execPath,['--import','tsx','scripts/smoke-source-settings.mjs'],{cwd:path.join(sandbox,'server'),encoding:'utf8',env:{...process.env,QIJI_TEST_SNAPSHOT:'1',ADMIN_TOKEN:'admin-dev',NODE_ROLE:'source'}});
 fs.writeFileSync(path.join(out,'api-tests.log'),output);process.stdout.write(output);
}catch(error){fs.writeFileSync(path.join(out,'api-tests.log'),String(error.stdout??'')+String(error.stderr??''));throw error;}
console.log('Sandbox:',sandbox);
