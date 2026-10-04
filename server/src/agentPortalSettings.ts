import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getAgent, agentSessionReadOnly, updateAgentPortalSettings, changeAgentPassword, bindAgentEmail, type Agent } from './store/agents.ts';
import './store/credits.ts';
import { db } from './store/sqlite.ts';
import { issueCode, verifyCode } from './store/regGuard.ts';
import { isSmtpConfigured, sendCodeMail } from './services/mailer.ts';
import { listPublishedMessages, publishMessage } from './store/messages.ts';

const tokenOf = (req: FastifyRequest) => (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
function settings(a: Agent, req: FastifyRequest) {
  return { id: a.id, name: a.name, account: a.account, inviteCode: a.inviteCode, email: a.email ?? '', emailVerifiedAt: a.emailVerifiedAt,
    credits: a.credits, registrationGiftCredits: a.registrationGiftCredits ?? 0, redeemCodePrefix: a.redeemCodePrefix ?? 'QJ', balanceWarningEnabled: a.balanceWarningEnabled === true,
    balanceWarningThreshold: a.balanceWarningThreshold ?? 0,
    balanceWarning: a.balanceWarningEnabled === true && a.credits <= (a.balanceWarningThreshold ?? 0),
    createdAt: a.createdAt, lastSeenAt: a.lastSeenAt, smtpConfigured: isSmtpConfigured(), readOnly: agentSessionReadOnly(tokenOf(req)) };
}
const emailOf = (body: unknown): string | undefined => {
  const value = (body as { email?: unknown } | undefined)?.email;
  if (typeof value !== 'string' || value.length > 254) return undefined;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined;
};

export function registerAgentPortalSettings(api: FastifyInstance) {
  api.get('/agent-api/messages', async req => ({ items: listPublishedMessages('agent', req.agent!.id) }));
  api.post('/agent-api/messages', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (Object.keys(body).some(k => !['title', 'body', 'kind'].includes(k)) || !['notice', 'announcement'].includes(String(body.kind))) return reply.code(400).send({ error: { message: '通知内容无效' } });
    try { return { ok: true, item: publishMessage({ issuer: 'agent', issuerId: req.agent!.id, audience: 'agent', audienceId: req.agent!.id, kind: body.kind as 'notice' | 'announcement', title: String(body.title ?? ''), body: String(body.body ?? '') }) }; }
    catch (error) { return reply.code(400).send({ error: { message: (error as Error).message } }); }
  });
  api.get('/agent-api/settings', async req => settings(req.agent!, req));
  api.put('/agent-api/settings', async (req, reply) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return reply.code(400).send({ error: { message: '设置内容无效' } });
    const result = updateAgentPortalSettings(req.agent!.id, req.body as Record<string, unknown>);
    if (!result.ok) return reply.code(400).send({ error: { message: result.error } });
    return { ok: true, settings: settings(result.agent, req) };
  });
  api.post('/agent-api/settings/password', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = changeAgentPassword(req.agent!.id, String(body.currentPassword ?? ''), String(body.password ?? ''), tokenOf(req));
    if (!result.ok) return reply.code(400).send({ error: { message: result.error } });
    return { ok: true };
  });
  api.post('/agent-api/settings/email-code', async (req, reply) => {
    const email = emailOf(req.body);
    if (!email) return reply.code(400).send({ error: { message: '邮箱格式不正确' } });
    if (!isSmtpConfigured()) return reply.code(503).send({ error: { message: '邮件服务暂未配置，请联系管理员' } });
    // Scope the code to this authenticated merchant and mailbox; never reuse a customer reset code.
    const result = issueCode('reset', `agent-email:${req.agent!.id}:${email}`, req.ip);
    if (!result.ok) return reply.code(429).send({ error: { message: result.error } });
    try { await sendCodeMail(email, result.code, '绑定邮箱'); }
    catch { return reply.code(503).send({ error: { message: '验证码发送失败，请稍后重试' } }); }
    return { ok: true };
  });
  api.post('/agent-api/settings/email', async (req, reply) => {
    const email = emailOf(req.body);
    if (!email) return reply.code(400).send({ error: { message: '邮箱格式不正确' } });
    const result = verifyCode('reset', `agent-email:${req.agent!.id}:${email}`, String((req.body as { code?: unknown }).code ?? ''));
    if (!result.ok) return reply.code(400).send({ error: { message: result.error } });
    const a = bindAgentEmail(req.agent!.id, email)!;
    return { ok: true, settings: settings(a, req) };
  });
  api.get('/agent-api/settings/credits', async req => {
    const a = getAgent(req.agent!.id)!;
    const q = req.query as { limit?: string; offset?: string };
    const limit = Math.min(500, Math.max(1, Math.floor(Number(q.limit) || 100))), offset = Math.min(1e9, Math.max(0, Math.floor(Number(q.offset) || 0)));
    const where = "FROM credit_ops c, json_each(c.accounts) j WHERE json_extract(j.value,'$.kind')='agent' AND json_extract(j.value,'$.id')=?";
    const items = db.prepare(`SELECT c.op_id AS opId,c.created_at AS at,c.reason,c.ref,c.status,
      json_extract(j.value,'$.delta') AS delta,json_extract(j.value,'$.pre') AS before,json_extract(j.value,'$.post') AS after
      ${where} ORDER BY c.seq DESC LIMIT ? OFFSET ?`).all(a.id, limit, offset);
    const total = db.prepare(`SELECT count(*) AS total, coalesce(sum(CASE WHEN c.status IN ('done','healed')
      AND c.reason IN ('generate','batch','refund','reconcile-refund','text-token-settle','text-token-mirror')
      THEN -cast(json_extract(j.value,'$.delta') AS REAL) ELSE 0 END),0) AS netSpent ${where}`).get(a.id) as { total: number; netSpent: number };
    return { items, total: total.total, limit, offset, balance: a.credits, netSpent: total.netSpent };
  });
}
