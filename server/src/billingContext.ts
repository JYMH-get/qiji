import { getUser, type User } from './store/users.ts';
import { teamOfUser, teamPaymentSource, grantedOf, type Team } from './store/teams.ts';
import { applyAgentFeatureGate } from './store/agents.ts';
import type { UserWalletRef } from './store/credits.ts';

export type CreditSource = 'personal' | 'team-shared' | 'team-allocation';
export interface PaymentContext {
  payer: User;
  priceOwner: User;
  source: CreditSource;
  team?: Team;
  wallet?: UserWalletRef;
  balance: number;
  key: string;
  unavailableError?: string;
}

/** The member chooses a wallet. Requests never switch currency when funds run out. */
export function paymentContextFor(user: User): PaymentContext {
  const team = teamOfUser(user.id), leader = team ? getUser(team.leaderId) : undefined;
  let payer = user, priceOwner = user, source: CreditSource = 'personal', wallet: UserWalletRef | undefined, balance = user.credits;
  if (team && teamPaymentSource(team, user.id) === 'team') {
    if (!leader) return { payer:user, priceOwner:user, team, balance:0,
      source:team.creditMode === 'shared' ? 'team-shared' : 'team-allocation',
      key:`${team.id}:${team.creditMode}:unavailable:${team.leaderId}`,
      unavailableError:'团队积分账户不可用，请联系团长或在团队页将积分消耗方式改为个人' };
    priceOwner = leader;
    if (team.creditMode === 'shared' || team.leaderId === user.id) {
      payer = leader; balance = leader.credits; source = 'team-shared';
    } else {
      source = 'team-allocation';
      balance = grantedOf(team.id, user.id);
      wallet = { teamId: team.id, ownerId: leader.id, ownerAgentId: leader.agentId };
    }
  }
  return { payer, priceOwner, source, wallet, balance, team,
    key: [team?.id, team?.creditMode, source, payer.id, priceOwner.id, priceOwner.agentId ?? 'source'].join(':') };
}

export function paymentFeaturesFor(user: User) {
  const context = paymentContextFor(user);
  return applyAgentFeatureGate(context.priceOwner.agentId, applyAgentFeatureGate(user.agentId, user.features));
}
