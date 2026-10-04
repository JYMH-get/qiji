import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
const root=fs.readFileSync('outputs/startup-usage-20260924/test-root.txt','utf8');
const cwd=path.join(root,'server');
// Exercise the existing-install startup path; empty-store route seeding is a
// separate pre-existing failure and is not part of this recovery regression.
const routingFile=path.join(cwd,'data/auto-routing.json');
const routing=JSON.parse(fs.readFileSync(routingFile,'utf8'));
fs.writeFileSync(routingFile,JSON.stringify({...routing,routeOnlyVersion:1}));
fs.copyFileSync('server/src/index.ts',path.join(cwd,'src/index.ts'));
fs.writeFileSync(path.join(cwd,'network-guard.mjs'),`globalThis.fetch=async()=>{throw new Error('Startup test forbids upstream requests')};`);
const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
const reports=[];
for(let run=0;run<2;run++) {
 const begin=performance.now();let output='';
 const child=spawn(process.execPath,['--import','./network-guard.mjs','--import','tsx','src/index.ts'],{cwd,env:{...process.env,PORT:String(port),QIJI_TEST_SNAPSHOT:'0',ADMIN_TOKEN:'admin-dev',NODE_ROLE:'source'},windowsHide:true,stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 const exited=new Promise(resolve=>child.once('exit',resolve));let ready;
 try {
  while(performance.now()-begin<45000) {
   if(child.exitCode!==null)throw Error('Startup process exited: '+output.slice(-1800));
   try{const response=await fetch(`http://127.0.0.1:${port}/ready`,{signal:AbortSignal.timeout(1000)});if(response.ok){ready=await response.json();break;}}catch{}
   await new Promise(r=>setTimeout(r,100));
  }
  assert.equal(ready?.ready,true,'full service becomes ready: '+output.slice(-1500));
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status,200);
  reports.push({run:run+1,readyMs:Math.round(performance.now()-begin)});
 } finally {
  child.kill('SIGTERM');await exited;
  fs.writeFileSync(`outputs/startup-usage-20260924/http-${run+1}.log`,output);
 }
}
fs.writeFileSync('outputs/startup-usage-20260924/http.json',JSON.stringify(reports,null,2));console.log(JSON.stringify(reports));
