import { getDualModeFeature } from '@/store/connectionStore';
import { supportsOfficialMaterials } from '@/services/materialPolicy';
import { useProjectStore } from '@/store/projectStore';
import { useCatalogStore } from '@/store/catalogStore';
import { startShotGeneration } from '@/services/generationQueue';
import { effectiveModelKey } from '@/components/ModelPicker';
import { ensurePublicUrl } from '@/lib/publicUrl';
import { mediaOf } from '@/lib/shotMaterials';
import { isIdentityShotMaterial } from '@/lib/shotMaterialOps';
import { buildAssetListVars } from '@/lib/assetVars';
import { buildNeighborVars } from '@/lib/inferContext';
import { resolvePresets, countUnifiedShots, gridPresetForShotCount, presetBody, hasGridInstruction } from '@/lib/presetSchemes';
import { buildImageParams } from '@/lib/genParams';
import { imageResolutionOptionsForKey, modelMethodsForKey, videoReqOptionsForKey } from '@/lib/modelOptions';
import { inferenceDurationLimit, normalInferenceStrategy, projectInferenceStrategy, resolveStrategyTemplate, type InferenceStrategy } from '@/lib/inferenceStrategy';
import { armPlaceholderSwap } from './placeholderSwap';
import { claimShotPreparation, currentRtcTarget, type ShotPreparation, type ShotSubmissionField } from './rtcShotSubmission';
import { resolveRtcGenerationDuration } from './rtcGenerationDuration';
import { isRtcFrameReference, planRtcVideoFrames } from './rtcFrameMaterials';
import type { ShotMaterial } from '@/services/projectFile';

/** RTC generation uses the shared queue; preparation owns a frozen request and a project-scoped lock. */
export function isSameSource(): boolean {
	return !getDualModeFeature() || !!useProjectStore.getState().mediaSettings?.imgVideoSameSource;
}
export function shotInferRunning(shotId: string): boolean {
	return useProjectStore.getState().inferTasks.some(t => t.shotId === shotId && t.mode === 'single' && t.status === 'running');
}
export interface ShotGenerationOptions {
	swapSegId?: string;
	/** Regeneration claims before creating its version placeholder. */
	preparation?: ShotPreparation;
}
async function withPreparation(
	episodeId: string, shotId: string, field: ShotSubmissionField,
	opts: ShotGenerationOptions | undefined, run: (claim: ShotPreparation) => Promise<boolean>,
): Promise<boolean> {
	const claim = opts?.preparation ?? claimShotPreparation(episodeId, shotId, field);
	if (!claim) return false;
	if (claim.episodeId !== episodeId || claim.shotId !== shotId || claim.field !== field) return false;
	try {
		if (!claim.alive() || (opts?.swapSegId && !claim.bindTarget(opts.swapSegId))) return false;
		return await run(claim);
	} catch (err) {
		if (claim.alive()) alert(err instanceof Error ? err.message : '素材准备失败，请重试。');
		return false;
	} finally { claim.release(); }
}

export async function inferShotPrompts(episodeId: string, shotId: string, options?: { strategy?: InferenceStrategy }): Promise<void> {
	await withPreparation(episodeId, shotId, 'infer', undefined, async claim => {
		const shot = claim.shot, ms = claim.mediaSettings;
		const text = (shot.scriptSegment || shot.prompt || '').trim();
		if (!text) throw new Error('该分镜没有原文，无法推理。请先在原文分段填写本镜内容。');
		const sameSource = isSameSource();
		const templates = useCatalogStore.getState().catalog?.templates ?? [];
		const strategy = structuredClone(normalInferenceStrategy(options?.strategy ?? projectInferenceStrategy(ms), templates));
		const template = resolveStrategyTemplate(templates, strategy.templateId);
		if (strategy.source === 'skill' ? !strategy.skillText?.trim() : !template) {
			throw new Error(strategy.source === 'skill' ? '请先导入或填写外部 Skills 内容' : '请选择可用的推理方案');
		}
		const templateId = strategy.source === 'skill' ? '' : template!.id;
		const inference = {
			source: strategy.source ?? 'template' as const,
			skillText: strategy.skillText,
			skillName: strategy.skillName,
			guidance: [strategy.guidance, shot.plotGuidance].filter(Boolean).join('\n\n'),
			durationLimit: inferenceDurationLimit(shot.overrides?.duration ?? shot.durationSec ?? ms.maxDuration),
		};
		const shots = structuredClone(useProjectStore.getState().episodes.find(e => e.id === episodeId)?.shots ?? []);
		const variables = { 原文: text, 视觉风格: useProjectStore.getState().visualStyle || '', ...buildAssetListVars(), ...buildNeighborVars(shots, shotId, sameSource) };
		const modelKey = effectiveModelKey('text') || undefined;
		const { startInfer } = await import('@/services/inferRun');
		if (!claim.alive()) return false;
		useProjectStore.getState().updateShot(episodeId, shotId, sameSource ? { unifiedPrompt: '' } : { storyboardPrompt: '', videoPrompt: '' });
		startInfer({ episodeId, mode: 'single', sameSource, shotId, templateId, inference, variables, modelKey });
		return true;
	});
}

export async function genShotStoryboard(episodeId: string, shotId: string, opts?: ShotGenerationOptions): Promise<boolean> {
	return withPreparation(episodeId, shotId, 'storyboard', opts, async claim => {
		const shot = claim.shot, ms = claim.mediaSettings, sameSource = isSameSource();
		let prompt = resolvePresets((sameSource ? shot.unifiedPrompt : shot.storyboardPrompt) || shot.scriptSegment || '');
		if (sameSource && (shot.unifiedPrompt || '').trim() && !hasGridInstruction(prompt)) {
			const gid = gridPresetForShotCount(countUnifiedShots(prompt)), body = gid ? presetBody(gid) : undefined;
			if (body) prompt = `${prompt}\n\n${body}`;
		}
		if (!prompt.trim()) throw new Error(sameSource ? '该分镜还没有同源提示词，请先「推理提示词」生成，或手动填写。' : '该分镜还没有故事板提示词，请先「推理提示词」生成，或手动填写。');
		// Model, options and all user input are fixed before the first upload awaits.
		const modelKey = effectiveModelKey('image') || undefined;
		const params = buildImageParams({ aspect: ms.imageAspect ?? '16:9', ...(ms.imageResolution !== undefined ? { resolution: ms.imageResolution } : {}), quality: ms.imageQuality ?? 'high' }, imageResolutionOptionsForKey(modelKey || ''));
		const imgs: { url: string; name?: string }[] = [];
		for (const m of shot.materials) {
			if (mediaOf(m) !== 'image') continue;
			if (!m.uri) throw new Error(`素材「${m.name}」没有图片，请补图或删除该素材后重试。`);
			if (!claim.alive()) return false;
			const url = await ensurePublicUrl(m.uri, { name: m.name, shouldContinue: claim.alive });
			if (!claim.alive()) return false;
			if (!url) throw new Error(`素材「${m.name}」无法取得公网直链，请重新上传该素材或删除后重试。`);
			imgs.push({ url, name: m.name });
		}
		if (!claim.alive()) return false;
		const pendingId = startShotGeneration({ episodeId, shotId, field: 'storyboard', purpose: 'asset.scene.image', prompt, params,
			input: imgs.length ? { images: imgs } : undefined, modelKey, label: `${shot.title || '分镜'}·故事板`, rtcTarget: claim.rtcTarget });
		if (opts?.swapSegId) armPlaceholderSwap(pendingId, episodeId, shotId, opts.swapSegId);
		return true;
	});
}

export async function genShotVideo(episodeId: string, shotId: string, opts?: ShotGenerationOptions): Promise<boolean> {
	return withPreparation(episodeId, shotId, 'video', opts, async claim => {
		const shot = claim.shot, ms = claim.mediaSettings, sameSource = isSameSource();
		const genWithAsset = ms.genWithAsset ?? true, genWithStory = ms.genWithStory ?? false;
		const prompt = resolvePresets((sameSource ? shot.unifiedPrompt : shot.videoPrompt) || shot.scriptSegment || '');
		if (!prompt.trim()) throw new Error(sameSource ? '该分镜还没有同源提示词，请先「推理提示词」生成，或手动填写。' : '该分镜还没有视频提示词，请先「推理提示词」生成，或手动填写。');
		const explicitFirst = shot.materials.some(material => isRtcFrameReference(material) && material.rtcFrameRole === 'first');
		if (genWithStory && !shot.storyboardUri && !explicitFirst) throw new Error('已开启「带故事板」但该分镜尚未生成故事板，请先生成故事板（或到视频设置关闭「带故事板」）。');
		const ov = shot.overrides || {}, modelKey = ov.videoModelKey || effectiveModelKey('video') || undefined;
		const model = useCatalogStore.getState().model(modelKey || '');
		const methods = modelMethodsForKey(modelKey || ''), req = videoReqOptionsForKey(modelKey || '');
		const method = ov.method ?? ms.videoMethod ?? methods[0];
		const seg = claim.rtcTarget ? currentRtcTarget(claim.rtcTarget) : undefined;
		const params: Record<string, unknown> = {
			duration: resolveRtcGenerationDuration(seg?.generationDuration, seg?.targetDurationUs, req.durations, ov.duration ?? shot.durationSec ?? ms.maxDuration ?? req.durations[0] ?? 15),
			resolution: ov.resolution ?? ms.resolution ?? req.resolutions[0] ?? '720p',
			aspect_ratio: ov.aspect ?? ms.aspect ?? req.aspects[0] ?? '16:9',
			...(method !== undefined ? { method } : {}),
		};
		let originalImageIndex = 0;
		const materials = shot.materials.map(material => mediaOf(material) === 'image'
			? { ...material, usage: isIdentityShotMaterial(material, originalImageIndex++, ov.officialAssetIndexes) ? 'identity' as const : 'reference' as const } : material);
		const storyboard: ShotMaterial | undefined = genWithStory && shot.storyboardUri
			? { id: 'rtc-storyboard-reference', kind: 'local', media: 'image', name: '故事板', uri: shot.storyboardUri, usage: 'reference' } : undefined;
		const frames = planRtcVideoFrames(materials, prompt, { method, includeReferences: genWithAsset, storyboard });
		if (method === 'frames') {
			const imgCount = frames.refs.filter(m => mediaOf(m) === 'image').length;
			if ((!frames.explicitFrames && storyboard ? 1 : 0) + imgCount < 2) throw new Error('「首尾帧」方法需要两张图：首帧（故事板图或素材第 1 张图片）+ 尾帧（素材下一张图片）。请补齐图片素材后重试。');
		}
		if (storyboard && !frames.explicitFrames) {
			const firstFrameUrl = await ensurePublicUrl(storyboard.uri, { name: '故事板', shouldContinue: claim.alive });
			if (!claim.alive()) return false;
			if (!firstFrameUrl) throw new Error('故事板无法取得公网直链，请重新上传或生成故事板后重试。');
			params.firstFrameUrl = firstFrameUrl;
		}
		const images: { id?: string; url: string; name?: string; usage?: 'reference' | 'identity' }[] = [];
		const videos: { id?: string; url: string; name?: string }[] = [], audios: { id?: string; url: string; name?: string }[] = [];
		{
			for (const m of frames.refs) {
				if (!m.uri) throw new Error(`素材「${m.name}」没有文件，请补齐或删除该素材后重试。`);
				if (!claim.alive()) return false;
				const url = await ensurePublicUrl(m.uri, { name: m.name, shouldContinue: claim.alive });
				if (!claim.alive()) return false;
				if (!url) throw new Error(`素材「${m.name}」无法取得公网直链，请重新上传该素材或删除后重试。`);
				const md = mediaOf(m), fileId = useProjectStore.getState().blobByUri(m.uri)?.id;
				const base = { url, name: m.name, ...(fileId && !fileId.startsWith('LC-') ? { id: fileId } : {}) };
				if (md === 'video') videos.push(base);
				else if (md === 'audio') audios.push(base);
				else images.push({ ...base, usage: m.usage });
			}
		}
		const input: Record<string, unknown> = {};
		if (images.length) input.images = images;
		if (videos.length) input.videos = videos;
		if (audios.length) input.audios = audios;
		const officialIdx = supportsOfficialMaterials(model) ? images.flatMap((image, index) => image.usage === 'identity' ? [index] : []) : [];
		if (officialIdx.length) params.officialAssetIndexes = officialIdx;
		if (!claim.alive()) return false;
		const pendingId = startShotGeneration({ episodeId, shotId, field: 'video', purpose: 'video.generate', prompt: frames.prompt, params,
			input: Object.keys(input).length ? input : undefined, modelKey, label: `${shot.title || '分镜'}·视频`, rtcTarget: claim.rtcTarget });
		if (opts?.swapSegId) armPlaceholderSwap(pendingId, episodeId, shotId, opts.swapSegId);
		return true;
	});
}
