/**
 * 星光 XingAPI：用户视频文档（2026-09-28），Bearer + JSON。
 * POST /v1/videos/generations -> task_id/id；GET /v1/videos/{id}；成功后 /content 下载。
 * images/videos/audios 为公网 URL 数组，@ImageN/@VideoN/@AudioN 顺序引用。
 * 状态枚举按文档；未知状态及 429/5xx/网络抖动继续轮询。提交不自动重试。
 * 情报源：GET https://xingapi.top/v1/models（Bearer，按 Key 授权）；
 * GET https://xingapi.top/api/pricing（公开，金额单位未确认）；/llms.txt 实测为 HTML。
 * 不硬编码素材数量/模态限制；仅执行平台已有管理员 matLimits。
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
const SUCCESS = new Set(['success', 'completed', 'succeeded', 'done', 'finished']);
const FAILED = new Set(['failed', 'error', 'cancelled', 'canceled']);
const QUEUED = new Set(['queued', 'pending']);
const unwrap = (d: any) => d?.data && typeof d.data === 'object' && !Array.isArray(d.data) ? d.data : d;
const state = (d: any) => String(d?.status ?? '').trim().toLowerCase();
function errorText(d: any, status: number): string {
  const msg = d?.error?.message || d?.error || d?.fail_reason || d?.message;
  return typeof msg === 'string' ? msg : `星光请求失败 HTTP ${status}`;
}
function publicUrl(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  try {
    const u = new URL(v), h = u.hostname.toLowerCase();
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password
      && !/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)
      && !h.endsWith('.localhost') && !h.endsWith('.local') && !h.startsWith('[');
  } catch { return false; }
}

export async function submitXingguangVideo(req: GenerateRequest, up: Upstream, onUpstream?: OnUpstream): Promise<VideoSubmit> {
  if (!up.apiKey) return { ok: false, error: '星光未配置上游密钥（管理端星光渠道或 XINGGUANG_API_KEY）' };
  if (!up.upstreamModel?.trim()) return { ok: false, error: '星光未配置上游模型名' };
  let prompt = buildPrompt(req);
  if (!prompt.trim() || prompt.trim() === '{}') return { ok: false, error: '提示词不能为空' };
  const p = req.params ?? {};
  if (p.lastFrameUrl || p.method && p.method !== 'omni') return { ok: false, error: '星光当前接口未声明首尾帧方法，请使用全能参考' };
  if (p.ratio != null && p.aspect_ratio != null && String(p.ratio) !== String(p.aspect_ratio))
    return { ok: false, error: 'ratio 与 aspect_ratio 冲突，请统一宽高比' };
  const refs = { images: resolveNamed(req.inputs?.images), videos: resolveNamed(req.inputs?.videos), audios: resolveNamed(req.inputs?.audios) };
  for (const kind of ['images', 'videos', 'audios'] as const) {
    if (refs[kind].length !== (req.inputs?.[kind]?.length ?? 0) || refs[kind].some(x => !publicUrl(x.url)))
      return { ok: false, error: '星光参考素材必须全部提供公网 HTTP(S) 地址，请重新上传不可用素材' };
  }
  prompt = injectReferenceTags(prompt, refs);
  if (p.firstFrameUrl) {
    if (!publicUrl(p.firstFrameUrl)) return { ok: false, error: '故事板参考图必须提供公网 HTTP(S) 地址' };
    if (!refs.images.some(x => x.url === p.firstFrameUrl)) {
      refs.images.push({ url: p.firstFrameUrl });
      prompt += `\n故事板整体参考：@Image${refs.images.length}`;
    }
  }
  // 保留显式额外参数，仅移除已翻译的 Qiji 内部字段；统一媒体字段不静默覆盖。
  const { aspect_ratio, firstFrameUrl, lastFrameUrl, method, ...extra } = p;
  const body: Record<string, unknown> = { ...extra, model: up.upstreamModel, prompt, duration: numberParam(p.duration, 10) };
  if (body.ratio == null && aspect_ratio != null) body.ratio = stringParam(aspect_ratio, '16:9');
  for (const kind of ['images', 'videos', 'audios'] as const) {
    if (refs[kind].length) {
      if (body[kind] != null) return { ok: false, error: `${kind} 同时出现在参数和素材中，请只保留一处` };
      body[kind] = refs[kind].map(x => x.url);
    }
  }
  const url = `${endpoint(up)}/generations`;
  onUpstream?.({ request: { url, method: 'POST', headers: { Authorization: `Bearer ${maskToken(up.apiKey)}`, 'Content-Type': 'application/json' }, body } });
  let resp: Response;
  try {
    resp = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${up.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: submitSignal() });
  } catch (e) { return { ok: false, error: `星光提交失败：${(e as Error).message}` }; }
  const raw: any = await resp.json().catch(() => ({})), d = unwrap(raw);
  onUpstream?.({ response: { httpStatus: resp.status, body: raw } });
  if (!resp.ok || raw?.error || d?.error || FAILED.has(state(d))) return { ok: false, error: errorText(d, resp.status) };
  const id = d?.task_id ?? d?.id;
  if (!['string', 'number'].includes(typeof id) || !String(id).trim()) return { ok: false, error: '星光提交未返回 task_id/id' };
  return { ok: true, taskId: String(id) };
}

export async function pollXingguangVideo(up: Upstream, taskId: string, onUpstream?: OnUpstream): Promise<VideoPoll> {
  let resp: Response;
  try {
    resp = await fetch(`${endpoint(up)}/${encodeURIComponent(taskId)}`, { headers: { Authorization: `Bearer ${up.apiKey}` }, signal: AbortSignal.timeout(30000) });
  } catch { return { status: 'running', progress: 50 }; }
  const raw: any = await resp.json().catch(() => ({})), d = unwrap(raw);
  if (resp.status >= 500 || resp.status === 429) return { status: 'running', progress: 50 };
  onUpstream?.({ response: { phase: 'poll', httpStatus: resp.status, body: raw } });
  if (!resp.ok || FAILED.has(state(d))) return { status: 'failed', error: errorText(d, resp.status) };
  if (SUCCESS.has(state(d))) {
    // 文档保证 /content 存在；成功无 URL 仍可取片，绝不在非成功态下载。
    const videoUrl = [d?.video_url, d?.url, d?.result?.video_url, d?.result?.url].find(publicUrl)
      || `${endpoint(up)}/${encodeURIComponent(taskId)}/content`;
    const resultHeaders = new URL(videoUrl).origin === new URL(up.baseUrl).origin ? { Authorization: `Bearer ${up.apiKey}` } : undefined;
    return { status: 'completed', videoUrl, resultHeaders };
  }
  const progress = Number(d?.progress);
  return { status: QUEUED.has(state(d)) ? 'queued' : 'running', progress: Number.isFinite(progress) ? Math.max(0, Math.min(99, progress)) : 50 };
}
