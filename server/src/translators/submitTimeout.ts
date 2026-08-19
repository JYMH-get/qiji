/**
 * 第169轮（用户令「取消提交超时」，⚠ 勿回退成短超时）：
 * 上游「提交 / 同步生成」类请求一律不再设短超时。
 *
 * 背景：大量提交在 60s 被我方 AbortSignal 主动掐断，而上游实际早已受理并开始生成（已计费）——
 * 我方判失败自动退款、上游照扣费 = 纯亏损。提交响应慢 ≠ 失败，等就是了。
 *
 * 这里只保留一个极长的安全闸（缺省 30 分钟）防「死连接把任务永远挂住」：
 *   env SUBMIT_TIMEOUT_MS 可调；设 0 = 完全不设超时（连安全闸也没有）。
 *
 * 范围约定：
 *  - 走本闸的：各翻译器发起生成的那一个请求（异步渠道的 submit POST、同步渠道的整单生成请求）。
 *  - 不走本闸的：轮询（短超时 + 瞬时故障重试，语义不变）、结果下载（有 fallbackUrl/客户端接力等回退链路）。
 *
 * ⚠ 配套：index.ts 已把 undici 全局 headersTimeout/bodyTimeout（缺省 300s）归零——
 * 那是全局 fetch 的隐形第二道闸，不归零的话这里放宽也会在 5 分钟处被掐断。
 */
const envMs = Number(process.env.SUBMIT_TIMEOUT_MS);
export const SUBMIT_TIMEOUT_MS = Number.isFinite(envMs) && envMs >= 0 ? envMs : 30 * 60 * 1000;

/** 提交类请求的 AbortSignal：SUBMIT_TIMEOUT_MS=0 时返回 undefined（完全无超时） */
export function submitSignal(): AbortSignal | undefined {
	return SUBMIT_TIMEOUT_MS > 0 ? AbortSignal.timeout(SUBMIT_TIMEOUT_MS) : undefined;
}
