import assert from 'node:assert/strict';
import fs from 'node:fs';
assert.ok(fs.existsSync(new URL('../.qiji-zongheng-sandbox', import.meta.url)));
const {listModels}=await import('../src/store/models.ts');
const {getChannel}=await import('../src/store/channels.ts');
const {getMode}=await import('../src/store/modes.ts');
const {resolveUpstream}=await import('../src/translators/upstream.ts');
const {isBuiltinProtocol}=await import('../src/store/protocols.ts');
assert.equal(getChannel('ch-zongheng').name,'纵横');
assert.equal(getMode('zongheng').name,'纵横');
assert.ok(isBuiltinProtocol('zongheng-video'));
const models=listModels().filter(m=>m.channelId==='ch-zongheng');
assert.deepEqual(models.map(m=>m.id),['zh-seedance-2.0','zh-seedance-2.5','zh-wan']);
assert.deepEqual(models.map(m=>m.upstreamModel),['sedanco2.0','XXseedacn2.5','wan-1080']);
assert.deepEqual(models.map(m=>m.familyId),['fam-seedance','fam-seedance-2-5','fam-wan']);
const {getFamily}=await import('../src/store/families.ts');
assert.equal(getFamily('fam-wan').name,'Wan');
for(const model of models){
 assert.equal(model.enabled,false);assert.equal(model.shareScope,'none');assert.equal(model.cost,1);
 assert.equal(model.matLimits,undefined);assert.deepEqual(model.methods,['omni','frames']);
 assert.deepEqual(model.params.map(p=>p.key),['duration','aspect_ratio','resolution','quality','negative_prompt','generate_audio']);
 assert.ok(model.params.every(p=>p.min===undefined&&p.max===undefined));
}
const fixture={id:'test',protocol:'zongheng-video',capability:'video',channelId:'ch-zongheng',upstreamModel:'公开模型',params:[]};
assert.equal(resolveUpstream(fixture).baseUrl,'https://cnd-coo-new.pages.dev/v1');
const retained=new URL('../retained.json',import.meta.url);
if(fs.existsSync(retained))assert.deepEqual(listModels().filter(m=>m.channelId!=='ch-zongheng'),JSON.parse(fs.readFileSync(retained)).filter(m=>m.channelId!=='ch-zongheng'));
const html=fs.readFileSync(new URL('../src/admin/index.html',import.meta.url),'utf8');
for(const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g))new Function(m[1]);
assert.ok(html.includes('"zongheng-video"'));
const index=fs.readFileSync(new URL('../src/translators/index.ts',import.meta.url),'utf8');
assert.ok(index.includes('"zongheng-video": { submit: submitZonghengVideo, poll: pollZonghengVideo }'));
assert.ok(index.includes('case "zongheng-video":'));assert.ok(index.includes('"zongheng-video": 10000'));
if(process.argv[2]==='seed'){console.log('PASS three generic models, separate families, unified parameters, placeholder pricing, closed catalog; existing models retained');process.exit(0);}
let calls=[],reply={code:0,success:true,task_id:'vid_test',status:'processing'},http=200,network=false;
globalThis.fetch=async(url,init)=>{calls.push({url:String(url),...init});if(network)throw Error('offline');return new Response(JSON.stringify(reply),{status:http});};
const {submitZonghengVideo:submit,pollZonghengVideo:poll}=await import('../src/translators/zongheng.ts');
const up={baseUrl:'https://cnd-coo-new.pages.dev/v1/',apiKey:'fake-secret-zongheng',upstreamModel:'公开模型'};
const req={model:'test',purpose:'video.generate',promptOverride:'人物动作',params:{duration:37,aspect_ratio:'7:5',resolution:'1440p',quality:'custom',generate_audio:false,negative_prompt:'文字',seed:123,firstFrameUrl:'https://ref.example/story.png'},inputs:{images:Array.from({length:12},(_,i)=>({url:`https://ref.example/${i}.png`,name:'图'+i})),videos:[{url:'https://ref.example/v.mp4'}],audios:[{url:'https://ref.example/a.mp3'}]}};
const before=structuredClone(req),logs=[];
for(const model of models){
 await submit(req,{...resolveUpstream(model),apiKey:up.apiKey});
 assert.equal(JSON.parse(calls.at(-1).body).model,model.upstreamModel);
 assert.equal(JSON.parse(calls.at(-1).body).duration,37);
}
assert.deepEqual(await submit(req,up,x=>logs.push(x)),{ok:true,taskId:'vid_test'});
let sent=JSON.parse(calls.at(-1).body);
assert.equal(calls.at(-1).url,'https://cnd-coo-new.pages.dev/v1/videos');
assert.equal(calls.at(-1).headers.Authorization,'Bearer '+up.apiKey);
assert.ok(calls.at(-1).headers['Idempotency-Key']);
assert.equal(sent.duration,37);assert.equal(sent.ratio,'7:5');assert.equal(sent.resolution,'1440p');
assert.equal(sent.images.length,13);assert.equal(sent.images[0],req.inputs.images[0].url);assert.equal(sent.images[12],req.params.firstFrameUrl);
assert.deepEqual(sent.reference_videos,['https://ref.example/v.mp4']);assert.deepEqual(sent.reference_audios,['https://ref.example/a.mp3']);
assert.equal(sent.generate_audio,false);assert.equal(sent.seed,123);assert.equal(sent.negative_prompt,'文字');assert.equal(sent.firstFrameUrl,undefined);
assert.ok(sent.prompt.includes('@Image13'));assert.ok(sent.prompt.includes('@Video1'));assert.ok(sent.prompt.includes('@Audio1'));
assert.deepEqual(req,before);assert.ok(!JSON.stringify(logs).includes(up.apiKey));
await submit({...req,params:{method:'frames'},inputs:{images:req.inputs.images.slice(0,3)}},up);
sent=JSON.parse(calls.at(-1).body);
assert.equal(sent.start_frame,req.inputs.images[0].url);assert.equal(sent.end_frame,req.inputs.images[1].url);assert.deepEqual(sent.images,[req.inputs.images[2].url]);
await submit({...req,params:{method:'frames',firstFrameUrl:'https://ref.example/start.png',lastFrameUrl:'https://ref.example/end.png'},inputs:{images:req.inputs.images.slice(0,1)}},up);
sent=JSON.parse(calls.at(-1).body);assert.equal(sent.start_frame,'https://ref.example/start.png');assert.equal(sent.end_frame,'https://ref.example/end.png');assert.equal(sent.images.length,1);
await submit({...req,params:{},inputs:{}},{...up,baseUrl:'https://cnd-coo-new.pages.dev'});
sent=JSON.parse(calls.at(-1).body);assert.equal(sent.duration,undefined);assert.equal(sent.resolution,undefined);
for(const bad of [{...req,promptOverride:'',inputs:{}},{...req,params:{method:'frames'},inputs:{}},{...req,inputs:{audios:[{url:'http://localhost/a'}]}},{...req,params:{ratio:'1:1',aspect_ratio:'16:9'}},{...req,params:{images:['https://ref.example/extra.png']}},{...req,params:{reference_videos:'bad'}},{...req,params:{start_frame:'file:///secret'}}]){
 const n=calls.length;assert.equal((await submit(bad,up)).ok,false);assert.equal(calls.length,n);
}
for(const badUp of [{...up,apiKey:''},{...up,upstreamModel:''}]){const n=calls.length;assert.equal((await submit(req,badUp)).ok,false);assert.equal(calls.length,n);}
for(const r of [{success:false,task_id:'bad',message:'业务失败'},{code:2,task_id:'bad'},{}]){reply=r;assert.equal((await submit(req,up)).ok,false);}
reply={error:{message:'余额不足'}};assert.equal((await submit(req,up)).error,'余额不足');
network=true;const n=calls.length;assert.equal((await submit(req,up)).ok,false);assert.equal(calls.length,n+1);network=false;
for(const status of ['processing','queued','unknown','completed','success']){reply={status,video_url:'https://cdn.example/out.mp4'};assert.equal((await poll(up,'a/b')).status,'running');}
assert.equal(calls.at(-1).url,'https://cnd-coo-new.pages.dev/v1/tasks/a%2Fb');
reply={status:'failed',error_code:'blocked',error_detail:'提示词未通过审核'};assert.equal((await poll(up,'x')).error,'提示词未通过审核');
reply={status:'succeeded'};assert.equal((await poll(up,'x')).status,'failed');
for(const key of ['video_url','url','result_url','download_url']){reply={status:'succeeded',[key]:'https://cnd-coo-new.pages.dev/api/video-content/vid_test'};const r=await poll(up,'x');assert.equal(r.status,'completed');assert.equal(r.resultHeaders.Authorization,'Bearer '+up.apiKey);}
reply={status:'succeeded',video_url:'https://cdn.example/out.mp4'};assert.equal((await poll(up,'x')).resultHeaders,undefined);
for(const status of [429,500,503]){http=status;assert.equal((await poll(up,'x')).status,'running');}
http=401;assert.equal((await poll(up,'x')).status,'failed');http=200;network=true;assert.equal((await poll(up,'x')).status,'running');network=false;
const {scrubChannelInfo}=await import('../src/errorScrub.ts');
const scrubbed=scrubChannelInfo('纵横 Zongheng https://cnd-coo-new.pages.dev failure');
assert.ok(scrubbed.includes('纵横'));assert.ok(!scrubbed.includes('cnd-coo-new.pages.dev'));assert.ok(!scrubbed.includes('Zongheng'));
console.log('PASS video media/frames/parameter preservation/guards/idempotency header/no retries/poll/auth/error scrub; zero live generation');
