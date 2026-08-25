/**
 * comfyuiStore —— ComfyUI 直连绑定状态（第三方本地渠道，与 libtvStore/dreaminaStore 同级）。
 *
 * 第250轮单地址 → 本轮**多端点**：用户可在「个人中心 → ComfyUI 直连」绑定多台 ComfyUI
 * （本机 + 多台自租云实例），提交时**自动分流**——并行探测各台 /queue 负载（在跑+排队数），
 * 派给最闲的一台，平手按轮转游标轮流（见 pickComfyEndpoint）。生成经 comfyuiAdapter 直连
 * 所选端点跑 jianyi933（MiniMax H3）工作流，不经管理端、不扣生成积分，仅按次手续费。
 *
 * 持久化：localStorage `Qiji:comfyui` 存 { endpoints: [{id,url,name,enabled}] }；
 * 兼容迁移第250轮旧形态 { url }（→ 单端点）。连通状态/测试结果是会话态不落盘。
 */
import { create } from "zustand";
import { comfyGet } from "@/services/comfyuiClient";

const LS_KEY = "Qiji:comfyui";

export interface ComfyEndpoint {
	id: string;
	/** 已归一化地址（http(s)://…，无尾斜杠） */
	url: string;
	/** 展示名（缺省=地址） */
	name: string;
	/** 停用=不参与自动分流（列表保留；该端点上的旧任务轮询也会提示恢复启用） */
	enabled: boolean;
}

/** 归一化地址：无协议补 http://、去尾斜杠；空/纯空白=无效（返回 ""） */
export function normalizeComfyuiUrl(raw: string): string {
	const s = String(raw ?? "").trim();
	if (!s) return "";
	const withProto = /^https?:\/\//i.test(s) ? s : `http://${s}`;
	return withProto.replace(/\/+$/, "");
}

function genEndpointId(): string {
	return `ep-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 读盘 + 兼容迁移（纯函数可单测）：
 *  - 新形态 { endpoints: [...] } → 逐条清洗（url 归一、空 url 丢弃、缺 id 补）；
 *  - 第250轮旧形态 { url: "..." } → 迁成单端点（名「默认」）；
 *  - 坏数据/非浏览器环境 → []。
 */
export function parseComfyPersist(raw: string | null): ComfyEndpoint[] {
	if (!raw) return [];
	try {
		const p = JSON.parse(raw) as { endpoints?: unknown; url?: unknown };
		if (Array.isArray(p?.endpoints)) {
			const seen = new Set<string>();
			const out: ComfyEndpoint[] = [];
			for (const e of p.endpoints as Partial<ComfyEndpoint>[]) {
				const url = normalizeComfyuiUrl(String(e?.url ?? ""));
				if (!url || seen.has(url)) continue;
				seen.add(url);
				out.push({
					id: String(e?.id ?? "") || genEndpointId(),
					url,
					name: String(e?.name ?? "").trim() || url,
					enabled: e?.enabled !== false,
				});
			}
			return out;
		}
		// 第250轮旧形态：单 url
		const legacy = normalizeComfyuiUrl(String(p?.url ?? ""));
		if (legacy) return [{ id: genEndpointId(), url: legacy, name: "默认", enabled: true }];
	} catch {
		/* 坏数据视为未绑定 */
	}
	return [];
}

function loadEndpoints(): ComfyEndpoint[] {
	try {
		return parseComfyPersist(localStorage.getItem(LS_KEY));
	} catch {
		return []; // 非浏览器环境（vitest node）
	}
}

function persistEndpoints(endpoints: ComfyEndpoint[]): void {
	try {
		localStorage.setItem(LS_KEY, JSON.stringify({ endpoints }));
	} catch {
		/* ignore */
	}
}

/** 单端点会话态测试结果 */
export interface EndpointProbe {
	state: "ok" | "fail";
	error?: string;
	/** 探到的队列负载（在跑+排队；仅 ok 时有） */
	load?: number;
}

interface ComfyuiState {
	endpoints: ComfyEndpoint[];
	/** 会话态：各端点最近一次测试结果（id → 结果） */
	probes: Record<string, EndpointProbe>;
	/** 会话态：各端点测试进行中 */
	testing: Record<string, boolean>;

	/** 新增端点（地址自动归一；空/重复地址返回 error） */
	addEndpoint: (rawUrl: string, name?: string) => { ok: boolean; error?: string };
	/** 更新端点（url 会归一化；url 变化会作废该端点的测试结果） */
	updateEndpoint: (id: string, patch: Partial<Pick<ComfyEndpoint, "url" | "name" | "enabled">>) => void;
	removeEndpoint: (id: string) => void;
	/** 测试单个端点：GET {url}/queue（5s）——通即算连上，顺带记录负载 */
	testEndpoint: (id: string) => Promise<boolean>;
}

export const useComfyuiStore = create<ComfyuiState>((set, get) => ({
	endpoints: loadEndpoints(),
	probes: {},
	testing: {},

	addEndpoint: (rawUrl, name) => {
		const url = normalizeComfyuiUrl(rawUrl);
		if (!url) return { ok: false, error: "请填写 ComfyUI 地址" };
		if (get().endpoints.some((e) => e.url === url)) return { ok: false, error: "该地址已绑定" };
		const ep: ComfyEndpoint = { id: genEndpointId(), url, name: (name ?? "").trim() || url, enabled: true };
		const endpoints = [...get().endpoints, ep];
		persistEndpoints(endpoints);
		set({ endpoints });
		return { ok: true };
	},

	updateEndpoint: (id, patch) => {
		let urlChanged = false;
		const endpoints = get().endpoints.map((e) => {
			if (e.id !== id) return e;
			const next = { ...e };
			if (patch.url !== undefined) {
				const url = normalizeComfyuiUrl(patch.url);
				if (url && url !== e.url) {
					next.url = url;
					urlChanged = true;
				}
			}
			if (patch.name !== undefined) next.name = patch.name.trim() || next.url;
			if (patch.enabled !== undefined) next.enabled = patch.enabled;
			return next;
		});
		persistEndpoints(endpoints);
		set((s) => {
			if (!urlChanged) return { endpoints };
			const probes = { ...s.probes };
			delete probes[id]; // 地址变了=旧测试结果作废
			return { endpoints, probes };
		});
	},

	removeEndpoint: (id) => {
		const endpoints = get().endpoints.filter((e) => e.id !== id);
		persistEndpoints(endpoints);
		set({ endpoints });
	},

	testEndpoint: async (id) => {
		const ep = get().endpoints.find((e) => e.id === id);
		if (!ep || get().testing[id]) return false;
		set((s) => ({ testing: { ...s.testing, [id]: true } }));
		try {
			const load = await probeEndpointLoad(ep.url, 5);
			set((s) => ({
				testing: { ...s.testing, [id]: false },
				probes: { ...s.probes, [id]: { state: "ok", load } },
			}));
			return true;
		} catch (e) {
			set((s) => ({
				testing: { ...s.testing, [id]: false },
				probes: {
					...s.probes,
					[id]: { state: "fail", error: e instanceof Error && e.message ? e.message : "无法连接（地址不通或实例未启动）" },
				},
			}));
			return false;
		}
	},
}));

/**
 * /queue 回执 → 队列负载（在跑+排队）；**响应形状不对返回 null**（纯函数可单测）。
 * ⚠ 只看 HTTP 200 不够（真机实锤，与服务端奇迹云同病）：云实例关机后其代理域名常返回
 * 200 的提示页（JSON 解析失败=body null，或解析出无队列数组的对象）——宽松判定会把
 * 已关机的实例判成「已连通 · 队列 0」，自动分流还会派单给它。
 */
export function queueLoadOf(body: unknown): number | null {
	const b = body as { queue_running?: unknown[]; queue_pending?: unknown[] } | null;
	if (!b || (!Array.isArray(b.queue_running) && !Array.isArray(b.queue_pending))) return null;
	return (Array.isArray(b.queue_running) ? b.queue_running.length : 0) + (Array.isArray(b.queue_pending) ? b.queue_pending.length : 0);
}

/** 探测单端点负载：GET /queue → 在跑+排队条数；不通/非 2xx/形状不对 抛错（文案供展示） */
async function probeEndpointLoad(url: string, timeoutSecs: number): Promise<number> {
	const r = await comfyGet(`${url}/queue`, { timeoutSecs });
	if (r.status < 200 || r.status >= 300) {
		throw new Error(`ComfyUI 响应异常（HTTP ${r.status}）——地址是否指向 ComfyUI 实例？`);
	}
	const load = queueLoadOf(r.body);
	if (load === null) throw new Error("响应不是 ComfyUI 队列——实例可能已关机（代理返回了提示页）或地址指向了别的服务");
	return load;
}

// ── 非 hook 读取（adapter 用） ──

/** 启用中的端点（自动分流候选） */
export function enabledComfyEndpoints(): ComfyEndpoint[] {
	return useComfyuiStore.getState().endpoints.filter((e) => e.enabled && !!e.url);
}

/** 按 id 找端点（含停用的——轮询旧任务要能找到它给出「恢复启用」指引） */
export function comfyEndpointById(id: string): ComfyEndpoint | undefined {
	return useComfyuiStore.getState().endpoints.find((e) => e.id === id);
}

/** 是否已绑定（≥1 个启用端点即算；不要求测试通过——测试只是辅助自检） */
export function isComfyuiBound(): boolean {
	return enabledComfyEndpoints().length > 0;
}

/**
 * 负载择优（纯函数可单测）：取 load 最小者；平手按轮转游标（cursor 递增）在并列者间轮流，
 * 保证多台空闲机被均匀使用而不是恒打第一台。空候选返回 null。
 */
export function chooseComfyEndpointId(cands: { id: string; load: number }[], cursor: number): string | null {
	if (!cands.length) return null;
	const min = Math.min(...cands.map((c) => c.load));
	const best = cands.filter((c) => c.load === min);
	return best[((cursor % best.length) + best.length) % best.length].id;
}

let rrCursor = 0;

/**
 * 自动分流选端点（adapter 提交时调用）：
 *  - 仅 1 台启用 → 直接用它（不探测，提交失败自然报错——与第250轮单端点行为一致）；
 *  - 多台 → 并行探测各台 /queue（4s 短超时），不通的剔除；按最小负载择优、平手轮转；
 *  - 全部不通 → 明确报错（逐台列名与原因，绝不静默挑一台送死）。
 */
export async function pickComfyEndpoint(): Promise<ComfyEndpoint> {
	const eps = enabledComfyEndpoints();
	if (!eps.length) throw new Error("尚未绑定 ComfyUI：请到「个人中心 → ComfyUI 直连」绑定地址后重试");
	if (eps.length === 1) return eps[0];
	const probed = await Promise.all(
		eps.map(async (ep) => {
			try {
				return { ep, load: await probeEndpointLoad(ep.url, 4), error: "" };
			} catch (e) {
				return { ep, load: -1, error: e instanceof Error ? e.message : "不可达" };
			}
		}),
	);
	const alive = probed.filter((p) => p.load >= 0);
	if (!alive.length) {
		const detail = probed.map((p) => `「${p.ep.name}」${p.error}`).join("；");
		throw new Error(`绑定的 ComfyUI 端点全部不可达：${detail}`);
	}
	const id = chooseComfyEndpointId(alive.map((p) => ({ id: p.ep.id, load: p.load })), rrCursor++);
	return alive.find((p) => p.ep.id === id)!.ep;
}
