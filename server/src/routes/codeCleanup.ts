import type { FastifyInstance } from 'fastify';
import { pruneUsedCodes } from '../store/redeemCodes.ts';
import { pruneUsedTeamCodes, listTeamCodesByAgent } from '../store/teams.ts';

/** Caller registers this inside its admin/agent authentication boundary. */
export function registerCodeCleanupRoutes(api: FastifyInstance, merchant: boolean): void {
  const prefix = merchant ? '/agent-api' : '/admin-api';
  for (const [kind,prune] of [['redeem-codes',pruneUsedCodes],['team-codes',pruneUsedTeamCodes]] as const) {
    api.post(`${prefix}/${kind}/prune-used`, async (req,reply) => {
      if (Object.keys(req.query as object).length || (req.body != null && (typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length))) return reply.code(400).send({error:{message:'清理范围由当前账号确定，无需额外参数'}});
      return {ok:true,...prune(merchant ? req.agent!.id : undefined)};
    });
  }
  if (merchant) api.get('/agent-api/team-codes',async req => ({items:listTeamCodesByAgent(req.agent!.id)}));
}
