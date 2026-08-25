/**
 * LibTV 本地渠道款式清单与 CLI 变体映射的锁定测试（第253轮：+Seedance 2.0 Mini / 2.5）。
 * 断言口径 = `libtv model <modelKey>` 实拉 schema（CLI 1.1.3，2026-08-22）。
 */
import { describe, it, expect } from "vitest";
import {
	LIBTV_MODEL_CHOICES,
	LIBTV_SEEDANCE_KEY,
	LIBTV_SEEDANCE_FAST_KEY,
	LIBTV_SEEDANCE_MINI_KEY,
	LIBTV_SEEDANCE_25_KEY,
	LIBTV_MINIMAX_H3_KEY,
	MINIMAX_FAMILY_ID,
} from "./libtvAdapter";
import { libtvVariantMeta, type LibtvSeedanceVariant } from "@/services/libtvCli";

describe("LibTV 款式清单", () => {
	it("五款齐全，id→变体→家族一一对应", () => {
		expect(LIBTV_MODEL_CHOICES.map((c) => c.id)).toEqual([
			LIBTV_SEEDANCE_KEY,
			LIBTV_SEEDANCE_FAST_KEY,
			LIBTV_SEEDANCE_MINI_KEY,
			LIBTV_SEEDANCE_25_KEY,
			LIBTV_MINIMAX_H3_KEY,
		]);
		const by = (id: string) => LIBTV_MODEL_CHOICES.find((c) => c.id === id)!;
		expect(by(LIBTV_SEEDANCE_MINI_KEY).variant).toBe("seedance2mini");
		expect(by(LIBTV_SEEDANCE_25_KEY).variant).toBe("seedance25");
		// 新增两款都归 Seedance 家族；H3 仍独立 MiniMax 家族（勿把新款钉错家族）
		expect(by(LIBTV_SEEDANCE_MINI_KEY).familyId).toBe("fam-seedance");
		expect(by(LIBTV_SEEDANCE_25_KEY).familyId).toBe("fam-seedance");
		expect(by(LIBTV_MINIMAX_H3_KEY).familyId).toBe(MINIMAX_FAMILY_ID);
	});

	it("显示名带渠道前缀，且各款唯一", () => {
		for (const c of LIBTV_MODEL_CHOICES) expect(c.label).toBe(`LibTV · ${c.variantLabel}`);
		expect(new Set(LIBTV_MODEL_CHOICES.map((c) => c.variantLabel)).size).toBe(LIBTV_MODEL_CHOICES.length);
	});
});

describe("LibTV CLI 变体映射", () => {
	const cases: [LibtvSeedanceVariant, string, boolean][] = [
		["seedance2", "star-video2", true],
		["seedance2fast", "star-video2-fast", true],
		["seedance2mini", "star-video2-mini", true],
		["seedance25", "star-video2.5", true],
		// H3 schema 无 enableSound 键（发了可能被拒）
		["minimaxH3", "MiniMax-Hailuo-H3", false],
	];
	it("modelKey 与 enableSound 精确（`-s model=` 按 key 反查实名）", () => {
		for (const [variant, modelKey, sound] of cases) {
			expect(libtvVariantMeta(variant).modelKey).toBe(modelKey);
			expect(libtvVariantMeta(variant).enableSound).toBe(sound);
		}
	});

	it("名字兜底匹配互不串味（线上实名漂移时的回退路径）", () => {
		const hit = (v: LibtvSeedanceVariant, n: string) => libtvVariantMeta(v).nameHit(n);
		// 线上实名（`model search --type video`）
		expect(hit("seedance2", "Seedance 2.0 VIP")).toBe(true);
		expect(hit("seedance2", "Seedance 2.0 Fast VIP")).toBe(false);
		expect(hit("seedance2", "Seedance 2.0 Mini")).toBe(false);
		expect(hit("seedance2", "Seedance 2.5")).toBe(false);
		expect(hit("seedance2fast", "Seedance 2.0 Fast VIP")).toBe(true);
		expect(hit("seedance2mini", "Seedance 2.0 Mini")).toBe(true);
		// Mini 的 schema 里 modelName 写作 StarVideo 2.0 Mini，两种写法都要认
		expect(hit("seedance2mini", "StarVideo 2.0 Mini")).toBe(true);
		expect(hit("seedance2mini", "Seedance 2.0 VIP")).toBe(false);
		expect(hit("seedance25", "Seedance 2.5")).toBe(true);
		expect(hit("seedance25", "Seedance 2.0 VIP")).toBe(false);
		expect(hit("minimaxH3", "Minimax H3")).toBe(true);
		expect(hit("minimaxH3", "Hailuo 2.3")).toBe(false);
	});
});
