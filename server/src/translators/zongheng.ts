/**
 * 纵横：用户《文档.txt》（2026-09-29），Bearer JSON。
 * POST /v1/videos -> task_id；GET /v1/tasks/{id}，10 秒轮询。
 * 仅 succeeded 读取 video_url/url/result_url/download_url；failed 读取 error_detail。
 * images/start_frame/end_frame/reference_videos/reference_audios 为公网 HTTPS URL。
 * 文档未声明特殊引用语法，图例按素材顺序追加；不增加模型素材数量限制。
 * 情报源 GET https://cnd-coo-new.pages.dev/v1/models（Bearer 按 Key 授权）。
 * 2026-09-29 无 Key 为401；/api/pricing 为404，/llms.txt 为HTML，无公开价格目录。
 */
import { randomUUID } from 'node:crypto';
import { buildPrompt } from './prompt.ts';
import { resolveNamed, injectReferenceTags, type VideoSubmit, type VideoPoll } from './jianmeng.ts';
import { maskToken } from '../store/logs.ts';
import { numberParam, stringParam } from './paramPass.ts';
import { submitSignal } from './submitTimeout.ts';
import type { GenerateRequest } from '../contract.ts';
import type { Upstream } from './upstream.ts';
import type { OnUpstream } from './openai.ts';

const root = (up: Upstream) => up.baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '');
const unwrap = (d: any) => d?.data && typeof d.data === 'object' && !Array.isArray(d.data) ? d.data : d;
function errorText(d: any, status: number): string {
  const msg = d?.error_detail || d?.error?.message || d?.message || d?.error;
  return typeof msg === 'string' ? msg : `纵横请求失败 HTTP ${status}`;
}
function publicUrl(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  try {
    const u = new URL(v), h = u.hostname.toLowerCase();
    return u.protocol === 'https:' && !u.username && !u.password
      && !/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)
      && !h.endsWith('.localhost') && !h.endsWith('.local') && !h.startsWith('[');
  } catch { return false; }
}
const businessFailed = (d: any) => d?.success === false || d?.code != null && String(d.code) !== '0';

export async function submitZonghengVideo(req: GenerateRequest, up: Upstream, onUpstream?: OnUpstream): Promise<VideoSubmit> {
  if (!up.apiKey) return { ok: false, error: '纵横未配置上游密钥（管理端纵横渠道或 ZONGHENG_API_KEY）' };
  if (!up.upstreamModel?.trim()) return { ok: false, error: '纵横未配置公开模型名' };
  let prompt = buildPrompt(req);
  if (!prompt.trim() || prompt.trim() === '{}') return { ok: false, error: '提示词不能为空' };
  const p = req.params ?? {};
  if (p.ratio != null && p.aspect_ratio != null && String(p.ratio) !== String(p.aspect_ratio))
    return { ok: false, error: 'ratio 与 aspect_ratio 冲突，请统一宽高比' };
  const refs = { images: resolveNamed(req.inputs?.images), videos: resolveNamed(req.inputs?.videos), audios: resolveNamed(req.inputs?.audios) };
  for (const kind of ['images', 'videos', 'audios'] as const) {
    if (refs[kind].length !== (req.inputs?.[kind]?.length ?? 0) || refs[kind].some(x => !publicUrl(x.url)))
      return { ok: false, error: '纵横参考素材必须全部提供公网 HTTPS 地址，请重新上传不可用素材' };
  }
  prompt = injectReferenceTags(prompt, refs);
  const { aspect_ratio, firstFrameUrl, lastFrameUrl, method, ...extra } = p;
  // 保留用户显式参数；只转换 Qiji 字段，未知参数由上游返回可理解错误。
  const body: Record<string, unknown> = { ...extra, model: up.upstreamModel, prompt };
  if (p.duration != null && p.duration !== '') body.duration = numberParam(p.duration, NaN);
  if (body.ratio == null && aspect_ratio != null) body.ratio = stringParam(aspect_ratio, '');
  if (p.resolution != null) body.resolution = stringParam(p.resolution, '');
  const put = (key: string, value: unknown) => {
    if (body[key] != null && JSON.stringify(body[key]) !== JSON.stringify(value)) throw Error(`${key} 同时出现在参数和素材中且不一致，请只保留一处`);
    body[key] = value;
  };
  try {
    for (const value of [firstFrameUrl, lastFrameUrl]) {
      if (value != null && value !== '' && !publicUrl(value)) throw Error('首尾帧必须提供公网 HTTPS 地址');
    }
    if (method === 'frames') {
      const images = refs.images.map(x => x.url);
      const start = firstFrameUrl || p.start_frame || images.shift();
      const end = lastFrameUrl || p.end_frame || images.shift();
      if (!start || !end) throw Error('首尾帧方法需要首帧和尾帧两张图片');
      put('start_frame', start); put('end_frame', end);
      if (images.length) put('images', images);
    } else {
      if (firstFrameUrl && !refs.images.some(x => x.url === firstFrameUrl)) {
        refs.images.push({ url: String(firstFrameUrl) });
        prompt += `\n故事板整体参考：@Image${refs.images.length}`;
      }
      if (refs.images.length) put('images', refs.images.map(x => x.url));
      if (lastFrameUrl) put('end_frame', lastFrameUrl);
    }
    if (refs.videos.length) put('reference_videos', refs.videos.map(x => x.url));
    if (refs.audios.length) put('reference_audios', refs.audios.map(x => x.url));
    for (const key of ['images', 'reference_videos', 'reference_audios']) {
      if (body[key] != null && (!Array.isArray(body[key]) || (body[key] as unknown[]).some(v => !publicUrl(v))))
        throw Error(`${key} 必须为公网 HTTPS 地址数组`);
    }
    for (const key of ['start_frame', 'end_frame']) {
      if (body[key] != null && !publicUrl(body[key])) throw Error(`${key} 必须为公网 HTTPS 地址`);
    }
  } catch (e) { return { ok: false, error: (e as Error).message }; }
  body.prompt = prompt;
  const url = `${root(up)}/v1/videos`;
  const headers = { Authorization: `Bearer ${up.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() };
  onUpstream?.({ request: { url, method: 'POST', headers: { ...headers, Authorization: `Bearer ${maskToken(up.apiKey)}` }, body } });
  let resp: Response;
  try {
    resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: submitSignal() });
  } catch (e) { return { ok: false, error: `纵横提交失败：${(e as Error).message}` }; }
  const raw: any = await resp.json().catch(() => ({})), d = unwrap(raw);
  onUpstream?.({ response: { httpStatus: resp.status, body: raw } });
  if (!resp.ok || businessFailed(raw) || raw?.error || d?.error || d?.status === 'failed')
    return { ok: false, error: errorText(d, resp.status) };
  if (typeof d?.task_id !== 'string' || !d.task_id.trim()) return { ok: false, error: '纵横提交未返回 task_id' };
  return { ok: true, taskId: d.task_id };
}

export async function pollZonghengVideo(up: Upstream, taskId: string, onUpstream?: OnUpstream): Promise<VideoPoll> {
  let resp: Response;
  try {
    resp = await fetch(`${root(up)}/v1/tasks/${encodeURIComponent(taskId)}`, { headers: { Authorization: `Bearer ${up.apiKey}` }, signal: AbortSignal.timeout(30000) });
  } catch { return { status: 'running', progress: 50 }; }
  if (resp.status >= 500 || resp.status === 429) return { status: 'running', progress: 50 };
  const raw: any = await resp.json().catch(() => ({})), d = unwrap(raw);
  onUpstream?.({ response: { phase: 'poll', httpStatus: resp.status, body: raw } });
  if (!resp.ok || businessFailed(raw) || d?.status === 'failed') return { status: 'failed', error: errorText(d, resp.status) };
  if (d?.status === 'succeeded') {
    const videoUrl = [d.video_url, d.url, d.result_url, d.download_url].find(publicUrl);
    if (!videoUrl) return { status: 'failed', error: '纵横完成但未返回有效成片链接' };
    const resultHeaders = new URL(videoUrl).origin === new URL(up.baseUrl).origin ? { Authorization: `Bearer ${up.apiKey}` } : undefined;
    return { status: 'completed', videoUrl, resultHeaders };
  }
  // 仅文档明确的 succeeded/failed 为终态，未知状态继续轮询。
  return { status: 'running', progress: 50 };
}
