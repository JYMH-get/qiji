/**
 * rtcQueueStore —— 结果占位片段的**在途排队信息**（第251轮需求④在 RTC 侧的落点）。
 *
 * 存的是 `TaskExtra`（排队位次 queuePosition/queueTotal、阶段文案 stageText）——它由
 * purposeRunner 的 onProgress 逐帧带下来，经 [rtcGenSink.mirrorProgress](./rtcGenSink.ts) 写进这里，
 * 显示侧（时间轴片段块 / 自由占位工作台 / 右栏 AI 设置）用 [progressLabel](@/lib/queueLabel)
 * 渲染成「排队中 · 第 3 位」而不是干巴巴的「生成中 0%」。
 *
 * ⚠ 刻意**只在内存、绝不落盘**（勿改成 RtcSegment 字段）：
 *   - 排队位次每一轮轮询都在变，写进片段 = 惊动 rtcDoc 回写 + 去抖落盘 + undo 语义，
 *     而它对「重开客户端」毫无价值（重开后由重挂轮询的首帧重新给出）；
 *   - 与 rtcGenSink 里 `progressMark` 的节流基准同性质：纯运行时辅助态。
 *
 * 生命周期：提交（armRunning）清一次陈旧值 → 进度帧刷新 → 终态（landMedia/markFailed）清除。
 */
import { create } from "zustand";
import type { TaskExtra } from "@/services/adapters/types";

interface RtcQueueState {
	/** segId → 该片段最近一帧的排队信息（无=未知/已结束） */
	infos: Record<string, TaskExtra>;
	/** 写入/清除（null=清除）；值未变化时不 setState（避免无谓重渲染） */
	setInfo: (segId: string, info: TaskExtra | null) => void;
}

/** 两份排队信息是否等价（逐键比对，避免每帧都换新对象引用触发重渲染） */
function sameInfo(a: TaskExtra | undefined, b: TaskExtra | null): boolean {
	if (!a && !b) return true;
	if (!a || !b) return false;
	return a.queuePosition === b.queuePosition && a.queueTotal === b.queueTotal && a.stageText === b.stageText;
}

/** 空信息（三个字段都没有）视同清除——别在表里留空壳 */
function isEmpty(info: TaskExtra | null): boolean {
	return !info || (info.queuePosition == null && info.queueTotal == null && !info.stageText);
}

export const useRtcQueueStore = create<RtcQueueState>((set, get) => ({
	infos: {},
	setInfo: (segId, info) => {
		const cur = get().infos[segId];
		const next = isEmpty(info) ? null : info;
		if (sameInfo(cur, next)) return;
		set((s) => {
			const infos = { ...s.infos };
			if (next) infos[segId] = next;
			else delete infos[segId];
			return { infos };
		});
	},
}));

/** 组件侧订阅：该片段的排队信息（引用稳定——值没变不会触发重渲染） */
export function useSegQueueInfo(segId: string | undefined): TaskExtra | undefined {
	return useRtcQueueStore((s) => (segId ? s.infos[segId] : undefined));
}

/** 非 hook 读取（提交/落笔链路用） */
export function segQueueInfo(segId: string): TaskExtra | undefined {
	return useRtcQueueStore.getState().infos[segId];
}
