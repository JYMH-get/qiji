/**
 * 生成「模式」注册表（第130轮）。
 *
 * 模式 = 一组模型的分类 + 一个可按用户/渠道商启用禁用的开关（与 libtv/即梦在「可用模式」里并列显示）。
 * `Model.modeId` 指向某个模式；**无 modeId 的模型属「默认模式」——常开、不可禁**。
 * 门禁：用户/渠道商的 `features.modes[modeId] === false` 关闭该模式 →
 *   ① 客户端按下发的 features.modes 隐藏这些模型（≤30s 心跳生效）；
 *   ② /v1/generate·/v1/batch 返回 403（真服务端拦——这些模型经服务端扣积分、进请求记录，
 *      区别于 libtv/即梦的本地 CLI 生成）。
 * 动态注册表：管理端「模式管理」可增删/改名；新建模型从模式下拉选择。删除模式时引用它的模型
 * modeId 清空（回落默认模式常开）。内置种子：qiji（现有视频生成 seedance）、jianmeng（简梦，初始为空）。
 */
import { loadJson, saveJson, genId } from "./db.ts";
import { clearModeFromModels, anyModelInMode } from "./models.ts";

export interface Mode {
	id: string; // 稳定标识（小写 kebab；创建后不可改）
	name: string; // 显示名
	order: number; // 排序（第165轮起管理端卡片可拖动重排；catalog 模型按此序稳定排序=客户端源顺序）
	/** 全局开关（第165轮）：false=停用——客户端隐藏该模式及其下全部模型、调用一律 403；缺省(undefined)=启用 */
	enabled?: boolean;
	createdAt: string;
	updatedAt: string;
}

interface Store {
	version: number;
	seeded?: boolean;
	/** 种子版本（第131轮起）：落后即按 id 补种缺失的内置模式（不覆盖已有同 id） */
	seedVersion?: number;
	modes: Mode[];
}

const FILE = "modes.json";
const now = (): string => new Date().toISOString();

// 第131轮：苏打水接入拆三个简梦模式（16 模型分归 jmgf/jm431/jm933）；第130轮的空占位模式
// "jianmeng"（简梦）被取代——迁移时若仍为空（无模型引用、未改名）则删除。
// v3：新增「Qiji 图片」（qiji-img）——全部出图模型归入（与视频同理，models.ts 迁移 ⑤c）。
// v4（第132轮）：新增「星辰」（xingchen）——AIStartLab 视频渠道 xc 系 14 模型归入。
// v5（第133轮）：新增「画影」（huaying）——AI-Studio（aixyzz）视频渠道 hy 系 6 模型归入。
// v6（第134轮）：新增「Dimensio」（dimensio）——jimeng.dimensio.cn 视频渠道 dm 系 3 模型归入。
// v7（第139轮）：新增「Aivide」（aivide）——aivideo.beauty 视频渠道 av933-2.0 归入。
// v8（第147轮）：新增「简梦P」（jmp）——Sora/Veo 系视频渠道（sora2/sora-v3-*/veo31-*）7 模型归入。
// v9（第151轮）：新增「简梦M」（jmm）——MuseAI（museai.vip）视频渠道 jmm 系 4 模型归入。
// v10（第152轮）：新增「简梦Z」（jmz）——zexitongxue.com 视频渠道 jmz 系 14 模型归入（第153轮图片 7 款同归）。
// v11（第154轮）：新增「简梦H」（jmh）——ZhengAPI（zhengapi.top）图片渠道 jmh 系 6 模型归入。
// v12（第156轮）：苏打水收编——三模式 jmgf/jm431/jm933 合一为「简梦S」（jms），旧三模式删除。
// v13（第157轮）：新增「云雾」（yunwu）——yunwu.ai 文本渠道（标准 OpenAI chat 协议）归入。
// v14（第160轮）：新增「简梦T」（jmt）——llm.chre3.com 视频渠道（sd2-c8·Seedance 2.0 满血版）归入。
// v15（第161轮）：新增「简梦F」（jmf）——new.vosle.xyz 视频渠道（Seedance 2.0，模型 ID 现拼）归入。
// v16（第186轮）：新增「overseas」（出海营 api.aiid.edu.kg）——Seedance 任务格式视频渠道 os 系模型归入。
// v17（第217轮）：新增「算力」（suanli，xienlive.com·OctopusAI）——MiniMax H3 音视频同步视频渠道归入。
// v18（第229轮）：新增「Yali」（yali，api.yaliai.com）——图片渠道（OpenAI Images + Banana/Gemini 两类接口）归入。
// v19（第230轮）：新增「Skylee」（skylee，api.808relay.com）——异步图片渠道（GPT Image 2/Gemini/Midjourney 12 款）归入。
// v20（第233轮）：新增「congge」（congchen.top·聪宸）——同站图片（同步 3 款）+ 视频（Seedance 2.0/2.5 4 款）归入。
// v21（第234轮）：新增「autodl」（autodl.art·ComfyUI 工作流平台）——H3 视频三工作流（多图参考/文生/首尾帧）归入。
const MODES_SEED_VERSION = 21;
const DEFAULT_MODES: Mode[] = [
	{ id: "qiji", name: "Qiji 视频", order: 1, createdAt: now(), updatedAt: now() },
	{ id: "qiji-img", name: "Qiji 图片", order: 2, createdAt: now(), updatedAt: now() },
	{ id: "jms", name: "简梦S", order: 3, createdAt: now(), updatedAt: now() },
	{ id: "xingchen", name: "星辰", order: 6, createdAt: now(), updatedAt: now() },
	{ id: "huaying", name: "画影", order: 7, createdAt: now(), updatedAt: now() },
	{ id: "dimensio", name: "Dimensio", order: 8, createdAt: now(), updatedAt: now() },
	{ id: "aivide", name: "Aivide", order: 9, createdAt: now(), updatedAt: now() },
	{ id: "jmp", name: "简梦P", order: 10, createdAt: now(), updatedAt: now() },
	{ id: "jmm", name: "简梦M", order: 11, createdAt: now(), updatedAt: now() },
	{ id: "jmz", name: "简梦Z", order: 12, createdAt: now(), updatedAt: now() },
	{ id: "jmh", name: "简梦H", order: 13, createdAt: now(), updatedAt: now() },
	{ id: "yunwu", name: "云雾", order: 14, createdAt: now(), updatedAt: now() },
	{ id: "jmt", name: "简梦T", order: 15, createdAt: now(), updatedAt: now() },
	{ id: "jmf", name: "简梦F", order: 16, createdAt: now(), updatedAt: now() },
	{ id: "overseas", name: "overseas", order: 17, createdAt: now(), updatedAt: now() },
	{ id: "suanli", name: "算力", order: 18, createdAt: now(), updatedAt: now() },
	{ id: "yali", name: "Yali", order: 19, createdAt: now(), updatedAt: now() },
	{ id: "skylee", name: "Skylee", order: 20, createdAt: now(), updatedAt: now() },
	{ id: "congge", name: "congge", order: 21, createdAt: now(), updatedAt: now() },
	{ id: "autodl", name: "autodl", order: 22, createdAt: now(), updatedAt: now() },
];

let store: Store = loadJson<Store>(FILE, { version: 0, modes: [] });
if (!store.seeded || (store.seedVersion ?? 1) < MODES_SEED_VERSION) {
	// 按 id 补种缺失的内置模式（不覆盖已有同 id——管理端改过名/序的保留）
	for (const d of DEFAULT_MODES) if (!store.modes.some((m) => m.id === d.id)) store.modes.push(d);
	// 一次性清理第130轮的空占位「简梦」模式（仅当未被模型引用且名字未被管理端改过才删，防误删用户数据）
	if ((store.seedVersion ?? 1) < 2) {
		const legacy = store.modes.find((m) => m.id === "jianmeng");
		if (legacy && legacy.name === "简梦" && !anyModelInMode("jianmeng")) {
			store.modes = store.modes.filter((m) => m.id !== "jianmeng");
		}
	}
	// v12（第156轮）：删除苏打水旧三模式（引用模型已由 models.ts ⑤f 迁移先行归入 jms——本模块 import
	// models.ts 保证其先跑；万一仍有模型引用则兜底不删，防悬空）
	if ((store.seedVersion ?? 1) < 12) {
		for (const id of ["jmgf", "jm431", "jm933"]) {
			if (!anyModelInMode(id)) store.modes = store.modes.filter((m) => m.id !== id);
		}
	}
	store.seeded = true;
	store.seedVersion = MODES_SEED_VERSION;
	store.version = (store.version || 0) + 1;
	saveJson(FILE, store);
}

function persist(): void {
	store.version += 1;
	saveJson(FILE, store);
}

/** 归一模式 id：小写、仅字母/数字/下划线/连字符 */
const normId = (s: string): string =>
	(s || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");

export function listModes(): Mode[] {
	return [...store.modes].sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt));
}
export function getMode(id: string): Mode | undefined {
	return store.modes.find((m) => m.id === id);
}
/** 模式显示名（未知 id 回退原 id） */
export function modeName(id?: string): string {
	return (id && getMode(id)?.name) || id || "";
}
export function modesVersion(): number {
	return store.version;
}

export function createMode(input: { id?: string; name: string }): { ok: boolean; error?: string; mode?: Mode } {
	const name = (input.name || "").trim();
	if (!name) return { ok: false, error: "模式名不能为空" };
	// 名称/指定 id 归一后为空（如纯中文名未填英文 id）→ 自动生成稳定 id，避免拒收
	const id = normId(input.id || name) || genId("mode");
	if (store.modes.some((m) => m.id === id)) return { ok: false, error: "该模式 id 已存在" };
	const order = store.modes.reduce((mx, m) => Math.max(mx, m.order), 0) + 1;
	const mode: Mode = { id, name, order, createdAt: now(), updatedAt: now() };
	store.modes.push(mode);
	persist();
	return { ok: true, mode };
}

export function updateMode(id: string, patch: { name?: string; order?: number; enabled?: boolean }): { ok: boolean; error?: string; mode?: Mode } {
	const m = getMode(id);
	if (!m) return { ok: false, error: "模式不存在" };
	if (patch.name !== undefined) {
		const nm = patch.name.trim();
		if (!nm) return { ok: false, error: "模式名不能为空" };
		m.name = nm;
	}
	if (patch.order !== undefined) m.order = Number(patch.order) || m.order;
	if (patch.enabled !== undefined) m.enabled = !!patch.enabled;
	m.updatedAt = now();
	persist();
	return { ok: true, mode: m };
}

/** 模式是否被全局停用（第165轮管理端开关）；未知 id/无 id=未停用 */
export function modeDisabled(id?: string): boolean {
	return !!id && getMode(id)?.enabled === false;
}

/**
 * 按 id 数组整体重排（管理端卡片拖动排序）：列表内按新序 1..n，未列出的（并发新增等）
 * 保持相对序排在其后；一次落盘一次版本 bump → catalog version `.m` 段变化 → 客户端 ≤30s 热更顺序。
 */
export function reorderModes(ids: string[]): boolean {
	const pos = new Map(ids.map((id, i) => [id, i]));
	if (!store.modes.some((m) => pos.has(m.id))) return false;
	const listed = store.modes.filter((m) => pos.has(m.id)).sort((a, b) => pos.get(a.id)! - pos.get(b.id)!);
	const rest = store.modes.filter((m) => !pos.has(m.id)).sort((a, b) => a.order - b.order);
	let n = 0;
	const at = now();
	for (const m of [...listed, ...rest]) {
		m.order = ++n;
		m.updatedAt = at;
	}
	persist();
	return true;
}

export function deleteMode(id: string): boolean {
	const before = store.modes.length;
	store.modes = store.modes.filter((m) => m.id !== id);
	if (store.modes.length === before) return false;
	persist();
	// 引用该模式的模型 → 清空 modeId（回落默认模式常开）
	clearModeFromModels(id);
	return true;
}
