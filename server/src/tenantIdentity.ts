import { getAgent, listAgents } from "./store/agents.ts";
import { listUsers } from "./store/users.ts";
import { getSourceInviteCode } from "./store/settings.ts";

export type RegistrationInvite =
	| { ok: true; agentId?: string; inviterId?: string; kind: "source" | "agent" | "user" }
	| { ok: false; error: string };

/** 不按前缀猜归属，任何跨来源或存量重复邀请码均拒绝。 */
export function resolveRegistrationInvite(raw: unknown): RegistrationInvite {
	const code = typeof raw === "string" ? raw.trim().toUpperCase() : "";
	if (!code) return { ok: false, error: "请填写邀请码" };
	const agents = listAgents().filter(a => a.inviteCode?.toUpperCase() === code);
	const users = listUsers().filter(u => u.inviteCode?.toUpperCase() === code);
	const source = code === getSourceInviteCode();
	if (agents.length + users.length + Number(source) !== 1) {
		return { ok: false, error: "邀请码无效或存在冲突" };
	}
	if (source) return { ok: true, kind: "source" };
	const agent = agents[0];
	if (agent) return agent.enabled
		? { ok: true, kind: "agent", agentId: agent.id }
		: { ok: false, error: "该邀请码已停用" };
	const user = users[0];
	if (!user.enabled || (user.agentId && !getAgent(user.agentId)?.enabled)) return { ok: false, error: "该邀请码已停用" };
	return { ok: true, kind: "user", agentId: user.agentId, inviterId: user.id };
}

export function sourceInviteConflict(raw: unknown): boolean {
	const code = typeof raw === "string" ? raw.trim().toUpperCase() : "";
	return listAgents().some(a => a.inviteCode?.toUpperCase() === code)
		|| listUsers().some(u => u.inviteCode?.toUpperCase() === code);
}
