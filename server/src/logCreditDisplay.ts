import type { LogMeta } from './store/logs.ts';
import { getUser } from './store/users.ts';
import { getAgent } from './store/agents.ts';

/** Use the frozen payment references, never the requester's current team. */
export function logCreditDisplay(log: LogMeta) {
  const payerId = log.payerId || log.userId;
  const payerName = payerId === log.userId ? log.userName || getUser(payerId || '')?.name : getUser(payerId || '')?.name;
  const source = log.creditSource || (log.userWallet ? 'team-allocation' : log.payerId && log.payerId !== log.userId ? 'team-shared' : undefined);
  const creditSourceLabel = source === 'team-allocation' ? '团队分配积分' : source === 'team-shared' ? '团队共享积分' : source === 'personal' ? '个人积分' : '历史积分来源未记录';
  const creditUserName = payerName || payerId || '未记录';
  const ownerId = log.userWallet?.ownerId;
  const owner = ownerId ? getUser(ownerId)?.name || ownerId : undefined;
  return {
    creditUserName, creditSourceLabel,
    creditChain: [{ kind: source?.startsWith('team-') ? 'team' : 'user', label: creditSourceLabel,
      amount: log.cost ?? 0, payerId, domain: creditUserName + (owner ? ` · 团长：${owner}` : '') },
      ...(log.agentCosts || []).map(a => ({ kind: 'agent', label: '渠道商成本', amount: a.cost,
        domain: getAgent(a.id)?.name || a.id }))],
  };
}
