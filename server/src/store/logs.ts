/**
 * 请求记录（按天分文件的轻量索引 + 分条详情）。
 *
 * 之前把每条的完整 ①②③④ 报文（每条约 20KB）都堆在一个 logs.jsonl 里、每次变更全量重写，
 * 大文件同步 stringify+写盘把 event loop 冻住（心跳/登录/admin 全卡）。第105轮拆两层，第129轮
 * 再把索引按天分文件——每天一个 data/logs-index/<YYYY-MM-DD>.jsonl：
 *   ① 索引 data/logs-index/<日期>.jsonl：只存元信息（用户/步骤/模型/状态/时间/消耗/错误/结果链接），
 *      **全部常驻内存**，防抖异步落盘时只重写当天（及被裁剪当天）的文件，不再全量重写——
 *      列表/统计/筛选/导出全走内存，绝不触碰重报文。
 *   ② 详情 data/logs/<id>.json：单条的重报文（headers + ①请求 ②响应 ③上游请求 ④上游响应），
 *      按条独立文件、只在「打开某条请求详情」或「启动对账救回视频」时才读。
 * 按时间保留（第222轮恢复三档——库体积失控（30 天全量报文 ≈5-6GB）后按用户定「报文仅留 3 天」）：
 *   ≤3 天    完整保留（索引 + 详情四段报文）；
 *   3~30 天  仅保留索引记录（详情清除、detailPruned 标记，详情页显示「已清除」）；
 *   >30 天   整天清除（索引 + 详情）。
 * 列表/统计/导出全走索引（成片链接已预抽进 resultLink），不受详情清除影响。
 * 裁剪时机：启动一次 + 每小时一次（闲置也照样过期），不挂在请求路径上。
 * 首启一次性迁移旧的单文件 data/logs.jsonl → 按天分文件（迁移后旧文件改名 .migrated 留底）。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { scrubChannelInfo } from "../errorScrub.ts";
import { readJsonl, genId, truncateBase64, DATA_DIR } from "./db.ts";
import { db } from "./sqlite.ts";
import type { GenerateRequest } from "../contract.ts";

const LEGACY_FILE = "logs.jsonl"; // 旧的单文件索引（第129轮前）；首启迁移后改名 .migrated
const INDEX_DIR_NAME = "logs-index"; // 按天分文件的索引目录（相对 DATA_DIR）
const INDEX_DIR = join(DATA_DIR, INDEX_DIR_NAME); // 绝对路径
const DETAIL_DIR = join(DATA_DIR, "logs"); // 分条详情目录
const META_KEEP_MS = 30 * 86400000; // 索引记录保留 30 天；超过则整天清除（索引 + 详情）
const DETAIL_KEEP_MS = 3 * 86400000; // ①②③④ 重报文只留 3 天（第222轮用户定稿；排障基本只查近几天的单）

/** 记录归属的 UTC 日期串（YYYY-MM-DD）——startedAt 恒为 toISOString 产物，切片即得 */
const dayOf = (startedAt: string): string => (startedAt || "").slice(0, 10);
/** 某天索引文件的相对名（供 readJsonl / scheduleSave） */
const indexName = (day: string): string => join(INDEX_DIR_NAME, `${day}.jsonl`);

/** 归属哨兵：平台直属（filterLogs.owners 用；与 agents.ts PLATFORM_AUDIENCE 同值） */
export const PLATFORM_OWNER = "platform";

/** 步骤 purpose 的中文代称（与客户端 purposeRegistry / admin PURPOSE_LABELS 对应） */
export const PURPOSE_LABELS: Record<string, string> = {
	"script.toScenes": "小说转剧本",
	"script.analyze": "剧本分析",
	"storyboard.split": "剧本分镜",
	"storyboard.toImagePrompt": "故事板提示词",
	"storyboard.toVideoPrompt": "视频提示词",
	"asset.character.image": "角色出图",
	"asset.character.variant": "角色变体",
	"asset.scene.image": "场景出图",
	"asset.scene.variant": "场景变体",
	"asset.creature.image": "生物出图",
	"asset.creature.variant": "生物变体",
	"asset.prop.image": "物品出图",
	"asset.prop.variant": "物品变体",
	"video.generate": "视频生成",
	"video.upscale": "视频超分",
	"video.desub": "视频去字幕",
	"image.upscale": "图像超分",
	"image.viewangle": "转视角",
	"image.panorama": "720°全景",
	"audio.tts": "语音合成",
	"storyboard.singleShot": "单卡推理",
	"storyboard.unified": "图视同源（多卡）",
	"storyboard.unifiedShot": "图视同源（单卡）",
	"chat.reply": "AI 对话",
	"chat.summarize": "对话总结",
	"code.issue": "激活码签发",
};
const purposeLabel = (p?: string) => (p ? PURPOSE_LABELS[p] || p : "");

/** 把敏感令牌脱敏为 "Bearer ****1234"（保留协议与末 4 位） */
export function maskToken(s: string): string {
	const m = String(s).match(/^(Bearer|Basic)\s+(.*)$/i);
	const tok = m ? m[2] : String(s);
	const tail = tok.length > 4 ? tok.slice(-4) : "";
	return (m ? m[1] + " " : "") + "****" + tail;
}
const SENSITIVE_HEADERS = new Set(["authorization", "x-api-key", "x-goog-api-key", "api-key", "cookie"]);
function maskHeaders(h: unknown): Record<string, unknown> | undefined {
	if (!h || typeof h !== "object") return undefined;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
		out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? maskToken(String(v)) : v;
	}
	return out;
}

/** 索引元信息：常驻内存 + 落盘 logs.jsonl（很小，列表/统计/导出/筛选全走它） */
export interface LogMeta {
	id: string;
	clientTaskId?: string;
	taskId?: string;
	userId?: string;
	userName?: string;
	/** 按渠道商归属的日志（第126轮开码消耗）：签发商 id。普通用户请求日志无此字段。
	 *  门户/商属请求记录经 agentIds 过滤纳入这些非用户日志（源站主视图排除）。 */
	agentId?: string;
	/** 归属渠道商（第198轮按渠道商分类，**落笔时固化**）：用户日志=其直属商 id、开码日志=签发商 id；
	 *  平台直属=undefined（SQLite owner 列存 ''）。此后归属不随 用户删除/改归属 漂移；
	 *  门户/管理端商属视图按它过滤（filterLogs.owners），不再从用户表反推。 */
	ownerId?: string;
	purpose?: string; // 请求方式 / 在哪一步
	model?: string;
	cost?: number; // 本次消耗积分——**用户侧实扣**（按其直属商售价；平台直属=平台价）
	/** 归属链各级渠道商的结算侧实扣（第124轮补：直属商→根，仅记 >0 的级）。
	 *  「每个环节只看自身积分变化」：门户显示本商那份、源站显示根级那份（=源站实收）、
	 *  客户端仍只回 cost（用户那份）——各级的价互相保密，经 logCostFor 一把尺取数。
	 *  ⚠ 该数组含上级各级的价，**任何对渠道商/用户的响应都不得原样下发**（门户端点已剥）。 */
	agentCosts?: { id: string; cost: number }[];
	/** 实际扣款人（第183轮）：团队共享积分模式下=团长。缺省=userId 本人。
	 *  ⚠ 启动对账（reconcile.ts）退孤儿日志的款时按它退——不记就会退给从没付过款的团员。 */
	payerId?: string;
	status: "running" | "success" | "failed";
	startedAt: string;
	finishedAt?: string;
	durationMs?: number;
	error?: string;
	resultLink?: string; // 成功产物链接（完成时从 response 预抽，导出/列表用，免读详情）
	detailPruned?: boolean; // 详情已按 3 天期限清除（只剩索引记录；随索引落盘，重启不重复探删）
}

/** 单条重报文：存 data/logs/<id>.json，仅详情视图/对账按需读取 */
export interface LogDetail {
	requestHeaders?: unknown; // ① 用户 → 管理端 的请求头（敏感值已脱敏）
	request?: unknown; // ① 用户 → 管理端 的完整请求体（截断 base64）
	response?: unknown; // ② 管理端 → 用户 的完整响应 / 结果（截断 base64）
	upstreamRequest?: unknown; // ③ 管理端 → 上游(网关/第三方) 的请求体
	upstreamResponse?: unknown; // ④ 上游 → 管理端 的原始响应
}

/** 完整记录（元信息 + 重报文）：详情视图、启动对账用 */
export type LogEntry = LogMeta & LogDetail;

// ── 持久层：SQLite（P4 第一批）──
// 换掉的两个病灶：
//  ① 索引按天 JSONL —— 当天文件每次 flush **全量 stringify + 重写**（13k 条/天 ≈ 4MB），
//     晚高峰每秒把 event loop 冻 20–50ms；现在改成单行 UPSERT，微秒级。
//  ② 详情按条落 data/logs/<id>.json —— 目录里堆了 39 万个文件，启动 readdir 扫一遍；
//     现在一张表，删除/清扫都是一条 SQL。
// ⚠ **只换持久层，查询逻辑一行不动**：列表/统计/筛选/导出仍在内存 `index` 数组上跑
//   （计费口径 logCostFor / filterLogs 全在那），改它风险大收益小。
// meta 整条以 JSON 存一列：省掉列映射，`toMeta` 与落盘格式保持同一形状，不会写着写着漂移。
db.exec(`
	CREATE TABLE IF NOT EXISTS logs (
		id         TEXT PRIMARY KEY,
		day        TEXT NOT NULL,   -- YYYY-MM-DD（UTC），>30 天整天清除按它
		started_at TEXT NOT NULL,
		owner      TEXT NOT NULL DEFAULT '', -- 归属渠道商 id；''=平台直属（第198轮按渠道商分类）
		meta       TEXT NOT NULL    -- LogMeta 的 JSON
	);
	CREATE INDEX IF NOT EXISTS idx_logs_day     ON logs(day);
	CREATE INDEX IF NOT EXISTS idx_logs_started ON logs(started_at);
	CREATE TABLE IF NOT EXISTS log_details (
		id     TEXT PRIMARY KEY,
		detail TEXT NOT NULL        -- LogDetail 的 JSON（①②③④ 四段报文）
	);
`);
// 存量库补 owner 列（幂等：已存在即抛错忽略）；索引须在补列之后建（第198轮）
try { db.exec("ALTER TABLE logs ADD COLUMN owner TEXT NOT NULL DEFAULT ''"); } catch { /* 列已存在 */ }
db.exec("CREATE INDEX IF NOT EXISTS idx_logs_owner ON logs(owner, started_at)");

const stmtLogUpsert = db.prepare("INSERT INTO logs (id, day, started_at, owner, meta) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET meta = excluded.meta, owner = excluded.owner");
const stmtLogAll = db.prepare("SELECT meta FROM logs ORDER BY started_at");
const stmtLogDelDay = db.prepare("DELETE FROM logs WHERE day = ?");
const stmtDetailGet = db.prepare("SELECT detail FROM log_details WHERE id = ?");
const stmtDetailPut = db.prepare("INSERT INTO log_details (id, detail) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET detail = excluded.detail");
const stmtDetailDel = db.prepare("DELETE FROM log_details WHERE id = ?");

function writeDetail(id: string, detail: LogDetail): void {
	try {
		stmtDetailPut.run(id, JSON.stringify(detail));
	} catch {
		/* 详情落库失败不影响主流程（索引仍在） */
	}
}
function readDetail(id: string): LogDetail | undefined {
	try {
		const r = stmtDetailGet.get(id) as { detail: string } | undefined;
		return r ? (JSON.parse(r.detail) as LogDetail) : undefined;
	} catch {
		return undefined;
	}
}
/** 读改写详情的一个字段（③④ 增量记录、②完成写入） */
function patchDetail(id: string, patch: LogDetail): void {
	writeDetail(id, { ...(readDetail(id) ?? {}), ...patch });
}
function deleteDetail(id: string): void {
	try {
		stmtDetailDel.run(id);
	} catch {
		/* 忽略 */
	}
}

/** 从 response 里抽成功产物链接（图/视频资产 url；文本结果无链接） */
function resultLinkFrom(resp: unknown): string {
	const r = resp as { assets?: unknown; result?: { assets?: unknown } } | undefined;
	const assets = (r?.assets ?? r?.result?.assets) as Array<{ url?: unknown }> | undefined;
	if (Array.isArray(assets)) {
		const urls = assets.map((a) => a?.url).filter((u): u is string => typeof u === "string" && !!u);
		if (urls.length) return urls.join(" | ");
	}
	return "";
}

// ── 内存索引的落库 ──
// 语义与之前一致：调用方 markDirty(meta) 标记若干条、随后 flushIndex() 一次性落盘。
// 区别是从「重写这些条所在的整天文件」变成「UPSERT 这几条」——同样是批量，但代价与**改动条数**
// 成正比，而不是与**当天总条数**成正比。这正是「越用越卡」的根因所在。
const dirty = new Set<LogMeta>();
const markDirty = (m: LogMeta): void => void dirty.add(m);
/** 落盘：一个事务批量 UPSERT（同步，但单条是微秒级索引写，不是几 MB 的 stringify） */
function flushIndex(): void {
	if (!dirty.size) return;
	const batch = [...dirty];
	dirty.clear();
	try {
		db.exec("BEGIN");
		for (const m of batch) stmtLogUpsert.run(m.id, dayOf(m.startedAt), m.startedAt, m.ownerId ?? "", JSON.stringify(m));
		db.exec("COMMIT");
	} catch {
		try { db.exec("ROLLBACK"); } catch { /* 已回滚 */ }
		/* 落库失败不崩进程：内存索引仍为准，下次该条再变更时会重试 */
	}
}
/** 删除某天的全部记录（>30 天整天清除时用） */
function deleteDayFile(day: string): void {
	try {
		stmtLogDelDay.run(day);
	} catch {
		/* 忽略 */
	}
}

function toMeta(r: Record<string, unknown>): LogMeta {
	return {
		id: String(r.id),
		clientTaskId: r.clientTaskId as string | undefined,
		taskId: r.taskId as string | undefined,
		userId: r.userId as string | undefined,
		userName: r.userName as string | undefined,
		// ⚠ agentId/agentCosts/ownerId 必须读回，否则重启后历史记录丢失渠道商归属（logCostFor/filterLogs 失配）
		agentId: r.agentId as string | undefined,
		ownerId: r.ownerId as string | undefined,
		agentCosts: Array.isArray(r.agentCosts) ? (r.agentCosts as { id: string; cost: number }[]) : undefined,
		payerId: r.payerId as string | undefined,
		purpose: r.purpose as string | undefined,
		model: r.model as string | undefined,
		cost: r.cost as number | undefined,
		status: (r.status as LogMeta["status"]) ?? "failed",
		startedAt: String(r.startedAt ?? new Date().toISOString()),
		finishedAt: r.finishedAt as string | undefined,
		durationMs: r.durationMs as number | undefined,
		error: r.error as string | undefined,
		resultLink: (r.resultLink as string | undefined) || (r.response !== undefined ? resultLinkFrom(r.response) || undefined : undefined),
		detailPruned: r.detailPruned === true ? true : undefined,
	};
}

/**
 * 首启一次性迁移旧的单文件 data/logs.jsonl → 按天分文件。
 * 遇旧格式（重字段内联在 jsonl 里）把重报文迁到独立详情文件，索引只留元信息。
 * 迁移成功后把旧文件改名 .migrated 留底，幂等（下次启动旧文件已不在，跳过）。
 */
function migrateLegacyIfNeeded(): void {
	const legacyPath = join(DATA_DIR, LEGACY_FILE);
	if (!existsSync(legacyPath)) return;
	try {
		const raw = readJsonl<Record<string, unknown>>(LEGACY_FILE);
		const byDay = new Map<string, LogMeta[]>();
		for (const r of raw) {
			const hasHeavy =
				r.request !== undefined || r.response !== undefined || r.requestHeaders !== undefined || r.upstreamRequest !== undefined || r.upstreamResponse !== undefined;
			if (hasHeavy) {
				writeDetail(String(r.id), {
					requestHeaders: r.requestHeaders,
					request: r.request,
					response: r.response,
					upstreamRequest: r.upstreamRequest,
					upstreamResponse: r.upstreamResponse,
				});
			}
			const m = toMeta(r);
			const day = dayOf(m.startedAt);
			let arr = byDay.get(day);
			if (!arr) { arr = []; byDay.set(day, arr); }
			arr.push(m);
		}
		if (!existsSync(INDEX_DIR)) mkdirSync(INDEX_DIR, { recursive: true });
		for (const [day, rows] of byDay) {
			// 首次迁移目录为空，直接写；正常不会覆盖运行期已生成的当天文件
			writeFileSync(join(INDEX_DIR, `${day}.jsonl`), rows.map((m) => JSON.stringify(m)).join("\n") + (rows.length ? "\n" : ""), "utf8");
		}
		renameSync(legacyPath, `${legacyPath}.migrated`);
	} catch {
		/* 迁移失败：保留旧文件下次再试，不崩启动 */
	}
}

/**
 * 首启一次性迁移「按天 JSONL 索引 + 分条详情文件」→ SQLite（P4）。
 * 幂等：logs 表非空即跳过；迁完把两个目录改名 `.migrated-sqlite` 留底（不删，出事可回滚）。
 * ⚠ 详情文件可能有几万个，这一步会阻塞启动几秒——一次性代价，换掉此后每天的持续卡顿。
 */
function migrateFilesToSqlite(): void {
	const n = Number((db.prepare("SELECT COUNT(*) AS n FROM logs").get() as { n: number }).n);
	if (n > 0) return; // 已迁移
	if (!existsSync(INDEX_DIR)) return; // 全新环境，无可迁
	let days: string[] = [];
	try { days = readdirSync(INDEX_DIR).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -6)); } catch { return; }
	if (!days.length) return;
	let metaCount = 0;
	let detailCount = 0;
	try {
		db.exec("BEGIN");
		for (const day of days) {
			for (const r of readJsonl<Record<string, unknown>>(indexName(day))) {
				const m = toMeta(r);
				stmtLogUpsert.run(m.id, dayOf(m.startedAt), m.startedAt, m.ownerId ?? "", JSON.stringify(m));
				metaCount += 1;
				// 详情：旧实现一条一个 <id>.json，逐个搬进表（读不到就跳过——多半已按期清除）
				try {
					const p = join(DETAIL_DIR, `${m.id}.json`);
					if (existsSync(p)) {
						stmtDetailPut.run(m.id, readFileSync(p, "utf8"));
						detailCount += 1;
					}
				} catch { /* 单条详情读失败不影响整体 */ }
			}
		}
		db.exec("COMMIT");
	} catch (e) {
		try { db.exec("ROLLBACK"); } catch { /* 已回滚 */ }
		console.warn("[logs] 迁移 SQLite 失败，继续用文件（下次启动重试）：", (e as Error).message);
		return;
	}
	console.log(`[logs] 已迁移 ${metaCount} 条记录 + ${detailCount} 条详情到 SQLite`);
	// 目录留底改名：迁移已提交，旧文件不再是真理源，但保留一份好回滚
	for (const [dir, suffix] of [[INDEX_DIR, ".migrated-sqlite"], [DETAIL_DIR, ".migrated-sqlite"]] as const) {
		try { if (existsSync(dir)) renameSync(dir, dir + suffix); } catch { /* 改名失败无碍：表非空守卫已防重复导入 */ }
	}
}

/** 启动加载索引：旧单文件 → 按天文件 → SQLite，逐级迁移后从表里读回全部（>30 天的由随后 trimAndPrune 清理）。 */
function loadIndex(): LogMeta[] {
	migrateLegacyIfNeeded(); // 第129轮前的单文件 logs.jsonl → 按天文件
	migrateFilesToSqlite(); // 按天文件 + 详情文件 → SQLite（P4）
	const metas: LogMeta[] = [];
	try {
		for (const r of stmtLogAll.all() as { meta: string }[]) metas.push(toMeta(JSON.parse(r.meta) as Record<string, unknown>));
	} catch { /* 读表失败=空索引，不崩启动 */ }
	// startedAt 为 toISOString 定长格式，字典序即时间序——SQL 已按它排序（旧→新，listLogs 依赖此序 reverse 取最新）
	return metas;
}

let index: LogMeta[] = loadIndex();

// 第168轮：存量请求记录「失败原因」一次性补擦渠道识别信息（新记录已在 applyFinishMeta 收口；
// ③④上游报文段不动——仅源站管理端可见，留全量供排障。flag 文件防每次启动全量重扫）
{
	// v2：补简梦X 系渠道别名（v1 漏擦）。⚠ flag 落 DATA_DIR 而非 INDEX_DIR ——
	// P4 迁移后 INDEX_DIR 已被改名，写在那里会导致每次启动都重扫全量。
	const flag = join(DATA_DIR, ".logs-error-scrub-v2");
	if (!existsSync(flag)) {
		try {
			for (const m of index) {
				if (!m.error) continue;
				const s = scrubChannelInfo(m.error);
				if (s !== m.error) { m.error = s; markDirty(m); }
			}
			flushIndex();
			writeFileSync(flag, new Date().toISOString());
		} catch { /* 迁移失败不影响启动，下次启动重试 */ }
	}
}

/**
 * 按时间裁剪（第129轮起纯按时间、无数量上限、无 3~30 天中间档）：>30 天**整天清除**——
 * 索引已按天分文件、同一天记录同属一个文件，直接删掉该天索引文件 + 各条详情，无需重写。
 * 启动 + 每小时各跑一次，不在请求路径上。
 */
function trimAndPrune(): void {
	// 以「天」为粒度：>30 天的整天丢弃
	const metaCutoffDay = dayOf(new Date(Date.now() - META_KEEP_MS).toISOString());
	const dropDays = new Set<string>();
	for (const m of index) if (dayOf(m.startedAt) < metaCutoffDay) dropDays.add(dayOf(m.startedAt));
	if (dropDays.size) {
		for (const m of index) if (dropDays.has(dayOf(m.startedAt))) deleteDetail(m.id);
		index = index.filter((m) => !dropDays.has(dayOf(m.startedAt)));
		for (const d of dropDays) deleteDayFile(d);
	}
	// 3~30 天：清详情只留索引（第222轮）。detailPruned 随索引落盘，重启/每小时不重复探删。
	// running 的不清——启动对账要读 ④ 段救回视频（僵尸 running 经对账收尾转终态后，下轮自然进本档）。
	const detailCutoffDay = dayOf(new Date(Date.now() - DETAIL_KEEP_MS).toISOString());
	for (const m of index) {
		if (m.detailPruned || m.status === "running") continue;
		if (dayOf(m.startedAt) >= detailCutoffDay) continue;
		deleteDetail(m.id);
		m.detailPruned = true;
		markDirty(m);
	}
	flushIndex();
}

/**
 * 启动时若空闲页过多（保留期收紧/大清理后的首启），VACUUM 一次把空间还给文件系统——
 * SQLite 的 DELETE 只把页挂进 freelist 复用，文件永不自行缩小。
 * ⚠ 只在启动跑：VACUUM 独占整库并阻塞（生产 GB 级库约几十秒，一次性代价），绝不能挂小时定时器。
 * 阈值：空闲 >80MB 且占比 >25%——日常稳态碰不到，防每次启动都白跑。
 */
function vacuumIfBloated(): void {
	try {
		const pc = (db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count;
		const fc = (db.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count;
		if (fc > 20000 && fc * 4 > pc) {
			const t0 = Date.now();
			db.exec("VACUUM");
			console.log(`[logs] VACUUM 完成：回收约 ${Math.round((fc * 4096) / 1048576)}MB，耗时 ${Date.now() - t0}ms`);
		}
	} catch {
		/* VACUUM 失败（如磁盘临时空间不足）不影响启动；下次启动再试 */
	}
}

/** 清扫无主详情文件（索引条目被淘汰后残留的 <id>.json / 中断残留的 .tmp），启动跑一次 */
function sweepOrphanDetails(): void {
	try {
		// 一条 SQL 顶掉原来「readdir 39 万个文件逐个比对再 unlink」的整轮扫描
		db.exec("DELETE FROM log_details WHERE id NOT IN (SELECT id FROM logs)");
	} catch {
		/* 清扫失败不影响主流程 */
	}
}

trimAndPrune();
sweepOrphanDetails();
vacuumIfBloated(); // 须在裁剪/清扫之后——大批删除产生的空闲页正是它要回收的
setInterval(trimAndPrune, 3600000).unref(); // 每小时裁剪一次；unref 不阻止进程退出

/**
 * 第198轮一次性回填：把存量请求记录的归属渠道商固化进 ownerId（新记录已在 startLog/logCodeIssue 落笔）。
 * 归属判定：开码日志按 agentId（签发商）；用户日志按**当前**用户表的直属商——与旧「查询期从用户表反推」
 * 口径在迁移时点等价；此后归属随记录固化，不再受 用户删除/改归属 影响。
 * ⚠ 由 index.ts 启动时注入 agentOfUser（logs.ts 不 import users.ts，防循环引用）；
 * flag 落 DATA_DIR（第183轮教训：放 INDEX_DIR 会因目录改名每启全量重扫）。
 */
export function backfillLogOwners(agentOfUser: (userId: string) => string | undefined): number {
	const flag = join(DATA_DIR, ".logs-owner-backfill-v1");
	if (existsSync(flag)) return 0;
	let n = 0;
	try {
		for (const m of index) {
			if (m.ownerId) continue;
			const owner = m.agentId || (m.userId ? agentOfUser(m.userId) : undefined);
			if (!owner) continue; // 平台直属/已删用户查不到归属 → 留在源站视图（与旧行为一致）
			m.ownerId = owner;
			markDirty(m);
			n += 1;
		}
		flushIndex();
		writeFileSync(flag, new Date().toISOString());
	} catch {
		/* 回填失败不崩启动，下次启动重试 */
	}
	return n;
}

export function startLog(input: {
	req: GenerateRequest;
	userId?: string;
	userName?: string;
	cost?: number;
	/** 归属链各级渠道商的结算侧实扣（直属商→根；来自 planBilling.agents） */
	agentCosts?: { id: string; cost: number }[];
	/** 实际扣款人（团队共享=团长）；与 userId 相同时传 undefined */
	payerId?: string;
	/** 归属渠道商（用户的直属商 id；平台直属不传）——第198轮落笔固化，商属视图按它过滤 */
	ownerId?: string;
	headers?: unknown;
}): LogMeta {
	const meta: LogMeta = {
		id: genId("log"),
		clientTaskId: input.req.clientTaskId,
		userId: input.userId,
		userName: input.userName,
		ownerId: input.ownerId,
		purpose: input.req.purpose,
		model: input.req.model,
		cost: input.cost,
		agentCosts: input.agentCosts?.length ? input.agentCosts : undefined,
		payerId: input.payerId,
		status: "running",
		startedAt: new Date().toISOString(),
	};
	index.push(meta);
	writeDetail(meta.id, { requestHeaders: maskHeaders(input.headers), request: truncateBase64(input.req) });
	markDirty(meta);
	flushIndex();
	return meta;
}

export interface FinishPatch {
	status: "success" | "failed";
	response?: unknown;
	error?: string;
	taskId?: string;
}

function applyFinishMeta(m: LogMeta, patch: FinishPatch): void {
	m.status = patch.status;
	m.finishedAt = new Date().toISOString();
	m.durationMs = new Date(m.finishedAt).getTime() - new Date(m.startedAt).getTime();
	// 第168轮：请求记录的失败原因擦除渠道识别信息（会经 /v1/logs 与门户下发；③④上游段不受影响）
	if (patch.error) m.error = scrubChannelInfo(patch.error);
	if (patch.taskId) m.taskId = patch.taskId;
	if (patch.response !== undefined) m.resultLink = resultLinkFrom(patch.response) || undefined;
}

/** 完成一条日志：更新索引元信息（防抖落盘）+ 把 ②响应 写入详情文件 */
export function finishLog(id: string, patch: FinishPatch): void {
	const m = index.find((x) => x.id === id);
	if (!m) return;
	applyFinishMeta(m, patch);
	if (patch.response !== undefined) patchDetail(id, { response: truncateBase64(patch.response) });
	markDirty(m);
	flushIndex();
}

/**
 * 第158轮：客户端接力转存完成后，把已完成日志的 ②响应 与 resultLink 从「上游原始时效直链」
 * 改写为真 OSS 直链（列表/导出/详情弹窗从此显示有效链接）。
 * 只动 响应段+resultLink，不动 status/finishedAt/耗时（统计口径不受改写影响）。
 */
export function rewriteLogResult(id: string, response: unknown): void {
	const m = index.find((x) => x.id === id);
	if (!m || m.status !== "success") return;
	m.resultLink = resultLinkFrom(response) || m.resultLink;
	patchDetail(id, { response: truncateBase64(response) });
	markDirty(m);
	flushIndex();
}

/** 批量收尾（启动对账清扫孤儿日志用）：一次性改多条、索引只落盘一次 */
export function finishLogsBulk(patches: ({ id: string } & FinishPatch)[]): void {
	if (!patches.length) return;
	for (const p of patches) {
		const m = index.find((x) => x.id === p.id);
		if (!m) continue;
		applyFinishMeta(m, p);
		if (p.response !== undefined) patchDetail(p.id, { response: truncateBase64(p.response) });
		markDirty(m);
	}
	flushIndex();
}

/**
 * 记录一条「激活码签发」消耗日志（第126轮：开码逐级扣费计入消耗日志）。
 * 直接落一条已完成记录（无上游请求、不走 GenerateRequest 流程）：
 *  - agentId=签发商（门户/商属请求记录按它纳入范围；源站主视图排除）；无 userId（不进客户端 /v1/logs）；
 *  - purpose="code.issue"、model=档位标签、userName=签发商名；cost=签发商自己那份；
 *    agentCosts=归属链各级实扣（logCostFor：门户看本商那份、源站看根级=源站口径）。
 */
export function logCodeIssue(input: {
	agentId: string;
	agentName?: string;
	tierLabel: string;
	cost?: number;
	agentCosts?: { id: string; cost: number }[];
	summary?: unknown;
}): LogMeta {
	const now = new Date().toISOString();
	const meta: LogMeta = {
		id: genId("log"),
		agentId: input.agentId,
		ownerId: input.agentId, // 开码日志归属=签发商（第198轮）
		userName: input.agentName,
		purpose: "code.issue",
		model: input.tierLabel,
		cost: input.cost,
		agentCosts: input.agentCosts?.length ? input.agentCosts : undefined,
		status: "success",
		startedAt: now,
		finishedAt: now,
		durationMs: 0,
	};
	index.push(meta);
	if (input.summary !== undefined) writeDetail(meta.id, { request: truncateBase64(input.summary) });
	markDirty(meta);
	flushIndex();
	return meta;
}

/** 仍为 running 的日志（启动对账用）：合并详情（对账要读 ④段救回视频） */
export function getRunningLogs(): LogEntry[] {
	return index.filter((l) => l.status === "running").map((m) => ({ ...m, ...(readDetail(m.id) ?? {}) }));
}

/** 记录上游(管理端↔网关/第三方)的请求体与原始响应；只写详情文件、不动索引。 */
export function attachUpstream(id: string, rec: { request?: unknown; response?: unknown }): void {
	if (!index.some((x) => x.id === id)) return;
	const patch: LogDetail = {};
	if (rec.request !== undefined) patch.upstreamRequest = truncateBase64(rec.request);
	if (rec.response !== undefined) patch.upstreamResponse = truncateBase64(rec.response);
	if (patch.upstreamRequest !== undefined || patch.upstreamResponse !== undefined) patchDetail(id, patch);
}

export interface LogFilter {
	from?: number; // startedAt ≥ from（epoch ms）
	to?: number; // startedAt < to（epoch ms）
	/** 归属范围（第198轮按渠道商分类）：仅这些归属的记录——渠道商 id；PLATFORM_OWNER=平台直属（ownerId 为空）。
	 *  按**落笔时固化**的 ownerId 判定；与 userIds 是 AND 关系（门户=owners 定范围 + userIds 收窄到单用户）。 */
	owners?: string[];
	userName?: string;
	purpose?: string;
	model?: string;
	status?: "success" | "failed" | "running"; // 成功/失败/进行中
	userIds?: string[]; // 仅这些 userId（渠道商门户按名下用户强制隔离 / 管理端看某商记录）
	/** 仅这些签发商 id 的按渠道商归属日志（第126轮开码消耗）——与 userIds 取**并集**纳入范围 */
	agentIds?: string[];
	/** 排除这些 userId（第116轮「源站视为一个渠道商」：管理端主请求记录/统计排除全部渠道商用户，
	 *  只看平台直属；无 userId 的历史记录保留）。 */
	excludeUserIds?: string[];
	/** 排除按渠道商归属的日志（agentId 有值，如开码消耗）——它们只在商属视图出现，不进源站主视图（第126轮） */
	excludeAgentScoped?: boolean;
}

/**
 * 消耗视角（第124轮「每个环节只看自身积分变化」；第220轮 P1 后商视角改口径）：
 * 同一条记录在不同入口显示的「消耗」不同——
 *  - user（缺省）：用户侧实扣（cost，统一平台价）——客户端 /v1/logs 用；
 *  - agent：门户请求记录/统计用。带 agentCosts 的记录（发码面额划转/作废退回、渠道节点池扣、
 *    统一定价切换前的旧链式结算）＝本商积分池那份；**其余（P1 统一定价后的生成请求，
 *    agentCosts 停写、积分实时扣用户）＝名下用户实扣（cost）**——第220轮起渠道商可见
 *    可统计名下用户消耗（此前恒 undefined 显示「—」、KPI 恒 0）；
 *  - platform：源站实收——带链记录（发码划转/节点池扣/旧链式）＝链根级实扣；无链记录＝用户实扣
 *    （统一定价后积分实时扣用户、无中转，源站实收即用户扣费——第220轮补充：源站商属视图借此
 *    可统计渠道商用户消耗，此前无链=undefined 致 KPI 恒 0）。
 * 与对外定价解耦：门户/客户端永远拿不到链上其他级的价（agentCosts 数组不下发）。
 */
export type LogCostView = { kind: "user" } | { kind: "agent"; agentId: string } | { kind: "platform" };
export function logCostFor(l: LogMeta, view?: LogCostView): number | undefined {
	if (!view || view.kind === "user") return l.cost;
	if (view.kind === "agent") {
		// 带链信息＝本商积分池的变动（发码/节点池扣/旧链式）；无链信息＝名下用户实扣（第220轮）
		if (l.agentCosts) return l.agentCosts.find((a) => a.id === view.agentId)?.cost ?? 0;
		return l.cost;
	}
	// platform：带链=根级实扣；无链=用户实扣（统一定价，源站实收=用户扣费——第220轮补充）
	if (l.agentCosts?.length) return l.agentCosts[l.agentCosts.length - 1].cost;
	return l.cost;
}

/** 按筛选取匹配日志（不分页，旧→新）。listLogs/exportLogs/批量下载清单 共用。只读索引元信息。 */
export function filterLogs(opts?: LogFilter): LogMeta[] {
	// 文本筛选一律「不区分大小写的包含」；步骤同时匹配中文代称与原 purpose
	const has = (hay: string, needle?: string) => !needle || hay.toLowerCase().includes(needle.toLowerCase());
	let arr = index;
	// 归属范围（第198轮）：按落笔固化的 ownerId 过滤；无 ownerId=平台直属
	if (opts?.owners?.length) {
		const os = new Set(opts.owners);
		arr = arr.filter((l) => os.has(l.ownerId ?? PLATFORM_OWNER));
	}
	// 作用域 = 名下用户日志（userIds）∪ 按渠道商归属日志（agentIds，如开码消耗）——门户/商属视图两者并集
	if (opts?.userIds || opts?.agentIds) {
		const uset = opts.userIds ? new Set(opts.userIds) : null;
		const aset = opts.agentIds ? new Set(opts.agentIds) : null;
		arr = arr.filter((l) =>
			(uset != null && l.userId != null && uset.has(l.userId)) ||
			(aset != null && l.agentId != null && aset.has(l.agentId)));
	}
	if (opts?.excludeUserIds?.length) { const ex = new Set(opts.excludeUserIds); arr = arr.filter((l) => l.userId == null || !ex.has(l.userId)); }
	// 源站主视图：排除按渠道商归属的日志（开码消耗只在商属视图出现）
	if (opts?.excludeAgentScoped) arr = arr.filter((l) => l.agentId == null);
	if (opts?.from != null) arr = arr.filter((l) => new Date(l.startedAt).getTime() >= opts.from!);
	if (opts?.to != null) arr = arr.filter((l) => new Date(l.startedAt).getTime() < opts.to!);
	if (opts?.userName) arr = arr.filter((l) => has(l.userName || "", opts.userName));
	if (opts?.purpose) arr = arr.filter((l) => has((l.purpose || "") + " " + purposeLabel(l.purpose), opts.purpose));
	if (opts?.model) arr = arr.filter((l) => has(l.model || "", opts.model));
	if (opts?.status) arr = arr.filter((l) => l.status === opts.status);
	return arr;
}

export function listLogs(opts?: LogFilter & { limit?: number; offset?: number }): { total: number; items: LogMeta[] } {
	const limit = opts?.limit ?? 50;
	const offset = opts?.offset ?? 0;
	const arr = filterLogs(opts);
	const sorted = [...arr].reverse(); // 最新在前
	return { total: arr.length, items: sorted.slice(offset, offset + limit) };
}

export interface LogExportRow {
	user: string;
	startedAt: string;
	finishedAt: string;
	purpose: string; // 中文步骤名
	model: string;
	cost: number | "";
	status: string;
	resultLink: string; // 成功的结果链接
	error: string; // 失败原因
}

/** 导出用：按筛选取全部匹配（不分页，旧→新）映射成表格行；view=消耗视角（缺省=用户侧） */
export function exportLogs(opts?: LogFilter, view?: LogCostView): LogExportRow[] {
	return filterLogs(opts).map((l) => {
		const c = logCostFor(l, view);
		return {
			user: l.userName || "",
			startedAt: l.startedAt || "",
			finishedAt: l.finishedAt || "",
			purpose: purposeLabel(l.purpose) || l.purpose || "",
			model: l.model || "",
			cost: c != null ? c : "",
			status: l.status,
			resultLink: l.status === "success" ? (l.resultLink || "") : "",
			error: l.status === "failed" ? (l.error || "") : "",
		};
	});
}

/**
 * 单用户维度统计（「对单用户的统计」）：按模型分开的成功/失败/进行中次数 + 消耗积分。
 * 消耗口径与 creditByDay 一致——失败已退款故不计入（仅统计非 failed 的 cost）。
 */
export function userModelStats(userId: string, opts?: { from?: number; to?: number }): {
	byModel: { model: string; success: number; failed: number; running: number; credits: number }[];
	totalSuccess: number;
	totalFailed: number;
	totalRunning: number;
	totalCredits: number;
	totalRequests: number;
} {
	const rows = new Map<string, { success: number; failed: number; running: number; credits: number }>();
	let totalSuccess = 0, totalFailed = 0, totalRunning = 0, totalCredits = 0, totalRequests = 0;
	for (const l of index) {
		if (l.userId !== userId) continue;
		const t = new Date(l.startedAt).getTime();
		if (opts?.from != null && t < opts.from) continue;
		if (opts?.to != null && t >= opts.to) continue;
		const key = l.model || "（无模型）";
		const r = rows.get(key) || { success: 0, failed: 0, running: 0, credits: 0 };
		totalRequests++;
		if (l.status === "success") { r.success++; totalSuccess++; }
		else if (l.status === "failed") { r.failed++; totalFailed++; }
		else { r.running++; totalRunning++; }
		if (l.status !== "failed" && l.cost) { r.credits += l.cost; totalCredits += l.cost; }
		rows.set(key, r);
	}
	const byModel = [...rows.entries()]
		.map(([model, v]) => ({ model, ...v }))
		.sort((a, b) => (b.success + b.failed + b.running) - (a.success + a.failed + a.running));
	return { byModel, totalSuccess, totalFailed, totalRunning, totalCredits, totalRequests };
}

/**
 * 按筛选聚合统计（统计页 + 请求记录简单统计条共用）。
 * 消耗口径：失败已退款不计入（仅非 failed 的消耗）；view=消耗视角（缺省=用户侧实扣，
 * 门户传 agent 视角=本商结算侧实扣，管理端商属范围传 platform=源站实收）。
 * byModel/byPurpose/byUser 按次数降序。
 */
export function logSummary(opts?: LogFilter, view?: LogCostView): {
	total: number;
	success: number;
	failed: number;
	running: number;
	credits: number;
	byModel: { key: string; count: number; success: number; failed: number; running: number; credits: number }[];
	byPurpose: { key: string; label: string; count: number; success: number; credits: number }[];
	byUser: { name: string; count: number; credits: number }[];
} {
	const arr = filterLogs(opts);
	let success = 0, failed = 0, running = 0, credits = 0;
	const bm = new Map<string, { count: number; success: number; failed: number; running: number; credits: number }>();
	const bp = new Map<string, { count: number; success: number; credits: number }>();
	const bu = new Map<string, { count: number; credits: number }>();
	for (const l of arr) {
		const c = l.status !== "failed" ? (logCostFor(l, view) || 0) : 0;
		credits += c;
		if (l.status === "success") success++;
		else if (l.status === "failed") failed++;
		else running++;
		const mk = l.model || "（无模型）";
		const m = bm.get(mk) || { count: 0, success: 0, failed: 0, running: 0, credits: 0 };
		m.count++;
		if (l.status === "success") m.success++; else if (l.status === "failed") m.failed++; else m.running++;
		m.credits += c;
		bm.set(mk, m);
		if (l.purpose) {
			const p = bp.get(l.purpose) || { count: 0, success: 0, credits: 0 };
			p.count++;
			if (l.status === "success") p.success++;
			p.credits += c;
			bp.set(l.purpose, p);
		}
		const uk = l.userName || "（未注册）";
		const u = bu.get(uk) || { count: 0, credits: 0 };
		u.count++; u.credits += c;
		bu.set(uk, u);
	}
	const byModel = [...bm.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.count - a.count);
	const byPurpose = [...bp.entries()].map(([key, v]) => ({ key, label: purposeLabel(key) || key, ...v })).sort((a, b) => b.count - a.count);
	const byUser = [...bu.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.count - a.count);
	return { total: arr.length, success, failed, running, credits, byModel, byPurpose, byUser };
}

/** 筛选下拉的可选值（去重）；可传范围过滤（如管理端只看平台直属用户的记录） */
export function logFacets(scope?: LogFilter): { users: string[]; purposes: string[]; models: string[] } {
	const u = new Set<string>();
	const p = new Set<string>();
	const m = new Set<string>();
	for (const l of scope ? filterLogs(scope) : index) {
		if (l.userName) u.add(l.userName);
		if (l.purpose) p.add(l.purpose);
		if (l.model) m.add(l.model);
	}
	return { users: [...u].sort(), purposes: [...p].sort(), models: [...m].sort() };
}

/** 详情视图/对账：合并元信息 + 该条重报文（按需从详情文件读取） */
export function getLog(id: string): LogEntry | undefined {
	const m = index.find((x) => x.id === id);
	if (!m) return undefined;
	return { ...m, ...(readDetail(id) ?? {}) };
}

/** 最近 n 天的 UTC 日期串（YYYY-MM-DD），升序，末位为今天。 */
function lastNDays(n: number): string[] {
	const out: string[] = [];
	const base = Date.now();
	for (let i = n - 1; i >= 0; i--) {
		out.push(new Date(base - i * 86400000).toISOString().slice(0, 10));
	}
	return out;
}

/** 请求维度统计（供管理端统计图表）：每日请求量/积分消耗 + 按步骤/模型分布。 */
export function requestStats(days = 14): {
	totalRequests: number;
	reqByDay: { date: string; success: number; failed: number; total: number }[];
	creditByDay: { date: string; credits: number }[];
	byPurpose: { key: string; label: string; count: number }[];
	byModel: { key: string; count: number }[];
} {
	const dayList = lastNDays(days);
	const dayIdx = new Map(dayList.map((d, i) => [d, i] as const));
	const reqByDay = dayList.map((date) => ({ date, success: 0, failed: 0, total: 0 }));
	const creditByDay = dayList.map((date) => ({ date, credits: 0 }));
	const byPurpose = new Map<string, number>();
	const byModel = new Map<string, number>();
	for (const l of index) {
		const i = dayIdx.get((l.startedAt || "").slice(0, 10));
		if (i != null) {
			reqByDay[i].total++;
			if (l.status === "failed") reqByDay[i].failed++;
			else if (l.status === "success") reqByDay[i].success++;
			if (l.status !== "failed" && l.cost) creditByDay[i].credits += l.cost;
		}
		if (l.purpose) byPurpose.set(l.purpose, (byPurpose.get(l.purpose) || 0) + 1);
		if (l.model) byModel.set(l.model, (byModel.get(l.model) || 0) + 1);
	}
	const top = (m: Map<string, number>, n: number) =>
		[...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
	return {
		totalRequests: index.length,
		reqByDay,
		creditByDay,
		byPurpose: top(byPurpose, 10).map(([key, count]) => ({ key, label: purposeLabel(key) || key, count })),
		byModel: top(byModel, 10).map(([key, count]) => ({ key, count })),
	};
}
