/** 源站管理员用户归属迁移。所有校验与提交均同步，整批全成或全败。
 * 团队本来允许跨渠道组成；保留成员、共享池与分发台账，不能调用退团结算改变余额。
 * 模型/模板/功能/共享素材受众通过 user.agentId 派生，下一次请求按新归属生效；
 * 历史日志与资产上的归属快照不重写，已有收藏、配额与登录身份仍按原 user.id 关联。
 * 在途任务仍按已保存的 payerId/agents 扣款快照结算退款，不按新归属重新记账。
 */
import { getAgent } from "../store/agents.ts";
import { getUser, transferUsersToAgent } from "../store/users.ts";

type TransferResult =
	| { ok: true; affected: number; unchanged: number; targetAgentId: string | null }
	| { ok: false; status: 400 | 404 | 409; error: { code: string; message: string } };

export function transferUsers(input: unknown): TransferResult {
	const fail = (status: 400 | 404 | 409, code: string, message: string): TransferResult => ({ ok: false, status, error: { code, message } });
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return fail(400, "INVALID_TRANSFER", "迁移参数无效");
	}
	const b = input as Record<string, unknown>;
	if (!Array.isArray(b.ids) || b.ids.length === 0 || b.ids.length > 500 || b.ids.some((id) => typeof id !== "string" || !id.trim())) {
		return fail(400, "INVALID_USERS", "请选择 1–500 名用户，用户 id 必须为非空字符串");
	}
	if (b.targetAgentId !== null && (typeof b.targetAgentId !== "string" || !b.targetAgentId.trim())) {
		return fail(400, "INVALID_TARGET", "请选择目标渠道商；迁回源站请传 targetAgentId: null");
	}
	const targetAgentId = b.targetAgentId === null ? undefined : b.targetAgentId as string;
	if (targetAgentId) {
		const target = getAgent(targetAgentId);
		if (!target) return fail(404, "TARGET_NOT_FOUND", "目标渠道商不存在");
		if (!target.enabled) return fail(409, "TARGET_DISABLED", "目标渠道商已停用，请启用后再迁移");
	}
	const ids = [...new Set(b.ids as string[])];
	const users = ids.map((id) => getUser(id));
	if (users.some((u) => !u)) return fail(404, "USER_NOT_FOUND", "部分用户已不存在，请刷新列表后重新选择；本次未迁移任何用户");
	const affected = transferUsersToAgent(ids, targetAgentId);
	return { ok: true, affected, unchanged: ids.length - affected, targetAgentId: targetAgentId ?? null };
}
