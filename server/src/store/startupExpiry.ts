import { refundRequest, type UserWalletRef } from './credits.ts';

interface ExpiredCharge {
  logId?: string; taskId?: string; userId?: string; payerId?: string;
  userWallet?: UserWalletRef; cost?: number; agents?: {id:string;cost:number}[];
  refunded?: boolean;
}
/** Account for expired work without loading or redelivering its generated result. */
export function settleExpiredRequest(input: ExpiredCharge): string {
  const expired = '任务已超过48小时或提交时间无效，停止自动恢复';
  const result = refundRequest({ ...input, reason: 'startup-expired-refund',
    payerId: input.payerId ?? input.userId, statsUserId: input.userId, userAmount: input.cost });
  if (!result.ok) return expired + `（账务待核对：${result.error}）`;
  if (result.status === 'settled') return expired + '（已结算，未重复退款）';
  if (result.status === 'already-refunded') return expired + '（已退款）';
  return result.status === 'refunded' ? expired + '（预扣已原路退回）' : expired;
}
