/**
 * 简梦 JA 视频渠道翻译器（Seedance 2 异步）。
 *
 * 上游本身是"提交→拿 task_id→轮询"架构：
 *   POST /v1/videos              → { task_id }
 *   GET  /v1/videos/{task_id}    → { status, video_url, ... }
 * 终态 completed 取 video_url（链接仅 6 小时有效）。
 * 素材引用：image_url（整体参考）+ extra_images/videos/audios（需在 prompt 用 @tag 引用才生效），均须公网 HTTPS。
 */
import { buildPrompt } from "./prompt.ts";
import { maskToken } from "../store/logs.ts";
import { getAsset } from "../store/assets.ts";
import type { Upstream } from "./upstream.ts";
import { submitSignal } from "./submitTimeout.ts";
import { numberParam, stringParam } from "./paramPass.ts";
import type { OnUpstream } from "./openai.ts";
import type { GenerateRequest, AssetRef } from "../contract.ts";

/** 视频翻译器通用回执（submit→poll 两段；各渠道翻译器共用，见 videos.ts / index.ts 的 VideoDriver） */
export type VideoSubmit = { ok: true; taskId: string } | { ok: false; error: string };
export type VideoPoll =
	| { status: "queued" | "running"; progress: number }
	| {
		status: "completed"; videoUrl: string; coverUrl?: string;
		/** 结果下载需携带的请求头（第153轮：简梦Z 图片结果链接须带 Bearer 且仅本站域下发，防密钥外泄）；缺省=裸 fetch */
		resultHeaders?: Record<string, string>;
	}
	| { status: "failed"; error: string };

/**
 * 把素材引用解析为公网可达 URL（垫图/参考图）。
 * 与 gemini.baseImagePart 同一思路——**id 为主、url 兜底**：
 *   ① 优先按 ref.id 取资产记录的 OSS 公网直链（id 是真理，url 仅缓存、6h 会过期）；
 *   ② 否则用传入的 ref.url。
 * 区别在于视频上游要的是 URL（image_url），不是内联字节，故 id 解析为 OSS 直链而非 bytes。
 * 注：未配 OSS 时资产仅内存态、只有 localhost /raw 直链，上游不可达——属已知限制（需公网部署/OSS）。
 */
/** webview 伪域直链（http://asset.localhost/... 等）——只在客户端 webview 内可达，发上游必失败，一律拒收 */
function isWebviewLocalUrl(u: string): boolean {
	try {
		return new URL(u).hostname.toLowerCase().endsWith(".localhost");
	} catch {
		return false;
	}
}

export function toPublicUrl(ref: AssetRef): string | undefined {
	if (ref.id) {
		const rec = getAsset(ref.id);
		if (rec?.url && /^https?:\/\//i.test(rec.url) && !isWebviewLocalUrl(rec.url)) return rec.url;
	}
	if (ref.url && /^https?:\/\//i.test(ref.url) && !isWebviewLocalUrl(ref.url)) return ref.url;
	return undefined;
}

/** 解析为 {url, name} 列表（仅保留公网可达的），用于按名注入 @tag / 作 referenceImages */
export function resolveNamed(refs?: AssetRef[]): { url: string; name?: string }[] {
	const out: { url: string; name?: string }[] = [];
	for (const r of refs ?? []) {
		const url = toPublicUrl(r);
		if (url) out.push({ url, name: r.name });
	}
	return out;
}

/**
 * 把素材按顺序注入 prompt 的 @tag 引用（简梦：extra_images→@Image1.. / videos→@Video1.. / audios→@Audio1..）。
 * tag 编号 = 素材在「同模态分组」内的 1-based 序号，与发往上游的 extra_ / reference 数组顺序严格一致。
 * 注入规则（幂等，三种来源殊途同归到「名字后紧贴 tag」的模型所需样式）：
 *  ① prompt 已含该 tag（前端「提取资产」写的图例「@Image1 是 张起灵」/「@素材」按钮插的「张起灵@Image1 」）→ 跳过；
 *  ② 资产名命中正文 → 名字后紧贴 tag（「张起灵」→「张起灵@Image1 」，符合上游所需样式）；
 *  ③ 都没有 → 末尾追加一条参考行，确保该参考素材被 prompt 引用（上游须 @tag 才生效）。
 */
function injectTags(prompt: string, items: { url: string; name?: string }[], kind: "Image" | "Video" | "Audio"): string {
	let out = prompt;
	items.forEach((it, i) => {
		const tag = `@${kind}${i + 1}`;
		// \b 词边界避免 @Image1 误命中 @Image10/@Image11
		if (new RegExp(`${tag}(?!\\d)`).test(out)) return; // 已显式引用（图例/手动/上一轮）
		if (it.name && out.includes(it.name)) {
			out = out.replace(it.name, `${it.name}${tag} `); // 名字后紧贴 tag + 空格（仅首次出现）
		} else {
			const label = kind === "Image" ? "图" : kind === "Video" ? "视频" : "音频";
			out += `${out.endsWith("\n") ? "" : "\n"}参考${label}${it.name ? `「${it.name}」` : ""}：${tag} `;
		}
	});
	return out;
}

/**
 * 三模态统一注入（images→@Image / videos→@Video / audios→@Audio），供各视频翻译器共用。
 * 各组按传入数组顺序编号；数组本身即发往上游的 extra_ / reference 顺序，保证 tag 与素材一一对应。
 */
export function injectReferenceTags(
	prompt: string,
	refs: { images?: { url: string; name?: string }[]; videos?: { url: string; name?: string }[]; audios?: { url: string; name?: string }[] },
): string {
	let out = prompt;
	out = injectTags(out, refs.images ?? [], "Image");
	out = injectTags(out, refs.videos ?? [], "Video");
	out = injectTags(out, refs.audios ?? [], "Audio");
	return out;
}

/** ① 提交视频生成任务 → 返回上游 task_id */
export async function submitJianmengVideo(req: GenerateRequest, up: Upstream, onUpstream?: OnUpstream): Promise<VideoSubmit> {
	if (!up.apiKey) {
		return { ok: false, error: "简梦视频未配置上游密钥（管理端模型设置或环境 JIANMENG_API_KEY）" };
	}
	// 资产素材 → extra_images（≤9，全部按名注入 @ImageN 引用）；视频/音频同理
	const imgs = resolveNamed(req.inputs?.images).slice(0, 9);
	const vids = resolveNamed(req.inputs?.videos).slice(0, 3);
	const auds = resolveNamed(req.inputs?.audios).slice(0, 3);
	// ⚠ 时长/比例原样透传，绝不静默改写（§9 第188轮定稿；第215轮根除本处旧夹钳 [4,15]——它把请求 20s
	//   静默砍成 15s、按秒计费却按 20 扣=多扣钱少交货）。非法值由上游明确报错（失败自动退款）。
	const duration = numberParam(req.params?.duration, 15);

	// prompt 注入 @tag（id/url 在 extra_*；@tag 在文本里引用才生效）
	let prompt = buildPrompt(req);
	prompt = injectReferenceTags(prompt, { images: imgs, videos: vids, audios: auds });

	const body: Record<string, unknown> = {
		model: up.upstreamModel,
		prompt,
		duration,
		aspect_ratio: stringParam(req.params?.aspect_ratio, "16:9"),
	};
	// 整体参考图（首帧/故事板）：客户端经 params.firstFrameUrl 传入，无需 @tag
	const firstFrame = typeof req.params?.firstFrameUrl === "string" ? req.params.firstFrameUrl : "";
	if (/^https?:\/\//i.test(firstFrame)) body.image_url = firstFrame;
	if (imgs.length) body.extra_images = imgs.map((x) => x.url);
	if (vids.length) body.extra_videos = vids.map((x) => x.url);
	if (auds.length) body.extra_audios = auds.map((x) => x.url);

	onUpstream?.({ request: { url: `${up.baseUrl}/v1/videos`, method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${maskToken(up.apiKey)}` }, body } });

	let resp: Response;
	try {
		resp = await fetch(`${up.baseUrl}/v1/videos`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${up.apiKey}` },
			body: JSON.stringify(body),
			signal: submitSignal(),
		});
	} catch (err) {
		return { ok: false, error: `简梦提交失败：${(err as Error).message}` };
	}
	const data: any = await resp.json().catch(() => ({}));
	onUpstream?.({ response: { httpStatus: resp.status, body: data } });
	if (!resp.ok) {
		return { ok: false, error: data?.error?.message || data?.message || `简梦提交 HTTP ${resp.status}` };
	}
	const taskId = data?.task_id || data?.id;
	if (!taskId) return { ok: false, error: "简梦提交未返回 task_id" };
	return { ok: true, taskId: String(taskId) };
}

/** ② 轮询上游任务状态（终态时把上游原始响应并入日志 ④） */
export async function pollJianmengVideo(up: Upstream, taskId: string, onUpstream?: OnUpstream): Promise<VideoPoll> {
	let resp: Response;
	try {
		resp = await fetch(`${up.baseUrl}/v1/videos/${encodeURIComponent(taskId)}`, {
			headers: { Authorization: `Bearer ${up.apiKey}` },
			signal: AbortSignal.timeout(30000),
		});
	} catch {
		// 网络抖动：当作仍在进行，让上层下一拍继续轮询
		return { status: "running", progress: 50 };
	}
	const data: any = await resp.json().catch(() => ({}));
	if (!resp.ok) {
		onUpstream?.({ response: { phase: "poll", httpStatus: resp.status, body: data } });
		return { status: "failed", error: data?.error?.message || `简梦轮询 HTTP ${resp.status}` };
	}
	const st = String(data?.status || "");
	if (st === "completed") {
		onUpstream?.({ response: { phase: "completed", httpStatus: resp.status, body: data } });
		if (!data?.video_url) return { status: "failed", error: "简梦完成但未返回 video_url" };
		return { status: "completed", videoUrl: String(data.video_url), coverUrl: data?.cover_url };
	}
	if (st === "failed") {
		onUpstream?.({ response: { phase: "failed", httpStatus: resp.status, body: data } });
		return { status: "failed", error: data?.error?.message || data?.message || "简梦生成失败" };
	}
	const p = Number(data?.progress);
	return { status: st === "queued" ? "queued" : "running", progress: Number.isFinite(p) && p > 0 ? Math.min(95, p) : 50 };
}
