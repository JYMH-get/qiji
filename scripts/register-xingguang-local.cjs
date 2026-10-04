// Offline registration from the verified isolated store. No business modules or network calls.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const source = process.argv[2];
if (!source || !fs.existsSync(path.join(source, '.qiji-xingguang-sandbox'))) throw Error('Verified sandbox required');
if (!process.env.XINGGUANG_REGISTRATION_KEY) throw Error('Registration key missing');
const target = path.join(root, 'server/data');
const specs = [
  ['channels.json','channels',x=>x.id==='ch-xingguang'],
  ['models.json','models',x=>x.channelId==='ch-xingguang'],
  ['modes.json','modes',x=>x.id==='xingguang'],
];
const prepared = specs.map(([file,field,pick])=>{
  const original = fs.readFileSync(path.join(target,file),'utf8'), data = JSON.parse(original);
  const additions = JSON.parse(fs.readFileSync(path.join(source,'data',file),'utf8'))[field].filter(pick);
  assert.equal(additions.length,1);
  const retained = data[field].filter(x=>!pick(x));
  for(const row of additions){
    if(data.deletedSeedIds?.includes(row.id)) throw Error('Deleted identity cannot be reused: '+row.id);
    if(!data[field].some(x=>x.id===row.id))data[field].push(row);
  }
  if(field==='channels'){
    const channel=data[field].find(pick);
    channel.apiKey=process.env.XINGGUANG_REGISTRATION_KEY;
    channel.updatedAt=new Date().toISOString();
  }
  if(typeof data.version==='number')data.version++;
  assert.deepEqual(data[field].filter(x=>!pick(x)),retained);
  return {file,field,pick,original,data,retained};
});
const backup=path.join(target,'backups','xingguang-'+new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(backup,{recursive:true});
for(const p of prepared)fs.writeFileSync(path.join(backup,p.file),p.original);
for(const p of prepared){
  assert.equal(fs.readFileSync(path.join(target,p.file),'utf8'),p.original,'Concurrent write: '+p.file);
  fs.writeFileSync(path.join(target,p.file+'.tmp'),JSON.stringify(p.data,null,2));
  fs.renameSync(path.join(target,p.file+'.tmp'),path.join(target,p.file));
  const actual=JSON.parse(fs.readFileSync(path.join(target,p.file),'utf8'));
  assert.deepEqual(actual[p.field].filter(x=>!p.pick(x)),p.retained);
}
console.log('Local Xingguang channel + generic model + mode registered; key configured; existing entries preserved. Backup: '+backup);
