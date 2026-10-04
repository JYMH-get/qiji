import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
const src = `
import { splitSegment, trimSegment, removeSegments, setSegmentSpeed } from './src/lib/rtcOps.ts';
import { effectiveTransformAt, effectiveVolumeAt } from './src/lib/rtcKeyframes.ts';
import { createCompound } from './src/lib/rtcCompound.ts';
import { activeTextSegments } from './src/lib/rtcTextCore.ts';
import { videoStageAt } from './src/rtc/rtcPlayback.ts';
import { buildDraftContent } from './src/lib/jianyingDraft.ts';
import { JY_TRANSITIONS } from './src/lib/jyTransitions.ts';
const S=1000000;
const seg=(id, extra={})=>({id,kind:'media',media:'video',uri:'test://'+id,assetId:id,targetStartUs:0,targetDurationUs:10*S,sourceStartUs:0,sourceDurationUs:10*S,...extra});
const track=(id,type,segments,extra={})=>({id,type,segments,...extra});
const doc=(...tracks)=>({id:'fixture',name:'audit',fps:30,tracks});
const a=seg('a',{keyframes:{x:[{t:0,v:0},{t:10*S,v:1}]}});
const d=doc(track('v','video',[a]));
const split=splitSegment(d,'a',5*S); const right=split.tracks[0].segments[1];
const trim=trimSegment(d,'a','start',5*S).tracks[0].segments[0];
const av=seg('a',{volume:1.8}); const volDoc=doc(track('v','video',[av]));
const resolve=id=>({absPath:'C:/fixture/'+id+'.mp4',kind:'video',durationUs:10*S,width:1920,height:1080});
const volExport=buildDraftContent(volDoc,resolve);
const subtitle=seg('text',{media:undefined,assetId:undefined,uri:undefined,text:{content:'字幕'}});
const textDoc=doc(track('txt','text',[subtitle]),track('v','video',[seg('a')]));
const compound=createCompound(textDoc,['text','a'],{segId:'compound',subDocId:'sub'});
const trans=JY_TRANSITIONS.find(x=>x.previewKind==='dissolve');
const ta=seg('ta',{targetDurationUs:5*S,sourceDurationUs:5*S,transitionAfter:{effectId:trans.effectId,resourceId:trans.resourceId,name:trans.name,durationUs:1*S}});
const tb=seg('tb',{targetStartUs:5*S,targetDurationUs:5*S,sourceDurationUs:5*S});
const td=doc(track('tv','video',[ta,tb]));
const tc=createCompound(td,['ta','tb'],{segId:'tc',subDocId:'tsub'});
const locked=doc(track('locked','video',[a],{locked:true}));
const compoundExport=buildDraftContent(compound,resolve);
const transformed=seg('transformed',{transform:{x:0.25,y:0,scaleX:0.5,scaleY:0.5,rotation:30,opacity:0.8},keyframes:{x:[{t:0,v:0},{t:10*S,v:1}]},transitionAfter:ta.transitionAfter});
const transformedCompound=createCompound(doc(track('t','video',[transformed],{muted:true})),['transformed'],{segId:'comp-transform',subDocId:'sub-transform'});
const transformedExport=buildDraftContent(transformedCompound,resolve);
const inline=transformedExport.draftContent.materials.drafts[0].draft;
console.log(JSON.stringify({
 splitKeyframe:{atAbs6sBefore:effectiveTransformAt(a,6*S).x,atAbs6sAfter:effectiveTransformAt(right,S).x},
 trimKeyframe:{atAbs6sBefore:effectiveTransformAt(a,6*S).x,atAbs6sAfter:effectiveTransformAt(trim,S).x},
 boostedVolume:{ui:av.volume,preview:effectiveVolumeAt(av,0),exported:volExport.draftContent.tracks[0].segments[0].volume},
 compoundSubtitle:{hostType:compound.tracks.find(t=>t.segments.some(s=>s.id==='compound')).type,videoBefore:videoStageAt(textDoc,S).layers.length,videoAfter:videoStageAt(compound,S).layers.length,textBefore:activeTextSegments(textDoc,S).length,textAfter:activeTextSegments(compound,S).length,exportTrackCount:compoundExport.draftContent.tracks.length,exportWarnings:compoundExport.warnings},
 compoundExportLoss:{sourceTransform:transformed.transform,exportTransform:inline.tracks[0].segments[0].clip,sourceKeyframes:transformed.keyframes,exportKeyframes:inline.tracks[0].segments[0].common_keyframes??null,sourceTrackMuted:true,exportTrackAttribute:inline.tracks[0].attribute??null,warnings:transformedExport.warnings},
 compoundTransition:{before:videoStageAt(td,4.75*S).layers.map(x=>({id:x.trackId,ghost:x.ghost,fx:x.fx})),after:videoStageAt(tc,4.75*S).layers.map(x=>({id:x.trackId,ghost:x.ghost,fx:x.fx}))},
 lockBypass:{remainingAfterDelete:removeSegments(locked,['a']).tracks[0].segments.length,speedAfterSet:setSegmentSpeed(locked,'a',2).tracks[0].segments[0].speed}
},null,2));
`;
const out=await build({stdin:{contents:src,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,platform:'node',format:'esm',logLevel:'silent',tsconfig:'tsconfig.json'});
await writeFile('outputs/rtc-audit-20261004/editor-pure-repro.bundle.mjs',out.outputFiles[0].text);
await import(new URL('./editor-pure-repro.bundle.mjs',import.meta.url));
