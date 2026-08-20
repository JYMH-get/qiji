/**
 * shotGenActions —— 实时剪辑右栏/舞台对「分镜占位符」的三个 AI 动作：
 *   推理提示词（单镜） / 生成故事板（生图） / 生成视频。
 *
 * ⚠ 红线（勿回退）：生成请求**只走库内唯一路径**——
 *   出图/出视频 = generationQueue.startShotGeneration（断连保护/任务态/结果落分镜全由它承载）；
 *   提示词推理 = inferRun.startInfer（锁定/找回同理）。
 *   本文件不拼任何提示词正文模板、不改写生成参数语义——参数组装逐行对齐 Frame161195
 *   的 genStoryboard/genVideo/inferShot（同一分镜行为的属性化视图，两处必须同尺）。
 */
import { useProjectStore } from "@/store/projectStore";
import { useCatalogStore } from "@/store/catalogStore";
import { startShotGeneration } from "@/services/generationQueue";
import { effectiveModelKey } from "@/components/ModelPicker";
import { ensurePublicUrl } from "@/lib/publicUrl";
import { mediaOf } from "@/lib/shotMaterials";
import { buildAssetListVars } from "@/lib/assetVars";
import { buildNeighborVars } from "@/lib/inferContext";
import { resolvePresets, countUnifiedShots, gridPresetForShotCount, presetBody, hasGridInstruction } from "@/lib/presetSchemes";
import { modelMethods, clampMethod, videoReqOptions, clampToOptions, clampDurationTo } from "@/lib/videoMethods";
import { clampDuration, imageResolutionOptions, clampImageResolution } from "@/lib/genParams";
import { SMART_INFER_SINGLE_TPL, SMART_INFER_UNIFIED_SINGLE_TPL } from "@/lib/smartInferPrompts";
import type { StoryboardShot } from "@/services/projectFile";
import { armPlaceholderSwap } from "./placeholderSwap";

// 图像「比例 × 分辨率」→ 出图 size（与 Frame161195 的 IMG_SIZE 同表——分镜行出图参数一把尺，勿改值；
// 导出供右栏「AI 生成属性」视图取比例档位/size 提示，值域单一来源）
export const IMG_SIZE: Record<string, Record<string, string>> = {
	"16:9": { "1K": "1280x720", "2K": "2048x1152", "4K": "3840x2160" },
	"9:16": { "1K": "720x1280", "2K": "1152x2048", "4K": "2160x3840" },
	"1:1": { "1K": "1024x1024", "2K": "2048x2048", "4K": "4096x4096" },
};

/** 项目是否图视同源模式（故事板/视频共用 unifiedPrompt） */
export function isSameSource(): boolean {
	return !!useProjectStore.getState().mediaSettings?.imgVideoSameSource;
}

/** 实时取最新分镜（组件传入的 shot 可能是陈旧快照） */
function liveShot(episodeId: string, shotId: string): StoryboardShot | undefined {
	return useProjectStore.getState().episodes.find((e) => e.id === episodeId)?.shots.find((s) => s.id === shotId);
}

/** 该分镜是否有单镜推理在途（锁定/按钮态用，非 hook——组件侧另行订阅 inferTasks） */
export function shotInferRunning(shotId: string): boolean {
	return useProjectStore.getState().inferTasks.some((t) => t.shotId === shotId && t.mode === "single" && t.status === "running");
}

/**
 * 推理提示词（单镜）：与 Frame161195.inferShot 同尺——覆盖语义（先清空该镜提示词），
 * 模板=视频设置所选（空=单卡默认；同源模式用同源单卡模板），走 startInfer 持久化运行。
 */
export async function inferShotPrompts(episodeId: string, shotId: string): Promise<void> {
	const shot = liveShot(episodeId, shotId);
	if (!shot) return;
	const text = (shot.scriptSegment || shot.prompt || "").trim();
	if (!text) { alert("该分镜没有原文，无法推理。请先在原文分段填写本镜内容。"); return; }
	if (shotInferRunning(shotId)) return; // 已在推理中 → 锁定
	const st = useProjectStore.getState();
	const sameSource = isSameSource();
	st.updateShot(episodeId, shotId, sameSource ? { unifiedPrompt: "" } : { storyboardPrompt: "", videoPrompt: "" }); // 覆盖：清空提示词
	const { startInfer } = await import("@/services/inferRun");
	const ms = useProjectStore.getState().mediaSettings;
	const stpl = sameSource ? (ms.unifiedSingleTplId || SMART_INFER_UNIFIED_SINGLE_TPL) : (ms.singleTplId || SMART_INFER_SINGLE_TPL);
	const freshShots = useProjectStore.getState().episodes.find((e) => e.id === episodeId)?.shots ?? [];
	startInfer({
		episodeId,
		mode: "single",
		sameSource,
		shotId,
		templateId: stpl,
		variables: { 原文: text, ...buildAssetListVars(), ...buildNeighborVars(freshShots, shotId, sameSource) },
		modelKey: effectiveModelKey("text") || undefined,
	});
}

/**
 * 生成故事板（生图）：与 Frame161195.genStoryboard 同尺——
 * 提示词=同源/故事板提示词（回退原文）+ 预设胶囊展开 + 同源宫格补丁；
 * 垫图=素材区全部**图像**素材（保序对齐 @ImageN，⚠ 一张都不许静默丢——不可用即明确报错不发请求）；
 * params={size,quality}，模型=生效图像模型。返回是否已提交。
 * opts.swapSegId：**图片占位**片段 id——提交后登记「成功即原位替换为 image 片段」监听
 * （placeholderSwap 对 field=storyboard 的台账天然落图片，与视频 swap 同一条机制，补充6）。
 */
export async function genShotStoryboard(episodeId: string, shotId: string, opts?: { swapSegId?: string }): Promise<boolean> {
	const shot = liveShot(episodeId, shotId);
	if (!shot) return false;
	const ms = useProjectStore.getState().mediaSettings;
	const sameSource = isSameSource();
	let prompt = resolvePresets((sameSource ? shot.unifiedPrompt : shot.storyboardPrompt) || shot.scriptSegment || "");
	// 图视同源宫格补丁（仅故事板图）：有推理产出的同源提示词、且未含宫格指令时按镜头数自动补
	if (sameSource && (shot.unifiedPrompt || "").trim() && !hasGridInstruction(prompt)) {
		const gid = gridPresetForShotCount(countUnifiedShots(prompt));
		const body = gid ? presetBody(gid) : undefined;
		if (body) prompt = `${prompt}\n\n${body}`;
	}
	if (!prompt.trim()) { alert(sameSource ? "该分镜还没有同源提示词，请先「推理提示词」生成，或手动填写。" : "该分镜还没有故事板提示词，请先「推理提示词」生成，或手动填写。"); return false; }
	// 垫图须公网可达；仅图像素材（保序对齐 @ImageN）。⚠ 不可用素材明确报错、请求不发出（编号错位红线）
	const imgs: { url: string; name?: string }[] = [];
	for (const m of shot.materials) {
		if (mediaOf(m) !== "image") continue;
		if (!m.uri) { alert(`素材「${m.name}」没有图片（资产未出图或上传失败）。垫图与提示词 @ 编号按位对应，缺一张会整体错位——请补图或删除该素材后重试。`); return false; }
		const u = await ensurePublicUrl(m.uri, { name: m.name });
		if (!u) { alert(`素材「${m.name}」无法取得公网直链（原文件失效或网络异常），请重新上传该素材或删除后重试。`); return false; }
		imgs.push({ url: u, name: m.name });
	}
	// 分辨率档按当前生效图像模型的 catalog params 收敛（服务端控档一把尺）
	const modelKey = effectiveModelKey("image") || "";
	const model = useCatalogStore.getState().model(modelKey);
	const resOptions = imageResolutionOptions(model);
	const imageAspect = ms.imageAspect ?? "16:9";
	const imageResolution = clampImageResolution(ms.imageResolution, resOptions).toUpperCase();
	const size = IMG_SIZE[imageAspect]?.[imageResolution] || "2048x1152";
	const pendingId = startShotGeneration({
		episodeId, shotId, field: "storyboard",
		purpose: "asset.scene.image",
		prompt, // → variables.prompt（视觉风格由 generationQueue 注入）
		params: { size, quality: ms.imageQuality ?? "high" },
		input: imgs.length ? { images: imgs } : undefined,
		modelKey: modelKey || undefined,
		label: `${shot.title || "分镜"}·故事板`,
	});
	// 图片占位：故事板生成成功 → 占位原位替换为 image 片段（target 不动；机制与视频 swap 同一条）
	if (opts?.swapSegId) armPlaceholderSwap(pendingId, episodeId, shotId, opts.swapSegId);
	return true;
}

/**
 * 生成视频：与 Frame161195.genVideo 同尺——
 * 单镜覆盖（overrides）优先、「要求」按当前模型 catalog 档位收敛；首尾帧前置校验；
 * 素材按模态分组保序（@ImageN/@VideoN/@AudioN），不可用即明确报错不发请求。
 * opts.swapSegId：占位符片段 id——提交后登记「成功即原位替换为 media 片段」监听。返回是否已提交。
 */
export async function genShotVideo(episodeId: string, shotId: string, opts?: { swapSegId?: string }): Promise<boolean> {
	const shot = liveShot(episodeId, shotId);
	if (!shot) return false;
	const ms = useProjectStore.getState().mediaSettings;
	const sameSource = isSameSource();
	const genWithAsset = ms.genWithAsset ?? true;
	const genWithStory = ms.genWithStory ?? false;
	const prompt = resolvePresets((sameSource ? shot.unifiedPrompt : shot.videoPrompt) || shot.scriptSegment || "");
	if (!prompt.trim()) { alert(sameSource ? "该分镜还没有同源提示词，请先「推理提示词」生成，或手动填写。" : "该分镜还没有视频提示词，请先「推理提示词」生成，或手动填写。"); return false; }
	if (genWithStory && !shot.storyboardUri) { alert("已开启「带故事板」但该分镜尚未生成故事板，请先生成故事板（或到视频设置关闭「带故事板」）。"); return false; }
	// 模型→方法→要求 按 catalog 解析（方法/档位服务端控；本地 CLI 模型无 catalog=仅全能参考）
	const ov = shot.overrides || {};
	const vModelKey = ov.videoModelKey || effectiveModelKey("video") || "";
	const vModel = useCatalogStore.getState().model(vModelKey);
	const methods = modelMethods(vModel);
	const method = clampMethod(ov.method || ms.videoMethod, methods);
	if (method === "frames") {
		// 首尾帧前置校验（与服务端同尺）：首帧=故事板图或素材第 1 张图；尾帧=素材下一张图
		const imgCount = genWithAsset ? shot.materials.filter((m) => { const md = mediaOf(m); return md !== "video" && md !== "audio"; }).length : 0;
		const frameSrc = (genWithStory && shot.storyboardUri ? 1 : 0) + imgCount;
		if (frameSrc < 2) {
			alert("「首尾帧」方法需要两张图：首帧（故事板图或素材第 1 张图片）+ 尾帧（素材下一张图片）。请补齐图片素材后重试。");
			return false;
		}
	}
	// 故事板 → 整体首帧参考；素材按模态分组（公网 url + name，保序对齐 @tag）
	let firstFrameUrl = "";
	if (genWithStory && shot.storyboardUri) firstFrameUrl = await ensurePublicUrl(shot.storyboardUri, { name: "故事板" });
	const images: { url: string; name?: string }[] = [];
	const videos: { url: string; name?: string }[] = [];
	const audios: { url: string; name?: string }[] = [];
	if (genWithAsset) {
		for (const m of shot.materials) {
			if (!m.uri) { alert(`素材「${m.name}」没有文件（资产未出图或上传失败）。垫素材与提示词 @ 编号按位对应，缺一条会整体错位——请补图或删除该素材后重试。`); return false; }
			const u = await ensurePublicUrl(m.uri, { name: m.name });
			if (!u) { alert(`素材「${m.name}」无法取得公网直链（原文件失效或网络异常），请重新上传该素材或删除后重试。`); return false; }
			const ref = { url: u, name: m.name };
			const md = mediaOf(m);
			if (md === "video") videos.push(ref);
			else if (md === "audio") audios.push(ref);
			else images.push(ref);
		}
	}
	const input: Record<string, unknown> = {};
	if (images.length) input.images = images;
	if (videos.length) input.videos = videos;
	if (audios.length) input.audios = audios;
	const req = videoReqOptions(vModel);
	const officialIdx = vModel?.officialAssets && method === "omni"
		? (ov.officialAssetIndexes ?? []).filter((i) => i >= 0 && i < images.length)
		: [];
	const pendingId = startShotGeneration({
		episodeId, shotId, field: "video",
		purpose: "video.generate",
		prompt,
		params: {
			duration: clampDurationTo(clampDuration(ov.duration || shot.durationSec || (ms.maxDuration ?? 15)), req.durations),
			resolution: clampToOptions(ov.resolution || (ms.resolution ?? "720p"), req.resolutions),
			aspect_ratio: clampToOptions(ov.aspect || (ms.aspect ?? "16:9"), req.aspects),
			...(firstFrameUrl ? { firstFrameUrl } : {}),
			...(methods.length > 1 ? { method } : {}),
			...(officialIdx.length ? { officialAssetIndexes: officialIdx } : {}),
		},
		input: Object.keys(input).length ? input : undefined,
		modelKey: vModelKey || undefined,
		label: `${shot.title || "分镜"}·视频`,
	});
	// 视频生成成功 → 占位符原位替换为 media 片段（target 不动，source=[0,视频时长]）
	if (opts?.swapSegId) armPlaceholderSwap(pendingId, episodeId, shotId, opts.swapSegId);
	return true;
}
