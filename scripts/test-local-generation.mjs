import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..'),sandbox=fs.mkdtempSync(path.join(os.tmpdir(),'qiji-local-generation-'));
fs.mkdirSync(path.join(sandbox,'src'));fs.mkdirSync(path.join(sandbox,'server/scripts'),{recursive:true});
fs.copyFileSync(path.join(root,'src/contract.ts'),path.join(sandbox,'src/contract.ts'));
for(const dir of ['src','skills'])fs.cpSync(path.join(root,'server',dir),path.join(sandbox,'server',dir),{recursive:true});
fs.copyFileSync(path.join(root,'server/package.json'),path.join(sandbox,'server/package.json'));
fs.symlinkSync(path.join(root,'server/node_modules'),path.join(sandbox,'server/node_modules'),'junction');
for(const name of ['smoke-local-generation.mjs','smoke-local-generation-restart.mjs']) {
 fs.copyFileSync(path.join(root,'server/scripts',name),path.join(sandbox,'server/scripts',name));
 process.stdout.write(execFileSync(process.execPath,['--import','tsx','scripts/'+name],{cwd:path.join(sandbox,'server'),encoding:'utf8',env:{...process.env,QIJI_TEST_SNAPSHOT:'1',ADMIN_TOKEN:'admin-dev'}}));
}
console.log('Isolated sandbox: '+sandbox);
