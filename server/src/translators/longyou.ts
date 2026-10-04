/**
 * 龙幽：用户提供的异步视频文档（2026-09-15）。Bearer 鉴权，Base URL 可带 /v1。
 * POST /v1/videos -> task_id/id；GET /v1/videos/{id}，先判状态再取 video_url/url。
 * images/videos 为 URL 数组；引用语法「图片N」「视频N」。音频字段文档明确未实测，暂拒绝。
 * duration 必须正整数；其余显式参数原样透传。上游未公布素材上限、完整时长和价格。
 * 情报源：GET https://api.hjmie.cc.cd/v1/models（Bearer）；/api/pricing（站点登录）。
 * 2026-09-12 历史无凭据探测为 401；/llms.txt 为 HTML。2026-09-15 Web 工具无法打开，未核实在线目录。
 * 成片代理带 video_token，可直接服务端下载并转存；不附生成密钥给结果链接。
 */
import { buildPrompt } from './prompt.ts';
import { resolveNamed, injectReferenceTags, type VideoSubmit, type VideoPoll } from './jianmeng.ts';
import { maskToken } from '../store/logs.ts';
import { numberParam, stringParam } from './paramPass.ts';
import { submitSignal } from './submitTimeout.ts';
import type { GenerateRequest } from '../contract.ts';
import type { Upstream } from './upstream.ts';
import type { OnUpstream } from './openai.ts';

const endpoint = (up: Upstream) => `${up.baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '')}/v1/videos`;
const SUCCESS = new Set(['completed', 'succeeded']);
const FAILED = new Set(['failed', 'cancelled']);
const QUEUED = new Set(['queued', 'pending', 'waiting']);
const state = (data: any) => String(data?.status ?? '').trim().toLowerCase();
function errorText(data: any, status: number): string {
  const msg = data?.error?.message || data?.error || data?.fail_reason || data?.message;
  return typeof msg === 'string' ? msg : `龙幽请求失败 HTTP ${status}`;
}
function publicUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value), h = u.hostname.toLowerCase();
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password
      && !/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)
      && !h.endsWith('.localhost') && !h.endsWith('.local') && !h.startsWith('[');
  } catch { return false; }
}

export async function submitLongyouVideo(req: GenerateRequest, up: Upstream, onUpstream?: OnUpstream): Promise<VideoSubmit> {
  if (!up.apiKey) return { ok: false, error: '龙幽未配置上游密钥（管理端龙幽渠道或 LONGYOU_API_KEY）' };
  if (!up.upstreamModel?.trim()) return { ok: false, error: '龙幽未配置上游模型名' };
  if (req.inputs?.audios?.length) return { ok: false, error: '龙幽音频参考尚未验证，请移除音频素材' };
  if (req.params?.method && req.params.method !== 'omni' || req.params?.lastFrameUrl)
    return { ok: false, error: '龙幽当前仅支持全能参考，不支持首尾帧方法' };
  const images = resolveNamed(req.inputs?.images), videos = resolveNamed(req.inputs?.videos);
  if (images.length !== (req.inputs?.images?.length ?? 0) || videos.length !== (req.inputs?.videos?.length ?? 0)
      || [...images, ...videos].some(x => !publicUrl(x.url)))
    return { ok: false, error: '龙幽参考素材必须全部提供公网 HTTP(S) 地址，请重新上传不可用素材' };
  let prompt = buildPrompt(req);
  if (!prompt.trim() || prompt.trim() === '{}') return { ok: false, error: '提示词不能为空' };
  prompt = injectReferenceTags(prompt, { images, videos })
    .replace(/@Image(\d+)(?!\d)/gi, '图片$1').replace(/@Video(\d+)(?!\d)/gi, '视频$1');
  // 故事板整体参考追加到末尾，已有素材编号不移动；不冒充上游首帧能力。
  if (req.params?.firstFrameUrl) {
    if (!publicUrl(req.params.firstFrameUrl)) return { ok: false, error: '故事板参考图必须提供公网 HTTP(S) 地址' };
    if (!images.some(x => x.url === req.params!.firstFrameUrl)) {
      images.push({ url: req.params.firstFrameUrl });
      prompt += `\n故事板整体参考：图片${images.length}`;
    }
  }
  const duration = numberParam(req.params?.duration, 15);
  if (typeof duration !== 'number' || !Number.isInteger(duration) || duration <= 0)
    return { ok: false, error: '龙幽视频时长必须为正整数秒' };
  const body: Record<string, unknown> = { model: up.upstreamModel, prompt, duration };
  const ratio = stringParam(req.params?.aspect_ratio ?? req.params?.ratio, '');
  const resolution = stringParam(req.params?.resolution, '');
  if (ratio) body.ratio = ratio;
  if (resolution) body.resolution = resolution;
  if (images.length) body.images = images.map(x => x.url);
  if (videos.length) body.videos = videos.map(x => x.url);
  const url = endpoint(up);
  onUpstream?.({ request: { url, method: 'POST', headers: { Authorization: `Bearer ${maskToken(up.apiKey)}`, 'Content-Type': 'application/json' }, body } });
  let resp: Response;
  try {
    resp = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${up.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: submitSignal() });
  } catch (e) { return { ok: false, error: `龙幽提交失败：${(e as Error).message}` }; }
  const data: any = await resp.json().catch(() => ({}));
  onUpstream?.({ response: { httpStatus: resp.status, body: data } });
  if (!resp.ok || data?.error || FAILED.has(state(data))) return { ok: false, error: errorText(data, resp.status) };
  const taskId = data?.task_id || data?.id;
  if (typeof taskId !== 'string' || !taskId.trim()) return { ok: false, error: '龙幽提交未返回 task_id/id' };
  return { ok: true, taskId };
}

export async function pollLongyouVideo(up: Upstream, taskId: string, onUpstream?: OnUpstream): Promise<VideoPoll> {
  let resp: Response;
  try {
    resp = await fetch(`${endpoint(up)}/${encodeURIComponent(taskId)}`, { headers: { Authorization: `Bearer ${up.apiKey}` }, signal: AbortSignal.timeout(30000) });
  } catch { return { status: 'running', progress: 50 }; }
  const data: any = await resp.json().catch(() => ({}));
  if (resp.status >= 500 || resp.status === 429) return { status: 'running', progress: 50 };
  onUpstream?.({ response: { phase: 'poll', httpStatus: resp.status, body: data } });
  if (!resp.ok || FAILED.has(state(data))) return { status: 'failed', error: errorText(data, resp.status) };
  if (SUCCESS.has(state(data))) {
    const videoUrl = [data?.video_url, data?.url, data?.metadata?.final_video_url].find(publicUrl);
    if (!videoUrl) return { status: 'failed', error: '龙幽完成但未返回成片链接' };
    return { status: 'completed', videoUrl };
  }
  const progress = Number(data?.progress);
  return { status: QUEUED.has(state(data)) ? 'queued' : 'running', progress: Number.isFinite(progress) ? Math.max(0, Math.min(99, progress)) : 50 };
}
