/**
 * 奇迹云（qijicloud）实例池 + 调度器 + 任务队列（第249轮）。
 *
 * 业务：用户在 autodl.art 租 RTX PRO 6000 应用实例（pro-xxx，可反复开关机），每台跑 ComfyUI
 *（监听 6006，经 snapshot 的 service_6006_domain 公网访问），执行 MiniMax H3 视频工作流。
 * 我方：客户端提交任务 → 服务端排队 → 派给有空闲槽位的实例（每实例并发默认 3=1 跑 2 排在
 * ComfyUI 自己的队列里）→ 上传素材 → 按骨架动态建图（translators/comfyGraph.ts）→ POST /prompt →
 * 轮询 /history → 成片 /view 直链交回轮询循环转存 OSS。管理端控制实例注册/分组/开关机；
 * 调度器按积压自动扩容（power_on 已注册的 shutdown 实例，上限=注册数）、按空闲缩容（power_off）。
 *
 * autodl 应用 API（Base https://www.autodl.art）：
 *   POST /api/v1/adl_dev/dev/instance/pro/list      body {page_index, page_size} → 实例列表（批量刷状态）
 *   GET  /api/v1/adl_dev/dev/instance/pro/status    ?instance_uuid=
 *   GET  /api/v1/adl_dev/dev/instance/pro/snapshot  ?instance_uuid= → service_6006_domain（ComfyUI 入口）
 *   POST /api/v1/adl_dev/dev/instance/pro/power_on  body {instance_uuid, payload:"gpu"}
 *   POST /api/v1/adl_dev/dev/instance/pro/power_off body {instance_uuid}
 * ⚠ 鉴权 `Authorization: <开发者Token>` **原样无 Bearer**（与 autodl 模式的 ComfyUI 令牌是两把不同 token）。
 * ⚠ 文档给 GET 接口的示例是「GET 带 JSON body」（非常规）——实现用 query string；真机 QA 若 400 改带 body。
 * 状态枚举参考弹性部署侧（creating/created/starting/running/shutting_down/shutdown），文档只实锤
 * "running" → 防御式：非 running 一律视为不可用；响应可能是信封 {code,msg,data} 形态，unwrap 双收。
 *
 * ComfyUI HTTP API（每实例 serviceUrl）：
 *   GET  {base}/queue                     → {queue_running, queue_pending}（探活）
 *   POST {base}/upload/image  multipart（字段 image + overwrite=true）→ {name, subfolder, type}
 *                                            ——图/音/视频文件都走它进 input 目录
 *   POST {base}/prompt        {prompt:图, client_id} → {prompt_id}；失败 {error:{message}, node_errors}
 *   GET  {base}/history/{prompt_id}       → { [id]: { status:{status_str, completed, messages}, outputs } }
 *                                            未完成时响应为空对象 {}；VHS_VideoCombine 输出在 outputs.*.gifs
 *   成片下载 {base}/view?filename=&subfolder=&type=output（无鉴权）
 *
 * ⚠ 面向用户的错误文案只用实例「名称」，绝不带 serviceUrl/uuid（实例地址=渠道信息，防泄漏；
 *   errorScrub 的域名清单另兜底 autodl.com/gpuhub.com/seetacloud.com）。
 */
import { loadJson, saveJson, scheduleSave, genId } from "./db.ts";
import { getChannel, CH_QIJICLOUD } from "./channels.ts";
import { config } from "../config.ts";
import { buildH3Graph } from "../translators/comfyGraph.ts";
import { audioDurationSec } from "../translators/audioMeta.ts";

// ── 数据模型 ──

export interface PoolInstance {
	uuid: string;
	name: string;
	/** 分组：调度按组匹配（任务当前全部落 default 组，分组为将来按模型/用户路由预留——注册实例请留在 default） */
	group: string;
	/** 并发槽位（1-10；⚠ 默认 1=不在 ComfyUI 里排队，出片最快；调大=多的排在 ComfyUI 队列里等） */
	concurrency: number;
	/** auto=调度器自动开关机；always=常开（关机即自动开回）；off=不参与派单（可手动开关机） */
	mode: "auto" | "always" | "off";
	/** ComfyUI 入口手动覆盖（空=从 snapshot 的 service_6006_domain 自动发现） */
	serviceUrl?: string;
	createdAt: string;
	updatedAt: string;
}

export interface PoolSettings {
	/** 空闲多少分钟后缩容关机（1-1440） */
	idleMinutes: number;
	/** 扩容全局冷却秒数（30-3600）：一轮开一台，冷却期内不重复开 */
	cooldownSec: number;
	/** 排队等待超过多少秒触发扩容（5-600） */
	scaleUpWaitSec: number;
	/** 调度总开关：关=不派单不扩缩容（statusLoop 照跑供管理端看状态） */
	enabled: boolean;
}

export interface JobSpec {
	/** 工作流骨架名（=模型 upstreamModel，如 "jianyi933"） */
	workflow: string;
	/** 已转写官方标签（<Picture N> 系）的最终提示词 */
	prompt: string;
	durationSec?: number | string;
	aspect?: string;
	resolution?: string;
	images: { url: string; name?: string }[];
	videos: { url: string; name?: string }[];
	audios: { url: string; name?: string }[];
}

export interface PoolJob {
	id: string; // genId("qjc") 产物（qjc_ 前缀）
	state: "queued" | "preparing" | "running" | "completed" | "failed";
	group: string;
	createdAt: number;
	dispatchedAt?: number;
	/** 排队时长（毫秒，第251轮）：派单那一刻定格 = dispatchedAt - createdAt。
	 *  终态记录（请求记录「365s（956s）」）与「排队不计入生成时长」的口径都取它。 */
	queuedMs?: number;
	instanceUuid?: string;
	promptId?: string;
	/** 成片 /view 直链（轮询循环据此转存 OSS） */
	resultUrl?: string;
	coverUrl?: string;
	error?: string;
	/** 非致命告警留痕（如音频时长解析失败走兜底值） */
	warning?: string;
	spec: JobSpec;
}

/** 实例运行态（纯内存，重启重建）；inflight 恒为派生值不落盘 */
interface InstanceRuntime {
	platformStatus: string;
	comfyReady: boolean;
	/** snapshot 自动发现的 ComfyUI 入口（实例 serviceUrl 手动覆盖优先） */
	serviceUrl?: string;
	lastError?: string;
	lastProbeAt?: number;
	lastJobDoneAt?: number;
	poweredAt?: number;
	/** 首次探活成功时刻（缩容空闲计时的最后兜底基准） */
	firstReadyAt?: number;
	/** 探活连续失败的起点；超 10 分钟=该实例上的在途任务判失联 */
	unreachableSince?: number;
	/** 上次对该实例发 power_on/off 的时刻（防对同一台反复打开关机请求） */
	lastPowerActionAt?: number;
}

// ── 持久化 ──

const POOL_FILE = "qijicloud-pool.json";
const JOBS_FILE = "qijicloud-jobs.json";
const JOB_TERMINAL_KEEP_MS = 48 * 3600 * 1000;
const JOB_QUEUE_TIMEOUT_MS = 2 * 3600 * 1000;
const UNREACHABLE_FAIL_MS = 10 * 60 * 1000;
/**
 * 派单后（preparing/running）硬超时——最后兜底，保证任何未预见的形态下任务都不会「永远生成中」。
 * 90 分钟 = 容忍 1跑2排 下排在 ComfyUI 队列里等两轮慢生成；真正的快速失败靠
 * 「平台明确关机立即置败」与「探活断 10 分钟置败」两条，此处只是天花板。
 */
const JOB_RUN_TIMEOUT_MS = 90 * 60 * 1000;
/** 开机后多久内算「启动中」（扩容判定不重复开；ComfyUI 大模型加载可能要几分钟） */
const STARTUP_GRACE_MS = 15 * 60 * 1000;
/** 状态循环一拍（过渡态实例按此刷新——第251轮：开关机中提速一倍） */
const STATUS_TICK_MS = 15 * 1000;
/**
 * 稳定态实例的刷新节流（目标=原 30s 周期，避免 20 台每 15s 全量探活徒增开销）。
 * ⚠ 取 25s 而不是 30s：一拍 15s 的网格上，第 2 拍距上次探活只过了约 27s，卡 30s 会把这拍
 * 整个跳掉、要等到第 3 拍（45s）才刷——比改造前还慢。留半拍余量才真的是 30s。（沙盒实锤）
 */
const STATUS_STABLE_MS = 25 * 1000;
/** 下发开关机后多久内仍按过渡态高频刷新（等平台状态落地） */
const POWER_SETTLE_MS = 3 * 60 * 1000;
const PROBE_TIMEOUT_MS = 5000;
/** 探活重试退避（第251轮）：首失 3s 再探、再失 5s 再探，三次全失败才算真失败 */
const PROBE_RETRY_DELAYS_MS = [3000, 5000];

/**
 * 每实例默认并发（第251轮：3 → 1）。
 * ⚠ 语义：并发 N = 同时派给该实例 N 单，其中 1 单在跑、N-1 单排在 ComfyUI 自己的队列里——
 * 排队的那几单从用户视角就是「一直转圈」，故默认只派 1 单，多的留在服务端队列（有排队位次可显示）。
 */
const DEFAULT_CONCURRENCY = 1;
/** 旧默认值：一次性迁移把仍停在旧默认的实例降到新默认（用户特意改过的值不动——只跑一次） */
const LEGACY_DEFAULT_CONCURRENCY = 3;

interface PoolStore {
	instances: PoolInstance[];
	settings: PoolSettings;
	/** 一次性迁移标记（第251轮并发默认 3→1） */
	concurrencyDefaultV2?: boolean;
}

function normSettings(raw: Partial<PoolSettings> | undefined): PoolSettings {
	const clamp = (v: unknown, dflt: number, min: number, max: number): number => {
		const n = Number(v);
		return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : dflt;
	};
	return {
		idleMinutes: clamp(raw?.idleMinutes, 10, 1, 1440),
		cooldownSec: clamp(raw?.cooldownSec, 300, 30, 3600),
		scaleUpWaitSec: clamp(raw?.scaleUpWaitSec, 30, 5, 600),
		enabled: raw?.enabled !== false,
	};
}

/** serviceUrl 归一：无协议补 https://、去尾斜杠；空返回 undefined */
function normServiceUrl(raw: unknown): string | undefined {
	const s = String(raw ?? "").trim();
	if (!s) return undefined;
	const withProto = /^https?:\/\//i.test(s) ? s : `https://${s}`;
	return withProto.replace(/\/+$/, "");
}

function normInstance(raw: Partial<PoolInstance> & { uuid: string }): PoolInstance {
	const now = new Date().toISOString();
	const conc = Number(raw.concurrency);
	return {
		uuid: String(raw.uuid).trim(),
		name: String(raw.name ?? "").trim() || String(raw.uuid).trim(),
		group: String(raw.group ?? "").trim() || "default",
		concurrency: Number.isFinite(conc) ? Math.min(10, Math.max(1, Math.round(conc))) : DEFAULT_CONCURRENCY,
		mode: raw.mode === "always" || raw.mode === "off" ? raw.mode : "auto",
		serviceUrl: normServiceUrl(raw.serviceUrl),
		createdAt: raw.createdAt || now,
		updatedAt: now,
	};
}

let pool: PoolStore = (() => {
	const raw = loadJson<Partial<PoolStore>>(POOL_FILE, {});
	const instances = (Array.isArray(raw.instances) ? raw.instances : [])
		.filter((i): i is PoolInstance => !!i && !!String((i as any).uuid ?? "").trim())
		.map((i) => normInstance(i));
	// 第251轮一次性迁移：仍停在旧默认 3 的实例降到新默认 1（只跑一次——之后用户在管理端设成 3 不会被再改）
	let migrated = false;
	if (!raw.concurrencyDefaultV2) {
		for (const i of instances) {
			if (i.concurrency === LEGACY_DEFAULT_CONCURRENCY) {
				i.concurrency = DEFAULT_CONCURRENCY;
				migrated = true;
			}
		}
	}
	const store: PoolStore = { instances, settings: normSettings(raw.settings), concurrencyDefaultV2: true };
	if (migrated || !raw.concurrencyDefaultV2) saveJson(POOL_FILE, store);
	return store;
})();

let jobs: PoolJob[] = (() => {
	const raw = loadJson<{ jobs?: PoolJob[] }>(JOBS_FILE, {});
	const list = Array.isArray(raw.jobs) ? raw.jobs.filter((j) => !!j?.id) : [];
	const now = Date.now();
	for (const j of list) {
		// 上次进程死在派单中途（preparing=素材上传/建图/提交阶段）→ 一律回退 queued 重派。
		// ⚠ /prompt 已提交、promptId 落盘前的极窄窗口可能双跑一次（多耗一次 GPU），可接受——
		//   反向（不重派）会让用户的单永久卡死，代价不对等。
		if (j.state === "preparing") {
			j.state = "queued";
			j.instanceUuid = undefined;
			j.dispatchedAt = undefined;
			j.queuedMs = undefined; // 回队重排：排队时长在重新派单那一刻按 now-createdAt 重新定格
		}
	}
	return list.filter((j) => !((j.state === "completed" || j.state === "failed") && now - j.createdAt > JOB_TERMINAL_KEEP_MS));
})();

function persistPool(): void {
	saveJson(POOL_FILE, pool);
}
function persistJobs(): void {
	// 容量兜底：终态最老的先裁（在途单绝不裁）
	if (jobs.length > 500) {
		const terminal = jobs.filter((j) => j.state === "completed" || j.state === "failed").sort((a, b) => a.createdAt - b.createdAt);
		const drop = new Set(terminal.slice(0, jobs.length - 500).map((j) => j.id));
		if (drop.size) jobs = jobs.filter((j) => !drop.has(j.id));
	}
	scheduleSave(JOBS_FILE, () => JSON.stringify({ jobs }, null, 2));
}

// ── 运行态 ──

const runtimes = new Map<string, InstanceRuntime>();
function rtOf(uuid: string): InstanceRuntime {
	let rt = runtimes.get(uuid);
	if (!rt) {
		rt = { platformStatus: "unknown", comfyReady: false };
		runtimes.set(uuid, rt);
	}
	return rt;
}
function inflightOf(uuid: string): number {
	return jobs.filter((j) => (j.state === "preparing" || j.state === "running") && j.instanceUuid === uuid).length;
}
/** 生效的 ComfyUI 入口：实例手动覆盖 > snapshot 自动发现 */
function serviceUrlOf(inst: PoolInstance): string | undefined {
	return inst.serviceUrl || rtOf(inst.uuid).serviceUrl;
}
function instByUuid(uuid: string): PoolInstance | undefined {
	return pool.instances.find((i) => i.uuid === uuid);
}
/** 面向用户的实例称呼：只用名称（uuid/serviceUrl 绝不进错误文案） */
function nameOf(uuid: string | undefined): string {
	return (uuid && instByUuid(uuid)?.name) || "云实例";
}

// ── autodl 应用 API ──

/** 凭据：渠道 ch-qijicloud（管理端可填）优先，环境 QIJICLOUD_DEV_TOKEN 兜底 */
export function poolCredentials(): { baseUrl: string; token: string } {
	const ch = getChannel(CH_QIJICLOUD);
	return {
		baseUrl: (ch?.baseUrl || config.qijicloud.baseUrl).replace(/\/+$/, ""),
		token: ch?.apiKey || config.qijicloud.apiKey,
	};
}

/** 信封拆包（{code,msg,data} 形态双收，参考 translators/autodl.ts 的 unwrap 模式） */
function unwrap(data: any): any {
	return data && typeof data === "object" && data.data && typeof data.data === "object" ? data.data : data ?? {};
}
/** 信封 code 存在且非成功族 = 业务失败（HTTP 200 也可能带错误体） */
function envelopeError(data: any): string | null {
	if (data?.code === undefined) return null;
	const code = String(data.code).toLowerCase();
	if (code === "success" || code === "ok" || code === "0" || code === "200") return null;
	return String(data?.msg || data?.message || `业务码 ${data.code}`);
}

async function appApi(path: string, opts: { method: "GET" | "POST"; body?: unknown; query?: Record<string, string> }): Promise<{ ok: boolean; data?: any; error?: string }> {
	const { baseUrl, token } = poolCredentials();
	if (!token) return { ok: false, error: "奇迹云未配置开发者Token（管理端「奇迹云」渠道或环境 QIJICLOUD_DEV_TOKEN）" };
	const qs = opts.query ? "?" + new URLSearchParams(opts.query).toString() : "";
	try {
		const resp = await fetch(`${baseUrl}${path}${qs}`, {
			method: opts.method,
			// ⚠ Authorization 原样 token（不带 Bearer 前缀，autodl 文档明写）
			headers: opts.body !== undefined ? { "Content-Type": "application/json", Authorization: token } : { Authorization: token },
			body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
			signal: AbortSignal.timeout(15000),
		});
		const data: any = await resp.json().catch(() => ({}));
		if (!resp.ok) return { ok: false, error: `平台接口 HTTP ${resp.status}` };
		const err = envelopeError(data);
		if (err) return { ok: false, error: err };
		return { ok: true, data };
	} catch (err) {
		return { ok: false, error: `平台接口不可达：${(err as Error).message}` };
	}
}

async function appPowerOn(uuid: string): Promise<{ ok: boolean; error?: string }> {
	const r = await appApi("/api/v1/adl_dev/dev/instance/pro/power_on", { method: "POST", body: { instance_uuid: uuid, payload: "gpu" } });
	if (r.ok) {
		const rt = rtOf(uuid);
		rt.poweredAt = Date.now();
		rt.lastPowerActionAt = Date.now();
		rt.platformStatus = "starting"; // 乐观置位；下一拍 statusLoop 以平台为准
	}
	return { ok: r.ok, error: r.error };
}
async function appPowerOff(uuid: string): Promise<{ ok: boolean; error?: string }> {
	const r = await appApi("/api/v1/adl_dev/dev/instance/pro/power_off", { method: "POST", body: { instance_uuid: uuid } });
	if (r.ok) {
		const rt = rtOf(uuid);
		rt.lastPowerActionAt = Date.now();
		rt.platformStatus = "shutting_down";
		rt.comfyReady = false;
	}
	return { ok: r.ok, error: r.error };
}

// ── 管理端 API 用导出（签名冻结——管理端「云实例」页按此编码，另一并行代理消费）──

export function listPoolInstances(): PoolInstance[] {
	return pool.instances.map((i) => ({ ...i }));
}

export function poolRuntimeOf(uuid: string): (InstanceRuntime & { inflight: number }) | undefined {
	if (!instByUuid(uuid)) return undefined;
	return { ...rtOf(uuid), inflight: inflightOf(uuid) };
}

export function poolOverview(): {
	settings: PoolSettings;
	instances: (PoolInstance & { platformStatus: string; comfyReady: boolean; serviceUrlEffective?: string; inflight: number; lastError?: string; lastProbeAt?: number; lastJobDoneAt?: number; unreachableSince?: number })[];
	queue: { queued: number; preparing: number; running: number; byGroup: Record<string, { queued: number; active: number }> };
	tokenConfigured: boolean;
} {
	const byGroup: Record<string, { queued: number; active: number }> = {};
	for (const j of jobs) {
		if (j.state === "completed" || j.state === "failed") continue;
		const g = (byGroup[j.group] ??= { queued: 0, active: 0 });
		if (j.state === "queued") g.queued += 1;
		else g.active += 1;
	}
	return {
		settings: { ...pool.settings },
		instances: pool.instances.map((i) => {
			const rt = rtOf(i.uuid);
			return {
				...i,
				platformStatus: rt.platformStatus,
				comfyReady: rt.comfyReady,
				serviceUrlEffective: serviceUrlOf(i),
				inflight: inflightOf(i.uuid),
				lastError: rt.lastError,
				lastProbeAt: rt.lastProbeAt,
				lastJobDoneAt: rt.lastJobDoneAt,
				unreachableSince: rt.unreachableSince,
			};
		}),
		queue: {
			queued: jobs.filter((j) => j.state === "queued").length,
			preparing: jobs.filter((j) => j.state === "preparing").length,
			running: jobs.filter((j) => j.state === "running").length,
			byGroup,
		},
		tokenConfigured: !!poolCredentials().token,
	};
}

export function updatePoolSettings(patch: Partial<PoolSettings>): PoolSettings {
	pool.settings = normSettings({ ...pool.settings, ...patch });
	persistPool();
	return { ...pool.settings };
}

export function addPoolInstance(input: { uuid: string; name?: string; group?: string; concurrency?: number; mode?: PoolInstance["mode"]; serviceUrl?: string }): { ok: boolean; error?: string; instance?: PoolInstance } {
	const uuid = String(input.uuid ?? "").trim();
	if (!uuid) return { ok: false, error: "instance_uuid 不能为空" };
	if (instByUuid(uuid)) return { ok: false, error: "该实例已注册" };
	const inst = normInstance({ ...input, uuid });
	pool.instances.push(inst);
	persistPool();
	return { ok: true, instance: { ...inst } };
}

export function updatePoolInstance(uuid: string, patch: Partial<Omit<PoolInstance, "uuid" | "createdAt">>): { ok: boolean; error?: string; instance?: PoolInstance } {
	const inst = instByUuid(uuid);
	if (!inst) return { ok: false, error: "实例不存在" };
	const next = normInstance({ ...inst, ...patch, uuid: inst.uuid, createdAt: inst.createdAt });
	// serviceUrl 显式传空串=清除手动覆盖（回到 snapshot 自动发现）
	if (patch.serviceUrl !== undefined) next.serviceUrl = normServiceUrl(patch.serviceUrl);
	Object.assign(inst, next);
	persistPool();
	return { ok: true, instance: { ...inst } };
}

export function removePoolInstance(uuid: string): { ok: boolean; error?: string } {
	const inst = instByUuid(uuid);
	if (!inst) return { ok: false, error: "实例不存在" };
	if (inflightOf(uuid) > 0) return { ok: false, error: `实例「${inst.name}」上还有在途任务，待完成或失败后再移除` };
	pool.instances = pool.instances.filter((i) => i.uuid !== uuid);
	runtimes.delete(uuid);
	persistPool();
	return { ok: true };
}

export async function powerOnInstance(uuid: string): Promise<{ ok: boolean; error?: string }> {
	if (!instByUuid(uuid)) return { ok: false, error: "实例不存在" };
	return appPowerOn(uuid);
}

export async function powerOffInstance(uuid: string, opts?: { force?: boolean }): Promise<{ ok: boolean; error?: string }> {
	const inst = instByUuid(uuid);
	if (!inst) return { ok: false, error: "实例不存在" };
	const inflight = inflightOf(uuid);
	if (inflight > 0 && !opts?.force) {
		return { ok: false, error: `实例「${inst.name}」上还有 ${inflight} 个在途任务；确认要中断请用强制关机` };
	}
	if (inflight > 0) {
		// force：先把该实例上的在途单全部置败（客户端轮询下一拍即见失败并退款），再关机
		for (const j of jobs) {
			if ((j.state === "preparing" || j.state === "running") && j.instanceUuid === uuid) {
				j.state = "failed";
				j.error = "实例被手动关机，任务已中断";
			}
		}
		persistJobs();
	}
	return appPowerOff(uuid);
}

export function listRecentJobs(limit = 100): Array<Omit<PoolJob, "spec"> & { spec: { workflow: string; durationSec?: number | string; aspect?: string; resolution?: string; images: number; videos: number; audios: number } }> {
	// spec 只吐素材计数与参数——素材 URL 全文/提示词不进管理端列表（体积与泄漏面双重考虑）
	return [...jobs]
		.sort((a, b) => b.createdAt - a.createdAt)
		.slice(0, Math.max(1, Math.min(500, limit)))
		.map(({ spec, ...rest }) => ({
			...rest,
			spec: {
				workflow: spec.workflow,
				durationSec: spec.durationSec,
				aspect: spec.aspect,
				resolution: spec.resolution,
				images: spec.images.length,
				videos: spec.videos.length,
				audios: spec.audios.length,
			},
		}));
}

// ── 任务入队 / 查询（翻译器 translators/qijicloud.ts 消费）──

export function enqueueQijicloudJob(spec: JobSpec): { ok: true; jobId: string } | { ok: false; error: string } {
	// 前置闸：注册表里连一台可参与派单的实例都没有 → 明确报错不入队不扣费
	if (!pool.instances.some((i) => i.mode !== "off")) {
		return { ok: false, error: "奇迹云未配置任何可用云实例，请在管理端「云实例」页注册" };
	}
	const job: PoolJob = {
		id: genId("qjc"),
		state: "queued",
		group: "default", // 当前全部任务落 default 组（分组为将来按模型/用户路由预留）
		createdAt: Date.now(),
		spec,
	};
	jobs.push(job);
	persistJobs();
	return { ok: true, jobId: job.id };
}

export function getQijicloudJob(jobId: string): PoolJob | undefined {
	return jobs.find((j) => j.id === jobId);
}

// ── 派单执行 ──

function failJob(job: PoolJob, error: string): void {
	job.state = "failed";
	job.error = error;
	if (job.instanceUuid) rtOf(job.instanceUuid).lastJobDoneAt = Date.now();
	persistJobs();
}

/** 短哈希（job id → 6 位十六进制），做上传文件名前缀防不同任务同名素材互相覆盖 */
function shortHash(s: string): string {
	let h = 0;
	for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
	return (h >>> 0).toString(16).padStart(6, "0").slice(-6);
}

const EXT_BY_CT: Record<string, string> = {
	"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif",
	"video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
	"audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/mp4": ".m4a", "audio/ogg": ".ogg",
};
const EXT_BY_KIND: Record<string, string> = { image: ".png", video: ".mp4", audio: ".mp3" };

function uploadNameFor(url: string, jobId: string, kind: "image" | "video" | "audio", contentType: string): string {
	let base = "";
	try {
		base = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
	} catch {
		/* 非法 URL 由下载环节报错 */
	}
	base = base.replace(/[^\w.一-鿿-]/g, "_").slice(-80) || kind;
	if (!/\.[A-Za-z0-9]{2,4}$/.test(base)) {
		const ct = (contentType || "").split(";")[0].trim().toLowerCase();
		base += EXT_BY_CT[ct] ?? EXT_BY_KIND[kind];
	}
	return `${shortHash(jobId)}_${base}`;
}

interface UploadedMaterial {
	file: string;
	bytes: Buffer;
}

/** 下载单条素材 → 上传进实例 input 目录 → 返回 ComfyUI 认的文件名 */
async function uploadMaterial(serviceUrl: string, job: PoolJob, kind: "image" | "video" | "audio", idx: number, m: { url: string; name?: string }): Promise<UploadedMaterial> {
	const kindLabel = kind === "image" ? "图片" : kind === "video" ? "视频" : "音频";
	let bytes: Buffer;
	let ct = "";
	try {
		const resp = await fetch(m.url, { signal: AbortSignal.timeout(120000) });
		if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
		bytes = Buffer.from(await resp.arrayBuffer());
		ct = resp.headers.get("content-type") ?? "";
	} catch (err) {
		throw new Error(`垫素材下载失败：第 ${idx + 1} 个${kindLabel}素材（${m.name || "未命名"}）——${(err as Error).message}`);
	}
	const filename = uploadNameFor(m.url, job.id, kind, ct);
	// ⚠ 图/音/视频统一走 /upload/image（ComfyUI 该端点只管落 input 目录，不校验媒体类型）
	const fd = new FormData();
	fd.append("image", new Blob([new Uint8Array(bytes)]), filename);
	fd.append("overwrite", "true");
	let uploaded: any;
	try {
		const resp = await fetch(`${serviceUrl}/upload/image`, { method: "POST", body: fd, signal: AbortSignal.timeout(120000) });
		if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
		uploaded = await resp.json().catch(() => ({}));
	} catch (err) {
		throw new Error(`素材上传到实例「${nameOf(job.instanceUuid)}」失败（第 ${idx + 1} 个${kindLabel}）——${(err as Error).message}`);
	}
	return { file: String(uploaded?.name || filename), bytes };
}

/** ComfyUI /prompt 报错 → 一句人话（error.message + node_errors 首条） */
function comfyPromptError(data: any): string {
	const main = data?.error?.message || data?.error || "";
	const nodeErrs = data?.node_errors && typeof data.node_errors === "object" ? Object.values<any>(data.node_errors) : [];
	const firstNode = nodeErrs.find((n) => Array.isArray(n?.errors) && n.errors.length);
	const detail = firstNode?.errors?.[0]?.message || firstNode?.errors?.[0]?.details || "";
	const msg = [main, detail].filter(Boolean).join("；");
	return msg ? `工作流提交被拒：${msg}` : "工作流提交被拒（实例未返回原因）";
}

async function dispatchJob(job: PoolJob): Promise<void> {
	const inst = job.instanceUuid ? instByUuid(job.instanceUuid) : undefined;
	const serviceUrl = inst ? serviceUrlOf(inst) : undefined;
	if (!inst || !serviceUrl) {
		// 拣中与派单之间实例被改/移除（极窄窗口）：回队重派，2h 排队超时兜底
		job.state = "queued";
		job.instanceUuid = undefined;
		job.dispatchedAt = undefined;
		job.queuedMs = undefined;
		persistJobs();
		return;
	}
	const spec = job.spec;

	// ── 素材：逐条 下载→上传（音频顺带解时长供 LoadAudioUI）──
	const images: { file: string }[] = [];
	const videos: { file: string }[] = [];
	const audios: { file: string; durationSec: number }[] = [];
	for (let i = 0; i < spec.images.length; i++) {
		images.push({ file: (await uploadMaterial(serviceUrl, job, "image", i, spec.images[i])).file });
	}
	for (let i = 0; i < spec.videos.length; i++) {
		videos.push({ file: (await uploadMaterial(serviceUrl, job, "video", i, spec.videos[i])).file });
	}
	for (let i = 0; i < spec.audios.length; i++) {
		const up = await uploadMaterial(serviceUrl, job, "audio", i, spec.audios[i]);
		let dur = audioDurationSec(up.bytes, spec.audios[i].name || spec.audios[i].url);
		if (dur === null) {
			// 解析不出（少见封装/坏头）→ 600s 兜底：LoadAudioUI 的 end_time 超过实际时长只会取到末尾，
			// 比拒单温和；留痕供排障
			dur = 600;
			job.warning = [job.warning, `第 ${i + 1} 条音频时长解析失败，按 600s 兜底`].filter(Boolean).join("；");
		}
		audios.push({ file: up.file, durationSec: dur });
	}

	// ── 建图 → 提交 ──
	const graph = buildH3Graph({
		workflow: spec.workflow,
		prompt: spec.prompt,
		durationSec: spec.durationSec,
		aspect: spec.aspect,
		resolution: spec.resolution,
		seed: Math.floor(Math.random() * 0x7fffffff),
		images,
		videos,
		audios,
	});
	let resp: Response;
	let data: any;
	try {
		resp = await fetch(`${serviceUrl}/prompt`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: graph, client_id: job.id }),
			signal: AbortSignal.timeout(30000),
		});
		data = await resp.json().catch(() => ({}));
	} catch (err) {
		throw new Error(`向实例「${inst.name}」提交任务失败：${(err as Error).message}`);
	}
	if (!resp.ok || !data?.prompt_id) throw new Error(comfyPromptError(data));
	job.promptId = String(data.prompt_id);
	job.state = "running";
	persistJobs();
}

// ── 调度循环 ──

let loopsStarted = false;
let warnedNoToken = false;
let lastScaleUpAt = 0;
let log: { info: (m: string) => void; warn: (m: string) => void } = { info: () => {}, warn: () => {} };

/**
 * 严格探活：GET /queue 必须返回**能解析且带 queue_running/queue_pending 数组**的 JSON 才算活。
 * ⚠ 只看 HTTP 200 不够（真机实锤）：autodl 的实例代理域名在实例关机后会返回 200 的 HTML
 * 提示页——宽松判定会把已关机的实例当成健康，失联置败永不触发、任务永远「生成中」。
 */
async function probeComfyQueue(url: string): Promise<void> {
	const resp = await fetch(`${url}/queue`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
	if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
	let body: any;
	try {
		body = await resp.json();
	} catch {
		throw new Error("响应不是 ComfyUI（实例可能已关机，代理返回了提示页）");
	}
	if (!Array.isArray(body?.queue_running) && !Array.isArray(body?.queue_pending)) {
		throw new Error("响应不是 ComfyUI 队列（实例可能已关机或端口指向了别的服务）");
	}
}

/**
 * 带退避的三连探活（第251轮）：**只保护「本来健康 / 身上有在途单」的实例**——
 * 第 1 次失败等 3s 再探、第 2 次失败等 5s 再探，三次全失败才算真失败（抗网络瞬时抖动，
 * 避免一次抖动就把正在跑单的实例踢出派单池）。
 * ⚠ 从未就绪的实例（启动中/已知不通）只探 1 次：那不是「确认失败」而是「等它起来」，
 * 三连重试只会拖慢 statusLoop 一拍的刷新（与「过渡态提速」的目标相反）。
 */
async function probeComfyWithRetry(url: string, protect: boolean): Promise<void> {
	if (!protect) return probeComfyQueue(url);
	let lastErr: unknown;
	for (let i = 0; i < PROBE_RETRY_DELAYS_MS.length + 1; i++) {
		if (i > 0) await new Promise((r) => setTimeout(r, PROBE_RETRY_DELAYS_MS[i - 1]));
		try {
			await probeComfyQueue(url);
			return;
		} catch (err) {
			lastErr = err;
		}
	}
	throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** 过渡态（开机中/关机中）：状态刷新提速一倍（STATUS_TICK_MS）；稳定态按 STATUS_STABLE_MS 节流 */
function isTransitional(rt: InstanceRuntime, now: number): boolean {
	if (STARTING_STATES.has(rt.platformStatus) || rt.platformStatus === "shutting_down") return true;
	// 刚下发过开关机、结果还没落到平台状态上的窗口也算过渡态
	return !!rt.lastPowerActionAt && now - rt.lastPowerActionAt < POWER_SETTLE_MS;
}

let statusBusy = false;
async function statusLoop(): Promise<void> {
	if (!pool.instances.length || statusBusy) return; // 防重入：探活重试可能超过一拍间隔
	statusBusy = true;
	try {
		const { token } = poolCredentials();
		if (!token) {
			if (!warnedNoToken) {
				warnedNoToken = true;
				log.warn("[qijicloud] 未配置开发者Token——实例状态刷新与自动扩缩容暂停（管理端「奇迹云」渠道可填）");
			}
			return;
		}
		warnedNoToken = false;

		// ① 批量刷平台状态（分页拉全量按 uuid 匹配注册表；page_index 假定 1 起，真机 QA 校准）
		const byUuid = new Map<string, any>();
		let listOk = false;
		for (let page = 1; page <= 20; page++) {
			const r = await appApi("/api/v1/adl_dev/dev/instance/pro/list", { method: "POST", body: { page_index: page, page_size: 50 } });
			if (!r.ok) break;
			listOk = true;
			const inner = unwrap(r.data);
			const rows: any[] = Array.isArray(inner) ? inner : Array.isArray(inner?.list) ? inner.list : Array.isArray(inner?.instances) ? inner.instances : [];
			for (const row of rows) {
				const id = String(row?.instance_uuid ?? row?.uuid ?? row?.id ?? "").trim();
				if (id) byUuid.set(id, row);
			}
			if (rows.length < 50) break;
		}

		const now = Date.now();
		// 各实例的 snapshot/探活互不依赖 → 并行（否则 20 台×5s 超时串行一轮要 100s）
		await Promise.all(pool.instances.map(async (inst) => {
			const rt = rtOf(inst.uuid);
			// 过渡态（开机中/关机中/刚下发开关机）每拍刷；稳定态按 30s 节流——「提速一倍」只加在需要的实例上
			if (!isTransitional(rt, now) && rt.lastProbeAt && now - rt.lastProbeAt < STATUS_STABLE_MS) return;
			rt.lastProbeAt = now;
			if (listOk) {
				const row = byUuid.get(inst.uuid);
				// 不在列表=unknown（可能被用户在平台释放）；文档只实锤 "running"，未知词一律非可用态
				rt.platformStatus = String(row?.status ?? "unknown").trim().toLowerCase() || "unknown";
			}
			const running = rt.platformStatus === "running";
			const platformOff = SHUTDOWN_STATES.has(rt.platformStatus) || rt.platformStatus === "shutting_down";
			// ⚠ 平台明确关机：自动发现的入口作废（重开机可能分配**新的** service_6006_domain，
			//   陈旧地址不清会挡住 running && 无入口 的 re-snapshot——实例永远 ready 不了）；
			//   手动覆盖（inst.serviceUrl）不动。
			if (platformOff && rt.serviceUrl) rt.serviceUrl = undefined;
			// ② running 且无入口 → snapshot 发现 service_6006_domain（⚠ 文档示例是 GET 带 JSON body 的
			//    非常规形态——这里用 query string；真机 QA 若 400 改带 body）
			if (running && !serviceUrlOf(inst)) {
				const r = await appApi("/api/v1/adl_dev/dev/instance/pro/snapshot", { method: "GET", query: { instance_uuid: inst.uuid } });
				if (r.ok) {
					const inner = unwrap(r.data);
					const domain = String(inner?.service_6006_domain ?? "").trim();
					if (domain) rt.serviceUrl = normServiceUrl(domain);
					else rt.lastError = "实例快照未返回 ComfyUI 入口（service_6006_domain）";
				} else {
					rt.lastError = r.error;
				}
			}
			// ③ ComfyUI 探活——⚠ 有入口就探、**不看 list 抖动**：可用性以 ComfyUI 实际可达为准。
			//    平台 list 接口抖动（实例短暂不在列表→unknown）不应把正在跑单的健康实例打成失联
			//    ——失联判定（unreachableSince→10 分钟置败在途单）只能由真实探活失败驱动。
			//    唯一例外：平台**明确**返回 shutdown/stopped（不是 unknown）——实例已关机不必再探
			//    （关机后代理域名常返回 200 的 HTML 提示页，探它只会假阳性）。
			const url = serviceUrlOf(inst);
			if (url && !platformOff) {
				// 三连重试只保护「本来健康 / 身上有在途单」的实例（详见 probeComfyWithRetry 注释）
				const protect = rt.comfyReady || inflightOf(inst.uuid) > 0;
				try {
					await probeComfyWithRetry(url, protect);
					rt.comfyReady = true;
					rt.unreachableSince = undefined;
					rt.lastError = undefined;
					if (!rt.firstReadyAt) rt.firstReadyAt = now;
				} catch (err) {
					rt.comfyReady = false;
					rt.unreachableSince ??= now;
					rt.lastError = `探活失败：${(err as Error).message}`;
				}
			} else {
				// 无入口（未发现/关机中）或平台明确关机：不可派单；只有背着在途任务时才计失联
				//（空闲关机态无联可失——平台关机的快速置败在 watchOnce 里另有专门分支，不等 10 分钟）
				rt.comfyReady = false;
				if (inflightOf(inst.uuid) > 0) rt.unreachableSince ??= now;
				else rt.unreachableSince = undefined;
			}
		}));
	} finally {
		statusBusy = false;
	}
}

function pickInstance(group: string): PoolInstance | undefined {
	const candidates = pool.instances
		.filter((i) => i.group === group && i.mode !== "off" && rtOf(i.uuid).comfyReady && inflightOf(i.uuid) < i.concurrency)
		.sort((a, b) => inflightOf(a.uuid) - inflightOf(b.uuid));
	return candidates[0];
}

/**
 * 排队队列（第251轮）：**与 dispatchLoop 同一把尺**——同 group 内 state==="queued" 按 createdAt 升序。
 * 派单本身是「按此序逐个尝试、拣到空闲实例就派」，故该序即用户看到的排队顺序。
 */
function queuedOfGroup(group: string): PoolJob[] {
	return jobs.filter((j) => j.state === "queued" && j.group === group).sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * 某任务的排队位次（1 基）与同组排队总数；不在排队中（已派单/终态/不存在）返回 null。
 * 翻译器 poll 的 queued 分支据此下发 queuePosition/queueTotal 给客户端显示「排队中 · 第 3/8 位」。
 */
export function queuePositionOf(jobId: string): { position: number; total: number } | null {
	const job = jobs.find((j) => j.id === jobId);
	if (!job || job.state !== "queued") return null;
	const list = queuedOfGroup(job.group);
	const idx = list.findIndex((j) => j.id === jobId);
	if (idx < 0) return null;
	return { position: idx + 1, total: list.length };
}

function dispatchLoop(): void {
	if (!pool.settings.enabled) return;
	const now = Date.now();
	const queued = jobs.filter((j) => j.state === "queued").sort((a, b) => a.createdAt - b.createdAt);
	for (const job of queued) {
		if (now - job.createdAt > JOB_QUEUE_TIMEOUT_MS) {
			failJob(job, "排队超时：无可用实例（请在管理端检查云实例状态）");
			continue;
		}
		const inst = pickInstance(job.group);
		if (!inst) continue;
		job.state = "preparing";
		job.instanceUuid = inst.uuid;
		job.dispatchedAt = now;
		// 排队时长在派单那一刻定格（第251轮）：终态记录「实际生成（排队）」与「排队不计入生成时长」都取它
		job.queuedMs = Math.max(0, now - job.createdAt);
		persistJobs();
		// 异步执行（不 await：一拍可派多单；错误统一置败）
		void dispatchJob(job).catch((err) => {
			if (job.state === "preparing" || job.state === "running") failJob(job, (err as Error).message);
		});
	}
}

/** history 回执 → 结果提取；未完成返回 null */
function extractHistoryResult(serviceUrl: string, rec: any): { ok: true; url: string } | { ok: false; error: string } | null {
	const status = rec?.status;
	if (!status) return null;
	const statusStr = String(status.status_str ?? "").toLowerCase();
	if (statusStr === "error") {
		// messages: [["execution_error", {exception_message,...}], ...] 提炼人话
		let detail = "";
		if (Array.isArray(status.messages)) {
			for (const m of status.messages) {
				if (Array.isArray(m) && m[0] === "execution_error") {
					detail = String(m[1]?.exception_message ?? "");
					break;
				}
			}
		}
		return { ok: false, error: detail ? `工作流执行失败：${detail}` : "工作流执行失败" };
	}
	if (!status.completed || statusStr !== "success") return null;
	// VHS_VideoCombine 的输出在 outputs.<nodeId>.gifs（mp4 也走该数组）
	const files: any[] = [];
	for (const out of Object.values<any>(rec.outputs ?? {})) {
		if (Array.isArray(out?.gifs)) files.push(...out.gifs);
	}
	const video =
		files.find((f) => /mp4/i.test(String(f?.format ?? "")) || /\.mp4$/i.test(String(f?.filename ?? ""))) || files[0];
	if (!video?.filename) return { ok: false, error: "工作流完成但未输出成片文件" };
	const qs = new URLSearchParams({
		filename: String(video.filename),
		subfolder: String(video.subfolder ?? ""),
		type: String(video.type ?? "output"),
	});
	return { ok: true, url: `${serviceUrl}/view?${qs.toString()}` };
}

let watchBusy = false;
async function watchLoop(): Promise<void> {
	if (watchBusy) return; // 防重入：多任务×8s 超时可能超过 5s 间隔
	watchBusy = true;
	try {
		await watchOnce();
	} finally {
		watchBusy = false;
	}
}
async function watchOnce(): Promise<void> {
	const now = Date.now();
	// 失联/关机判定 → 在途单置败（退款交给上层失败链路）：
	//  - 平台**明确**返回 shutdown/stopped/shutting_down → **立即**置败（ComfyUI 队列在内存里，
	//    关机=任务必死，不必陪等探活或 10 分钟；list 抖动只产生 unknown，不会误入此分支）；
	//  - 其余按探活断超 10 分钟兜底（探活自带三连重试，抗瞬时抖动）。
	for (const inst of pool.instances) {
		const rt = rtOf(inst.uuid);
		const deadNow = SHUTDOWN_STATES.has(rt.platformStatus) || rt.platformStatus === "shutting_down";
		const unreachableLong = !!rt.unreachableSince && now - rt.unreachableSince >= UNREACHABLE_FAIL_MS;
		if (!deadNow && !unreachableLong) continue;
		for (const j of jobs) {
			if ((j.state === "preparing" || j.state === "running") && j.instanceUuid === inst.uuid) {
				failJob(j, deadNow ? `云实例「${inst.name}」已关机，任务已中断` : `云实例「${inst.name}」失联，任务已中断`);
			}
		}
	}
	// 派单后硬超时（最后兜底）：无论何种未预见形态，preparing/running 都不允许超过 90 分钟
	for (const j of jobs) {
		if ((j.state === "preparing" || j.state === "running") && j.dispatchedAt && now - j.dispatchedAt > JOB_RUN_TIMEOUT_MS) {
			failJob(j, "生成超时：云实例长时间未返回结果，任务已中断");
		}
	}
	for (const job of jobs.filter((j) => j.state === "running" && j.promptId)) {
		const inst = job.instanceUuid ? instByUuid(job.instanceUuid) : undefined;
		if (!inst) {
			// 实例已从注册表移除（removePoolInstance 拦 inflight>0，此处只剩「强制路径外的极端」）
			failJob(job, `云实例「${nameOf(job.instanceUuid)}」已被移除，任务已中断`);
			continue;
		}
		const serviceUrl = serviceUrlOf(inst);
		if (!serviceUrl) {
			// ⚠ 入口暂缺 ≠ 实例被移除：服务端重启后自动发现的 serviceUrl 要等 statusLoop 重新
			//   snapshot 才回来——这里等着别误杀（真失联由 unreachableSince→10 分钟兜底）
			continue;
		}
		let rec: any;
		try {
			const resp = await fetch(`${serviceUrl}/history/${encodeURIComponent(job.promptId!)}`, { signal: AbortSignal.timeout(8000) });
			if (!resp.ok) continue; // 瞬时失败：下一拍继续（失联由 unreachableSince 兜底）
			const data: any = await resp.json().catch(() => ({}));
			rec = data?.[job.promptId!];
		} catch {
			continue;
		}
		if (!rec) continue; // 未完成时 /history/{id} 返回空对象 {}
		const result = extractHistoryResult(serviceUrl, rec);
		if (!result) continue;
		if (result.ok) {
			job.state = "completed";
			job.resultUrl = result.url;
			rtOf(inst.uuid).lastJobDoneAt = Date.now();
			persistJobs();
		} else {
			failJob(job, result.error);
		}
	}
}

const STARTING_STATES = new Set(["creating", "created", "starting"]);
const SHUTDOWN_STATES = new Set(["shutdown", "stopped"]);

let scaleBusy = false;
async function scaleLoop(): Promise<void> {
	if (!pool.settings.enabled || scaleBusy) return; // 防重入（开关机请求 15s 超时×多台可能超 60s 间隔）
	scaleBusy = true;
	try {
		await scaleOnce();
	} finally {
		scaleBusy = false;
	}
}
async function scaleOnce(): Promise<void> {
	const now = Date.now();
	const { cooldownSec, scaleUpWaitSec, idleMinutes } = pool.settings;

	// ① always 实例：关机即开回（按台冷却防对同一台反复请求）
	for (const inst of pool.instances) {
		const rt = rtOf(inst.uuid);
		if (inst.mode !== "always" || !SHUTDOWN_STATES.has(rt.platformStatus)) continue;
		if (rt.lastPowerActionAt && now - rt.lastPowerActionAt < cooldownSec * 1000) continue;
		const r = await appPowerOn(inst.uuid);
		log[r.ok ? "info" : "warn"](`[qijicloud] 常开实例「${inst.name}」开机${r.ok ? "已下发" : `失败：${r.error}`}`);
	}

	// ② 扩容：某组排队等待超阈值、组内无空闲槽且无「启动中」实例 → 开一台 auto+shutdown（全局冷却）
	const queuedGroups = new Map<string, number>(); // group → 最老等待 ms
	for (const j of jobs) {
		if (j.state !== "queued") continue;
		const wait = now - j.createdAt;
		if (wait > (queuedGroups.get(j.group) ?? -1)) queuedGroups.set(j.group, wait);
	}
	for (const [group, wait] of queuedGroups) {
		if (wait < scaleUpWaitSec * 1000) continue;
		const groupInsts = pool.instances.filter((i) => i.group === group && i.mode !== "off");
		const hasFreeSlot = groupInsts.some((i) => rtOf(i.uuid).comfyReady && inflightOf(i.uuid) < i.concurrency);
		const hasStarting = groupInsts.some((i) => {
			const rt = rtOf(i.uuid);
			return STARTING_STATES.has(rt.platformStatus) || (!!rt.poweredAt && !rt.comfyReady && now - rt.poweredAt < STARTUP_GRACE_MS);
		});
		if (hasFreeSlot || hasStarting) continue;
		if (now - lastScaleUpAt < cooldownSec * 1000) continue;
		const cand = groupInsts.find((i) => i.mode === "auto" && SHUTDOWN_STATES.has(rtOf(i.uuid).platformStatus));
		if (!cand) continue; // 上限=注册数：没有可开的关机实例即到顶
		lastScaleUpAt = now;
		const r = await appPowerOn(cand.uuid);
		log[r.ok ? "info" : "warn"](`[qijicloud] 组「${group}」积压 ${Math.round(wait / 1000)}s，扩容实例「${cand.name}」${r.ok ? "开机已下发" : `失败：${r.error}`}`);
	}

	// ③ 缩容：auto+就绪+零在途+组内无排队+空闲超时 → 关一台/轮
	for (const inst of pool.instances) {
		if (inst.mode !== "auto") continue;
		const rt = rtOf(inst.uuid);
		// ⚠ 按台冷却 + 关机态跳过（本轮沙盒实锤）：power_off 已下发但 ComfyUI 在 statusLoop
		//   下一拍前仍探活成功的窗口里，不加这两条会对同一台反复关机、还借「一轮只关一台」
		//   的 break 挤占其它空闲实例的缩容名额
		if (rt.lastPowerActionAt && now - rt.lastPowerActionAt < cooldownSec * 1000) continue;
		if (SHUTDOWN_STATES.has(rt.platformStatus) || rt.platformStatus === "shutting_down") continue;
		if (!rt.comfyReady || inflightOf(inst.uuid) > 0) continue;
		if (jobs.some((j) => j.state === "queued" && j.group === inst.group)) continue;
		const idleSince = rt.lastJobDoneAt ?? rt.poweredAt ?? rt.firstReadyAt;
		if (!idleSince || now - idleSince < idleMinutes * 60 * 1000) continue;
		const r = await appPowerOff(inst.uuid);
		log[r.ok ? "info" : "warn"](`[qijicloud] 实例「${inst.name}」空闲 ${idleMinutes} 分钟，缩容关机${r.ok ? "已下发" : `失败：${r.error}`}`);
		break; // 一轮最多关一台（防批量误关）
	}
}

/** 启动四条调度循环（幂等；relay 节点勿调——index.ts 只在源站分支挂） */
export function startQijicloudLoops(logger: { info: (m: string) => void; warn: (m: string) => void }): void {
	log = logger;
	if (loopsStarted) return;
	loopsStarted = true;
	const guard = (fn: () => void | Promise<void>) => (): void => {
		void Promise.resolve()
			.then(fn)
			.catch((err) => log.warn(`[qijicloud] 调度循环异常：${(err as Error).message}`));
	};
	// 状态循环一拍 15s：过渡态（开关机中）实例每拍刷=提速一倍；稳定态实例内部按 30s 节流
	setInterval(guard(statusLoop), STATUS_TICK_MS).unref();
	setInterval(guard(dispatchLoop), 3000).unref();
	setInterval(guard(watchLoop), 5000).unref();
	setInterval(guard(scaleLoop), 60000).unref();
	// 启动即刷一拍状态（让管理端/派单不用干等 30s）
	setTimeout(guard(statusLoop), 3000).unref();
}
