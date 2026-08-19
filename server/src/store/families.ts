/**
 * 模型「家族」注册表（第163轮）。
 *
 * 家族 = 底层模型的种类（Seedance 2.0 / Sora2 / GPT Image 2…），**纯展示分组维度**：
 * 客户端模型选择改为「家族 → 渠道/线路 → 模型 → 要求」四级，以家族为一级筛选——
 * 同一模型横跨多渠道（Seedance 2.0 一种就跨 10 个渠道）时用户先选模型种类再挑渠道。
 * ⚠ 与「模式」（modes.ts）分工锁定（用户定，勿混）：
 *   - 模式 = 渠道源头分组 + 用户/渠道商**门禁开关**（关渠道用它；仍是第二级「渠道/线路」的显示名来源）；
 *   - 家族 = 模型种类，**不参与任何门禁/计费**——删除/改动家族只影响客户端下拉分组。
 * `Model.familyId` 指向某个家族；无 familyId 的模型客户端归入「其他」分组。
 * 动态注册表：管理端「渠道」页「家族管理」可增删/改名；删除家族时引用它的模型 familyId 清空。
 * 归类规则（用户定，第163轮）：933/431/403/dolo/aivide 及支持全能参考的 sora-v3 系都是 seedance；
 * 详见 models.ts classifyFamily（种子与迁移共用一把尺）。
 */
import { loadJson, saveJson, genId } from "./db.ts";
import { clearFamilyFromModels } from "./models.ts";

export interface Family {
	id: string; // 稳定标识（小写 kebab；创建后不可改）
	name: string; // 显示名
	/** 家族所属能力（video/image）：管理端模型页家族下拉按能力过滤用；缺省=不限 */
	capability?: "video" | "image";
	order: number; // 排序（客户端一级下拉按此序；第165轮起管理端卡片可拖动重排）
	/** 全局开关（第165轮）：false=停用——客户端一级筛选不再显示该家族、其模型归入「其他」分组
	 *（纯展示：模型仍可用，不参与门禁/计费——关渠道仍用「模式」）；缺省(undefined)=启用 */
	enabled?: boolean;
	createdAt: string;
	updatedAt: string;
}

interface Store {
	version: number;
	seeded?: boolean;
	seedVersion?: number;
	families: Family[];
}

const FILE = "families.json";
const now = (): string => new Date().toISOString();

// v1（第163轮）：内置 11 个家族（用户定稿清单）——视频 7：Seedance 2.0/Grok/Kling3/Veo3.1/Sora2/
// Gemini Omni/Runway 4.5；图像 4：GPT Image 2/Nano Banana/Grok Image/MJ（MJ 预留、暂无模型）。
// v2（第216轮）：+MiniMax（星辰 59 线海螺 H3；id 与客户端 LibTV 本地 H3 的 fam-minimax 同名——
// 第203轮预留「服务端注册同 id 家族则显示名自动跟随」在此兑现）+HappyHorse（星辰 56 线快乐马）。
const FAMILIES_SEED_VERSION = 2;
const fam = (id: string, name: string, capability: "video" | "image", order: number): Family => ({
	id, name, capability, order, createdAt: now(), updatedAt: now(),
});
const DEFAULT_FAMILIES: Family[] = [
	fam("fam-seedance", "Seedance 2.0", "video", 1),
	fam("fam-grok", "Grok", "video", 2),
	fam("fam-kling3", "Kling3", "video", 3),
	fam("fam-veo31", "Veo3.1", "video", 4),
	fam("fam-sora2", "Sora2", "video", 5),
	fam("fam-gemini-omni", "Gemini Omni", "video", 6),
	fam("fam-runway45", "Runway 4.5", "video", 7),
	fam("fam-gpt-image-2", "GPT Image 2", "image", 8),
	fam("fam-nano-banana", "Nano Banana", "image", 9),
	fam("fam-grok-image", "Grok Image", "image", 10),
	fam("fam-mj", "MJ", "image", 11),
	fam("fam-minimax", "MiniMax", "video", 12),
	fam("fam-happyhorse", "HappyHorse", "video", 13),
];

let store: Store = loadJson<Store>(FILE, { version: 0, families: [] });
if (!store.seeded || (store.seedVersion ?? 0) < FAMILIES_SEED_VERSION) {
	// 按 id 补种缺失的内置家族（不覆盖已有同 id——管理端改过名/序的保留）
	for (const d of DEFAULT_FAMILIES) if (!store.families.some((f) => f.id === d.id)) store.families.push(d);
	store.seeded = true;
	store.seedVersion = FAMILIES_SEED_VERSION;
	store.version = (store.version || 0) + 1;
	saveJson(FILE, store);
}

function persist(): void {
	store.version += 1;
	saveJson(FILE, store);
}

/** 归一家族 id：小写、仅字母/数字/下划线/连字符 */
const normId = (s: string): string =>
	(s || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");

export function listFamilies(): Family[] {
	return [...store.families].sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt));
}
export function getFamily(id: string): Family | undefined {
	return store.families.find((f) => f.id === id);
}
/** 家族显示名（未知 id 回退原 id） */
export function familyName(id?: string): string {
	return (id && getFamily(id)?.name) || id || "";
}
export function familiesVersion(): number {
	return store.version;
}

export function createFamily(input: { id?: string; name: string; capability?: string }): { ok: boolean; error?: string; family?: Family } {
	const name = (input.name || "").trim();
	if (!name) return { ok: false, error: "家族名不能为空" };
	const id = normId(input.id || name) || genId("fam");
	if (store.families.some((f) => f.id === id)) return { ok: false, error: "该家族 id 已存在" };
	const capability = input.capability === "video" || input.capability === "image" ? input.capability : undefined;
	const order = store.families.reduce((mx, f) => Math.max(mx, f.order), 0) + 1;
	const family: Family = { id, name, capability, order, createdAt: now(), updatedAt: now() };
	store.families.push(family);
	persist();
	return { ok: true, family };
}

export function updateFamily(id: string, patch: { name?: string; order?: number; capability?: string; enabled?: boolean }): { ok: boolean; error?: string; family?: Family } {
	const f = getFamily(id);
	if (!f) return { ok: false, error: "家族不存在" };
	if (patch.name !== undefined) {
		const nm = patch.name.trim();
		if (!nm) return { ok: false, error: "家族名不能为空" };
		f.name = nm;
	}
	if (patch.order !== undefined) f.order = Number(patch.order) || f.order;
	if (patch.capability !== undefined) f.capability = patch.capability === "video" || patch.capability === "image" ? patch.capability : undefined;
	if (patch.enabled !== undefined) f.enabled = !!patch.enabled;
	f.updatedAt = now();
	persist();
	return { ok: true, family: f };
}

/**
 * 按 id 数组整体重排（管理端卡片拖动排序）：列表内按新序 1..n，未列出的保持相对序排其后；
 * 一次落盘一次版本 bump → catalog version `.f` 段变化 → 客户端 ≤30s 热更一级筛选顺序。
 */
export function reorderFamilies(ids: string[]): boolean {
	const pos = new Map(ids.map((id, i) => [id, i]));
	if (!store.families.some((f) => pos.has(f.id))) return false;
	const listed = store.families.filter((f) => pos.has(f.id)).sort((a, b) => pos.get(a.id)! - pos.get(b.id)!);
	const rest = store.families.filter((f) => !pos.has(f.id)).sort((a, b) => a.order - b.order);
	let n = 0;
	const at = now();
	for (const f of [...listed, ...rest]) {
		f.order = ++n;
		f.updatedAt = at;
	}
	persist();
	return true;
}

export function deleteFamily(id: string): boolean {
	const before = store.families.length;
	store.families = store.families.filter((f) => f.id !== id);
	if (store.families.length === before) return false;
	persist();
	// 引用该家族的模型 → 清空 familyId（客户端回落「其他」分组；纯展示维度，无门禁/计费影响）
	clearFamilyFromModels(id);
	return true;
}
