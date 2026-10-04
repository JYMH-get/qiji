/**
 * 结算闸门（第183轮 P4 第二批）：把「用户侧扣款 + 归属链各级渠道商扣款」收成**一次结算**。
 *
 * 要解决的两件事（范围收窄后确认后者才是主因）：
 *
 * ① 跨 await 的校验/扣款竞态（**每天都在发生，不需要任何崩溃**）——旧实现里
 *    `planBilling`（查余额）与 `applyBilling`（真扣）之间隔着 `await dispatchGenerate`，
 *    也就是一整次上游提交，**秒级窗口**。窗口里并发进来的请求各自都能通过余额预检；
 *    等它们先后回来扣款时，`chargeCreditsAs` 只会返回 `{ok:false}` 而**返回值被丢弃**，
 *    于是「用户没扣、渠道商照扣」；更糟的是异步任务随后按 **plan 的金额**登记 billing，
 *    失败退款时退的是一笔从未扣过的钱 → **凭空造币**。
 *    修法：扣款移到 dispatch **之前**，校验与扣款处在同一个同步块里，窗口归零。
 *
 * ② 两个 JSON 文件之间的崩溃窗口——`users.json` 与 `agents.json` 各自原子写，
 *    但两次 `renameSync` 之间进程若被 -9/OOM 杀掉，就会「扣了用户没扣渠道商」。
 *    窗口只有微秒级，但既然结算已经收口到一处，顺手用一张流水表补上：
 *    落盘前先写 `pending` 意图（含每个账户的 pre/post 余额），落盘后标 `done`；
 *    启动时按 pre/post 自愈（见 selfHeal）。
 *
 * ⚠ 刻意**不**把 users/agents 整表迁 SQLite —— 生产实测 users.json 132 条 / 113KB /
 *    stringify 0.68ms，写盘开销可忽略，迁移只会平添「谁是真相之源」的风险。
 *    这里只做「一次结算 = 一次可追溯的原子事件」，余额仍以 JSON 为唯一真相。
 *
 * 附带产物：`credit_ops` 是一张**可查的积分流水**。在此之前「某用户为什么少了 300 分」
 * 只能靠翻请求日志倒推，现在有账可对。
 */
import { db } from "./sqlite.ts";
import { AGENT_CREDIT_SHORTAGE } from '../creditFeedback.ts';
import { applyUserCreditsDelta, userCredits, persistUsers, userTeamWallet, applyTeamCreditsDelta, getUser } from "./users.ts";
import { applyAgentCreditsDelta, agentCredits, persistAgents } from "./agents.ts";

db.exec(`
CREATE TABLE IF NOT EXISTS credit_ops (
	seq       INTEGER PRIMARY KEY AUTOINCREMENT,
	op_id     TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	reason    TEXT NOT NULL,
	ref       TEXT,
	payer_id  TEXT,
	stats_user_id TEXT,
	accounts  TEXT NOT NULL,
	status    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credit_ops_status ON credit_ops(status);
CREATE INDEX IF NOT EXISTS idx_credit_ops_ref ON credit_ops(ref);
CREATE INDEX IF NOT EXISTS idx_credit_ops_op_id ON credit_ops(op_id);
CREATE INDEX IF NOT EXISTS idx_credit_ops_created ON credit_ops(created_at);
`);

/** 一次结算里被动到的一个账户（delta<0=扣，>0=退/加） */
interface OpAccount {
	kind: "user" | "agent" | "team";
	id: string;
	wallet?: UserWalletRef;
	delta: number;
	pre: number;
	post: number;
}

export interface UserWalletRef { teamId: string; ownerId: string; ownerAgentId?: string }

export interface SettleInput {
	/** 结算事由：generate / batch / refund / reconcile-refund */
	reason: string;
	idempotencyKey?: string;
	/** 关联对象（logId 或 taskId），便于对账时回溯 */
	ref?: string;
	/** 实际扣款人（团队共享积分模式=团长），=统计人时两者相同 */
	payerId: string;
	/** 消耗统计归属人（实际发起请求的用户） */
	statsUserId: string;
	/** 用户侧金额：>0=扣，<0=退 */
	userAmount: number;
	/** 分配模式独立团队钱包；缺省从payer个人余额扣。 */
	userWallet?: UserWalletRef;
	/** Explicit selected source also distinguishes a leader consuming their own shared team pool. */
	creditSource?: 'personal' | 'team-shared' | 'team-allocation';
	/** 归属链各级渠道商：cost>0=扣，<0=退 */
	agents: { id: string; cost: number }[];
}

/** 结算成功后的**实扣快照**——异步任务据此登记 billing、失败时据此原路退回。
 *  ⚠ 必须用它而不是 plan，plan 只是「打算扣多少」。 */
export interface Charged {
	opId: string;
	payerId: string;
	statsUserId: string;
	userAmount: number;
	userWallet?: UserWalletRef;
	agents: { id: string; cost: number }[];
}

export type SettleResult = { ok: true; charged: Charged } | { ok: false; error: string };

export interface RequestRefundInput {
	logId?: string;
	taskId?: string;
	ref?: string;
	reason?: 'refund' | 'reconcile-refund' | 'startup-expired-refund';
	payerId?: string;
	statsUserId?: string;
	userAmount?: number;
	userWallet?: UserWalletRef;
	agents?: { id: string; cost: number }[];
	refunded?: boolean;
}
export type RequestRefundResult = { ok: true; status: 'refunded' | 'already-refunded' | 'settled' | 'free' } | { ok: false; error: string };

/** One request has one refund across live failure, restart and expiry. Old releases
 * used random operation IDs and either taskId or logId as ref, so check both. */
export function refundRequest(input: RequestRefundInput): RequestRefundResult {
	const key = input.logId ?? input.taskId ?? input.ref;
	if (!key) return { ok: false, error: '缺少请求标识' };
	const tableExists = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
	let requestStartedAt: number | undefined;
	if (input.logId && tableExists('logs')) {
		const log = db.prepare("SELECT started_at, json_extract(meta,'$.status') AS status FROM logs WHERE id=?").get(input.logId) as { started_at: string; status: string } | undefined;
		if (log?.status === 'success') return { ok: true, status: 'settled' };
		if (log && Number.isFinite(Date.parse(log.started_at))) requestStartedAt = Date.parse(log.started_at);
	}
	const text = input.logId && tableExists('text_billing')
		? db.prepare("SELECT json_extract(data,'$.finalized') AS finalized, json_extract(data,'$.charged') AS charged FROM text_billing WHERE log_id=?").get(input.logId) as { finalized: number | null; charged: string | null } | undefined
		: undefined;
	const textOps = input.logId ? db.prepare('SELECT status FROM credit_ops WHERE op_id=?').all('text:' + input.logId) as { status: string }[] : [];
	if (text?.finalized || textOps.some(o => ['done', 'healed'].includes(o.status))) return { ok: true, status: 'settled' };
	if (textOps.some(o => o.status !== 'aborted')) return { ok: false, error: '结算流水未完成' };
	for (const ref of new Set([input.logId, input.taskId, input.ref].filter((v): v is string => !!v))) {
		const rows = db.prepare("SELECT op_id, created_at, payer_id, stats_user_id, status FROM credit_ops WHERE ref=? AND reason IN ('refund','reconcile-refund','startup-expired-refund')").all(ref) as { op_id: string; created_at: number; payer_id: string; stats_user_id: string; status: string }[];
		const previous = rows.filter(o => {
			if (!input.logId || ref === input.logId) return true;
			// tasks.json also holds its sequence and is debounced. After a crash a
			// task ID may be reused; a refund for another log is never ours.
			if (o.op_id.startsWith('refund:')) return o.op_id === 'refund:' + input.logId;
			if (o.op_id.startsWith('expire:') && ![input.logId, input.taskId].some(id => o.op_id === 'expire:' + id)) return false;
			// Legacy random IDs contain no request identity. Bound their task alias
			// by the durable admission time and original payer/statistics identity.
			return requestStartedAt !== undefined && o.created_at >= requestStartedAt
				&& (!input.payerId || o.payer_id === input.payerId)
				&& (!input.statsUserId || o.stats_user_id === input.statsUserId);
		});
		if (previous.some(o => ['done', 'healed'].includes(o.status))) return { ok: true, status: 'already-refunded' };
		if (previous.some(o => o.status !== 'aborted')) return { ok: false, error: '退款流水未完成' };
	}
	if (input.refunded) return { ok: true, status: 'already-refunded' };
	// A saved text precharge is more precise than a stale task/log price snapshot.
	let charged: Charged | undefined;
	try { charged = text?.charged ? JSON.parse(text.charged) as Charged : undefined; }
	catch { return { ok: false, error: '预扣快照无效' }; }
	const amount = charged?.userAmount ?? input.userAmount ?? 0, agents = charged?.agents ?? input.agents ?? [];
	if (!Number.isFinite(amount) || amount < 0 || !Array.isArray(agents) || agents.some(a => !a?.id || !Number.isFinite(a.cost) || a.cost < 0)) return { ok: false, error: '预扣快照无效' };
	if (!amount && !agents.some(a => a.cost > 0)) return { ok: true, status: 'free' };
	const payerId = charged?.payerId ?? input.payerId, statsUserId = charged?.statsUserId ?? input.statsUserId;
	if (!payerId || !statsUserId) return { ok: false, error: '缺少付款归属' };
	const result = settle({ reason: input.reason ?? 'refund', idempotencyKey: 'refund:' + key,
		ref: input.logId ?? input.taskId ?? input.ref, payerId, statsUserId,
		userAmount: -amount, userWallet: charged?.userWallet ?? input.userWallet,
		agents: agents.map(a => ({ id: a.id, cost: -a.cost })) });
	return result.ok ? { ok: true, status: 'refunded' } : result;
}

let _opSeq = 0;
function nextOpId(): string {
	_opSeq += 1;
	return `co_${Date.now().toString(36)}${_opSeq.toString(36)}`;
}

function readBalance(kind: OpAccount['kind'], id: string, wallet?: UserWalletRef): number | null {
	if (kind === 'team') return wallet ? userTeamWallet(id, wallet.teamId)?.balance ?? null : null;
	return kind === "user" ? userCredits(id) : agentCredits(id);
}

/**
 * 执行一次结算：**全通过才动钱，任一不足则一分不动**。
 * 同步、不可被打断（Node 单线程 + saveJson 同步写），故无需锁。
 */
export function settle(input: SettleInput): SettleResult {
	if (input.idempotencyKey) {
    const old = db.prepare("SELECT status FROM credit_ops WHERE op_id=?").get(input.idempotencyKey) as {status:string}|undefined;
    if (old && ['done','healed'].includes(old.status)) return {ok:true,charged:{opId:input.idempotencyKey,payerId:input.payerId,statsUserId:input.statsUserId,userAmount:input.userAmount,userWallet:input.userWallet,agents:input.agents}};
    if (old && old.status !== 'aborted') return {ok:false,error:'结算流水待恢复'};
    if (old) db.prepare("DELETE FROM credit_ops WHERE op_id=? AND status='aborted'").run(input.idempotencyKey);
  }
  const accounts: OpAccount[] = [];
	const push = (kind: OpAccount['kind'], id: string, delta: number, wallet?: UserWalletRef): string | null => {
		if (!Number.isFinite(delta)) return '结算金额无效';
		if (!id || delta === 0) return null;
		const pre = readBalance(kind, id, wallet);
		if (pre === null) return kind === "user" ? "用户不存在" : "渠道商不存在";
		const post = pre + delta;
		if (post < 0 && delta < 0 && input.reason !== "text-token-settle" && input.reason !== "text-token-mirror") {
			// 退款方向不该走到这里；扣款方向=余额在 plan 之后被并发请求吃掉了
			if (kind === 'agent') return AGENT_CREDIT_SHORTAGE;
			const team = kind === 'team' || input.creditSource?.startsWith('team-') || input.payerId !== input.statsUserId;
			return team
				? `团队积分不足：本次需 ${-delta}，剩余 ${pre}。请联系团长或在团队页将积分消耗方式改为个人`
				: `个人积分不足：本次需 ${-delta}，剩余 ${pre}，请充值`;
		}
		accounts.push({ kind, id, wallet, delta, pre, post });
		return null;
	};

	let payerId = input.payerId, wallet = input.userWallet;
	if (wallet) {
		const record = userTeamWallet(payerId, wallet.teamId);
		if (record && (record.ownerId !== wallet.ownerId || record.ownerAgentId !== wallet.ownerAgentId)) return { ok: false, error: '团队积分归属不一致' };
		if (!record || record.closed) {
			// A completed request may settle/refund after the member left. Money still
			// belongs to the original leader, never to the former member's personal wallet.
			if (!getUser(wallet.ownerId) || getUser(wallet.ownerId)!.agentId !== wallet.ownerAgentId) return { ok: false, error: '原团队积分账户不可用' };
			payerId = wallet.ownerId;
			wallet = undefined;
		}
	}
	const err = push(wallet ? 'team' : 'user', payerId, -input.userAmount, wallet);
	if (err) return { ok: false, error: err };
	for (const a of input.agents) {
		const e = push("agent", a.id, -a.cost);
		if (e) return { ok: false, error: e };
	}

	const charged: Charged = {
		opId: input.idempotencyKey ?? nextOpId(),
		payerId: input.payerId,
		statsUserId: input.statsUserId,
		userAmount: input.userAmount,
		userWallet: input.userWallet,
		agents: input.agents.filter((a) => a.cost !== 0),
	};
	if (!accounts.length) return { ok: true, charged }; // 免费模型：无账可动，直接放行

	// ① 先落「意图 + 每账户 pre/post」——崩溃自愈的唯一依据
	db.prepare(
		"INSERT INTO credit_ops (op_id, created_at, reason, ref, payer_id, stats_user_id, accounts, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')",
	).run(charged.opId, Date.now(), input.reason, input.ref ?? null, input.payerId, input.statsUserId, JSON.stringify(accounts));

	// ② 改内存 + 落盘（两个文件各自原子；两者之间的微秒窗口由启动自愈兜底）
	applyAccounts(accounts, input.statsUserId);

	// ③ 标记完成
	db.prepare("UPDATE credit_ops SET status = 'done' WHERE op_id = ?").run(charged.opId);
	return { ok: true, charged };
}

/** 把账户变动写进内存并落盘（settle 与 selfHeal 共用一把尺） */
function applyAccounts(accounts: OpAccount[], statsUserId: string): void {
	let touchedUsers = false;
	let touchedAgents = false;
	for (const a of accounts) {
		if (a.kind === 'team') {
			if (!a.wallet || !applyTeamCreditsDelta(a.id, a.wallet.teamId, statsUserId, a.delta, a.post < 0)) throw new Error('团队积分写入失败');
			touchedUsers = true;
		} else if (a.kind === "user") {
			if (!applyUserCreditsDelta(a.id, statsUserId, a.delta, a.post < 0)) throw new Error("用户结算余额写入失败");
			touchedUsers = true;
		} else {
			if (!applyAgentCreditsDelta(a.id, a.delta, a.post < 0)) throw new Error("渠道结算余额写入失败");
			touchedAgents = true;
		}
	}
	if (touchedUsers) persistUsers();
	if (touchedAgents) persistAgents();
}

/**
 * 原路退回一次结算（异步任务失败 / 同步请求失败）。
 * 走统一退款闸门检查已结算/已退款记录，再经 settle 原子写入。
 * 返回状态区分实退、重复退款、已结算与账务错误。
 */
export function reverse(charged: Charged, reason: RequestRefundInput['reason'] = 'refund', ref?: string): RequestRefundResult {
	return refundRequest({ logId: ref, ref: ref ?? charged.opId,
		reason, payerId: charged.payerId, statsUserId: charged.statsUserId,
		userAmount: charged.userAmount, userWallet: charged.userWallet, agents: charged.agents });
}

/**
 * 启动自愈：处理上次进程死在「意图已写、落盘没写完」之间的残留。
 *
 * 判据（因为结算是同步块，任一时刻最多只有一条 pending 被撕开）：
 *  - 所有账户都还停在 pre → 那次结算**一个字节都没落盘**，请求也就没发出去 → 作废；
 *  - 只要有任一账户已到 post → 结算已经开始生效 → 把剩下停在 pre 的账户补齐到 post。
 * 既不多扣也不少扣，且对「已经手工改过余额」的账户保守跳过并留痕。
 */
export function selfHealCredits(logger?: { warn: (m: string) => void }): void {
	const rows = db.prepare("SELECT op_id, accounts, stats_user_id FROM credit_ops WHERE status = 'pending' ORDER BY seq").all() as {
		op_id: string;
		accounts: string;
		stats_user_id: string;
	}[];
	if (!rows.length) return;
	const warn = (m: string) => (logger ? logger.warn(m) : console.warn(m));

	for (const row of rows) {
		let accounts: OpAccount[] = [];
		try {
			accounts = JSON.parse(row.accounts) as OpAccount[];
		} catch {
			db.prepare("UPDATE credit_ops SET status = 'corrupt' WHERE op_id = ?").run(row.op_id);
			continue;
		}
		const cur = accounts.map((a) => ({ a, now: readBalance(a.kind, a.id, a.wallet) }));
		const anyApplied = cur.some((c) => c.now !== null && c.now === c.a.post && c.a.pre !== c.a.post);
		if (!anyApplied) {
			db.prepare("UPDATE credit_ops SET status = 'aborted' WHERE op_id = ?").run(row.op_id);
			warn(`[结算自愈] ${row.op_id} 未落盘，作废（涉及 ${accounts.length} 个账户）`);
			continue;
		}
		const todo = cur.filter((c) => c.now !== null && c.now === c.a.pre && c.a.pre !== c.a.post).map((c) => c.a);
		const stale = cur.filter((c) => c.now !== null && c.now !== c.a.pre && c.now !== c.a.post);
		if (todo.length) applyAccounts(todo, row.stats_user_id);
		db.prepare("UPDATE credit_ops SET status = 'healed' WHERE op_id = ?").run(row.op_id);
		warn(
			`[结算自愈] ${row.op_id} 撕裂，已补齐 ${todo.length} 个账户` +
			(stale.length ? `；${stale.length} 个账户余额已被改动，保守跳过：${stale.map((s) => `${s.a.kind}:${s.a.id}`).join(",")}` : ""),
		);
	}
}

/** 积分流水查询（管理端对账用；倒序，按需过滤账户/关联对象） */
export function listCreditOps(opts: { accountId?: string; ref?: string; limit?: number } = {}): {
	opId: string; at: number; reason: string; ref?: string; status: string; accounts: OpAccount[];
}[] {
	const limit = Math.min(Math.max(opts.limit ?? 200, 1), 2000);
	const where: string[] = [];
	const args: (string | number)[] = [];
	if (opts.ref) { where.push("ref = ?"); args.push(opts.ref); }
	if (opts.accountId) { where.push("(payer_id = ? OR accounts LIKE ?)"); args.push(opts.accountId, `%"${opts.accountId}"%`); }
	const sql = `SELECT op_id, created_at, reason, ref, status, accounts FROM credit_ops${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY seq DESC LIMIT ${limit}`;
	const rows = db.prepare(sql).all(...args) as { op_id: string; created_at: number; reason: string; ref: string | null; status: string; accounts: string }[];
	return rows.map((r) => {
		let accounts: OpAccount[] = [];
		try { accounts = JSON.parse(r.accounts) as OpAccount[]; } catch { /* 损坏行按空账户回 */ }
		return { opId: r.op_id, at: r.created_at, reason: r.reason, ref: r.ref ?? undefined, status: r.status, accounts };
	});
}

/** 流水裁剪（保留天数外的 done 行；pending/healed/aborted 一律保留供人工核） */
export function pruneCreditOps(keepDays = 180): number {
	const cutoff = Date.now() - keepDays * 86400_000;
	const r = db.prepare("DELETE FROM credit_ops WHERE status = 'done' AND created_at < ?").run(cutoff);
	return Number(r.changes ?? 0);
}
