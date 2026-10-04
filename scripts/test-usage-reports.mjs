import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..'),sandbox=fs.mkdtempSync(path.join(os.tmpdir(),'qiji-usage-reports-'));
fs.mkdirSync(path.join(sandbox,'src'));fs.mkdirSync(path.join(sandbox,'server/scripts'),{recursive:true});
fs.copyFileSync(path.join(root,'src/contract.ts'),path.join(sandbox,'src/contract.ts'));
for(const dir of ['src','skills'])fs.cpSync(path.join(root,'server',dir),path.join(sandbox,'server',dir),{recursive:true});
fs.copyFileSync(path.join(root,'server/package.json'),path.join(sandbox,'server/package.json'));
fs.symlinkSync(path.join(root,'server/node_modules'),path.join(sandbox,'server/node_modules'),'junction');
const out=path.join(root,'outputs/company-usage-20260918');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'sandbox.txt'),sandbox);
for(const name of ['smoke-usage-reports.mjs','smoke-usage-reports-restart.mjs','smoke-usage-products.mjs','smoke-usage-products-restart.mjs','smoke-usage-products-restart.mjs']){
 fs.copyFileSync(path.join(root,'server/scripts',name),path.join(sandbox,'server/scripts',name));
 try{const output=execFileSync(process.execPath,['--import','tsx','scripts/'+name],{cwd:path.join(sandbox,'server'),encoding:'utf8',env:{...process.env,QIJI_TEST_SNAPSHOT:'1',ADMIN_TOKEN:'admin-dev'}});fs.writeFileSync(path.join(out,name+'.log'),output);process.stdout.write(output)}catch(e){fs.writeFileSync(path.join(out,name+'.log'),String(e.stdout)+String(e.stderr));throw e}
}
console.log('Sandbox: '+sandbox);
