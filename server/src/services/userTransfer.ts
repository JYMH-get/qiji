/** Source-admin transfer boundary. Final checks and users.json commit stay synchronous. */
import { createHash, randomBytes } from "node:crypto";
import { getAgent } from "../store/agents.ts";
import { commitUserTransfer, getUser, listUsers, type User, type UserTransferArchive } from "../store/users.ts";
import { getRunningLogs } from "../store/logs.ts";
import { listPendingTasks } from "../store/tasks.ts";
import { listTeams } from "../store/teams.ts";
import { db } from "../store/sqlite.ts";

type Failure = { ok: false; status: 400 | 404 | 409; error: { code: string; message: string } };
type Request = { ids: string[]; targetAgentId: string | null; token?: string };
const fail = (status: Failure["status"], code: string, message: string): Failure => ({ ok: false, status, error: { code, message } });
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const PREVIEW_MS = 10 * 60_000;
const previews = new Map<string, { requestHash: string; fingerprint: string; expiresAt: number }>();

function parse(input: unknown, commit: boolean): Request | Failure {
	if (!input || typeof input !== "object" || Array.isArray(input)) return fail(400, "INVALID_TRANSFER", "迁移参数无效");
	const body = input as Record<string, unknown>;
	const keys = commit ? ["ids", "targetAgentId", "token"] : ["ids", "targetAgentId"];
	if (Object.keys(body).some(k => !keys.includes(k))) return fail(400, "INVALID_TRANSFER", "迁移参数包含未知字段");
	if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 500 || body.ids.some(id => typeof id !== "string" || !id.trim() || id.length > 200)) return fail(400, "INVALID_USERS", "请选择 1–500 名用户");
	if (new Set(body.ids).size !== body.ids.length) return fail(400, "INVALID_USERS", "不能重复选择同一用户");
	if (body.targetAgentId !== null && (typeof body.targetAgentId !== "string" || !body.targetAgentId.trim() || body.targetAgentId.length > 200)) return fail(400, "INVALID_TARGET", "请选择目标渠道商；迁回源站请传 targetAgentId: null");
	if (commit && (typeof body.token !== "string" || !/^[a-f0-9]{64}$/.test(body.token))) return fail(400, "PREVIEW_REQUIRED", "请先预览迁移并确认封存余额");
	return { ids: [...body.ids as string[]].sort(), targetAgentId: body.targetAgentId as string | null, ...(commit ? { token: body.token as string } : {}) };
}
const requestHashOf = (r: Request) => digest({ ids: r.ids, targetAgentId: r.targetAgentId });
const isFailure = (value: object): value is Failure => "ok" in value && value.ok === false;
const memberView = (m: User["membership"]) => m ? { planName: m.planName, expiresAt: m.expiresAt, discountPercent: m.discountPercent } : null;

function busy(ids: Set<string>): Failure | undefined {
	const matches = (...values: (string | undefined)[]) => values.some(v => v && ids.has(v));
	if (getRunningLogs().some(l => matches(l.userId, l.payerId, l.userWallet?.ownerId))) return fail(409, "TRANSFER_BUSY", "所选用户或其团队积分仍有在途请求，请等待请求和退款结算完成后迁移");
	if (listPendingTasks().some(t => matches(t.ownerUserId, t.billing?.userId, t.billing?.payerId, t.billing?.userWallet?.ownerId))) return fail(409, "TRANSFER_BUSY", "所选用户或其团队积分仍有在途任务，请等待任务和退款结算完成后迁移");
	const creditRows = db.prepare("SELECT payer_id,stats_user_id,accounts FROM credit_ops WHERE status IN ('pending','corrupt')").all() as { payer_id?: string; stats_user_id?: string; accounts: string }[];
	for (const row of creditRows) {
		let accounts: { kind?: string; id?: string; wallet?: { ownerId?: string } }[];
		try { accounts = JSON.parse(row.accounts); if (!Array.isArray(accounts)) throw new Error(); }
		catch { return fail(409, "TRANSFER_PENDING_CREDITS", "存在待核对的积分流水，请完成恢复后迁移"); }
		if (matches(row.payer_id, row.stats_user_id) || accounts.some(a => matches(a.kind === "user" || a.kind === "team" ? a.id : undefined, a.wallet?.ownerId))) return fail(409, "TRANSFER_PENDING_CREDITS", "所选用户存在未完成的积分结算，请完成恢复后迁移");
	}
	const textRows = db.prepare("SELECT data FROM text_billing").all() as { data: string }[];
	for (const row of textRows) {
		let entry: { finalized?: boolean; result?: unknown; charged?: { payerId?: string; statsUserId?: string; userWallet?: { ownerId?: string } } };
		try { entry = JSON.parse(row.data); if (!entry || typeof entry !== "object") throw new Error(); }
		catch { return fail(409, "TRANSFER_PENDING_TEXT", "存在待核对的文本结算，请完成恢复后迁移"); }
		// Prepared entries without a result have no recovery settlement. Live
		// requests are guarded by log/task status; failed entries may remain 7 days.
		if (!entry.finalized && entry.result && matches(entry.charged?.payerId, entry.charged?.statsUserId, entry.charged?.userWallet?.ownerId)) return fail(409, "TRANSFER_PENDING_TEXT", "所选用户存在未完成的文本结算，请等待结算完成后迁移");
	}
}

function inspect(r: Request) {
	const target = r.targetAgentId ? getAgent(r.targetAgentId) : undefined;
	if (r.targetAgentId && !target) return fail(404, "TARGET_NOT_FOUND", "目标渠道商不存在");
	if (target && !target.enabled) return fail(409, "TARGET_DISABLED", "目标渠道商已停用，请启用后再迁移");
	const selected: User[] = [];
	for (const id of r.ids) {
		const user = getUser(id);
		if (!user) return fail(404, "USER_NOT_FOUND", "部分用户已不存在，请刷新列表后重新选择；本次未迁移任何用户");
		if ((user.agentId || null) === r.targetAgentId) return fail(409, "SAME_OWNER", "所选用户已属于目标方，请重新选择");
		if (user.agentId && r.targetAgentId) return fail(409, "UNSUPPORTED_TRANSFER", "渠道商用户只能迁回源站，不支持渠道商之间直接迁移");
		if (!Number.isFinite(user.credits) || user.credits < 0) return fail(409, "TRANSFER_DEBT", "所选用户个人积分存在欠款或异常，请结清并核对后迁移");
		selected.push(user);
	}
	const ids = new Set(r.ids), all = listUsers();
	const wallets = all.flatMap(member => Object.values(member.teamWallets ?? {}).filter(w => ids.has(w.ownerId)).map(w => ({ ...w, memberId: member.id })));
	if (wallets.some(w => !Number.isFinite(w.balance) || w.balance < 0)) return fail(409, "TRANSFER_DEBT", "所选团长的团队积分存在欠款或异常，请结清并核对后迁移");
	const blocked = busy(ids); if (blocked) return blocked;
	const targetName = target?.name ?? "源站";
	const rows = selected.map(u => {
		const owned = wallets.filter(w => w.ownerId === u.id);
		return { id: u.id, name: u.name, account: u.account, sourceAgentId: u.agentId ?? null, sourceName: u.agentId ? getAgent(u.agentId)?.name ?? "已移除渠道商" : "源站", credits: u.credits, membership: memberView(u.membership), teamWalletCount: owned.length, teamCredits: owned.reduce((n, w) => n + w.balance, 0) };
	});
	const topology = listTeams().filter(t => ids.has(t.leaderId) || t.memberIds.some(id => ids.has(id))).map(t => ({ id: t.id, leaderId: t.leaderId, memberIds: [...t.memberIds].sort(), creditMode: t.creditMode, paymentSources: t.paymentSources })).sort((a,b) => a.id.localeCompare(b.id));
	const fingerprint = digest({ target: { id: r.targetAgentId, name: targetName, enabled: target?.enabled }, users: selected.map(u => ({ id: u.id, name: u.name, account: u.account, agentId: u.agentId, enabled: u.enabled, accessKey: u.accessKey, credits: u.credits, membership: u.membership, transferHistory: u.transferHistory, teamWallets: u.teamWallets })), topology, wallets: wallets.sort((a, b) => (a.memberId + ":" + a.teamId).localeCompare(b.memberId + ":" + b.teamId)) });
	return { selected, wallets, rows, fingerprint, targetName };
}

export function previewUserTransfer(input: unknown) {
	const r = parse(input, false); if (isFailure(r)) return r;
	const state = inspect(r); if (isFailure(state)) return state;
	const now = Date.now();
	for (const [key, value] of previews) if (value.expiresAt <= now) previews.delete(key);
	if (previews.size >= 1000) previews.delete(previews.keys().next().value!);
	const token = randomBytes(32).toString("hex"), expiresAt = now + PREVIEW_MS;
	previews.set(token, { requestHash: requestHashOf(r), fingerprint: state.fingerprint, expiresAt });
	return { ok: true as const, token, expiresAt: new Date(expiresAt).toISOString(), fingerprint: state.fingerprint, targetAgentId: r.targetAgentId, targetName: state.targetName, users: state.rows, totalCredits: state.rows.reduce((n, u) => n + u.credits, 0), totalTeamCredits: state.rows.reduce((n, u) => n + u.teamCredits, 0), affected: state.selected.length };
}

function resultOf(a: UserTransferArchive, replayed: boolean) {
	return { ok: true as const, transferId: a.transferId, affected: a.affected, unchanged: 0, targetAgentId: a.targetAgentId, at: a.at, replayed };
}

export function transferUsers(input: unknown) {
	const r = parse(input, true); if (isFailure(r)) return r;
	const hash = requestHashOf(r);
	const previous = listUsers().flatMap(u => u.transferHistory ?? []).find(a => a.token === r.token);
	if (previous) return previous.requestHash === hash ? resultOf(previous, true) : fail(409, "TRANSFER_TOKEN_MISMATCH", "确认凭证与所选用户或目标不一致，请重新预览");
	const preview = previews.get(r.token!);
	if (!preview || preview.expiresAt <= Date.now()) return fail(409, "TRANSFER_PREVIEW_EXPIRED", "迁移预览已过期，请重新预览");
	if (preview.requestHash !== hash) return fail(409, "TRANSFER_TOKEN_MISMATCH", "确认凭证与所选用户或目标不一致，请重新预览");
	const state = inspect(r); if (isFailure(state)) return state;
	if (state.fingerprint !== preview.fingerprint) return fail(409, "TRANSFER_STALE", "用户余额、会员或团队积分已变化，请重新预览后确认");
	const transferId = "ut_" + randomBytes(16).toString("hex"), at = new Date().toISOString();
	const entries = state.selected.map(u => {
		const view = state.rows.find(row => row.id === u.id)!;
		const archive: UserTransferArchive = { transferId, token: r.token!, requestHash: hash, affected: state.selected.length, userName: u.name, account: u.account, at, actor: "source-admin", sourceAgentId: u.agentId ?? null, sourceName: view.sourceName, targetAgentId: r.targetAgentId, targetName: state.targetName, personalCredits: u.credits, membership: u.membership ? structuredClone(u.membership) : undefined, ownedTeamWallets: state.wallets.filter(w => w.ownerId === u.id) };
		return { userId: u.id, archive };
	});
	commitUserTransfer(entries);
	previews.delete(r.token!);
	return resultOf(entries[0].archive, false);
}

/** Explicit source-admin projection: bearer keys and confirmation tokens stay private. */
export function listUserTransfers(userId?: string) {
	return { items: listUsers().filter(u => !userId || u.id === userId).flatMap(u => (u.transferHistory ?? []).map(a => ({ transferId: a.transferId, at: a.at, userId: u.id, name: a.userName, account: a.account, sourceAgentId: a.sourceAgentId, sourceName: a.sourceName, targetAgentId: a.targetAgentId, targetName: a.targetName, personalCredits: a.personalCredits, teamCredits: a.ownedTeamWallets.reduce((n, w) => n + w.balance, 0), teamWalletCount: a.ownedTeamWallets.length, membership: memberView(a.membership), actor: a.actor }))).sort((a, b) => b.at.localeCompare(a.at)) };
}
