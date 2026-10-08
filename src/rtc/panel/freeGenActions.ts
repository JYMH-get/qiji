/** Legacy free placeholders use the shared purpose runner and carry their task address in the RTC document. */
import { useSyncExternalStore } from 'react';
import type { Purpose } from '@/contract';
import { ensurePublicUrl } from '@/lib/publicUrl';
import { useProjectStore } from '@/store/projectStore';
import { effectiveModelKey } from '@/components/ModelPicker';
import { resolvePresets } from '@/lib/presetSchemes';
import { imageResolutionOptionsForKey, videoReqOptionsForKey } from '@/lib/modelOptions';
import { runPurpose } from '@/services/purposeRunner';
import type { TaskExtra } from '@/services/adapters/types';
import type { RtcGenerationTarget } from '@/services/projectFile';
import type { RtcSegment } from '@/types/rtc';
import { rememberFreeRtcPreparation, discardFreeRtcPreparation, moveFreeRtcReceipt, updateFreeRtcTask, rememberFreeRtcTask, rememberFreeRtcCompletion, readFreeRtcCompletion, receivedFreeRtcTasks, deliverFreeRtcCompletion } from '@/services/rtcFreeGenerationDelivery';
import { AUDIO_GEN_UNSUPPORTED, buildFreeImageParams, buildFreeInput, buildFreeVideoParams, genCapabilityFor, genPurposeFor, packTaskRef, parseTaskRef, type FreeRefUrl, type RtcGenKind } from './rtcGenCore';
import { useRtcFreeGenStore } from './rtcFreeGenStore';
import { resolveRtcGenerationDuration } from './rtcGenerationDuration';
import { planRtcVideoFrames } from './rtcFrameMaterials';
import { armRunning, currentOwner, ownerAlive, liveSegment, markFailed, mirrorProgress, mirrorStatus, resolveRtcTarget, rtcSegments } from './rtcGenSink';

export type FreeGenResult = { ok: true } | { ok: false; error: string };
type Attachment = { owner: string; savePath: string | null; target: RtcGenerationTarget; taskRef?: string; previousTaskRef?: string; phase: 'preparing' | 'running'; media: RtcGenKind; name: string; createdAt: number };
const attached = new Map<string, Attachment>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
const keyOf = (owner: string, target: RtcGenerationTarget) => JSON.stringify([owner, target.episodeId, target.subDocId, target.segId]);
const ownerOf = (scope: Attachment) => {
	const state = useProjectStore.getState();
	if (state.projectInstanceId === scope.owner && !state.isProjectLoading && state.savePath !== scope.savePath) {
		moveFreeRtcReceipt({ projectInstanceId: scope.owner, savePath: scope.savePath }, { projectInstanceId: scope.owner, savePath: state.savePath }, scope.target);
		scope.savePath = state.savePath;
	}
	return { projectInstanceId: scope.owner, savePath: scope.savePath };
};
const owns = (scope: Attachment) => attached.get(keyOf(scope.owner, scope.target)) === scope;
const ownerCurrent = (scope: Attachment) => owns(scope) && ownerAlive(scope.owner);
const alive = (scope: Attachment) => {
	if (!owns(scope) || !ownerAlive(scope.owner) || useProjectStore.getState().isProjectLoading) return false;
	const seg = liveSegment(scope.target.segId, scope.target);
	return !!seg && seg.kind === 'placeholder' && (!scope.taskRef || seg.taskRef === scope.taskRef);
};
const guardOf = (scope: Attachment) => ({ target: scope.target, expectedTaskRef: scope.taskRef, shouldContinue: () => alive(scope) });
function detach(scope: Attachment): void {
	if (!owns(scope)) return;
	attached.delete(keyOf(scope.owner, scope.target)); notify();
}
const sameTarget = (a: RtcGenerationTarget, b: RtcGenerationTarget) => a.episodeId === b.episodeId && a.subDocId === b.subDocId && a.segId === b.segId;
const sameProject = (scope: Attachment, owner: string, savePath: string | null) => scope.owner === owner || (!!savePath && scope.savePath === savePath);
function adoptRunning(owner: string, savePath: string | null, target: RtcGenerationTarget, seg?: RtcSegment | null): boolean {
	const scope = [...attached.values()].find(candidate => sameProject(candidate, owner, savePath) && sameTarget(candidate.target, target)
		&& candidate.phase === 'running' && (!seg || seg.kind !== 'placeholder' || seg.status !== 'running' || !seg.taskRef || seg.taskRef === candidate.taskRef));
	if (!scope) return false;
	ownerOf(scope);
	attached.delete(keyOf(scope.owner, scope.target)); scope.owner = owner; scope.savePath = savePath; scope.target = target;
	attached.set(keyOf(owner, target), scope);
	// A disk snapshot may precede acceptance or still contain the previous attempt's result.
	if (seg?.kind === 'placeholder') {
		if (!scope.taskRef || seg.taskRef !== scope.taskRef) mirrorStatus(seg.id, { taskRef: undefined, rtcResult: undefined, resultTaskRef: undefined }, owner, { target });
		armRunning(seg.id, scope.taskRef, owner, { target });
	}
	notify();
	return true;
}
function replacePreviousAttempt(owner: string, savePath: string | null, target: RtcGenerationTarget): void {
	for (const scope of attached.values()) if (sameProject(scope, owner, savePath) && sameTarget(scope.target, target)) detach(scope);
}
export function freeGenBusy(segId: string): boolean {
	const target = resolveRtcTarget(segId);
	return !!target && attached.has(keyOf(currentOwner(), target));
}
export function useFreeGenPreparing(segId: string): boolean {
	useProjectStore(s => s.projectInstanceId);
	return useSyncExternalStore(
		listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
		() => { const target = resolveRtcTarget(segId); return !!target && attached.get(keyOf(currentOwner(), target))?.phase === 'preparing'; },
		() => false,
	);
}
export function segGenKind(seg: RtcSegment): RtcGenKind { return seg.genKind ?? seg.media ?? 'video'; }

export async function startFreeGen(segId: string): Promise<FreeGenResult> {
	const owner = currentOwner(), target = resolveRtcTarget(segId);
	const seg = target ? liveSegment(segId, target) : null;
	if (!seg || !target) return { ok: false, error: '该片段已被删除。' };
	if (seg.kind !== 'placeholder') return { ok: false, error: '该片段已经是结果片段，如需新版本请右键「重新生成」。' };
	if (attached.has(keyOf(owner, target))) return { ok: false, error: '该占位正在生成中，请等它结束。' };
	const savePath = useProjectStore.getState().savePath;
	if (adoptRunning(owner, savePath, target, seg)) return { ok: true };
	if (seg.status === 'running') return { ok: false, error: '该占位正在生成中，请等它结束。' };
	replacePreviousAttempt(owner, savePath, target);
	const scope: Attachment = { owner, target, savePath, previousTaskRef: seg.taskRef, phase: 'preparing', media: segGenKind(seg), name: seg.name || (segGenKind(seg) === 'image' ? '图片占位' : '视频占位'), createdAt: Date.now() };
	attached.set(keyOf(owner, target), scope); notify();
	let submitted = false, preparationError = '';
	try {
		const snapshot = structuredClone(seg), draft = structuredClone(useRtcFreeGenStore.getState().draftOf(segId));
		const ms = structuredClone(useProjectStore.getState().mediaSettings);
		const kind = segGenKind(snapshot), purpose = genPurposeFor(kind), cap = genCapabilityFor(kind);
		if (!purpose || !cap) return { ok: false, error: AUDIO_GEN_UNSUPPORTED };
		const rawPrompt = (draft.prompt || '').trim();
		if (!rawPrompt) return { ok: false, error: '请先填写提示词——生成需要知道要做什么。' };
		const modelKey = draft.modelKey || effectiveModelKey(cap);
		if (!modelKey) return { ok: false, error: '当前没有可用模型，请检查连接或选择模型。' };
		const videoReq = videoReqOptionsForKey(modelKey);
		const params = kind === 'video' ? {
			...buildFreeVideoParams(snapshot.targetDurationUs, ms, videoReq),
			duration: resolveRtcGenerationDuration(snapshot.generationDuration ?? 'auto', snapshot.targetDurationUs, videoReq.durations, 1),
			...(ms.videoMethod !== undefined ? { method: ms.videoMethod } : {}),
		} : buildFreeImageParams(ms, imageResolutionOptionsForKey(modelKey));
		const prompt = resolvePresets(rawPrompt), label = snapshot.name || (kind === 'video' ? '视频占位' : '图片占位');
		const frames = kind === 'video' ? planRtcVideoFrames(draft.refs, prompt, { method: ms.videoMethod }) : { refs: draft.refs, prompt };
		if (kind === 'video' && ms.videoMethod === 'frames' && frames.refs.filter(ref => ref.media === 'image').length < 2) throw new Error('「首尾帧」方法需要首帧与尾帧两张图片，请补齐素材后重试。');
		rememberFreeRtcPreparation(ownerOf(scope), target, { media: kind, name: label, createdAt: scope.createdAt }, scope.previousTaskRef);
		const refs: FreeRefUrl[] = [];
		for (const ref of frames.refs) {
			if (!alive(scope)) return { ok: false, error: '' };
			const url = await ensurePublicUrl(ref.uri, { name: ref.name, shouldContinue: () => alive(scope) });
			if (!alive(scope)) return { ok: false, error: '' };
			if (!url) { preparationError = `素材「${ref.name || '未命名'}」无法取得公网直链，请移除该素材或重新拖入后重试。`; return { ok: false, error: preparationError }; }
			refs.push({ url, name: ref.name, media: ref.media, ...(ref.rtcFrameRole ? { rtcFrameRole: ref.rtcFrameRole } : {}) });
		}
		if (!alive(scope)) return { ok: false, error: '' };
		scope.phase = 'running'; notify();
		updateFreeRtcTask(ownerOf(scope), target, { status: 'running' });
		armRunning(segId, undefined, owner, guardOf(scope));
		mirrorStatus(segId, { taskRef: undefined, rtcResult: undefined, resultTaskRef: undefined }, owner, guardOf(scope));
		submitted = true;
		void runOne({ scope, purpose, modelKey, kind, label, params, input: buildFreeInput(refs), prompt: frames.prompt });
		return { ok: true };
	} catch (err) {
		preparationError = alive(scope) ? (err instanceof Error ? err.message : '素材准备失败，请重试。') : '';
		return { ok: false, error: preparationError };
	} finally {
		if (!submitted && owns(scope)) {
			if (preparationError) updateFreeRtcTask(ownerOf(scope), target, { status: 'failed', error: preparationError });
			else discardFreeRtcPreparation(ownerOf(scope), target);
			detach(scope);
		}
	}
}

async function runOne(args: {
	scope: Attachment; purpose: Purpose; modelKey: string; kind: RtcGenKind; label: string;
	prompt?: string; params?: Record<string, unknown>; input?: Record<string, unknown>;
	resumeTask?: { taskId: string; adapterKey: string };
}): Promise<void> {
	const { scope, kind } = args, segId = scope.target.segId;
	const fail = (error: string) => {
		if (!owns(scope)) return;
		updateFreeRtcTask(ownerOf(scope), scope.target, { status: 'failed', error });
		markFailed(segId, error, scope.owner, guardOf(scope));
	};
	try {
		if (scope.taskRef && readFreeRtcCompletion(ownerOf(scope), scope.target, scope.taskRef)) {
			await deliverFreeRtcCompletion({ owner: ownerOf(scope), target: scope.target, taskRef: scope.taskRef, shouldContinue: () => ownerCurrent(scope) });
			return;
		}
		const r = await runPurpose(args.purpose, {
			modelKey: args.modelKey,
			...(args.resumeTask ? { resumeTask: args.resumeTask } : { prompt: args.prompt, params: args.params, input: args.input }),
			onTaskId: (taskId, adapterKey) => {
				if (!owns(scope)) return;
				const taskRef = packTaskRef(adapterKey, taskId);
				rememberFreeRtcTask(ownerOf(scope), scope.target, taskRef, scope.previousTaskRef);
				if (alive(scope)) armRunning(segId, taskRef, scope.owner, guardOf(scope));
				scope.taskRef = taskRef; // Keep accepted identity even if the project switched during submit.
			},
			onProgress: (progress, status, _partial, extra?: TaskExtra) => {
				if (owns(scope) && (status === 'running' || status === 'queued')) {
					updateFreeRtcTask(ownerOf(scope), scope.target, { progress, status: 'running' }, false);
					mirrorProgress(segId, progress, scope.owner, extra, guardOf(scope));
				}
			},
		});
		if (owns(scope) && r.status === 'success' && r.resultUri && scope.taskRef) {
			rememberFreeRtcCompletion(ownerOf(scope), scope.target, scope.taskRef, {
				uri: r.resultUri, assetId: r.assetId, media: kind, taskId: r.taskId, rawLink: r.rawLink, saveToOss: r.saveToOss,
			});
		}
		if (!owns(scope)) return;
		if (r.status === 'no_model') { fail('所选模型当前不可用，请换一个模型后重试。'); return; }
		if (r.status === 'failed') { fail(r.error || '生成失败'); return; }
		if (!r.resultUri) { fail('生成完成但没有取到结果文件，请重试。'); return; }
		if (scope.taskRef && ownerCurrent(scope)) await deliverFreeRtcCompletion({ owner: ownerOf(scope), target: scope.target, taskRef: scope.taskRef, shouldContinue: () => ownerCurrent(scope) });
	} catch (err) {
		fail(err instanceof Error ? err.message : '生成失败');
	} finally { detach(scope); }
}

/** Restore every episode. A same-process reopen adopts its runner instead of replacing taskCenter's handler. */
export function resumeFreeGens(): void {
	const owner = currentOwner(), savePath = useProjectStore.getState().savePath;
	if (!ownerAlive(owner)) return;
	// Adopt live requests before stale on-disk receipts can restore an older task identity.
	for (const scope of [...attached.values()]) {
		if (scope.owner !== owner && sameProject(scope, owner, savePath)) adoptRunning(owner, savePath, scope.target, liveSegment(scope.target.segId, scope.target));
	}
	for (const { target, seg } of rtcSegments()) {
		if (seg.kind === 'placeholder' && !attached.has(keyOf(owner, target))) adoptRunning(owner, savePath, target, seg);
	}
	for (const receipt of receivedFreeRtcTasks({ projectInstanceId: owner, savePath })) {
		if (attached.has(keyOf(owner, receipt.target))) continue;
		const seg = liveSegment(receipt.target.segId, receipt.target);
		if (!receipt.taskRef) {
			const error = '生成准备已中断，尚未取得任务回执，请重新生成。';
			if (receipt.status !== 'failed') updateFreeRtcTask({ projectInstanceId: owner, savePath }, receipt.target, { status: 'failed', error });
			if (seg?.kind === 'placeholder' && seg.status === 'running' && !seg.taskRef) markFailed(seg.id, error, owner, { target: receipt.target });
			continue;
		}
		if (receipt.status === 'failed') continue;
		if (seg?.kind === 'media' && seg.resultTaskRef === receipt.taskRef) {
			void deliverFreeRtcCompletion({ owner: { projectInstanceId: owner, savePath }, target: receipt.target, taskRef: receipt.taskRef });
		} else if (!seg || seg.kind !== 'placeholder') {
			const completed = readFreeRtcCompletion({ projectInstanceId: owner, savePath }, receipt.target, receipt.taskRef);
			const kind = receipt.media ?? completed?.media, purpose = kind ? genPurposeFor(kind) : null;
			const ref = parseTaskRef(receipt.taskRef);
			if (!kind || !purpose || ref?.kind !== 'task') continue;
			const scope: Attachment = { owner, savePath, target: receipt.target, taskRef: receipt.taskRef, phase: 'running', media: kind, name: receipt.name || '自由生成', createdAt: receipt.createdAt ?? Date.now() };
			attached.set(keyOf(owner, scope.target), scope); notify();
			void runOne({ scope, purpose, modelKey: '', kind, label: scope.name, resumeTask: { taskId: ref.taskId, adapterKey: ref.adapterKey } });
		} else if (seg?.kind === 'placeholder' && !attached.has(keyOf(owner, receipt.target))) {
			const canAdopt = !seg.taskRef || seg.taskRef === receipt.taskRef || receipt.supersededTaskRefs?.includes(seg.taskRef);
			if (!canAdopt || (seg.status === 'failed' && seg.taskRef === receipt.taskRef)) continue;
			if (seg.taskRef !== receipt.taskRef) mirrorStatus(seg.id, { rtcResult: undefined, resultTaskRef: undefined }, owner, { target: receipt.target });
			armRunning(seg.id, receipt.taskRef, owner, { target: receipt.target });
		}
	}
	for (const { target, seg } of rtcSegments()) {
		if (seg.kind !== 'placeholder' || seg.status !== 'running' || attached.has(keyOf(owner, target))) continue;
		const ref = parseTaskRef(seg.taskRef);
		if (!ref || ref.kind !== 'task') continue;
		const kind = segGenKind(seg), purpose = genPurposeFor(kind);
		if (!purpose) continue;
		replacePreviousAttempt(owner, savePath, target);
		const scope: Attachment = { owner, savePath, target, taskRef: seg.taskRef, phase: 'running', media: kind, name: seg.name || '占位', createdAt: Date.now() };
		attached.set(keyOf(owner, target), scope); notify();
		// resumeTask does not emit onTaskId; the document's explicit identity supersedes an older receipt.
		rememberFreeRtcTask(ownerOf(scope), target, seg.taskRef!);
		updateFreeRtcTask(ownerOf(scope), target, { media: kind, name: scope.name, createdAt: scope.createdAt, status: 'running' });
		void runOne({ scope, purpose, modelKey: '', kind, label: seg.name || '占位', resumeTask: { taskId: ref.taskId, adapterKey: ref.adapterKey } });
	}
}
export async function retryFreeGen(segId: string): Promise<FreeGenResult> { return startFreeGen(segId); }
