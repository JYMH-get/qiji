/**
 * presetSchemes — 预设（提示词「预设胶囊」）。
 *
 * 预设 = 服务端**独立预设库**（第174轮从提示词模板数据层拆分，catalog.presets 全文下发）：
 *  画风 / 出图预设方案 / 资产拆分前后缀 都是预设——客户端在提示词框里选中一个预设即插入一枚
 *  **预设胶囊** `【预设:id】`（显示为彩色 pill，底层是这段标记文本）；**提交时**由 resolvePresets
 *  把标记替换成服务端下发的完整预设正文（正文权威在服务端，客户端只持有 id + catalog 副本）。
 *  旧服务端（catalog 无 presets 字段）回退旧口径：读模板清单里 category==="预设方案" 的条目。
 *  autoAttach（第174轮）：预设声明的「资产拆分自动附加范围」——见 splitPresetAttach.ts。
 */
import { useCatalogStore } from "@/store/catalogStore";
import { useSettingsStore } from "@/store/settingsStore";

/** 预设方案分类名（旧服务端回退口径=模板分类；新服务端=预设库分组名） */
export const PRESET_CATEGORY = "预设方案";

/** 预设胶囊在提示词里的标记文本：`【预设:<模板id>】`（id 限 ASCII，可含点/横线/下划线）。
 *  与 @ImageN（@ 开头）、@[port]（@[ ）、{{变量}}、【素材图例】（【素材…）均不冲突。 */
export const PRESET_TAG_RE = /【预设:([A-Za-z0-9._-]+)】/g;
export const presetTag = (id: string): string => `【预设:${id}】`;

/** 预设的默认插入位置：前缀（用户输入前）/ 后缀（用户输入后） */
export type PresetPosition = "prefix" | "suffix";

export interface PresetOption {
	id: string;
	name: string;
}

export interface PresetScheme extends PresetOption {
	body: string;
	/** 互斥组：同一非空组内的预设不能同时出现在一段提示词里（插入其一即移除同组其它）。宫格预设同属 GRID_GROUP。 */
	group?: string;
	/** 默认插入位置（前缀/后缀）；缺省=前缀 */
	position?: PresetPosition;
	/** 分组（"画风"/"预设方案"/…；本地自定义预设无分组） */
	category?: string;
	/** 资产拆分自动附加范围（characters/crowds/scenes/organisms/items）；见 splitPresetAttach */
	autoAttach?: string[];
}

/** 内置宫格预设的互斥组名（4/6/9 宫格同属一组，只能存在一个）；用户自定义预设填「宫格」即与其互斥 */
export const GRID_GROUP = "宫格";
/** 判定服务端预设是否为宫格预设（id 形如 preset.storyboard.4grid），并从中取宫格数 */
const GRID_ID_RE = /^preset\.storyboard\.(\d+)grid$/;

/**
 * 当前可用预设 = 服务端预设库（catalog.presets，全部分组含画风——画风胶囊也要能展开）
 * + 用户自定义预设（本地设置），均含完整正文 body。
 * 旧服务端（无 presets 字段）回退读模板清单里的「预设方案」分类（旧口径，画风不含在内）。
 */
export function listPresetSchemes(): PresetScheme[] {
	const cat = useCatalogStore.getState();
	const serverPresets = cat.presets();
	const server: PresetScheme[] = serverPresets.length
		? serverPresets.map((p) => ({
			id: p.id,
			name: p.name,
			body: p.body ?? "",
			// 互斥组优先用管理端配置；画风/宫格无配置时按分组/id 兜底
			group: p.group?.trim() || (p.category === "画风" ? "画风" : GRID_ID_RE.test(p.id) ? GRID_GROUP : undefined),
			position: normPos(p.position),
			category: p.category,
			autoAttach: p.autoAttach,
		}))
		: cat
			.templatesByCategory(PRESET_CATEGORY)
			// 旧服务端回退：互斥组优先 presetGroup；内置 4/6/9 宫格无配置时按 id 归「宫格」组。
			.map((t) => ({ id: t.id, name: t.name, body: t.body ?? t.bodyPreview ?? "", group: t.presetGroup?.trim() || (GRID_ID_RE.test(t.id) ? GRID_GROUP : undefined), position: normPos(t.presetPosition), category: t.category }));
	const custom = useSettingsStore.getState().customPresets.map((p) => ({ id: p.id, name: p.name, body: p.body, group: p.group?.trim() || undefined, position: normPos(p.position) }));
	return [...server, ...custom].filter((p) => p.body.trim().length > 0);
}

/** 归一化位置：仅接受 "suffix"，其余（含缺省）都是 "prefix" */
function normPos(v: unknown): PresetPosition {
	return v === "suffix" ? "suffix" : "prefix";
}

/** 按 id 取预设默认插入位置（前缀/后缀；缺省=前缀） */
export function presetPosition(id: string): PresetPosition {
	return listPresetSchemes().find((p) => p.id === id)?.position ?? "prefix";
}

/** 按 id 取预设正文（供双击胶囊就地展开为可编辑正文） */
export function presetBody(id: string): string | undefined {
	return listPresetSchemes().find((p) => p.id === id)?.body;
}

/** 按 id 取互斥组（空=无互斥）；供插入胶囊时移除同组旧胶囊 */
export function presetGroup(id: string): string | undefined {
	return listPresetSchemes().find((p) => p.id === id)?.group || undefined;
}

/** 数「同源提示词」里的镜头数：匹配「第X镜/第X个镜头」或「镜头X」（X=中文数字或阿拉伯数字），去重取个数；数不出→0 */
export function countUnifiedShots(text: string): number {
	const matches = (text || "").match(/第\s*[一二三四五六七八九十百零两\d]+\s*(?:个)?镜(?:头)?|镜头\s*[一二三四五六七八九十\d]+/g);
	if (!matches) return 0;
	return new Set(matches.map((s) => s.replace(/\s/g, ""))).size;
}

/** 提示词里是否已含宫格指令（含「N宫格」）——用户手动插过预设时不再自动补丁 */
export function hasGridInstruction(text: string): boolean {
	return /\d\s*宫格/.test(text || "");
}

/** 按镜头数选合适的宫格预设 id（4→4宫格、5-6→6宫格、更多→9宫格；不足 4 按 4 宫格），仅返回 catalog 里实际存在的；无则 undefined */
export function gridPresetForShotCount(n: number): string | undefined {
	const want = n <= 4 ? 4 : n <= 6 ? 6 : 9;
	const grids = listPresetSchemes().filter((p) => GRID_ID_RE.test(p.id));
	const exact = grids.find((p) => Number(GRID_ID_RE.exec(p.id)![1]) === want);
	if (exact) return exact.id;
	// 想要的档位不存在 → 取存在的宫格里最接近 want 的
	if (!grids.length) return undefined;
	return grids.sort((a, b) => Math.abs(Number(GRID_ID_RE.exec(a.id)![1]) - want) - Math.abs(Number(GRID_ID_RE.exec(b.id)![1]) - want))[0].id;
}

/** 供选择器/胶囊显示用（不含正文） */
export function listPresetOptions(): PresetOption[] {
	return listPresetSchemes().map((p) => ({ id: p.id, name: p.name }));
}

/** id → 显示名（供富文本编辑器把 【预设:id】 渲染成带名字的 pill） */
export function presetNameMap(): Map<string, string> {
	return new Map(listPresetSchemes().map((p) => [p.id, p.name]));
}

/**
 * 提交前把提示词里的预设胶囊 `【预设:id】` 展开成完整预设正文（服务端下发）。
 * 未知预设 id（catalog 里没有）保持原样，不误删。
 */
export function resolvePresets(text: string): string {
	if (!text || text.indexOf("【预设:") < 0) return text;
	const bodyById = new Map(listPresetSchemes().map((p) => [p.id, p.body]));
	return text.replace(new RegExp(PRESET_TAG_RE.source, "g"), (m, id: string) => bodyById.get(id) ?? m);
}
