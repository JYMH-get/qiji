/**
 * 奇迹云（qijicloud）视频翻译器（第249轮）：自建 autodl 云实例池 + ComfyUI 直驱。
 *
 * 与其它渠道的根本区别：**没有外部生成上游**——「上游」是我们自己在 autodl.art 租的
 * RTX PRO 6000 实例池（每台跑 ComfyUI + MiniMax H3 工作流）。本翻译器只做两件事：
 *   submit：组好提示词/参数/素材清单 → enqueueQijicloudJob 入本地队列（store/qijicloudPool.ts）——
 *           零外发 HTTP，排队/派单/上传素材/建图/提交/看护全在池的调度循环里；
 *   poll：  读池里的任务状态（零网络）——completed 时把成片 /view 直链交回通用轮询循环转存 OSS。
 *
 * ⚠ 模型更新情报源：无外部上游——工作流骨架在 translators/comfyGraph.ts（内嵌常量），
 *   用户在 ComfyUI 重导出工作流时更新那边的骨架常量（原件存档 资料/奇迹云H3工作流-jianyi933.json）；
 *   模型「上游模型名」=骨架名（jianyi933），管理端勿改。
 *
 * 提示词引用：injectReferenceTags 注入的 @ImageN/@VideoN/@AudioN 图例经 toOfficialTags 转写为
 * H3 官方标签 <Picture N>/<Video N>/<Audio N>（编号与 ref_image_N 0 基连线天然对齐）。
 * duration/resolution/aspect §9 原样透传（缺省不进 spec=骨架默认值兜底；非法值构图层明确报错）。
 * 成片 /view 直链无鉴权 → poll 不附 resultHeaders（「密钥只对本站域附头」规则天然满足）。
 */
import { buildPrompt } from "./prompt.ts";
import { resolveNamed, injectReferenceTags } from "./jianmeng.ts";
import type { VideoSubmit, VideoPoll } from "./jianmeng.ts";
import type { Upstream } from "./upstream.ts";
import { numberParam, stringParam } from "./paramPass.ts";
import { toOfficialTags } from "./comfyGraph.ts";
import { enqueueQijicloudJob, getQijicloudJob, queuePositionOf } from "../store/qijicloudPool.ts";
import type { OnUpstream } from "./openai.ts";
import type { GenerateRequest } from "../contract.ts";

/** 缺省（undefined/null/空串）→ undefined=不进 spec（骨架默认值兜底）；显式值经 numberParam 原样透传 */
function optionalNumber(raw: unknown): number | string | undefined {
	if (raw === undefined || raw === null || String(raw).trim() === "") return undefined;
	return numberParam(raw, NaN);
}

/** ① 提交：组装 JobSpec 入本地队列（零外发 HTTP；taskId=池 job id） */
export async function submitQijicloudVideo(req: GenerateRequest, up: Upstream, onUpstream?: OnUpstream): Promise<VideoSubmit> {
	const imgs = resolveNamed(req.inputs?.images);
	const vids = resolveNamed(req.inputs?.videos);
	const auds = resolveNamed(req.inputs?.audios);
	// 数量守卫（matLimits 已前置硬闸，这里兜底）：超限明确报错，绝不静默丢（丢一张=@tag 图例整段错位）
	if (imgs.length > 9) return { ok: false, error: `奇迹云 H3 最多 9 张图片素材（当前 ${imgs.length} 张），请减少后重试` };
	if (vids.length > 3) return { ok: false, error: `奇迹云 H3 最多 3 条视频素材（当前 ${vids.length} 条），请减少后重试` };
	if (auds.length > 3) return { ok: false, error: `奇迹云 H3 最多 3 条音频素材（当前 ${auds.length} 条），请减少后重试` };

	// ⚠ 空提示词判定必须在注入图例**之前**——带素材时图例行会追加在 "{}" 之后，
	//   注入后再判会被绕过（"{}"+图例 照样入队真跑 GPU；本轮沙盒实锤，勿挪回注入后）
	let prompt = buildPrompt(req);
	if (!prompt.trim() || prompt.trim() === "{}") {
		return { ok: false, error: "提示词不能为空：请填写视频描述后重试" };
	}
	prompt = injectReferenceTags(prompt, { images: imgs, videos: vids, audios: auds });
	prompt = toOfficialTags(prompt);

	// 带故事板（firstFrameUrl）：整体构图参考图追加 images 末尾（不前插防 <Picture N> 编号错位）
	const firstFrameUrl = typeof req.params?.firstFrameUrl === "string" && /^https?:\/\//i.test(req.params.firstFrameUrl)
		? req.params.firstFrameUrl
		: "";
	const images = imgs.map((x) => ({ url: x.url, name: x.name }));
	if (firstFrameUrl && !images.some((x) => x.url === firstFrameUrl)) {
		images.push({ url: firstFrameUrl, name: "故事板" });
		prompt += `${prompt.endsWith("\n") ? "" : "\n"}<Picture ${images.length}> 是本镜头的整体构图参考`;
		if (images.length > 9) {
			return { ok: false, error: `奇迹云 H3 最多 9 张图片素材（含故事板参考图共 ${images.length} 张），请减少图片素材后重试` };
		}
	}

	// §9 参数原样透传：显式给了才进 spec（缺省=骨架默认值兜底，构图层 buildH3Graph 对非法值明确报错）
	const durationSec = optionalNumber(req.params?.duration);
	const aspect = stringParam(req.params?.aspect_ratio, "") || undefined;
	const resolution = stringParam(req.params?.resolution, "") || undefined;

	const workflow = up.upstreamModel || "jianyi933";
	const spec = {
		workflow,
		prompt,
		durationSec,
		aspect,
		resolution,
		images,
		videos: vids.map((x) => ({ url: x.url, name: x.name })),
		audios: auds.map((x) => ({ url: x.url, name: x.name })),
	};
	// ③ 段：无外发 HTTP——记入队请求本身（排队/派单/上传/建图在池调度循环里，素材 URL 不重复展开）
	onUpstream?.({
		request: {
			queue: "qijicloud",
			workflow,
			materials: { images: images.length, videos: vids.length, audios: auds.length },
			params: { duration: durationSec, aspect_ratio: aspect, resolution },
		},
	});
	const r = enqueueQijicloudJob(spec);
	if (!r.ok) return { ok: false, error: r.error };
	return { ok: true, taskId: r.jobId };
}

/** ② 轮询：读池（零网络）。completed 交出 /view 直链（无鉴权，不附 resultHeaders）由通用循环转存 OSS */
export async function pollQijicloudVideo(_up: Upstream, jobId: string, onUpstream?: OnUpstream): Promise<VideoPoll> {
	const job = getQijicloudJob(jobId);
	if (!job) return { status: "failed", error: "奇迹云任务记录丢失（服务端队列已裁剪或数据异常）" };
	switch (job.state) {
		case "queued": {
			// 排队位次（第251轮）：客户端据此显示「排队中 · 第 3/8 位」；⚠ status 仍是 queued/running 二选一，
			// 由 tasks.getTaskState 归一为 running 下发（改 status 会牵动客户端一堆在途判定）
			const q = queuePositionOf(jobId);
			return q
				? { status: "queued", progress: 5, queuePosition: q.position, queueTotal: q.total }
				: { status: "queued", progress: 5 };
		}
		case "preparing":
			// 派单后：排队已定格 → 带上 queuedMs（终态写进请求记录「实际生成（排队）」）
			return { status: "running", progress: 12, queuedMs: job.queuedMs, stageText: "准备素材中" };
		case "running": {
			// 无逐帧进度源：按派单后耗时线性推进到 90（H3 单镜分钟级，观感够用）
			// ⚠ 计时基准=dispatchedAt（排队时长不计入生成进度，用户明令）
			const elapsed = Date.now() - (job.dispatchedAt ?? job.createdAt);
			return { status: "running", progress: Math.min(90, 15 + Math.floor(elapsed / 3000)), queuedMs: job.queuedMs };
		}
		case "completed": {
			// ④ 段：终态回执（实例只记名称，serviceUrl 在 resultUrl 里本就要下载、日志 ④ 段仅管理端可见）
			onUpstream?.({ response: { phase: "completed", instance: job.instanceUuid, promptId: job.promptId, resultUrl: job.resultUrl, warning: job.warning } });
			if (!job.resultUrl) return { status: "failed", error: "奇迹云任务完成但未产出成片链接", queuedMs: job.queuedMs };
			return { status: "completed", videoUrl: job.resultUrl, coverUrl: job.coverUrl, queuedMs: job.queuedMs };
		}
		case "failed":
			onUpstream?.({ response: { phase: "failed", instance: job.instanceUuid, promptId: job.promptId, error: job.error } });
			return { status: "failed", error: job.error || "奇迹云任务失败", queuedMs: job.queuedMs };
	}
}
