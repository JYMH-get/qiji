import { describe, expect, it } from "vitest";
import {
	RTC_ACTION_DEFS,
	RTC_KEY_GROUPS,
	comboFromEvent,
	comboOwner,
	comboTable,
	effectiveKeys,
	formatCombo,
	isValidCombo,
	normalizeKeymapOverrides,
	resolveRtcShortcut,
	setRtcShortcutsSuspended,
	shouldIgnoreKeyTarget,
	splitCombo,
	type RtcKeymapOverrides,
} from "./rtcKeymap";

describe("rtcKeymap shouldIgnoreKeyTarget", () => {
	it("输入框/文本域/下拉/可编辑区：一律不劫持", () => {
		for (const tag of ["INPUT", "TEXTAREA", "SELECT"]) {
			expect(shouldIgnoreKeyTarget({ tagName: tag }, "Delete")).toBe(true);
			expect(shouldIgnoreKeyTarget({ tagName: tag }, " ")).toBe(true);
		}
		expect(shouldIgnoreKeyTarget({ tagName: "DIV", isContentEditable: true }, "Delete")).toBe(true);
	});

	it("按钮/链接只放行空格（它自己的激活键），其余键照常劫持", () => {
		expect(shouldIgnoreKeyTarget({ tagName: "BUTTON" }, " ")).toBe(true);
		expect(shouldIgnoreKeyTarget({ tagName: "BUTTON" }, "Delete")).toBe(false);
		expect(shouldIgnoreKeyTarget({ tagName: "A" }, " ")).toBe(true);
	});

	it("普通元素 / 无目标：不跳过", () => {
		expect(shouldIgnoreKeyTarget({ tagName: "DIV" }, " ")).toBe(false);
		expect(shouldIgnoreKeyTarget(null, " ")).toBe(false);
		expect(shouldIgnoreKeyTarget(undefined, "Delete")).toBe(false);
	});
});

describe("rtcKeymap comboFromEvent（组合键规范）", () => {
	it("字母：大写归一 + 显式修饰键（Ctrl/Alt/Shift 顺序恒定；Meta 归一为 Ctrl）", () => {
		expect(comboFromEvent({ key: "z", ctrlKey: true })).toBe("Ctrl+Z");
		expect(comboFromEvent({ key: "Z", metaKey: true })).toBe("Ctrl+Z");
		expect(comboFromEvent({ key: "Z", ctrlKey: true, shiftKey: true })).toBe("Ctrl+Shift+Z");
		expect(comboFromEvent({ key: "m", altKey: true })).toBe("Alt+M");
		expect(comboFromEvent({ key: "b" })).toBe("B");
	});

	it("符号：字符本身编码 Shift（Shift+= 产出的 '+' 与数字键盘 '+' 同组合）", () => {
		expect(comboFromEvent({ key: "+", shiftKey: true })).toBe("+");
		expect(comboFromEvent({ key: "+" })).toBe("+");
		expect(comboFromEvent({ key: "_", shiftKey: true })).toBe("_");
		expect(comboFromEvent({ key: "[" })).toBe("[");
	});

	it("命名键：Space 归一 + 修饰键全带；纯修饰键返回 null（录制时表示还在等主键）", () => {
		expect(comboFromEvent({ key: " " })).toBe("Space");
		expect(comboFromEvent({ key: "Spacebar" })).toBe("Space");
		expect(comboFromEvent({ key: "Delete", shiftKey: true })).toBe("Shift+Delete");
		expect(comboFromEvent({ key: "ArrowLeft", shiftKey: true })).toBe("Shift+ArrowLeft");
		expect(comboFromEvent({ key: "Control", ctrlKey: true })).toBeNull();
		expect(comboFromEvent({ key: "Shift", shiftKey: true })).toBeNull();
	});
});

describe("rtcKeymap splitCombo / isValidCombo / formatCombo", () => {
	it("拆解与校验：主键为 '+' 的组合单独处理；残串/未知修饰键判非法", () => {
		expect(splitCombo("Ctrl+Shift+Z")).toEqual({ mods: ["Ctrl", "Shift"], main: "Z" });
		expect(splitCombo("+")).toEqual({ mods: [], main: "+" });
		expect(splitCombo("Ctrl++")).toEqual({ mods: ["Ctrl"], main: "+" });
		expect(splitCombo("Ctrl+")).toBeNull();
		expect(splitCombo("Foo+Z")).toBeNull();
		expect(isValidCombo("Ctrl+K")).toBe(true);
		expect(isValidCombo("[")).toBe(true);
		expect(isValidCombo("")).toBe(false);
		expect(isValidCombo(42)).toBe(false);
	});

	it("展示文本：Space→空格、方向键→箭头，修饰键段原样", () => {
		expect(formatCombo("Space")).toBe("空格");
		expect(formatCombo("Shift+ArrowLeft")).toBe("Shift+←");
		expect(formatCombo("Ctrl+Shift+S")).toBe("Ctrl+Shift+S");
	});
});

describe("rtcKeymap 默认键位定稿（第238轮）", () => {
	const k = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) =>
		resolveRtcShortcut({ key, ...mods });

	it("分割=B / Ctrl+K；⚠ S 与 Ctrl+B 已从分割解绑；批量分割=Ctrl+B", () => {
		expect(k("b")).toBe("split");
		expect(k("B")).toBe("split");
		expect(k("k", { ctrlKey: true })).toBe("split");
		expect(k("s")).toBeNull(); // S 解绑
		expect(k("b", { ctrlKey: true })).toBe("splitAll"); // Ctrl+B 改批量分割
		expect(k("s", { ctrlKey: true })).toBeNull(); // Ctrl+S 保存不抢
	});

	it("向左/右全选 [ ]；向左/右裁剪 Q W；上/下一分割点 ↑ ↓", () => {
		expect(k("[")).toBe("selectLeft");
		expect(k("]")).toBe("selectRight");
		expect(k("q")).toBe("trimLeft");
		expect(k("w")).toBe("trimRight");
		expect(k("ArrowUp")).toBe("prevCut");
		expect(k("ArrowDown")).toBe("nextCut");
	});

	it("时间轴大幅移动 + / −（=/_ 天然同组合）", () => {
		expect(k("+", { shiftKey: true })).toBe("bigStepForward"); // Shift+= 的产出
		expect(k("+")).toBe("bigStepForward"); // 数字键盘 +
		expect(k("=")).toBe("bigStepForward"); // 不按 Shift 的 = 键
		expect(k("-")).toBe("bigStepBack");
		expect(k("_", { shiftKey: true })).toBe("bigStepBack");
	});

	it("镜像 F / 旋转 R / 分离音频 Ctrl+Shift+S / 组合 Ctrl+G / 解组 Ctrl+Shift+G", () => {
		expect(k("f")).toBe("mirror");
		expect(k("r")).toBe("rotate");
		expect(k("S", { ctrlKey: true, shiftKey: true })).toBe("separateAudio");
		expect(k("g", { ctrlKey: true })).toBe("group");
		expect(k("G", { ctrlKey: true, shiftKey: true })).toBe("ungroup");
	});

	it("复制/粘贴属性 Ctrl+Shift+C / Ctrl+Shift+V（与普通复制粘贴并存）", () => {
		expect(k("C", { ctrlKey: true, shiftKey: true })).toBe("copyAttrs");
		expect(k("V", { ctrlKey: true, shiftKey: true })).toBe("pasteAttrs");
		expect(k("c", { ctrlKey: true })).toBe("copy");
		expect(k("v", { ctrlKey: true })).toBe("paste");
	});

	it("既有键保持：撤销重做/剪切/副本/删除/波纹删/走带/空格", () => {
		expect(k("z", { ctrlKey: true })).toBe("undo");
		expect(k("z", { ctrlKey: true, shiftKey: true })).toBe("redo");
		expect(k("y", { ctrlKey: true })).toBe("redo");
		expect(k("x", { ctrlKey: true })).toBe("cut");
		expect(k("d", { ctrlKey: true })).toBe("duplicate");
		expect(k("Delete")).toBe("delete");
		expect(k("Backspace")).toBe("delete");
		expect(k("Delete", { shiftKey: true })).toBe("rippleDelete");
		expect(k(" ")).toBe("playPause");
		expect(k("ArrowLeft")).toBe("stepBack");
		expect(k("ArrowRight", { shiftKey: true })).toBe("jumpForward");
		expect(k("Home")).toBe("gotoStart");
		expect(k("End")).toBe("gotoEnd");
	});

	it("未绑定的组合一律 null 放行（含未占用的 Alt 组合——机制为后续批次留好）", () => {
		expect(k("m", { altKey: true })).toBe("markerAlt"); // 集成轮起 Alt+M=添加异色标记
		expect(k("j", { altKey: true })).toBeNull(); // 未占用的 Alt 组合照常放行
		expect(k("g", { altKey: true })).toBe("compound"); // 集成轮起 Alt+G=新建复合片段
		expect(k("q", { ctrlKey: true })).toBeNull();
		expect(k("F5")).toBeNull();
		expect(k("z", { ctrlKey: true, altKey: true })).toBeNull(); // Ctrl+Alt+Z ≠ Ctrl+Z
	});
});

describe("rtcKeymap 覆盖层与生效表", () => {
	it("覆盖层整组替换默认；未覆盖的动作保持默认", () => {
		const o: RtcKeymapOverrides = { split: ["S"] };
		const table = comboTable(effectiveKeys(o));
		expect(resolveRtcShortcut({ key: "s" }, table)).toBe("split");
		expect(resolveRtcShortcut({ key: "b" }, table)).toBeNull(); // B 被整组替换掉
		expect(resolveRtcShortcut({ key: "k", ctrlKey: true }, table)).toBeNull();
		expect(resolveRtcShortcut({ key: "Delete" }, table)).toBe("delete"); // 未覆盖：默认仍在
	});

	it("空数组覆盖=解绑该动作", () => {
		const table = comboTable(effectiveKeys({ playPause: [] }));
		expect(resolveRtcShortcut({ key: " " }, table)).toBeNull();
	});

	it("同组合被两个动作声明时先定义者生效（解析确定性）", () => {
		const table = comboTable(effectiveKeys({ rotate: ["F"] })); // 与 mirror 默认的 F 撞
		expect(table.get("F")).toBe("mirror"); // mirror 定义在前
	});

	it("comboOwner 找到当前绑定方（排除自身）", () => {
		const eff = effectiveKeys({});
		expect(comboOwner(eff, "F")).toBe("mirror");
		expect(comboOwner(eff, "F", "mirror")).toBeNull();
		expect(comboOwner(eff, "Ctrl+B")).toBe("splitAll");
		expect(comboOwner(eff, "Alt+M")).toBe("markerAlt"); // 集成轮起已绑定
		expect(comboOwner(eff, "Alt+J")).toBeNull();
	});

	it("normalizeKeymapOverrides：未知动作/坏组合/非数组全部剔除", () => {
		const raw = {
			split: ["S", "Ctrl+", 42, "S"], // 残串与非串剔除、去重
			nosuch: ["A"], // 未知动作
			mirror: "F", // 非数组
			playPause: [],
		};
		expect(normalizeKeymapOverrides(raw)).toEqual({ split: ["S"], playPause: [] });
		expect(normalizeKeymapOverrides(null)).toEqual({});
		expect(normalizeKeymapOverrides([1, 2])).toEqual({});
	});

	it("停用标记：suspended 期间一律返回 null（设置弹窗录制态防误触发）", () => {
		setRtcShortcutsSuspended(true);
		try {
			expect(resolveRtcShortcut({ key: "b" })).toBeNull();
			expect(resolveRtcShortcut({ key: "Delete" })).toBeNull();
		} finally {
			setRtcShortcutsSuspended(false);
		}
		expect(resolveRtcShortcut({ key: "b" })).toBe("split");
	});
});

describe("rtcKeymap 定义表自检（设置界面数据源）", () => {
	it("三分组齐备且每个动作归属其一；默认键位全部形状合法且无跨动作重复", () => {
		expect(RTC_KEY_GROUPS).toEqual(["时间线", "播放器", "基础"]);
		const seen = new Set<string>();
		for (const def of RTC_ACTION_DEFS) {
			expect(RTC_KEY_GROUPS).toContain(def.group);
			expect(def.label.length).toBeGreaterThan(0);
			for (const combo of def.defaultKeys) {
				expect(isValidCombo(combo)).toBe(true);
				expect(seen.has(combo)).toBe(false); // 默认表内不允许键位互撞
				seen.add(combo);
			}
		}
	});
});
