/** Public credit errors expose the failing account layer, never purchase prices. */
export const AGENT_CREDIT_SHORTAGE = '所属渠道商积分不足，请联系管理员';
export const UPSTREAM_CREDIT_SHORTAGE = '当前线路的上游账户余额不足，请联系简一处理';

/** Only call at an upstream failure boundary. HTTP status/quota alone is not evidence of insufficient funds. */
export function upstreamCreditFeedback(message: string): string {
  // Preserve ambiguous permission errors and our own wallet errors, including repeated normalization.
  if (/(?:个人|团队|团长|渠道商).*?(?:积分|余额|额度)不足|(?:或|可能|疑似).*?(?:余额|积分|额度)不足|(?:余额|积分|额度)不足.*?(?:或|可能)/.test(message)) return message;
  const explicit = /(?:余额|积分|额度|点数)不足|(?:余额|积分|额度)已(?:耗尽|用完)|(?:无|暂无)可用额度|\binsufficient[\s_-]*(?:account[\s_-]*)?(?:balance|credits?|funds)\b|\b(?:balance|credits?|funds)[\s_-]*(?:is[\s_-]*)?insufficient\b/i;
  return explicit.test(message) ? UPSTREAM_CREDIT_SHORTAGE : message;
}
