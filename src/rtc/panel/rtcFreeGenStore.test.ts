import { describe, expect, it } from "vitest";
import { DRAFT_MAX, DRAFT_TTL_MS, sanitizeDraft, sanitizeDrafts, upsertDraft, type FreeGenDraftMap } from "./rtcFreeGenStore";

const NOW = 1_800_000_000_000;

describe("rtcFreeGenStore · 草稿清洗", () => {
	it("正常草稿原样收下（refs 归一 media，assetId/name 可选）", () => {
		const d = sanitizeDraft({ prompt: "一只猫", refs: [{ uri: "u1", assetId: "C1", name: "甲", media: "video" }], updatedAt: NOW }, NOW);
		expect(d).toEqual({ prompt: "一只猫", refs: [{ uri: "u1", media: "video", assetId: "C1", name: "甲" }], updatedAt: NOW });
	});

	it("⚠ 红线：base64/data: 素材一律丢弃（草稿绝不承载字节）", () => {
		const d = sanitizeDraft({ prompt: "p", refs: [{ uri: "data:image/png;base64,AAA" }, { uri: "u2" }] }, NOW);
		expect(d?.refs).toEqual([{ uri: "u2", media: "image" }]);
	});

	it("坏 media 值归一为 image；没有 uri 的整条丢掉", () => {
		const d = sanitizeDraft({ prompt: "p", refs: [{ uri: "u", media: "weird" }, { name: "无 uri" }] }, NOW);
		expect(d?.refs).toEqual([{ uri: "u", media: "image" }]);
	});

	it("空草稿（无提示词无素材无模型）不留", () => {
		expect(sanitizeDraft({ prompt: "", refs: [] }, NOW)).toBeNull();
		expect(sanitizeDraft(null, NOW)).toBeNull();
		expect(sanitizeDraft("x", NOW)).toBeNull();
	});

	it("只选了模型也算有效草稿（下次打开还记得用哪个模型）", () => {
		expect(sanitizeDraft({ modelKey: "m1" }, NOW)?.modelKey).toBe("m1");
	});
});

describe("rtcFreeGenStore · 整表清洗（TTL + 容量）", () => {
	it("超过保留期的草稿淘汰", () => {
		const map = sanitizeDrafts(
			{
				fresh: { prompt: "a", updatedAt: NOW - 1000 },
				stale: { prompt: "b", updatedAt: NOW - DRAFT_TTL_MS - 1 },
			},
			NOW,
		);
		expect(Object.keys(map)).toEqual(["fresh"]);
	});

	it("超容量时保留最新的 DRAFT_MAX 条", () => {
		const raw: Record<string, unknown> = {};
		for (let i = 0; i < DRAFT_MAX + 5; i++) raw[`seg-${i}`] = { prompt: `p${i}`, updatedAt: NOW - i };
		const map = sanitizeDrafts(raw, NOW);
		expect(Object.keys(map)).toHaveLength(DRAFT_MAX);
		expect(map["seg-0"]).toBeTruthy(); // 最新的留下
		expect(map[`seg-${DRAFT_MAX + 4}`]).toBeUndefined(); // 最旧的淘汰
	});

	it("脏数据不炸（非对象/坏条目直接跳过）", () => {
		expect(sanitizeDrafts(null, NOW)).toEqual({});
		expect(sanitizeDrafts({ a: 1, b: { prompt: "ok", updatedAt: NOW } }, NOW)).toEqual({
			b: { prompt: "ok", refs: [], updatedAt: NOW },
		});
	});
});

describe("rtcFreeGenStore · upsert", () => {
	const base: FreeGenDraftMap = { s1: { prompt: "旧", refs: [{ uri: "u", media: "image" }], modelKey: "m1", updatedAt: 1 } };

	it("只改提示词时其它字段原样保留，并刷新更新时间", () => {
		const next = upsertDraft(base, "s1", { prompt: "新" }, NOW);
		expect(next.s1).toEqual({ prompt: "新", refs: [{ uri: "u", media: "image" }], modelKey: "m1", updatedAt: NOW });
		expect(base.s1.prompt).toBe("旧"); // 不可变：原表不动
	});

	it("模型置空 = 清除显式选择（回落 ModelPicker 的生效模型）", () => {
		expect(upsertDraft(base, "s1", { modelKey: "" }, NOW).s1.modelKey).toBeUndefined();
	});

	it("新片段直接建草稿", () => {
		const next = upsertDraft(base, "s2", { prompt: "p" }, NOW);
		expect(next.s2).toEqual({ prompt: "p", refs: [], updatedAt: NOW });
		expect(next.s1).toBe(base.s1);
	});
});
