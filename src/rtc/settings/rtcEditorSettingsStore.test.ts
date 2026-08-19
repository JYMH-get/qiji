import { describe, expect, it } from "vitest";
import {
	DEFAULT_EDITOR_SETTINGS,
	imageDefaultUsFromSettings,
	normalizeEditorSettings,
	useRtcEditorSettingsStore,
} from "./rtcEditorSettingsStore";

describe("rtcEditorSettingsStore normalizeEditorSettings", () => {
	it("缺省/坏值/非对象一律回默认（10 / 10 / 3.0）", () => {
		expect(normalizeEditorSettings(null)).toEqual(DEFAULT_EDITOR_SETTINGS);
		expect(normalizeEditorSettings("junk")).toEqual(DEFAULT_EDITOR_SETTINGS);
		expect(normalizeEditorSettings({ bigStepFrames: "abc", bigValueStep: NaN, imageDefaultSec: null })).toEqual(
			DEFAULT_EDITOR_SETTINGS,
		);
	});

	it("越界夹取：帧数 1–600 取整、数值步长 1–100、图片时长 0.2–120 保留 1 位小数", () => {
		expect(normalizeEditorSettings({ bigStepFrames: 0, bigValueStep: 9999, imageDefaultSec: 0.01 })).toEqual({
			bigStepFrames: 1,
			bigValueStep: 100,
			imageDefaultSec: 0.2,
		});
		expect(normalizeEditorSettings({ bigStepFrames: 24.6, imageDefaultSec: 4.567 })).toEqual({
			bigStepFrames: 25,
			bigValueStep: 10,
			imageDefaultSec: 4.6,
		});
		expect(normalizeEditorSettings({ imageDefaultSec: 999 }).imageDefaultSec).toBe(120);
	});

	it("数字串容忍（localStorage 手改场景）；未知键忽略", () => {
		expect(normalizeEditorSettings({ bigStepFrames: "30", junkKey: 1 })).toEqual({
			...DEFAULT_EDITOR_SETTINGS,
			bigStepFrames: 30,
		});
	});
});

describe("rtcEditorSettingsStore 运行时", () => {
	it("patch 归一后落库；imageDefaultUsFromSettings 换算微秒；reset 回默认", () => {
		const st = useRtcEditorSettingsStore.getState();
		st.patch({ imageDefaultSec: 5 });
		expect(useRtcEditorSettingsStore.getState().imageDefaultSec).toBe(5);
		expect(imageDefaultUsFromSettings()).toBe(5_000_000);
		st.patch({ bigStepFrames: -3 }); // 越界 → 夹到 1
		expect(useRtcEditorSettingsStore.getState().bigStepFrames).toBe(1);
		st.reset();
		expect(useRtcEditorSettingsStore.getState().imageDefaultSec).toBe(3);
		expect(imageDefaultUsFromSettings()).toBe(3_000_000); // 默认 3s 行为不变
	});
});
