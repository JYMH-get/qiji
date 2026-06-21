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
import type { Upstream } from "./upstream.ts";
import type { OnUpstream } from "./openai.ts";
import type { GenerateRequest, AssetRef } from "../contract.ts";

export type JianmengSubmit = { ok: true; taskId: string } | { ok: false; error: string };
export type JianmengPoll =
	| { status: "queued" | "running"; progress: number }
	| { status: "completed"; videoUrl: string; coverUrl?: string }
	| { status: "failed"; error: string };

function publicUrls(refs?: AssetRef[]): string[] {
	return (refs ?? []).map((r) => r.url).filter((u): u is string => !!u && /^https?:\/\//i.test(u));
}

/** ① 提交视频生成任务 → 返回上游 task_id */
export async function submitJianmengVideo(req: GenerateRequest, up: Upstream, onUpstream?: OnUpstream): Promise<JianmengSubmit> {
	if (!up.apiKey) {
		return { ok: false, error: "简梦视频未配置上游密钥（管理端模型设置或环境 JIANMENG_API_KEY）" };
	}
	const imgs = publicUrls(req.inputs?.images);
	const vids = publicUrls(req.inputs?.videos);
	const auds = publicUrls(req.inputs?.audios);
	const durationRaw = Number(req.params?.duration ?? 15);
	const duration = Math.max(4, Math.min(15, Math.round(durationRaw) || 15));

	const body: Record<string, unknown> = {
		model: up.upstreamModel,
		prompt: buildPrompt(req),
		duration,
		aspect_ratio: (req.params?.aspect_ratio as string) || "16:9",
	};
	if (imgs.length) {
		body.image_url = imgs[0]; // 全能参考图（整体视觉参考，无需 @tag）
		if (imgs.length > 1) body.extra_images = imgs.slice(1, 10);
	}
	if (vids.length) body.extra_videos = vids.slice(0, 3);
	if (auds.length) body.extra_audios = auds.slice(0, 3);

	onUpstream?.({ request: { url: `${up.baseUrl}/v1/videos`, method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${maskToken(up.apiKey)}` }, body } });

	let resp: Response;
	try {
		resp = await fetch(`${up.baseUrl}/v1/videos`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${up.apiKey}` },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(60000),
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
export async function pollJianmengVideo(up: Upstream, taskId: string, onUpstream?: OnUpstream): Promise<JianmengPoll> {
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
