/**
 * xiha888 / https://api.lk888.ai：用户提供的 mj_imagine 文档（2026-09-21）。
 * Bearer；POST /v1/media/generate {model,prompt,params}，GET /v1/media/status?task_id=。
 * 仅 is_final === true 后按 state success/failed 判终态；中文 status 不参与判断。
 * 参考图 params.images 为 URL 数组；notify_url 位于顶层。素材数量仅执行管理端 matLimits。
 * 情报源 GET https://api.lk888.ai/v1/models（Bearer，未提供密钥，尚未在线核对）。
 */
import { buildPrompt } from './prompt.ts';
import { resolveNamed, type VideoSubmit, type VideoPoll } from './jianmeng.ts';
import { maskToken } from '../store/logs.ts';
import { stringParam } from './paramPass.ts';
import { submitSignal } from './submitTimeout.ts';
import type { GenerateRequest } from '../contract.ts';
import type { Upstream } from './upstream.ts';
import type { OnUpstream } from './openai.ts';

const endpoint = (up: Upstream) => `${up.baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '')}/v1/media`;
const errorText = (data: any, status: number) => String(data?.error?.message || data?.error || data?.msg || `上游 HTTP ${status}`);

export async function submitXiha888Image(req: GenerateRequest, up: Upstream, onUpstream?: OnUpstream): Promise<VideoSubmit> {
  if (!up.apiKey) return { ok: false, error: 'xiha888 未配置上游密钥' };
  if (!up.upstreamModel) return { ok: false, error: 'xiha888 未配置上游模型名' };
  const prompt = buildPrompt(req);
  if (!prompt.trim() || prompt.trim() === '{}') return { ok: false, error: '提示词不能为空' };
  if (req.inputs?.videos?.length || req.inputs?.audios?.length)
    return { ok: false, error: '此图片接口没有视频或音频素材字段' };
  const params: Record<string, unknown> = { ...req.params };
  const notifyUrl = params.notify_url;
  delete params.notify_url;
  params.botType ??= stringParam(undefined, 'MID_JOURNEY');
  params.aspectRatio ??= stringParam(params.aspect_ratio ?? params.ratio, '1:1');
  const images = resolveNamed(req.inputs?.images);
  if (images.length !== (req.inputs?.images?.length ?? 0)) return { ok: false, error: '参考图地址不可用，请重新上传' };
  // 显式原生 images 和素材区不能互相覆盖；追加引用但不截断或重新排列。
  if (images.length) {
    if (params.images !== undefined && !Array.isArray(params.images)) return { ok: false, error: 'params.images 必须为数组' };
    params.images = [...(params.images as unknown[] ?? []), ...images.map(x => x.url)];
  }
  const body = { model: up.upstreamModel, prompt, params, ...(notifyUrl !== undefined ? { notify_url: notifyUrl } : {}) };
  const url = `${endpoint(up)}/generate`;
  onUpstream?.({ request: { url, method: 'POST', headers: { Authorization: `Bearer ${maskToken(up.apiKey)}`, 'Content-Type': 'application/json' }, body } });
  try {
    const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${up.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: submitSignal() });
    const data: any = await response.json().catch(() => ({}));
    onUpstream?.({ response: { httpStatus: response.status, body: data } });
    if (!response.ok || data.code !== 200) return { ok: false, error: errorText(data, response.status) };
    const id = data.data?.task_id;
    if (!(typeof id === 'string' && id.trim() || typeof id === 'number' && Number.isFinite(id)))
      return { ok: false, error: '上游未返回有效 task_id' };
    return { ok: true, taskId: String(id) };
  } catch (e) { return { ok: false, error: `xiha888 提交失败：${(e as Error).message}` }; }
}

export async function pollXiha888Image(up: Upstream, taskId: string, onUpstream?: OnUpstream): Promise<VideoPoll> {
  let response: Response;
  try {
    response = await fetch(`${endpoint(up)}/status?task_id=${encodeURIComponent(taskId)}`, { headers: { Authorization: `Bearer ${up.apiKey}` }, signal: AbortSignal.timeout(30000) });
  } catch { return { status: 'running', progress: 0 }; }
  const data: any = await response.json().catch(() => ({}));
  onUpstream?.({ response: { phase: 'poll', httpStatus: response.status, body: data } });
  if (response.status >= 500 || response.status === 429) return { status: 'running', progress: 0 };
  if (!response.ok) return { status: 'failed', error: errorText(data, response.status) };
  if (data.is_final === true) {
    if (data.state === 'failed') return { status: 'failed', error: errorText(data, response.status) };
    if (data.state === 'success') {
      if (typeof data.result_url !== 'string' || !/^https?:\/\/\S+$/i.test(data.result_url))
        return { status: 'failed', error: '上游任务成功但没有有效结果链接' };
      return { status: 'completed', videoUrl: data.result_url };
    }
  }
  const progress = Number(String(data.progress ?? '').replace(/%$/, ''));
  return { status: data.state === 'pending' ? 'queued' : 'running', progress: Number.isFinite(progress) ? Math.max(0, Math.min(99, progress)) : 0 };
}
