import { describe, expect, it } from 'vitest';
import { upstreamCreditFeedback, UPSTREAM_CREDIT_SHORTAGE } from '../../server/src/creditFeedback';

describe('upstream credit feedback', () => {
  it.each([
    '官方上游拒绝：insufficient balance', 'insufficient_balance', 'InsufficientBalance',
    'insufficient credits', 'Insufficient funds', 'account balance is insufficient',
    'Dimensio 上游积分不足，请联系运营充值后重试', '余额不足', '渠道额度不足（HTTP 402）',
    '暂无可用额度', '余额已耗尽', UPSTREAM_CREDIT_SHORTAGE,
  ])('identifies explicit upstream funds error: %s', message => {
    expect(upstreamCreditFeedback(message)).toBe(UPSTREAM_CREDIT_SHORTAGE);
  });
  it.each([
    '个人积分不足：本次需 10，剩余 0', '团队积分不足，请联系团长',
    '所属渠道商积分不足，请联系管理员', '官方上游无权限或余额不足',
    '余额不足或密钥无效', '可能余额不足', 'HTTP 402', 'HTTP 403',
    'rate_limit_exceeded', 'quota exceeded', 'insufficient_quota',
    '服务暂不可用，请稍后重试或联系管理员。', '素材审核未通过', 'Invalid API key',
  ])('preserves other or ambiguous errors: %s', message => {
    expect(upstreamCreditFeedback(message)).toBe(message);
  });
});
