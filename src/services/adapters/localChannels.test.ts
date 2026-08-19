import { describe, it, expect } from "vitest";
import {
	modelChannels,
	buildModelSourceOptions,
	sourceValueOf,
	modelForSource,
	modelVariantsOf,
	modelFamilies,
	familyOf,
	modelForFamily,
	channelOf,
	CHANNEL_SOURCE_PREFIX,
	QIJI_CHANNEL,
} from "@/services/adapters/localChannels";
import { LIBTV_CHANNEL, LIBTV_MODEL_CHOICES, LIBTV_MINIMAX_H3_KEY, MINIMAX_FAMILY_ID } from "@/services/adapters/libtvAdapter";

const L0 = LIBTV_MODEL_CHOICES[0].id;
const L1 = LIBTV_MODEL_CHOICES[1]?.id ?? L0; // LibTV 至少两款（Seedance 2.0 / Fast）
const SRC_LIBTV = CHANNEL_SOURCE_PREFIX + LIBTV_CHANNEL;
const SRC_QIJI = CHANNEL_SOURCE_PREFIX + QIJI_CHANNEL;

describe("localChannels 源→模型 两级选择", () => {
	const opts = [
		{ id: "mgd-video", label: "管理端视频模型" },
		...LIBTV_MODEL_CHOICES.map((c) => ({ id: c.id, label: c.label })),
	];

	it("buildModelSourceOptions：管理端模型平铺，本地渠道折叠为一个源", () => {
		const srcs = buildModelSourceOptions(opts);
		expect(srcs.filter((s) => s.value === "mgd-video").length).toBe(1); // 管理端各占一项
		const libtvSrc = srcs.filter((s) => s.value === SRC_LIBTV);
		expect(libtvSrc.length).toBe(1); // LibTV 多款折叠为一个源
		expect(libtvSrc[0].label).toBe(LIBTV_CHANNEL);
	});

	it("sourceValueOf：本地渠道模型→src:渠道名；管理端模型→模型id本身", () => {
		expect(sourceValueOf(L0)).toBe(SRC_LIBTV);
		expect(sourceValueOf("mgd-video")).toBe("mgd-video");
		expect(sourceValueOf("")).toBe("");
	});

	it("modelForSource：选本地渠道源→已在该渠道则保持款式、否则取默认款；管理端源→即模型id", () => {
		expect(modelForSource("mgd-video", L0)).toBe("mgd-video");
		expect(modelForSource(SRC_LIBTV, L1)).toBe(L1); // 已在 LibTV → 保持当前款式
		expect(modelForSource(SRC_LIBTV, "mgd-video")).toBe(L0); // 从管理端切到 LibTV → 默认款
	});

	it("modelVariantsOf：本地渠道有二级款式；管理端模型无二级(null)", () => {
		const v = modelVariantsOf(L0);
		expect(v && v.length).toBe(LIBTV_MODEL_CHOICES.length);
		expect(modelVariantsOf("mgd-video")).toBeNull();
	});
});

describe("localChannels Qiji 源（视频：管理端模型折叠为一个源）", () => {
	// 视频下拉的真实形态：catalog 模型在前，本地渠道注入在后
	const opts = [
		{ id: "seedance-2.0", label: "Seedance 2.0" },
		{ id: "seedance-2.0-fast", label: "Seedance 2.0 Fast" },
		...LIBTV_MODEL_CHOICES.map((c) => ({ id: c.id, label: c.label })),
	];
	const channels = modelChannels(opts, true);

	it("modelChannels：管理端模型归入 Qiji 源，本地渠道原样保留", () => {
		const qiji = channels.find((c) => c.channel === QIJI_CHANNEL);
		expect(qiji?.choices.map((c) => c.id)).toEqual(["seedance-2.0", "seedance-2.0-fast"]);
		expect(channels.find((c) => c.channel === LIBTV_CHANNEL)?.choices.length).toBe(LIBTV_MODEL_CHOICES.length);
	});

	it("modelChannels：qiji=false 或清单里无管理端模型 → 只有本地渠道（管理端模型平铺，旧行为）", () => {
		expect(modelChannels(opts, false).some((c) => c.channel === QIJI_CHANNEL)).toBe(false);
		const localOnly = LIBTV_MODEL_CHOICES.map((c) => ({ id: c.id, label: c.label }));
		expect(modelChannels(localOnly, true).some((c) => c.channel === QIJI_CHANNEL)).toBe(false);
	});

	it("buildModelSourceOptions：源下拉只剩 Qiji / LibTV（seedance 不再各占一源）", () => {
		const srcs = buildModelSourceOptions(opts, channels);
		expect(srcs).toEqual([
			{ value: SRC_QIJI, label: QIJI_CHANNEL },
			{ value: SRC_LIBTV, label: LIBTV_CHANNEL },
		]);
	});

	it("sourceValueOf：管理端模型 → src:Qiji", () => {
		expect(sourceValueOf("seedance-2.0", channels)).toBe(SRC_QIJI);
		expect(sourceValueOf("seedance-2.0-fast", channels)).toBe(SRC_QIJI);
		expect(sourceValueOf(L0, channels)).toBe(SRC_LIBTV);
	});

	it("modelVariantsOf：Qiji 的二级款式=管理端各模型（显示全名）", () => {
		expect(modelVariantsOf("seedance-2.0", channels)).toEqual([
			{ id: "seedance-2.0", label: "Seedance 2.0" },
			{ id: "seedance-2.0-fast", label: "Seedance 2.0 Fast" },
		]);
	});

	it("modelForSource：选 Qiji 源→已在 Qiji 则保持款式、否则取第一款", () => {
		expect(modelForSource(SRC_QIJI, "seedance-2.0-fast", channels)).toBe("seedance-2.0-fast"); // 保持款式
		expect(modelForSource(SRC_QIJI, L0, channels)).toBe("seedance-2.0"); // 从 LibTV 切到 Qiji → 默认款
		expect(modelForSource(SRC_LIBTV, "seedance-2.0", channels)).toBe(L0); // 从 Qiji 切到 LibTV → 默认款
	});
});

describe("localChannels 按模式折叠成源（第131轮：模式=源头级）", () => {
	// 视频下拉真实形态：qiji 模式 + 三个简梦模式 + 无模式模型 + 本地渠道
	const opts = [
		{ id: "seedance-2.0", label: "Seedance 2.0", modeId: "qiji", modeName: "Qiji 视频" },
		{ id: "gf903-sd2.0", label: "gf903-sd2.0", modeId: "jmgf", modeName: "简梦GF" },
		{ id: "gf903-sd2.0-fast", label: "gf903-sd2.0-fast", modeId: "jmgf", modeName: "简梦GF" },
		{ id: "jm431-sd2.0", label: "jm431-sd2.0", modeId: "jm431", modeName: "简梦431" },
		{ id: "no-mode-video", label: "无模式模型" },
		...LIBTV_MODEL_CHOICES.map((c) => ({ id: c.id, label: c.label })),
	];
	const channels = modelChannels(opts, true);

	it("modelChannels：带 modeId 的按模式分桶（源名=模式名），无 modeId 的进 Qiji 兜底源", () => {
		expect(channels.find((c) => c.channel === "简梦GF")?.choices.map((c) => c.id)).toEqual(["gf903-sd2.0", "gf903-sd2.0-fast"]);
		expect(channels.find((c) => c.channel === "Qiji 视频")?.choices.map((c) => c.id)).toEqual(["seedance-2.0"]);
		expect(channels.find((c) => c.channel === QIJI_CHANNEL)?.choices.map((c) => c.id)).toEqual(["no-mode-video"]);
	});

	it("buildModelSourceOptions：每模式一个源 + 本地渠道 + 兜底 Qiji", () => {
		const srcs = buildModelSourceOptions(opts, channels);
		const labels = srcs.map((s) => s.label);
		expect(labels).toContain("Qiji 视频");
		expect(labels).toContain("简梦GF");
		expect(labels).toContain("简梦431");
		expect(labels).toContain(LIBTV_CHANNEL);
		expect(labels.filter((l) => l === "简梦GF").length).toBe(1); // 同模式两款折叠为一个源
	});

	it("sourceValueOf / modelForSource / modelVariantsOf：模式源与本地渠道同语义", () => {
		expect(sourceValueOf("gf903-sd2.0-fast", channels)).toBe(CHANNEL_SOURCE_PREFIX + "简梦GF");
		expect(modelForSource(CHANNEL_SOURCE_PREFIX + "简梦GF", "gf903-sd2.0-fast", channels)).toBe("gf903-sd2.0-fast"); // 保款式
		expect(modelForSource(CHANNEL_SOURCE_PREFIX + "简梦GF", "seedance-2.0", channels)).toBe("gf903-sd2.0"); // 跨源→默认款
		expect(modelVariantsOf("jm431-sd2.0", channels)).toEqual([{ id: "jm431-sd2.0", label: "jm431-sd2.0" }]);
	});
});

describe("localChannels 家族三级折叠（第163轮：家族→渠道/线路→模型）", () => {
	// 视频下拉真实形态：seedance 家族跨 3 条线（星辰/Dimensio/LibTV）、sora2 家族一条线、未分家族模型、
	// 本地渠道家族按款自带（第203轮：LibTV 的 MiniMax H3 独立成 MiniMax 家族，勿再全员钉 seedance）
	const opts = [
		{ id: "xc933-sd2.0", label: "xc933-sd2.0", modeId: "xingchen", modeName: "星辰", familyId: "fam-seedance", familyName: "Seedance 2.0" },
		{ id: "xc933-sd2.0-fast", label: "xc933-sd2.0-fast", modeId: "xingchen", modeName: "星辰", familyId: "fam-seedance", familyName: "Seedance 2.0" },
		{ id: "dm933-sd2.0", label: "dm933-sd2.0", modeId: "dimensio", modeName: "简梦D", familyId: "fam-seedance", familyName: "Seedance 2.0" },
		{ id: "sora2", label: "sora2", modeId: "jmp", modeName: "简梦P", familyId: "fam-sora2", familyName: "Sora2" },
		{ id: "mystery-video", label: "未分家族模型", modeId: "jmp", modeName: "简梦P" },
		...LIBTV_MODEL_CHOICES.map((c) => ({ id: c.id, label: c.label, familyId: c.familyId, familyName: c.familyName })),
	];
	// familyOrder 模拟 catalog.families 序（sora2 在前也不影响组内容，只影响排序；fam-minimax 不在 catalog=排已知家族后、「其他」前）
	const families = modelFamilies(opts, ["fam-sora2", "fam-seedance"]);
	const LIBTV_SEEDANCE_CHOICES = LIBTV_MODEL_CHOICES.filter((c) => c.familyId === "fam-seedance");

	it("modelFamilies：按家族分组、组内按 模式名/本地渠道 分线；未分家族归「其他」恒最后", () => {
		expect(families.map((f) => f.familyId)).toEqual(["fam-sora2", "fam-seedance", MINIMAX_FAMILY_ID, ""]); // familyOrder 序 + 其他最后
		const sd = families.find((f) => f.familyId === "fam-seedance")!;
		expect(sd.familyName).toBe("Seedance 2.0");
		expect(sd.channels.map((c) => c.channel)).toEqual(["星辰", "简梦D", LIBTV_CHANNEL]); // opts 首现序
		expect(sd.channels[0].choices.map((c) => c.id)).toEqual(["xc933-sd2.0", "xc933-sd2.0-fast"]);
		// 本地 CLI 款式名用渠道常量短名（「Seedance 2.0 Fast」）而非全名；seedance 家族内只有 seedance 两款
		const libtvCh = sd.channels.find((c) => c.channel === LIBTV_CHANNEL)!;
		expect(libtvCh.choices.map((c) => c.variantLabel)).toEqual(LIBTV_SEEDANCE_CHOICES.map((c) => c.variantLabel));
		expect(families.find((f) => f.familyId === "")!.familyName).toBe("其他");
		expect(families.find((f) => f.familyId === "")!.channels[0].choices[0].id).toBe("mystery-video");
	});

	it("MiniMax H3 独立家族：LibTV 线单独成组，不混进 seedance", () => {
		const mm = families.find((f) => f.familyId === MINIMAX_FAMILY_ID)!;
		expect(mm.familyName).toBe("MiniMax");
		expect(mm.channels.map((c) => c.channel)).toEqual([LIBTV_CHANNEL]);
		expect(mm.channels[0].choices.map((c) => c.id)).toEqual([LIBTV_MINIMAX_H3_KEY]);
		expect(familyOf(LIBTV_MINIMAX_H3_KEY, families)?.familyId).toBe(MINIMAX_FAMILY_ID);
	});

	it("familyOf：按模型 id 反查家族；未知 id/空 → null", () => {
		expect(familyOf("dm933-sd2.0", families)?.familyId).toBe("fam-seedance");
		expect(familyOf("mystery-video", families)?.familyId).toBe("");
		expect(familyOf("nope", families)).toBeNull();
		expect(familyOf("", families)).toBeNull();
	});

	it("modelForFamily：当前模型在家族内保持不重置；跨家族取第一线第一款；未知家族=空", () => {
		expect(modelForFamily("fam-seedance", "dm933-sd2.0", families)).toBe("dm933-sd2.0"); // 保持
		expect(modelForFamily("fam-seedance", "sora2", families)).toBe("xc933-sd2.0"); // 跨家族→第一款
		expect(modelForFamily("fam-sora2", "dm933-sd2.0", families)).toBe("sora2");
		expect(modelForFamily("", "sora2", families)).toBe("mystery-video"); // 「其他」也是合法家族
		expect(modelForFamily("fam-nope", "sora2", families)).toBe("");
	});

	it("家族内二级线路复用既有 channelOf/modelForSource 语义（换线保款式/取默认款）", () => {
		const sd = families.find((f) => f.familyId === "fam-seedance")!;
		expect(channelOf("xc933-sd2.0-fast", sd.channels)?.channel).toBe("星辰");
		expect(modelForSource(CHANNEL_SOURCE_PREFIX + "简梦D", "xc933-sd2.0-fast", sd.channels)).toBe("dm933-sd2.0"); // 换线→该线默认款
		expect(modelForSource(CHANNEL_SOURCE_PREFIX + "星辰", "xc933-sd2.0-fast", sd.channels)).toBe("xc933-sd2.0-fast"); // 本线→保款式
	});
});
