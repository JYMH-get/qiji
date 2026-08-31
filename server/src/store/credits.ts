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
import { applyUserCreditsDelta, userCredits, persistUsers } from "./users.ts";
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
CREATE INDEX IF NOT EXISTS idx_credit_ops_created ON credit_ops(created_at);
`);

/** 一次结算里被动到的一个账户（delta<0=扣，>0=退/加） */
interface OpAccount {
	kind: "user" | "agent";
	id: string;
	delta: number;
	pre: number;
	post: number;
}

export interface SettleInput {
	/** 结算事由：generate / batch / refund / reconcile-refund */
	reason: string;
	/** 关联对象（logId 或 taskId），便于对账时回溯 */
	ref?: string;
	/** 实际扣款人（团队共享积分模式=团长），=统计人时两者相同 */
	payerId: string;
	/** 消耗统计归属人（实际发起请求的用户） */
	statsUserId: string;
	/** 用户侧金额：>0=扣，<0=退 */
	userAmount: number;
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
	agents: { id: string; cost: number }[];
}

export type SettleResult = { ok: true; charged: Charged } | { ok: false; error: string };

let _opSeq = 0;
function nextOpId(): string {
	_opSeq += 1;
	return `co_${Date.now().toString(36)}${_opSeq.toString(36)}`;
}

function readBalance(kind: "user" | "agent", id: string): number | null {
	return kind === "user" ? userCredits(id) : agentCredits(id);
}

/**
 * 执行一次结算：**全通过才动钱，任一不足则一分不动**。
 * 同步、不可被打断（Node 单线程 + saveJson 同步写），故无需锁。
 */
export function settle(input: SettleInput): SettleResult {
	const accounts: OpAccount[] = [];
	const push = (kind: "user" | "agent", id: string, delta: number): string | null => {
		if (!id || delta === 0) return null;
		const pre = readBalance(kind, id);
		if (pre === null) return kind === "user" ? "用户不存在" : "渠道商不存在";
		const post = pre + delta;
		if (post < 0) {
			// 退款方向不该走到这里；扣款方向=余额在 plan 之后被并发请求吃掉了
			return delta < 0
				? kind === "user"
					? `额度不足：本次需 ${-delta}，剩余 ${pre}`
					: "服务暂不可用，请联系你的服务商"
				: "余额异常";
		}
		accounts.push({ kind, id, delta, pre, post });
		return null;
	};

	const err = push("user", input.payerId, -input.userAmount);
	if (err) return { ok: false, error: err };
	for (const a of input.agents) {
		const e = push("agent", a.id, -a.cost);
		if (e) return { ok: false, error: e };
	}

	const charged: Charged = {
		opId: nextOpId(),
		payerId: input.payerId,
		statsUserId: input.statsUserId,
		userAmount: input.userAmount,
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
		if (a.kind === "user") {
			applyUserCreditsDelta(a.id, statsUserId, a.delta);
			touchedUsers = true;
		} else {
			applyAgentCreditsDelta(a.id, a.delta);
			touchedAgents = true;
		}
	}
	if (touchedUsers) persistUsers();
	if (touchedAgents) persistAgents();
}

/**
 * 原路退回一次结算（异步任务失败 / 同步请求失败）。
 * 走同一条 settle 通道 → 退款本身也是原子的、也进流水。
 * 退款方向不会被余额卡住（都是加钱），故正常必定成功。
 */
export function reverse(charged: Charged, reason = "refund", ref?: string): SettleResult {
	return settle({
		reason,
		ref: ref ?? charged.opId,
		payerId: charged.payerId,
		statsUserId: charged.statsUserId,
		userAmount: -charged.userAmount,
		agents: charged.agents.map((a) => ({ id: a.id, cost: -a.cost })),
	});
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
		const cur = accounts.map((a) => ({ a, now: readBalance(a.kind, a.id) }));
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
