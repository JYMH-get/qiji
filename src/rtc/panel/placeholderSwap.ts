/**
 * placeholderSwap —— 「结果占位」与**在途台账**（generationQueue.pendingGens）的对账层：
 * 状态镜像（准备中/生成中/失败）+ 终态落笔（占位就地变 media）+ 重开客户端后的接续。
 *
 * ⚠ 核心设计约束（第237轮用户定稿，勿改成回调闭包驱动）：
 *   占位片段的在途状态**由已落盘的台账驱动**，不由"提交那一刻的回调闭包"驱动——
 *   `pendingGens` 随项目文件持久化（第47/61轮），关掉客户端重开后
 *   `resumePendingGenerations()` 会把它们重新挂上轮询；本模块订阅台账，按
 *   `RtcSegment.taskRef` 对上占位片段，把 status 回填进去，**断连找回几乎是白得的**。
 *   （自由占位那条链的在途状态记在片段自己身上，重挂在 [freeGenActions.resumeFreeGens]。）
 *
 * 两类占位、一条落笔路径：
 *   ① **走台账的**（分镜出片 startShotGeneration / 超分·去字幕 startDerivedGeneration）：
 *      taskRef = pending 台账 id；结果落点是分镜（videoUris/storyboardImages）或分镜的派生记录；
 *   ② **自由占位**（无 shotRef，runPurpose 直连）：taskRef = `adapterKey|taskId`，本模块只负责
 *      在扫描时把它交给 resumeFreeGens 重挂。
 *   两类的落笔都经 [rtcGenSink](./rtcGenSink.ts)（同一套项目身份守卫、同一套"只认还是占位的片段"、
 *   同一套撤销栈分工）。
 *
 * ⚠ 项目隔离：arm 时记 projectInstanceId，订阅回调入口比对——切项目立刻作废（复制/导入的项目
 *   会撞 episodeId/shotId/segId，不校验就会对新项目误判误替换）；异步探测时长回来后再验一次。
 */
import { useProjectStore } from "@/store/projectStore";
import { useRtcStore } from "@/store/rtcStore";
import type { PendingGen } from "@/services/projectFile";
import type { RtcSegment } from "@/types/rtc";
import { orphanPatch, parseTaskRef, pendingMirrorPatch } from "./rtcGenCore";
import {
	armRunning,
	currentOwner,
	landMedia,
	liveSegment,
	markFailed,
	mirrorStatus,
	ownerAlive,
	probeDurationSec,
} from "./rtcGenSink";
import { resumeFreeGens } from "./freeGenActions";

/* ────────────────────────── 结果解析（按台账目标类型） ────────────────────────── */

function shotOf(episodeId: string, shotId: string) {
	return useProjectStore.getState().episodes.find((e) => e.id === episodeId)?.shots.find((s) => s.id === shotId);
}

/** 该 pending 的结果落在分镜的哪个列表上（video=成片历史 / storyboard=故事板历史） */
function shotResultList(p: PendingGen): string[] {
	const t = p.shot;
	if (!t) return [];
	const sh = shotOf(t.episodeId, t.shotId);
	if (!sh) return [];
	return (t.field === "storyboard" ? sh.storyboardImages : sh.videoUris) ?? [];
}

/** 台账目标 → 产物类型（故事板/图像超分=图片，其余=视频） */
function mediaOfPending(p: PendingGen): NonNullable<RtcSegment["media"]> {
	if (p.derived) return p.derived.field === "storyboard" ? "image" : "video";
	return p.shot?.field === "storyboard" ? "image" : "video";
}

/* ────────────────────────── 终态监听 ────────────────────────── */

interface WatchCtx {
	pendingId: string;
	segId: string;
	owner: string;
	media: NonNullable<RtcSegment["media"]>;
	/** 分镜结果列表在 arm 那一刻的长度（用于判断"这一单有没有产出新结果"） */
	baseLen: number;
	/** 最后一次见到的台账记录——销账后 settle 还要知道这一单的目标是分镜还是派生记录 */
	last?: PendingGen;
}

/** segId → 本会话接管中的监听（同一占位换了新任务时旧监听作废，只认最新一次） */
const armed = new Map<string, { pendingId: string; disarm: () => void }>();

/** 该占位此刻是否已被本会话接管（决定"台账里查无此单"要不要判孤儿） */
export function isPlaceholderArmed(segId: string): boolean {
	return armed.has(segId);
}

/**
 * 成功落笔：占位就地变 media（target 位置/时长分毫不动）。
 *
 * source 窗口两种口径（⚠ 勿混，混了画面会跳）：
 *   - **超分 / 去字幕**（derived）：产物与源片段是同一条时间线的同一段内容 → **原样沿用源片段的
 *     source 窗口**（凭占位的血缘 originSegId 回查），绝不重置成 [0, 全长]；
 *   - **新生成的内容**（分镜出片 / 重新生成 / 自由占位）：产物是全新素材 → 探它自己的真实时长
 *     建 [0, 时长]（探不到就不建窗口，宁可没有也不写假值）。
 */
function landResult(ctx: WatchCtx, uri: string): void {
	const assetId = useProjectStore.getState().blobByUri(uri)?.id;
	if (ctx.last?.derived && ctx.media !== "image") {
		const holder = liveSegment(ctx.segId);
		const src = holder?.originSegId ? liveSegment(holder.originSegId) : null;
		if (src && src.sourceStartUs != null && src.sourceDurationUs != null) {
			landMedia(ctx.segId, {
				media: ctx.media,
				uri,
				assetId,
				sourceWindow: { sourceStartUs: src.sourceStartUs, sourceDurationUs: src.sourceDurationUs },
				owner: ctx.owner,
			});
			return;
		}
	}
	void probeDurationSec(uri, ctx.media).then((sec) => {
		if (!ownerAlive(ctx.owner)) return; // 探测窗口内切了项目 → 放弃落笔
		landMedia(ctx.segId, { media: ctx.media, uri, assetId, durationSec: sec, owner: ctx.owner });
	});
}

/** 台账销账时判定这一单的下场（成功=落笔；否则占位转失败并说明原因，**片段保留不删**） */
function settle(ctx: WatchCtx): void {
	const seg = liveSegment(ctx.segId);
	if (!seg || seg.kind !== "placeholder") return; // 片段已删/已被别的结果占了 → 不抢
	const p = ctx.last;
	if (!p) {
		// 从没见过这一单（arm 时它已不在台账）→ 无从判定结果落点，如实报告可操作原因
		if (seg.status !== "failed") markFailed(ctx.segId, "生成任务已结束但结果没能自动落位，请重新生成", ctx.owner);
		return;
	}
	if (p.derived) {
		// 超分/去字幕：结果写在分镜的派生记录上（失败时台账直接销账、记录标红）
		const t = p.derived;
		const sh = shotOf(t.episodeId, t.shotId);
		const list = (t.field === "storyboard" ? sh?.sbDerived : sh?.videoDerived) ?? [];
		const rec = list.find((d) => d.id === t.recId);
		if (!rec) {
			markFailed(ctx.segId, "处理记录已被删除或覆盖，请重新处理", ctx.owner);
			return;
		}
		if (rec.status === "failed" || !rec.uri) {
			markFailed(ctx.segId, rec.error || "处理失败，可重新处理", ctx.owner);
			return;
		}
		landResult(ctx, rec.uri);
		return;
	}
	// 分镜出片：台账销账 = 成功（失败时台账会保留 status:"failed" 的记录，由状态镜像负责）
	const uris = shotResultList(p);
	if (uris.length <= ctx.baseLen) {
		if (seg.status !== "failed") {
			markFailed(ctx.segId, "生成记录已被移除或分镜已删除，结果未能落位，请重新生成", ctx.owner);
		}
		return;
	}
	landResult(ctx, uris[uris.length - 1]);
}

/**
 * 登记一次「台账在途 → 占位终态」监听（幂等：同一占位重复 arm 时旧监听作废）。
 * 同时把占位打成「生成中」并记下 taskRef——taskRef 是重开客户端后重新对上号的凭据。
 */
export function armPendingWatch(pendingId: string, segId: string): void {
	const cur = armed.get(segId);
	// ⚠ 同一占位 + 同一单已在接管中 → 直接返回：重新 arm 会把 baseLen（分镜结果列表的基准长度）
	// 重设成"已含本次结果"的长度，销账时就会把成功误判成"没有新结果"。
	if (cur?.pendingId === pendingId) return;
	cur?.disarm();
	const owner = currentOwner();
	const p0 = useProjectStore.getState().pendingGens.find((x) => x.id === pendingId);
	const ctx: WatchCtx = {
		pendingId,
		segId,
		owner,
		media: p0 ? mediaOfPending(p0) : (liveSegment(segId)?.genKind ?? "video"),
		baseLen: p0 ? shotResultList(p0).length : 0,
		last: p0,
	};
	const unsub = useProjectStore.subscribe((state) => {
		if (state.projectInstanceId !== owner) {
			disarm(); // 已切项目：旧监听立刻作废（复制/导入项目会撞 id）
			return;
		}
		const p = state.pendingGens.find((x) => x.id === pendingId);
		if (p) {
			ctx.last = p; // 记住最后形态（销账后判定结果落点要用）
			// 仍在途：把台账状态镜像到占位（running / failed 可重试重连），不进撤销栈
			const seg = liveSegment(segId);
			const patch = seg ? pendingMirrorPatch(seg, p) : null;
			if (patch) mirrorStatus(segId, patch, owner);
			return;
		}
		disarm();
		settle(ctx); // 销账 → 判定下场
	});
	const disarm = () => {
		unsub();
		if (armed.get(segId)?.disarm === disarm) armed.delete(segId);
	};
	armed.set(segId, { pendingId, disarm });
}

/**
 * 兼容入口（shotGenActions 在提交分镜视频后调用）：登记监听 + 把占位打成「生成中」并记 taskRef。
 * 参数保持原签名（episodeId/shotId 已能从台账反查，留着是为了调用方可读）。
 */
export function armPlaceholderSwap(pendingId: string, _episodeId: string, _shotId: string, segId: string): void {
	armPendingWatch(pendingId, segId);
	// 占位转「生成中」+ 记下台账 id（重开客户端后靠它对上号）——用户动作，进撤销栈
	armRunning(segId, pendingId, currentOwner());
}

/* ────────────────────────── 全局扫描（重开客户端 / 切项目后的接续） ────────────────────────── */

/**
 * 扫一遍当前 doc 的占位片段，把「已落盘的在途状态」接回来：
 *   - taskRef=台账 id 且台账里还有这一单 → 镜像状态 + 补挂终态监听（本会话没接管过的话）；
 *   - taskRef=台账 id 但台账里查无此单、本会话也没接管过 → 判孤儿转失败（绝不让占位永远转圈）；
 *   - taskRef=`adapterKey|taskId` → 交给 freeGenActions 重挂集中轮询（不重新提交不再扣费）。
 * 幂等且便宜：没有变化时不产生任何 doc 写入（补丁 no-op 会被 rtcGenSink 拦掉）。
 */
export function scanPlaceholders(): void {
	const doc = useRtcStore.getState().doc;
	if (!doc) return;
	const pendings = useProjectStore.getState().pendingGens;
	const owner = currentOwner();
	for (const t of doc.tracks) {
		for (const seg of t.segments) {
			if (seg.kind !== "placeholder") continue;
			const ref = parseTaskRef(seg.taskRef);
			if (!ref || ref.kind !== "pending") continue; // 无 taskRef=还没提交过；task 形态归 resumeFreeGens
			const p = pendings.find((x) => x.id === ref.pendingId);
			if (p) {
				const patch = pendingMirrorPatch(seg, p);
				if (patch) mirrorStatus(seg.id, patch, owner);
				if (!armed.has(seg.id)) armPendingWatch(ref.pendingId, seg.id); // 重开后补挂终态监听
				continue;
			}
			// 台账里没有这一单：本会话接管过（刚销账，落笔可能正在异步进行）→ 交给监听处理；
			// 从没接管过（多半是关软件期间它已经跑完并销账了）→ 转失败并给出可操作说明
			if (!armed.has(seg.id) && seg.status !== "failed") mirrorStatus(seg.id, orphanPatch(), owner);
		}
	}
	resumeFreeGens();
}

let inited = false;
let prevDoc = useRtcStore.getState().doc;
let prevPendings = useProjectStore.getState().pendingGens;
let prevInstance = useProjectStore.getState().projectInstanceId;

/**
 * 挂上全局对账（幂等，可重复调用）：由右栏 [RtcPropertyPanel] 挂载时调用一次。
 * 触发扫描的时机——项目切换、rtcDoc 引用变化（载入/收编/落笔）、pendingGens 引用变化（台账更新）。
 * ⚠ 订阅里必须按引用比对再扫：rtcStore 每帧播放头都在变，projectStore 更是什么都往里写，
 *   不比对就是每帧全量扫描。
 */
export function initRtcGenWatch(): void {
	if (inited) return;
	inited = true;
	scanPlaceholders();
	useRtcStore.subscribe((s) => {
		if (s.doc === prevDoc) return;
		prevDoc = s.doc;
		scanPlaceholders();
	});
	useProjectStore.subscribe((s) => {
		const instChanged = s.projectInstanceId !== prevInstance;
		const pendChanged = s.pendingGens !== prevPendings;
		prevInstance = s.projectInstanceId;
		prevPendings = s.pendingGens;
		if (!instChanged && !pendChanged) return;
		scanPlaceholders();
	});
}
