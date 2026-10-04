import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const root=process.cwd(), testRoot=fs.mkdtempSync(path.join(os.tmpdir(),'qiji-token-billing-startup-'));
fs.mkdirSync(path.join(testRoot,'src'));
fs.mkdirSync(path.join(testRoot,'server/scripts'),{recursive:true});
fs.copyFileSync('src/contract.ts',path.join(testRoot,'src/contract.ts'));
for(const d of ['src','skills']) fs.cpSync('server/'+d,path.join(testRoot,'server',d),{recursive:true});
fs.copyFileSync('server/package.json',path.join(testRoot,'server/package.json'));
fs.symlinkSync(path.join(root,'server/node_modules'),path.join(testRoot,'server/node_modules'),'junction');
fs.mkdirSync(path.join(testRoot,'server/data'));
fs.writeFileSync(path.join(testRoot,'server/data/auto-routing.json'),JSON.stringify({version:0,enabled:false,lines:[]}));
const output='outputs/startup-usage-20260924';fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(output+'/test-root.txt',testRoot);
for(const f of ['smoke-text-billing.mjs','smoke-text-billing-restart.mjs','smoke-recovery-window.mjs','smoke-startup-recovery.mjs']) {
 fs.copyFileSync('server/scripts/'+f,path.join(testRoot,'server/scripts',f));
 const stdout=execFileSync(process.execPath,['--import','tsx','scripts/'+f],{cwd:path.join(testRoot,'server'),encoding:'utf8',timeout:120000,maxBuffer:4e6,env:{...process.env,QIJI_TEST_SNAPSHOT:'1',ADMIN_TOKEN:'admin-dev'}});
 fs.writeFileSync(output+'/'+f+'.log',stdout);console.log(stdout);
}
console.log('Isolated test data: '+testRoot);
