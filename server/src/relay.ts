/**
 * 渠道节点 relay 模式（P3 商业化改造，docs/商业化改造方案.md §5）。
 *
 * 角色：NODE_ROLE=relay 时本服务是渠道商自部署的「渠道节点」——
 *  - **本地拥有**：用户库（P2 注册体系全套）、团队、兑换码（本地积分自主发行）、请求日志、注册设置；
 *  - **转发**：目录/生成/任务/素材全部经 SOURCE_URL + SOURCE_NODE_KEY（ank-）走源站 /v1 协议，
 *    源站按平台价扣该商积分池；本地按**源站回传的实扣 cost** 镜像扣本地用户——
 *    金额恒等，对账=「本地日志合计 vs 源站该商 ownerId 日志合计」。
 *  - **信任边界（§5.3）**：本地积分想发多少发多少，源站不管；守门员只有商积分池——
 *    池扣穿=转发一律 402，超卖是商务问题不是技术漏洞。
 *
 * 计费镜像的时序（⚠ 勿改成「先扣本地再转发」）：
 *  转发前只做**预检**（本地余额 ≥ 目录预估价，挡住明显不够的单），真扣发生在源站受理之后、
 *  按源站回传的实扣金额——预估公式（目录价）与源站实扣可能有差（如参考视频按秒加权），
 *  以源站为准才有「金额恒等」。极端并发下本地余额可能在窗口内被吃掉 → 扣到多少算多少并告警
 *  （节点自己的经济体，差额=节点管理员的坏账，见手册对账节）。
 *
 * 异步任务退款：本地台账（relay-ledger.json）记录 taskId→{用户,金额,日志}；
 * 轮询透传见到 failed（源站已退池）→ 本地一次性退用户；长期无人轮询的由定时清扫兜底
 * （源站终态只留 48h，72h 后仍 404 视为中断退款——与源站重启对账「中断退款」语义对齐）。
 */
import { config } from "./config.ts";
import { loadJson, saveJson } from "./store/db.ts";
import { settle, type Charged } from "./store/credits.ts";
import { getUser, userCredits, type User } from "./store/users.ts";
import { finishLog } from "./store/logs.ts";
import type { Catalog } from "./contract.ts";

export const isRelay = (): boolean => config.role === "relay";

/** 源站请求：统一带 ank- 节点密钥；path 以 / 开头 */
export async function sourceFetch(path: string, init?: RequestInit & { nodeUser?: { id: string; name?: string } }): Promise<Response> {
	if (!config.source.url || !config.source.nodeKey) {
		throw new Error("渠道节点未配置源站（SOURCE_URL / SOURCE_NODE_KEY）");
	}
	const headers = new Headers(init?.headers);
	headers.set("authorization", `Bearer ${config.source.nodeKey}`);
	if (init?.nodeUser) {
		headers.set("x-node-user", init.nodeUser.id);
		if (init.nodeUser.name) headers.set("x-node-user-name", encodeURIComponent(init.nodeUser.name));
	}
	return fetch(`${config.source.url}${path}`, { ...init, headers });
}

/** 源站响应体解析（失败回 null，调用方按状态码处置） */
export async function jsonOf(res: Response): Promise<Record<string, unknown> | null> {
	try {
		const text = await res.text();
		return text ? (JSON.parse(text) as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}
export const sourceErrMsg = (j: Record<string, unknown> | null, fallback: string): string =>
	String((j?.error as { message?: string } | undefined)?.message ?? fallback);

// ── 目录缓存：定时从源站拉（带 since），本地用户与计费预估共用一份 ──────────

let cachedCatalog: Catalog | null = null;
let catalogFetchedAt = 0;
const CATALOG_TTL_MS = 20_000;

export async function relayCatalog(): Promise<Catalog | null> {
	const now = Date.now();
	if (cachedCatalog && now - catalogFetchedAt < CATALOG_TTL_MS) return cachedCatalog;
	try {
		const since = cachedCatalog ? `?since=${encodeURIComponent(cachedCatalog.version)}` : "";
		const res = await sourceFetch(`/v1/catalog${since}`);
		if (res.status === 304) {
			catalogFetchedAt = now;
			return cachedCatalog;
		}
		if (res.ok) {
			const j = (await res.json()) as Catalog;
			cachedCatalog = j;
			catalogFetchedAt = now;
			return j;
		}
	} catch {
		/* 源站瞬断：沿用旧缓存（无缓存时返回 null，调用方明确报错） */
	}
	return cachedCatalog;
}

/**
 * 本地预估价（转发前预检用）：按目录计费字段复算，与源站 resolveModelCost 同构——
 * costField×costPerUnit（routes 档随 costRules 投影）/ 固定 cost。
 * 差异边界：参考视频按秒加权（refVideoSecondsWeight）需源站探测素材时长，预估不含该部分；
 * 实扣以源站回传为准。目录里没有的模型（如已下架）预估 0，由源站定夺。
 */
export function estimateCostFromCatalog(cat: Catalog | null, model: string, params?: Record<string, unknown>): number {
	type CatModel = { id: string; cost?: number; costField?: string; costPerUnit?: number; costRules?: { when: Record<string, string>; cost?: number; costPerUnit?: number }[] };
	const models = (cat?.models ?? []) as unknown as CatModel[];
	const cm = models.find((m) => m.id === model);
	if (!cm) return 0;
	const p = params ?? {};
	const rule = (cm.costRules ?? []).find((r) => Object.keys(r.when ?? {}).every((k) => String(p[k]) === String(r.when[k])));
	if (cm.costField) {
		const perUnit = rule?.costPerUnit ?? cm.costPerUnit ?? 0;
		const unit = Math.max(0, Number(p[cm.costField]) || 0);
		if (perUnit > 0 && unit > 0) return Math.round(perUnit * unit);
	}
	return rule?.cost ?? cm.cost ?? 0;
}

// ── 本地计费镜像 ─────────────────────────────────────────────────────

/**
 * 按源站实扣金额扣本地用户（payer=团队共享模式的团长由调用方解析好传入）。
 * 余额被并发吃穿的极端窗口：扣到多少算多少（差额=节点坏账，告警留痕）——
 * 源站池已实扣，本地不能因扣不动而把请求作废。
 */
export function chargeLocalMirror(payer: User, statsUserId: string, amount: number, ref?: string): { charged: Charged | null; shortfall: number } {
	if (amount <= 0) return { charged: null, shortfall: 0 };
	const r = settle({ reason: "generate", ref, payerId: payer.id, statsUserId, userAmount: amount, agents: [] });
	if (r.ok) return { charged: r.charged, shortfall: 0 };
	const balance = Math.max(0, userCredits(payer.id) ?? 0);
	const partial = Math.min(amount, balance);
	if (partial > 0) {
		const r2 = settle({ reason: "generate", ref, payerId: payer.id, statsUserId, userAmount: partial, agents: [] });
		if (r2.ok) return { charged: r2.charged, shortfall: amount - partial };
	}
	return { charged: null, shortfall: amount };
}

/** 退本地用户（异步任务失败镜像退款；金额按台账记录原路退） */
export function refundLocalMirror(payerId: string, statsUserId: string, amount: number, ref?: string): void {
	if (amount <= 0) return;
	settle({ reason: "refund", ref, payerId, statsUserId, userAmount: -amount, agents: [] });
}

// ── 异步任务台账：taskId → 本地扣款记录（退款/清扫依据；随盘防重启丢） ──────

interface LedgerEntry {
	/** 消耗用户（统计归属） */
	u: string;
	/** 实际扣款人（团队共享=团长；缺省=u） */
	p?: string;
	/** 本地实扣金额（=源站回传 cost，可能因本地余额吃穿而少扣——差额已在扣款时告警） */
	c: number;
	/** 本地请求日志 id（终态收尾用） */
	log?: string;
	at: string;
	/** 终态已处理（成功收尾/失败退款）——防重复退 */
	done?: boolean;
}
interface LedgerFile {
	tasks: Record<string, LedgerEntry>;
}

const LEDGER_FILE = "relay-ledger.json";
const ledger: LedgerFile = loadJson<LedgerFile>(LEDGER_FILE, { tasks: {} });
const persistLedger = (): void => saveJson(LEDGER_FILE, ledger);

export function ledgerRecord(taskId: string, e: Omit<LedgerEntry, "at">): void {
	ledger.tasks[taskId] = { ...e, at: new Date().toISOString() };
	persistLedger();
}

/**
 * 任务终态处理（轮询透传与定时清扫共用一把尺；幂等——done 后再见终态不重复处理）。
 * failed=源站已退池 → 本地镜像退用户 + 日志收尾；success=日志收尾。
 */
export function ledgerSettleTerminal(taskId: string, status: "success" | "failed", opts?: { error?: string; response?: unknown }): void {
	const e = ledger.tasks[taskId];
	if (!e || e.done) return;
	e.done = true;
	if (status === "failed") {
		refundLocalMirror(e.p ?? e.u, e.u, e.c, taskId);
		if (e.log) finishLog(e.log, { status: "failed", error: opts?.error ? `${opts.error}（已退回 ${e.c} 积分）` : `生成失败（已退回 ${e.c} 积分）` });
	} else if (e.log) {
		finishLog(e.log, { status: "success", response: opts?.response, taskId });
	}
	persistLedger();
}

/**
 * 定时清扫：长期无人轮询的在途任务（客户端崩溃/关机）向源站补查一次。
 *  - 终态 → 正常收尾（失败退款）；
 *  - 404 且已超 72h（源站终态只留 48h）→ 视为中断，退款收尾；
 *  - done 且超 7 天 → 从台账清除。
 */
export async function relaySweep(log?: { info?: (m: string) => void; warn?: (m: string) => void }): Promise<void> {
	const now = Date.now();
	let touched = false;
	for (const [taskId, e] of Object.entries(ledger.tasks)) {
		if (e.done) {
			if (now - new Date(e.at).getTime() > 7 * 86400_000) {
				delete ledger.tasks[taskId];
				touched = true;
			}
			continue;
		}
		try {
			const res = await sourceFetch(`/v1/tasks/${encodeURIComponent(taskId)}`, { nodeUser: { id: e.u } });
			if (res.ok) {
				const j = (await res.json()) as { status?: string; error?: { message?: string } | string; result?: unknown };
				if (j.status === "failed") {
					ledgerSettleTerminal(taskId, "failed", { error: typeof j.error === "string" ? j.error : j.error?.message });
					log?.info?.(`[relay 清扫] 任务 ${taskId} 源站已失败，本地退款 ${e.c}`);
				} else if (j.status === "success") {
					ledgerSettleTerminal(taskId, "success", { response: j.result });
					log?.info?.(`[relay 清扫] 任务 ${taskId} 源站已完成，本地日志收尾`);
				}
			} else if (res.status === 404 && now - new Date(e.at).getTime() > 72 * 3600_000) {
				ledgerSettleTerminal(taskId, "failed", { error: "任务中断（源站已过期）" });
				log?.warn?.(`[relay 清扫] 任务 ${taskId} 源站已过期，按中断退款 ${e.c}`);
			}
		} catch {
			/* 源站瞬断：下轮再试 */
		}
	}
	if (touched) persistLedger();
}

/** 源站连通性自检（节点管理端「源站连接」卡）：/v1/node/me 一把尺 */
export async function relaySourceStatus(): Promise<{
	configured: boolean;
	sourceUrl: string;
	ok: boolean;
	error?: string;
	agent?: { id: string; name: string; credits: number; enabled: boolean; inviteCode?: string };
	catalogVersion?: string;
	pendingTasks: number;
}> {
	const pendingTasks = Object.values(ledger.tasks).filter((e) => !e.done).length;
	if (!config.source.url || !config.source.nodeKey) {
		return { configured: false, sourceUrl: config.source.url, ok: false, error: "未配置 SOURCE_URL / SOURCE_NODE_KEY", pendingTasks };
	}
	try {
		const res = await sourceFetch("/v1/node/me");
		const j = await jsonOf(res);
		if (!res.ok) {
			return { configured: true, sourceUrl: config.source.url, ok: false, error: sourceErrMsg(j, `源站返回 ${res.status}`), pendingTasks };
		}
		return {
			configured: true,
			sourceUrl: config.source.url,
			ok: true,
			agent: j as unknown as { id: string; name: string; credits: number; enabled: boolean; inviteCode?: string },
			catalogVersion: cachedCatalog?.version,
			pendingTasks,
		};
	} catch (err) {
		return { configured: true, sourceUrl: config.source.url, ok: false, error: (err as Error).message, pendingTasks };
	}
}

/** relay 启动装配：目录预热 + 台账清扫（启动一次 + 每 10 分钟） */
export function startRelayLoops(log?: { info?: (m: string) => void; warn?: (m: string) => void }): void {
	void relayCatalog();
	void relaySweep(log);
	setInterval(() => {
		void relaySweep(log);
	}, 10 * 60_000).unref?.();
}

/** 免检查取 payer 的团队解析由 routes 传入（避免 relay↔teams 循环依赖）；这里只补一个便捷读用户 */
export const relayGetUser = getUser;
