/**
 * 预设存储（文件持久化）—— 第174轮从「提示词模板」中**数据层真拆分**出来的独立实体。
 *
 * 预设 = 无用途、不可执行的**正文片段**（画风 / 出图预设方案 / 资产拆分前后缀）：
 *  - catalog 全文下发（正文即价值，区别于提示词模板「正文只留服务端」）；
 *  - 客户端以「预设胶囊」`【预设:id】` 插入提示词，提交时展开成正文；
 *  - `autoAttach`（第174轮）：按**资产类别**声明自动附加范围——资产拆分完成把资产出图提示词
 *    写入五类界面时，客户端自动给该类资产挂上本预设的胶囊（前缀/后缀由 position 决定），
 *    前后缀不再依赖 LLM 推理产出（省 token 省等待）。画风前缀独立于此：恒按项目画风
 *    （新建项目所选画风预设 id）取，全类别通用，不走 autoAttach。
 *
 * 迁移：首启把 templates.json 里 分类∈{画风,预设方案} 的**平台**模板（连管理端改过的正文一起）
 * 搬进本库并从模板库移除（templates.ts 种子已同步剔除，不会补种复活）；渠道商自营模板不动。
 */
import { loadJson, saveJson } from "./db.ts";
import { extractPlatformPresetTemplates } from "./templates.ts";

/** 资产拆分自动附加的类别键（与客户端项目 store 五类字段名一致） */
export const SPLIT_ATTACH_CATS = ["characters", "crowds", "scenes", "organisms", "items"] as const;
export type SplitAttachCat = (typeof SPLIT_ATTACH_CATS)[number];

export interface PresetDef {
	id: string;
	name: string;
	/** 分组："画风"（新建项目画风选择器 + 画风前缀）/ "预设方案"（出图预设胶囊）/ 其它自由分组 */
	category: string;
	/** 完整正文（预设是正文片段，catalog 全文下发） */
	body: string;
	/** 参考图（data URL，已压缩）——画风参考图等 */
	images: string[];
	/** 插入位置：前缀（用户输入前）/后缀（用户输入后）；缺省=前缀 */
	position?: "prefix" | "suffix";
	/** 互斥组：同一非空组内的预设不能同时出现在一段提示词里（客户端插入其一即移除同组旧胶囊） */
	group?: string;
	/** 自动附加范围（第174轮）：资产拆分完成时自动挂到这些类别资产的出图提示词上 */
	autoAttach?: SplitAttachCat[];
	enabled: boolean;
	order: number;
	createdAt: string;
	updatedAt: string;
}

interface Store {
	version: number;
	/** 已被管理员删除的内置预设 id（墓碑）——重启不再补种，使删除可持久 */
	deletedSeedIds?: string[];
	presets: PresetDef[];
}

const FILE = "presets.json";

/**
 * 宫格预设正文（自第164轮补充2 的 templates.ts 迁来；正文含「满幅填充/无边框/无缝拼贴」要求）。
 * 三档共用一个骨架，只差 数量/行列/编号。
 */
function gridPresetBody(n: number, layout: string): string {
	return `生成一个${n}宫格的电影故事板网格，固定横排16:9的格式，排列方式为${layout}。所有宫格16:9的格式相同，按从左至右、从上至下，每张画面左下角必须标注黑色纤细阿拉伯数字1-${n}，无画面重叠拉伸变形，各宫格画面满幅填充、无边框无描边，宫格之间及整图四周零间距无缝拼贴（无分隔线、无留白、无外边距、无底色露出），所有子图画幅、光影、美术风格完全统一，按叙事逻辑有序排布，标准专业故事板版式，对齐规整无缝，镜头类型错落丰富，整套画面色调高度统一。电影级3D国风动画CG风格，UE5虚幻引擎渲染质量，真实景深，高级电影颗粒感，构图清晰，色彩基调一致，确保环境资产外观、环境及光线方向绝对一致，无多余人物，无多余元素，无画面闪烁，无跳帧，无肢体扭曲，无模糊不清。`;
}
/** 旧版宫格预设正文——仅供迁移比对：正文仍是旧种子原样（管理端没改过）才升级到新正文 */
function legacyGridPresetBody(n: number, layout: string): string {
	return `生成一个${n}宫格的电影故事板网格，固定横排16:9的格式，排列方式为${layout}。所有宫格16:9的格式相同，按从左至右、从上至下，每张画面左下角必须标注黑色纤细阿拉伯数字1-${n}，无画面重叠拉伸变形，所有子图画幅、光影、美术风格完全统一，按叙事逻辑有序排布，标准专业故事板版式，对齐规整、留白干净，镜头类型错落丰富，整套画面色调高度统一。电影级3D国风动画CG风格，UE5虚幻引擎渲染质量，真实景深，高级电影颗粒感，构图清晰，色彩基调一致，确保环境资产外观、环境及光线方向绝对一致，无多余人物，无多余元素，无画面闪烁，无跳帧，无肢体扭曲，无模糊不清。`;
}
const GRID_PRESET_SPECS: Record<string, { n: number; layout: string }> = {
	"preset.storyboard.4grid": { n: 4, layout: "2行2列" },
	"preset.storyboard.6grid": { n: 6, layout: "3行2列" },
	"preset.storyboard.9grid": { n: 9, layout: "3行3列" },
};

function pre(partial: Pick<PresetDef, "id" | "name" | "category" | "body"> & Partial<PresetDef>): PresetDef {
	const now = new Date().toISOString();
	return {
		images: [],
		position: "prefix",
		enabled: true,
		order: 0,
		createdAt: now,
		updatedAt: now,
		...partial,
	};
}

/** 内置预设种子（全新环境用；存量环境由 templates.json 迁移带入管理端改过的正文） */
const DEFAULT_PRESETS: PresetDef[] = [
	// ── 画风（新建项目画风选择器 + 【画风前缀】；同组互斥）──
	pre({ id: "style.3d-guoman", name: "3D国漫 (动漫半写实)", category: "画风", group: "画风", order: 1, body: "3D国风动画" }),
	pre({ id: "style.2d-hand", name: "2D手绘 (二次元日系)", category: "画风", group: "画风", order: 2, body: "2D日漫剧场版" }),
	pre({ id: "style.realistic", name: "真人写实 (电影级大片)", category: "画风", group: "画风", order: 3, body: "电影级写实" }),
	// ── 出图预设方案（宫格故事板；同组互斥）──
	pre({ id: "preset.storyboard.4grid", name: "4宫格电影故事板", category: "预设方案", group: "宫格", order: 1, body: gridPresetBody(4, "2行2列") }),
	pre({ id: "preset.storyboard.6grid", name: "6宫格电影故事板", category: "预设方案", group: "宫格", order: 2, body: gridPresetBody(6, "3行2列") }),
	pre({ id: "preset.storyboard.9grid", name: "9宫格电影故事板", category: "预设方案", group: "宫格", order: 3, body: gridPresetBody(9, "3行3列") }),
];

const BUILTIN_PRESET_IDS = new Set(DEFAULT_PRESETS.map((d) => d.id));

let store: Store = loadJson<Store>(FILE, { version: 0, presets: [] });
{
	let changed = false;
	if (!store.deletedSeedIds) { store.deletedSeedIds = []; changed = true; }
	// ── 迁移：把 templates.json 里的平台预设类模板搬进本库（每启都跑，天然幂等——搬完模板库就没有了）。
	// 连管理端改过的正文/名称/启停一起带入；同 id 已在本库（不该发生）则保留本库版本。
	const migrated = extractPlatformPresetTemplates();
	for (const t of migrated) {
		if (store.presets.some((p) => p.id === t.id)) continue;
		store.presets.push({
			id: t.id,
			name: t.name,
			category: t.category || "预设方案",
			body: t.body || "",
			images: t.images || [],
			position: t.presetPosition === "suffix" ? "suffix" : "prefix",
			group: t.presetGroup || undefined,
			enabled: t.enabled !== false,
			order: t.order || 0,
			createdAt: t.createdAt,
			updatedAt: new Date().toISOString(),
		});
		changed = true;
	}
	// ── 补种缺失的内置预设（墓碑不复活；只加缺失、不动存量）──
	const tomb = new Set(store.deletedSeedIds);
	for (const def of DEFAULT_PRESETS) {
		if (tomb.has(def.id)) continue;
		if (!store.presets.some((p) => p.id === def.id)) { store.presets.push(def); changed = true; }
	}
	// ── 归一化（幂等）：画风预设补互斥组「画风」；宫格补互斥组「宫格」；宫格旧种子正文升级
	// （仅正文仍是旧种子原样才升级——管理端改过的一律不动，提示词正文以管理端为权威 §4）。
	for (const p of store.presets) {
		if (p.category === "画风" && !p.group) { p.group = "画风"; changed = true; }
		if (/^preset\.storyboard\.\d+grid$/.test(p.id) && !p.group) { p.group = "宫格"; changed = true; }
		const gp = GRID_PRESET_SPECS[p.id];
		if (gp) {
			const legacy = legacyGridPresetBody(gp.n, gp.layout);
			const legacies = gp.n === 9 ? [legacy, legacy.replace("数字1-9", "数字1-6")] : [legacy];
			if (legacies.includes(p.body)) { p.body = gridPresetBody(gp.n, gp.layout); p.updatedAt = new Date().toISOString(); changed = true; }
		}
	}
	if (changed) persist();
}

function persist(bump = true): void {
	if (bump) store.version += 1;
	saveJson(FILE, store);
}

export function presetsVersion(): number {
	return store.version;
}

export function listPresets(): PresetDef[] {
	return store.presets;
}

export function listEnabledPresets(): PresetDef[] {
	return store.presets.filter((p) => p.enabled);
}

export function getPresetDef(id: string): PresetDef | undefined {
	return store.presets.find((p) => p.id === id);
}

/** 清洗 autoAttach：只收合法类别键、去重；空数组=清除 */
export function normAutoAttach(v: unknown): SplitAttachCat[] | undefined {
	if (!Array.isArray(v)) return undefined;
	const valid = new Set<string>(SPLIT_ATTACH_CATS);
	const out = [...new Set(v.map((x) => String(x)).filter((x) => valid.has(x)))] as SplitAttachCat[];
	return out.length ? out : undefined;
}

export function createPreset(input: Partial<PresetDef> & Pick<PresetDef, "id" | "name">): PresetDef {
	const p = pre({
		category: "预设方案",
		body: "",
		...input,
		id: input.id.trim(),
		position: input.position === "suffix" ? "suffix" : "prefix",
		autoAttach: normAutoAttach(input.autoAttach),
	});
	const idx = store.presets.findIndex((x) => x.id === p.id);
	if (idx >= 0) store.presets[idx] = p;
	else store.presets.push(p);
	persist();
	return p;
}

export function updatePreset(id: string, patch: Partial<Omit<PresetDef, "id" | "createdAt">>): PresetDef | undefined {
	const p = getPresetDef(id);
	if (!p) return undefined;
	const next = { ...patch } as Record<string, unknown>;
	if ("position" in next) next.position = next.position === "suffix" ? "suffix" : "prefix";
	if ("autoAttach" in next) next.autoAttach = normAutoAttach(next.autoAttach);
	Object.assign(p, next, { updatedAt: new Date().toISOString() });
	persist();
	return p;
}

export function deletePreset(id: string): boolean {
	const before = store.presets.length;
	store.presets = store.presets.filter((p) => p.id !== id);
	if (store.presets.length !== before) {
		if (BUILTIN_PRESET_IDS.has(id)) {
			if (!store.deletedSeedIds) store.deletedSeedIds = [];
			if (!store.deletedSeedIds.includes(id)) store.deletedSeedIds.push(id);
		}
		persist();
		return true;
	}
	return false;
}
