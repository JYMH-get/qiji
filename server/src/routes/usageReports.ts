import type { FastifyInstance } from 'fastify';
import { getUsageReport, getTeamUsageReport, getPersonalProductReport, usageCompanies } from '../services/usageReports.ts';
import { teamOfUser } from '../store/teams.ts';

export function registerTeamUsageReportRoutes(api: FastifyInstance): void {
  for (const personal of [false,true]) api.get(personal ? '/v1/me/product-reports' : '/v1/team/usage-reports', async (req,reply) => {
    if (!req.user) return reply.code(403).send({error:{message:'仅用户凭证可用'}});
    const team = req.user && teamOfUser(req.user.id);
    if (!personal && (!team || team.leaderId !== req.user?.id)) return reply.code(403).send({error:{message:'仅团长可查看团队统计'}});
    const query = req.query as Record<string,unknown>;
    if (Object.keys(query).some(key => !['days','from','to'].includes(key))) return reply.code(400).send({error:{message:'统计筛选参数无效'}});
    const days = query.days === undefined ? 30 : typeof query.days === 'string' && /^\d+$/.test(query.days) ? Number(query.days) : NaN;
    if (!Number.isInteger(days) || days < 1 || days > 90) return reply.code(400).send({error:{message:'统计范围为 1–90 天'}});
    let range: {from:string;to:string} | undefined;
    if (query.from !== undefined || query.to !== undefined) {
      const valid = (v:unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0,10) === v;
      if (query.days !== undefined || !valid(query.from) || !valid(query.to) || query.from > query.to || query.to > new Date().toISOString().slice(0,10) || Date.parse(query.to)-Date.parse(query.from) > 365*86400000) return reply.code(400).send({error:{message:'请选择有效的起止日期，单次最多366天，结束日期不能晚于今天'}});
      range = {from:query.from,to:query.to};
    }
    return reply.header('Cache-Control','no-store').send(personal ? getPersonalProductReport(req.user,days,range) : getTeamUsageReport(team!,days,range));
  });
}

/** Register inside the caller's admin/merchant authentication boundary. */
export function registerUsageReportRoutes(api: FastifyInstance, merchant: boolean): void {
  api.get(merchant ? '/agent-api/usage-reports' : '/admin-api/usage-reports', async (req, reply) => {
    const query = req.query as Record<string, unknown>;
    if (Object.keys(query).some(key => !['companyId', 'days', 'from', 'to'].includes(key))) return reply.code(400).send({ error: { message: '统计筛选参数无效' } });
    const days = query.days === undefined ? 30 : typeof query.days === 'string' && /^\d+$/.test(query.days) ? Number(query.days) : NaN;
    if (!Number.isInteger(days) || days < 1 || days > 90) return reply.code(400).send({ error: { message: '统计范围为 1–90 天' } });
    let range: {from:string;to:string} | undefined;
    if (query.from !== undefined || query.to !== undefined) {
      const valid = (v:unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0,10) === v;
      if (query.days !== undefined || !valid(query.from) || !valid(query.to) || query.from > query.to || query.to > new Date().toISOString().slice(0,10) || Date.parse(query.to)-Date.parse(query.from) > 365*86400000) return reply.code(400).send({error:{message:'请选择有效的起止日期，单次最多366天，结束日期不能晚于今天'}});
      range = {from:query.from,to:query.to};
    }
    if (query.companyId !== undefined && (typeof query.companyId !== 'string' || !query.companyId)) return reply.code(400).send({ error: { message: '请选择公司' } });
    // Never derive merchant access from a query parameter or a user's current owner.
    if (merchant && query.companyId !== undefined && query.companyId !== req.agent!.id) return reply.code(403).send({ error: { message: '只能查看本公司统计' } });
    const companyId = merchant ? req.agent!.id : (query.companyId as string | undefined) || 'source';
    if (companyId !== 'all' && !usageCompanies().some(c => c.id === companyId)) return reply.code(404).send({ error: { message: '公司不存在' } });
    const report = getUsageReport(companyId, days, Date.now(), range);
    return reply.header('Cache-Control', 'no-store').send({ ...report, ...(!merchant ? { availableCompanies: usageCompanies() } : {}) });
  });
}
