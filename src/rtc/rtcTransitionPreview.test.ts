/**
 * 转场真预览纯逻辑单测（用户定稿：没有预览的转场不上 UI，预览观感须与剪映一致）：
 *  - transitionStateAt：窗口口径（叠化/闪对称跨切点、推移只在切点前）、严格相邻判定、
 *    不可预览款不触发、窗口钳进两侧片段跨度；
 *  - transitionGhost/transitionMainFx：叠化双侧淡化连续、色闪峰值在切点、推移双画面推挤到位；
 *  - videoStageAt 集成：#tr 幽灵槽 layerIndex 与 videoLayerSlotsBottomUp 严格同序、幽灵冻结/静音、
 *    色闪填充层形状、窗口外零幽灵（零回归）。
 */
import { describe, expect, it } from "vitest";
import type { RtcDoc, RtcSegment, RtcTrack } from "@/types/rtc";
import { JY_PREVIEW_TRANSITIONS, JY_TRANSITIONS } from "@/lib/jyTransitions";
import {
	TRANSITION_SLOT_SUFFIX,
	transitionGhost,
	transitionMainFx,
	transitionStateAt,
	videoLayerSlotsBottomUp,
	videoStageAt,
} from "./rtcPlayback";

const SEC = 1_000_000;

function seg(id: string, startUs: number, durUs: number, extra?: Partial<RtcSegment>): RtcSegment {
	return { id, kind: "media", media: "video", uri: `u://${id}`, targetStartUs: startUs, targetDurationUs: durUs, ...extra } as RtcSegment;
}
function tr(effectId: string, durationUs: number) {
	const meta = JY_TRANSITIONS.find((t) => t.effectId === effectId)!;
	return { effectId: meta.effectId, resourceId: meta.resourceId, name: meta.name, durationUs };
}
function doc(tracks: RtcTrack[]): RtcDoc {
	return { id: "d", name: "d", fps: 30, tracks } as RtcDoc;
}
const DISSOLVE = "322577";
const FLASH_BLACK = "321493";
const SLIDE_LEFT = "2917286";

describe("transitionStateAt 窗口与判定", () => {
	const a = seg("a", 0, 4 * SEC, { transitionAfter: tr(DISSOLVE, SEC) });
	const b = seg("b", 4 * SEC, 4 * SEC);

	it("叠化：窗口对称跨切点 [cut−d/2, cut+d/2)，p 线性、切点前后 side 切换", () => {
		const segs = [a, b];
		expect(transitionStateAt(segs, 3.4 * SEC)).toBeNull(); // 窗口前
		const atStart = transitionStateAt(segs, 3.5 * SEC)!;
		expect(atStart.side).toBe("A");
		expect(atStart.p).toBeCloseTo(0);
		const atCut = transitionStateAt(segs, 4 * SEC)!;
		expect(atCut.side).toBe("B");
		expect(atCut.p).toBeCloseTo(0.5);
		const nearEnd = transitionStateAt(segs, 4.4 * SEC)!;
		expect(nearEnd.p).toBeCloseTo(0.9);
		expect(transitionStateAt(segs, 4.5 * SEC)).toBeNull(); // 窗口右缘开区间
	});

	it("推移：窗口只在切点前 [cut−d, cut)", () => {
		const a2 = seg("a", 0, 4 * SEC, { transitionAfter: tr(SLIDE_LEFT, SEC) });
		const segs = [a2, b];
		expect(transitionStateAt(segs, 2.9 * SEC)).toBeNull();
		expect(transitionStateAt(segs, 3 * SEC)!.p).toBeCloseTo(0);
		expect(transitionStateAt(segs, 3.9 * SEC)!.p).toBeCloseTo(0.9);
		expect(transitionStateAt(segs, 4 * SEC)).toBeNull(); // 切点即完成，B 正常接管
	});

	it("不相邻（有空隙）不预览；不可预览款（雾化）不触发", () => {
		const gapB = seg("b", 4.2 * SEC, 2 * SEC);
		expect(transitionStateAt([a, gapB], 3.9 * SEC)).toBeNull();
		const fancy = seg("a", 0, 4 * SEC, { transitionAfter: tr("11387229", SEC) }); // 雾化：无 previewKind
		expect(transitionStateAt([fancy, b], 3.9 * SEC)).toBeNull();
	});

	it("窗口钳进两侧片段跨度（转场时长超过片段时不盖到第三段）", () => {
		const shortA = seg("a", 3 * SEC, 0.2 * SEC, { transitionAfter: tr(SLIDE_LEFT, SEC) }); // 窗口名义上从 2.2s 开始
		const b2 = seg("b", 3.2 * SEC, 2 * SEC);
		expect(transitionStateAt([shortA, b2], 2.9 * SEC)).toBeNull(); // A 自己的跨度之外不触发
		expect(transitionStateAt([shortA, b2], 3.1 * SEC)).not.toBeNull();
	});
});

describe("transitionGhost / transitionMainFx 效果数值", () => {
	const a = seg("a", 0, 4 * SEC, { transitionAfter: tr(DISSOLVE, SEC) });
	const b = seg("b", 4 * SEC, 4 * SEC);

	it("叠化：切点前=B 淡入（α=p）、切点后=A 淡出（α=1−p）——切点两态同为 0.5 视觉连续", () => {
		const before = transitionStateAt([a, b], 3.9 * SEC)!;
		const g1 = transitionGhost(before)!;
		expect(g1.seg?.id).toBe("b");
		expect(g1.freeze).toBe("start");
		expect(g1.fx.alphaMul).toBeCloseTo(0.4);
		expect(transitionMainFx(before)).toBeNull(); // 叠化主层不动
		const after = transitionStateAt([a, b], 4.1 * SEC)!;
		const g2 = transitionGhost(after)!;
		expect(g2.seg?.id).toBe("a");
		expect(g2.freeze).toBe("end");
		expect(g2.fx.alphaMul).toBeCloseTo(0.4); // 1 − 0.6
	});

	it("闪黑：无片段纯色填充，切点处 α=1、两端归 0", () => {
		const fa = seg("a", 0, 4 * SEC, { transitionAfter: tr(FLASH_BLACK, SEC) });
		const atCut = transitionGhost(transitionStateAt([fa, b], 4 * SEC)!)!;
		expect(atCut.fill).toBe("#000");
		expect(atCut.seg).toBeNull();
		expect(atCut.fx.alphaMul).toBeCloseTo(1);
		const nearEdge = transitionGhost(transitionStateAt([fa, b], 3.55 * SEC)!)!;
		expect(nearEdge.fx.alphaMul).toBeCloseTo(0.1);
	});

	it("左移推移：A 随进度左移出、B 冻结帧从右侧推入，切点处恰好到位", () => {
		const sa = seg("a", 0, 4 * SEC, { transitionAfter: tr(SLIDE_LEFT, SEC) });
		const ts = transitionStateAt([sa, b], 3.75 * SEC)!; // p = 0.75
		expect(transitionMainFx(ts)).toEqual({ txPct: -75, tyPct: 0 });
		const g = transitionGhost(ts)!;
		expect(g.seg?.id).toBe("b");
		expect(g.fx.txPct).toBeCloseTo(25); // (1−p)×100 从右侧推入
	});
});

describe("videoStageAt 集成（#tr 幽灵槽）", () => {
	const a = seg("a", 0, 4 * SEC, { transitionAfter: tr(DISSOLVE, SEC), sourceStartUs: 0, sourceDurationUs: 4 * SEC });
	const b = seg("b", 4 * SEC, 4 * SEC, { sourceStartUs: SEC, sourceDurationUs: 4 * SEC });
	const d = doc([{ id: "t1", type: "video", segments: [a, b] } as RtcTrack]);

	it("幽灵层 layerIndex 与 videoLayerSlotsBottomUp 严格同序；冻结/静音/ghost 标记齐全", () => {
		const slots = videoLayerSlotsBottomUp(d).map((s) => s.slotId);
		expect(slots).toEqual(["t1", `t1${TRANSITION_SLOT_SUFFIX}`]);
		const stage = videoStageAt(d, 3.9 * SEC);
		expect(stage.layers).toHaveLength(2);
		const [main, ghost] = stage.layers;
		expect(main.trackId).toBe("t1");
		expect(main.layerIndex).toBe(0);
		expect(ghost.trackId).toBe(`t1${TRANSITION_SLOT_SUFFIX}`);
		expect(ghost.layerIndex).toBe(1); // 与槽位枚举同序（幽灵压在本轨之上）
		expect(ghost.ghost).toBe(true);
		expect(ghost.frozen).toBe(true);
		expect(ghost.muted).toBe(true);
		expect(ghost.volume).toBe(0);
		expect(ghost.seg.id).toBe("b");
		expect(ghost.sourceSec).toBeCloseTo(1); // B 段首冻结 = 自己的 sourceStartUs
		expect(ghost.kfRelUs).toBe(0);
	});

	it("切点后幽灵=A 段尾冻结；窗口外零幽灵（零回归）", () => {
		const after = videoStageAt(d, 4.2 * SEC);
		const ghost = after.layers.find((l) => l.ghost)!;
		expect(ghost.seg.id).toBe("a");
		expect(ghost.sourceSec).toBeCloseTo(4); // A 段尾（source 窗口右缘）
		expect(ghost.kfRelUs).toBe(4 * SEC);
		const outside = videoStageAt(d, 2 * SEC);
		expect(outside.layers).toHaveLength(1);
		expect(outside.layers[0].fx).toBeUndefined();
	});

	it("闪黑：幽灵为纯色填充层（uri 空、fill 有值）", () => {
		const fa = seg("a", 0, 4 * SEC, { transitionAfter: tr(FLASH_BLACK, SEC) });
		const fd = doc([{ id: "t1", type: "video", segments: [fa, b] } as RtcTrack]);
		const stage = videoStageAt(fd, 4 * SEC);
		const fill = stage.layers.find((l) => l.fill)!;
		expect(fill.uri).toBe("");
		expect(fill.fill).toBe("#000");
		expect(fill.fx?.alphaMul).toBeCloseTo(1);
	});
});

describe("JY_PREVIEW_TRANSITIONS 清单（所见即所得红线）", () => {
	it("只含带 previewKind 的款式（7 款基础转场）；花式款保留在总表但不进选择器", () => {
		expect(JY_PREVIEW_TRANSITIONS.every((t) => !!t.previewKind)).toBe(true);
		expect(JY_PREVIEW_TRANSITIONS.map((t) => t.name)).toEqual(["叠化", "闪黑", "闪白", "左移", "右移", "上移", "下移"]);
		expect(JY_TRANSITIONS.length).toBeGreaterThan(JY_PREVIEW_TRANSITIONS.length); // 总表仍全量（导出兼容）
	});
});
