/**
 * rtcKeymap —— 实时剪辑快捷键的**数据驱动两层表**（纯函数为主，可单测；不碰 DOM）。
 *
 * 分层（第238轮定稿，替代旧的 switch 硬编码）：
 *   ① 动作定义表 RTC_ACTION_DEFS：{id, label, group, defaultKeys[]} —— 一动作可多绑；
 *   ② 用户覆盖层（localStorage `Qiji:rtcKeymap`，持久化在 settings/rtcKeymapStore）：
 *      按动作 id 覆盖键位数组（存在即整组替换，可为空数组=解绑）。
 *   生效表 = 定义表 ⊕ 覆盖层（effectiveKeys → comboTable）；
 *   解析（resolveRtcShortcut）与设置界面的键位展示**都从生效表派生**——键位与说明单一来源。
 *
 * 组合键规范（comboFromEvent，录制与解析共用同一把尺）：
 *   - 修饰键顺序恒为 Ctrl → Alt → Shift（Meta 归一为 Ctrl，Mac 习惯不另立记法）；
 *   - 字母一律大写并**显式带 Shift**（"Shift+S" 与 "S" 是两个组合）；
 *   - 其它单字符（+ - = _ [ ] 等）**不带 Shift**——字符本身已编码按没按 Shift
 *     （Shift+= 产出 "+"，直接按 "+" 键也产出 "+"，两者天然同组合）；
 *   - 命名键（Space/Delete/方向键/Home/End…）带全部修饰键；" "/"Spacebar" 归一为 "Space"。
 *
 * ⚠ 旧规则「Alt 组合一律不接」改为「**未绑定的组合才放行**」——数据驱动下天然成立
 *   （Alt 组合不在生效表里就返回 null），后续批次要绑 Alt+M/Alt+G 只需往表里加。
 * ⚠ 弹窗录制期间快捷键须整体失效：setRtcShortcutsSuspended（RtcSettingsModal 开关时调用）。
 */

export type RtcShortcut =
	// 基础
	| "undo"
	| "redo"
	| "copy"
	| "cut"
	| "paste"
	| "duplicate"
	| "delete"
	| "copyAttrs"
	| "pasteAttrs"
	| "selectAll"
	// 时间线
	| "split"
	| "splitAll"
	| "rippleDelete"
	| "selectLeft"
	| "selectRight"
	| "trimLeft"
	| "trimRight"
	| "prevCut"
	| "nextCut"
	| "bigStepBack"
	| "bigStepForward"
	| "mirror"
	| "rotate"
	| "separateAudio"
	| "group"
	| "ungroup"
	// 集成轮：标记 / 定格 / 关键帧 / 倒放 / 裁剪 / 复合片段
	| "marker"
	| "markerAlt"
	| "prevMarker"
	| "nextMarker"
	| "freeze"
	| "keyframe"
	| "reverse"
	| "crop"
	| "compound"
	| "uncompound"
	| "toggleScriptTrack"
	// 播放器
	| "playPause"
	| "stepBack"
	| "stepForward"
	| "jumpBack"
	| "jumpForward"
	| "gotoStart"
	| "gotoEnd";

export type RtcKeyGroup = "基础" | "时间线" | "播放器";

export interface RtcKeyActionDef {
	id: RtcShortcut;
	label: string;
	group: RtcKeyGroup;
	/** 默认键位（组合键规范串，可多绑）；空数组=默认无键（仅菜单/按钮触发） */
	defaultKeys: string[];
}

/**
 * 动作定义表（⚠ 键位定稿，第238轮）：
 *   分割=B（保留 Ctrl+K 别名；**S 与 Ctrl+B 已从分割解绑**）· 批量分割=Ctrl+B ·
 *   向左/右全选=[ / ] · 向左/右裁剪=Q / W · 上/下一分割点=↑ / ↓ ·
 *   时间轴大幅移动=+ / −（= 与 _ 天然同组合，见 comboFromEvent 符号规范）·
 *   镜像=F · 旋转=R · 分离音频=Ctrl+Shift+S · 组合/解组=Ctrl+G / Ctrl+Shift+G ·
 *   复制/粘贴属性=Ctrl+Shift+C / Ctrl+Shift+V；其余沿用既有键。
 * 数组顺序 = 冲突裁决顺序（同一组合被多动作声明时，先定义者生效）+ 设置界面展示顺序。
 */
export const RTC_ACTION_DEFS: RtcKeyActionDef[] = [
	// ── 基础 ──
	{ id: "undo", label: "撤销", group: "基础", defaultKeys: ["Ctrl+Z"] },
	{ id: "redo", label: "重做", group: "基础", defaultKeys: ["Ctrl+Shift+Z", "Ctrl+Y"] },
	{ id: "copy", label: "复制", group: "基础", defaultKeys: ["Ctrl+C"] },
	{ id: "cut", label: "剪切", group: "基础", defaultKeys: ["Ctrl+X"] },
	{ id: "paste", label: "粘贴", group: "基础", defaultKeys: ["Ctrl+V"] },
	{ id: "duplicate", label: "创建副本", group: "基础", defaultKeys: ["Ctrl+D"] },
	{ id: "delete", label: "删除", group: "基础", defaultKeys: ["Delete", "Backspace"] },
	{ id: "copyAttrs", label: "复制属性", group: "基础", defaultKeys: ["Ctrl+Shift+C"] },
	{ id: "selectAll", label: "全选片段（注意力在时间轴时）", group: "基础", defaultKeys: ["Ctrl+A"] },
	{ id: "pasteAttrs", label: "粘贴属性", group: "基础", defaultKeys: ["Ctrl+Shift+V"] },
	// ── 时间线 ──
	{ id: "split", label: "分割", group: "时间线", defaultKeys: ["B", "Ctrl+K"] },
	{ id: "splitAll", label: "批量分割（全部轨道）", group: "时间线", defaultKeys: ["Ctrl+B"] },
	{ id: "rippleDelete", label: "波纹删除", group: "时间线", defaultKeys: ["Shift+Delete", "Shift+Backspace"] },
	{ id: "selectLeft", label: "向左全选", group: "时间线", defaultKeys: ["["] },
	{ id: "selectRight", label: "向右全选", group: "时间线", defaultKeys: ["]"] },
	{ id: "trimLeft", label: "向左裁剪（左缘裁到播放头）", group: "时间线", defaultKeys: ["Q"] },
	{ id: "trimRight", label: "向右裁剪（右缘裁到播放头）", group: "时间线", defaultKeys: ["W"] },
	{ id: "prevCut", label: "上一分割点", group: "时间线", defaultKeys: ["ArrowUp"] },
	{ id: "nextCut", label: "下一分割点", group: "时间线", defaultKeys: ["ArrowDown"] },
	{ id: "bigStepBack", label: "时间轴大幅左移", group: "时间线", defaultKeys: ["-", "_"] },
	{ id: "bigStepForward", label: "时间轴大幅右移", group: "时间线", defaultKeys: ["+", "="] },
	{ id: "mirror", label: "镜像（水平翻转）", group: "时间线", defaultKeys: ["F"] },
	{ id: "rotate", label: "旋转 90°", group: "时间线", defaultKeys: ["R"] },
	{ id: "separateAudio", label: "分离音频", group: "时间线", defaultKeys: ["Ctrl+Shift+S"] },
	{ id: "group", label: "创建组合", group: "时间线", defaultKeys: ["Ctrl+G"] },
	{ id: "ungroup", label: "解除组合", group: "时间线", defaultKeys: ["Ctrl+Shift+G"] },
	// ── 集成轮：批2/3/4 功能的键位（剪映对齐） ──
	{ id: "marker", label: "添加标记", group: "时间线", defaultKeys: ["M"] },
	{ id: "markerAlt", label: "添加异色标记", group: "时间线", defaultKeys: ["Alt+M"] },
	{ id: "nextMarker", label: "下一标记", group: "时间线", defaultKeys: ["Shift+M"] },
	{ id: "prevMarker", label: "上一标记", group: "时间线", defaultKeys: ["Alt+Shift+M"] },
	{ id: "freeze", label: "定格", group: "时间线", defaultKeys: ["G"] },
	{ id: "keyframe", label: "添加关键帧（位置/缩放/旋转）", group: "时间线", defaultKeys: ["T"] },
	{ id: "reverse", label: "倒放（桌面版）", group: "时间线", defaultKeys: ["D"] },
	{ id: "crop", label: "裁剪画面", group: "时间线", defaultKeys: ["C"] },
	{ id: "compound", label: "新建复合片段", group: "时间线", defaultKeys: ["Alt+G"] },
	{ id: "uncompound", label: "解除复合片段", group: "时间线", defaultKeys: ["Alt+Shift+G"] },
	{ id: "toggleScriptTrack", label: "显示/隐藏原文（预览窗参考条）", group: "时间线", defaultKeys: ["O"] },
	// ── 播放器 ──
	{ id: "playPause", label: "播放 / 暂停", group: "播放器", defaultKeys: ["Space"] },
	{ id: "stepBack", label: "上一帧", group: "播放器", defaultKeys: ["ArrowLeft"] },
	{ id: "stepForward", label: "下一帧", group: "播放器", defaultKeys: ["ArrowRight"] },
	{ id: "jumpBack", label: "后退 1 秒", group: "播放器", defaultKeys: ["Shift+ArrowLeft"] },
	{ id: "jumpForward", label: "前进 1 秒", group: "播放器", defaultKeys: ["Shift+ArrowRight"] },
	{ id: "gotoStart", label: "跳到开头", group: "播放器", defaultKeys: ["Home"] },
	{ id: "gotoEnd", label: "跳到结尾", group: "播放器", defaultKeys: ["End"] },
];

export const RTC_KEY_GROUPS: RtcKeyGroup[] = ["时间线", "播放器", "基础"];

const DEF_BY_ID: ReadonlyMap<RtcShortcut, RtcKeyActionDef> = new Map(RTC_ACTION_DEFS.map((d) => [d.id, d]));

export function rtcActionDef(id: RtcShortcut): RtcKeyActionDef | undefined {
	return DEF_BY_ID.get(id);
}

/** 键事件里本解析层用得到的部分（便于单测直接喂字面量） */
export interface RtcKeyLike {
	key: string;
	ctrlKey?: boolean;
	metaKey?: boolean;
	shiftKey?: boolean;
	altKey?: boolean;
}

/* ────────────────────────── 组合键规范 ────────────────────────── */

const MOD_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

/** 键事件 → 规范组合串（纯修饰键返回 null——录制时表示「还在等主键」） */
export function comboFromEvent(e: RtcKeyLike): string | null {
	const key = e.key;
	if (!key || MOD_KEYS.has(key)) return null;
	let name: string;
	let includeShift = true;
	if (key === " " || key === "Spacebar") {
		name = "Space";
	} else if (key.length === 1) {
		if (/[a-z]/i.test(key)) {
			name = key.toUpperCase(); // 字母：大写 + 显式 Shift
		} else {
			name = key;
			includeShift = false; // 符号：字符本身已编码 Shift（"+"="Shift+=" 与数字键盘 "+" 同组合）
		}
	} else {
		name = key;
	}
	const mods: string[] = [];
	if (e.ctrlKey || e.metaKey) mods.push("Ctrl");
	if (e.altKey) mods.push("Alt");
	if (includeShift && e.shiftKey) mods.push("Shift");
	return [...mods, name].join("+");
}

/**
 * 拆组合串 → { 修饰键, 主键 }；形状不合法返回 null。
 * ⚠ 主键本身是 "+" 的组合（"+"、"Ctrl++"）要单独处理——朴素 split("+") 会把它拆成空串。
 */
export function splitCombo(combo: string): { mods: string[]; main: string } | null {
	if (typeof combo !== "string" || !combo) return null;
	let main: string;
	let rest: string;
	if (combo === "+") return { mods: [], main: "+" };
	if (combo.endsWith("++")) {
		main = "+";
		rest = combo.slice(0, -2);
	} else if (combo.endsWith("+")) {
		return null; // "Ctrl+" 残串
	} else {
		const idx = combo.lastIndexOf("+");
		main = idx < 0 ? combo : combo.slice(idx + 1);
		rest = idx < 0 ? "" : combo.slice(0, idx);
	}
	if (!main) return null;
	const mods = rest ? rest.split("+") : [];
	if (mods.some((m) => !["Ctrl", "Alt", "Shift"].includes(m))) return null;
	return { mods, main };
}

/** 组合串是否形状合法（覆盖层读盘校验用；不校验「是否可按出」——布局差异留给录制层保证） */
export function isValidCombo(combo: unknown): combo is string {
	return typeof combo === "string" && splitCombo(combo) != null;
}

const COMBO_NAME_MAP: Record<string, string> = {
	Space: "空格",
	ArrowLeft: "←",
	ArrowRight: "→",
	ArrowUp: "↑",
	ArrowDown: "↓",
	Delete: "Del",
	Backspace: "⌫",
};

/** 组合串 → 界面展示文本（Space→空格、方向键→箭头；修饰键段保持 Ctrl/Alt/Shift 原样） */
export function formatCombo(combo: string): string {
	const parsed = splitCombo(combo);
	if (!parsed) return combo;
	const main = COMBO_NAME_MAP[parsed.main] ?? parsed.main;
	return [...parsed.mods, main].join("+");
}

/* ────────────────────────── 覆盖层与生效表 ────────────────────────── */

/** 用户覆盖层：动作 id → 键位数组（存在即整组替换默认；空数组=解绑该动作） */
export type RtcKeymapOverrides = Partial<Record<RtcShortcut, string[]>>;

/** 读盘归一：只认已知动作 id + 形状合法的组合串（去重）；坏值整体丢弃回空覆盖 */
export function normalizeKeymapOverrides(raw: unknown): RtcKeymapOverrides {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: RtcKeymapOverrides = {};
	for (const [id, keys] of Object.entries(raw as Record<string, unknown>)) {
		if (!DEF_BY_ID.has(id as RtcShortcut)) continue;
		if (!Array.isArray(keys)) continue;
		const cleaned = [...new Set(keys.filter(isValidCombo))];
		out[id as RtcShortcut] = cleaned;
	}
	return out;
}

/** 生效键位表：覆盖层存在的动作用覆盖值，其余用默认值 */
export function effectiveKeys(overrides: RtcKeymapOverrides): Map<RtcShortcut, string[]> {
	const map = new Map<RtcShortcut, string[]>();
	for (const def of RTC_ACTION_DEFS) {
		map.set(def.id, overrides[def.id] ?? def.defaultKeys);
	}
	return map;
}

/** 生效表 → 组合串反查表（同组合被多动作声明时**先定义者生效**，后声明者静默失效） */
export function comboTable(effective: Map<RtcShortcut, string[]>): Map<string, RtcShortcut> {
	const table = new Map<string, RtcShortcut>();
	for (const def of RTC_ACTION_DEFS) {
		for (const combo of effective.get(def.id) ?? []) {
			if (!table.has(combo)) table.set(combo, def.id);
		}
	}
	return table;
}

/** 组合串当前绑在哪个动作上（排除 exceptId；录制冲突检测用）；无主返回 null */
export function comboOwner(
	effective: Map<RtcShortcut, string[]>,
	combo: string,
	exceptId?: RtcShortcut,
): RtcShortcut | null {
	for (const def of RTC_ACTION_DEFS) {
		if (def.id === exceptId) continue;
		if ((effective.get(def.id) ?? []).includes(combo)) return def.id;
	}
	return null;
}

/* ────────────────────────── 模块运行态（解析入口） ────────────────────────── */

/** 当前生效的组合表（settings/rtcKeymapStore 初始化与每次改键后经 setActiveKeymapOverrides 推入） */
let activeTable: Map<string, RtcShortcut> = comboTable(effectiveKeys({}));
/** 快捷键整体停用标记（设置弹窗打开=true，防录制键位时误触发时间轴动作） */
let suspended = false;

/** 覆盖层落地为解析用的生效表（store 侧唯一推入口；keymap 不反向依赖 store，防循环引用） */
export function setActiveKeymapOverrides(overrides: RtcKeymapOverrides): void {
	activeTable = comboTable(effectiveKeys(overrides));
}

/** 设置弹窗开关时调用：true=全部快捷键失效（resolveRtcShortcut 一律返回 null） */
export function setRtcShortcutsSuspended(v: boolean): void {
	suspended = v;
}

/**
 * 键事件 → 动作。认不出（未绑定的组合，含全部未占用的 Alt 组合）返回 null 放行给浏览器/系统。
 * table 参数仅供单测注入；运行时走模块级生效表 + 停用标记。
 */
export function resolveRtcShortcut(e: RtcKeyLike, table?: Map<string, RtcShortcut>): RtcShortcut | null {
	if (!table && suspended) return null;
	const combo = comboFromEvent(e);
	if (!combo) return null;
	return (table ?? activeTable).get(combo) ?? null;
}

/* ────────────────────────── 焦点守卫（与旧版一致） ────────────────────────── */

/** 键盘焦点落在这些控件里时**一律不劫持**（时间码输入、提示词框、轨道重命名都在同一页面） */
const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
/** 这些控件自身要吃空格（按钮/链接的激活键）——只放行空格，其余键照常 */
const SPACE_OWNING_TAGS = new Set(["BUTTON", "A", "SUMMARY"]);

/** 事件目标是否应当跳过（编辑态控件全跳；按钮类只跳空格） */
export function shouldIgnoreKeyTarget(
	target: { tagName?: string | null; isContentEditable?: boolean } | null | undefined,
	key: string,
): boolean {
	if (!target) return false;
	if (target.isContentEditable) return true;
	const tag = (target.tagName || "").toUpperCase();
	if (EDITABLE_TAGS.has(tag)) return true;
	return key === " " && SPACE_OWNING_TAGS.has(tag);
}
