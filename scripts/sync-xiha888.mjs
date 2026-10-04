// 只读生产；仅同步 xiha888 及其模型/家族/模式依赖，生产密钥在远端移除。
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const root=path.resolve('server/data'), stamp=new Date().toISOString().replace(/[:.]/g,'-');
const backup=path.join(root,'backups','xiha888-sync-'+stamp);fs.mkdirSync(backup,{recursive:true});
const remote=`const fs=require('fs');const read=n=>JSON.parse(fs.readFileSync('/app/server/data/'+n+'.json'));const channel=read('channels').channels.find(c=>c.id==='ch_mu7s96848'&&c.baseUrl==='https://api.lk888.ai');if(!channel)throw Error('channel missing');channel.apiKey='';const models=read('models').models.filter(m=>m.channelId===channel.id).map(({apiKey,...m})=>m);const familyIds=new Set(models.map(m=>m.familyId));const modeIds=new Set(models.map(m=>m.modeId));console.log(JSON.stringify({channel,models,families:read('families').families.filter(f=>familyIds.has(f.id)),modes:read('modes').modes.filter(m=>modeIds.has(m.id))}));`;
const raw=execFileSync('C:/Program Files/Git/usr/bin/ssh.exe',['-o','BatchMode=yes','qiji','docker exec -i qiji-server node -'],{input:remote,encoding:'utf8',timeout:30000});
const snapshot=JSON.parse(raw); assert.equal(snapshot.models.length,5);
fs.writeFileSync(path.join(backup,'production-channel.json'),JSON.stringify(snapshot,null,2));
for(const [name,items] of [['channels',[snapshot.channel]],['models',snapshot.models],['families',snapshot.families],['modes',snapshot.modes]]){
 const file=path.join(root,name+'.json');const original=fs.readFileSync(file,'utf8');fs.writeFileSync(path.join(backup,name+'.json'),original);
 const store=JSON.parse(original), ids=new Set(items.map(x=>x.id));
 const untouched=store[name].filter(x=>!ids.has(x.id));
 for(const item of items){const i=store[name].findIndex(x=>x.id===item.id); if(i<0)store[name].push(item);else store[name][i]=item;}
 assert.deepEqual(store[name].filter(x=>!ids.has(x.id)),untouched);
 store.deletedSeedIds=store.deletedSeedIds?.filter(id=>!ids.has(id));
 store.version=(store.version||0)+1;
 fs.writeFileSync(file+'.tmp',JSON.stringify(store,null,2));fs.renameSync(file+'.tmp',file);
 const after=JSON.parse(fs.readFileSync(file)); for(const item of items)assert.deepEqual(after[name].find(x=>x.id===item.id),item);
}
console.log(JSON.stringify({channel:snapshot.channel.name,channelId:snapshot.channel.id,models:snapshot.models.map(m=>m.id),families:snapshot.families.length,modes:snapshot.modes.length,backup,verified:true}));
