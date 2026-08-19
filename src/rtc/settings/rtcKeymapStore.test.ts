import { afterEach, describe, expect, it } from "vitest";
import { useRtcKeymapStore } from "./rtcKeymapStore";
import { resolveRtcShortcut } from "../timeline/rtcKeymap";

/* 模块级单例：每条用例后恢复默认，防状态串测（node 环境无 localStorage，持久化静默跳过） */
afterEach(() => {
	useRtcKeymapStore.getState().resetAll();
});

describe("rtcKeymapStore 录制与冲突改绑", () => {
	it("追加绑定（slot=null）：新键生效、默认键保留；解析层即时跟随", () => {
		const r = useRtcKeymapStore.getState().recordKey("split", "Alt+B", null);
		expect(r.takenFrom).toBeNull();
		expect(resolveRtcShortcut({ key: "b", altKey: true })).toBe("split");
		expect(resolveRtcShortcut({ key: "b" })).toBe("split"); // 默认 B 仍在
	});

	it("替换槽位（slot=0）：旧绑定被换掉", () => {
		useRtcKeymapStore.getState().recordKey("split", "S", 0); // 默认 ["B","Ctrl+K"] → ["S","Ctrl+K"]
		expect(resolveRtcShortcut({ key: "s" })).toBe("split");
		expect(resolveRtcShortcut({ key: "b" })).toBeNull();
		expect(resolveRtcShortcut({ key: "k", ctrlKey: true })).toBe("split");
	});

	it("冲突改绑：组合已在别的动作上 → 自动解除并返回 takenFrom（绝不留双绑定）", () => {
		const r = useRtcKeymapStore.getState().recordKey("rotate", "F", null); // F 默认=mirror
		expect(r.takenFrom).toBe("mirror");
		expect(resolveRtcShortcut({ key: "f" })).toBe("rotate");
		// mirror 的 F 已被摘除（覆盖层里留了空数组）
		expect(useRtcKeymapStore.getState().overrides.mirror).toEqual([]);
	});

	it("同动作重复录同键 no-op；removeKey 摘除单个绑定", () => {
		const r = useRtcKeymapStore.getState().recordKey("split", "B", null);
		expect(r.takenFrom).toBeNull();
		expect(useRtcKeymapStore.getState().overrides.split).toBeUndefined(); // 与默认一致=覆盖层不落
		useRtcKeymapStore.getState().removeKey("split", "B");
		expect(resolveRtcShortcut({ key: "b" })).toBeNull();
		expect(resolveRtcShortcut({ key: "k", ctrlKey: true })).toBe("split");
	});

	it("resetAction 恢复单个动作；resetAll 全部恢复且覆盖层清空", () => {
		useRtcKeymapStore.getState().recordKey("split", "S", 0);
		useRtcKeymapStore.getState().recordKey("rotate", "F", null);
		useRtcKeymapStore.getState().resetAction("split");
		expect(resolveRtcShortcut({ key: "b" })).toBe("split");
		expect(resolveRtcShortcut({ key: "f" })).toBe("rotate"); // rotate 的覆盖还在
		useRtcKeymapStore.getState().resetAll();
		expect(useRtcKeymapStore.getState().overrides).toEqual({});
		expect(resolveRtcShortcut({ key: "f" })).toBe("mirror");
	});
});
