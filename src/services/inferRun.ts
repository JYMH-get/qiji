/**
 * inferRun —— 「智能推理」的持久化运行 + 锁定 + 断连找回。
 *
 * 问题：原 handleSmartInfer/inferShot 直接 `await runPurpose`，「推理中」靠组件局部 busy 标记。
 * 切页组件卸载即丢锁（后台仍在跑），用户回来可二次点击 → 两条流并发写同一集冲突；
 * 关客户端则彻底断联，无从找回。
 *
 * 方案：把在途推理登记进 `projectStore.inferTasks`（随项目落盘）：
 *  - 锁定：episode（多镜）/ shot（单镜）只要存在 running 记录，界面恒「推理中」、按钮禁用（派生自 store，跨导航/重启不丢）；
 *  - 提交确认拿到 taskId/adapterKey 立即落盘（找回关键）；
 *  - 运行/结果走**全局 store**（与当前在哪个页面无关）→ 流式合并分镜 + 完成清记录；
 *  - 重开 `resumeInferTasks()`：对 running + 有 taskId 的记录**重挂轮询**，
 *    **仅补缺失字段**（已完成镜头不覆盖，防抹掉用户修改）。
 *
 * 覆盖语义：用户点击智能推理（单/多镜）即「删除当前提示词覆盖」——
 *  多镜清空整集分镜、单镜清空该镜两段提示词（由调用方 Frame161195 在 startInfer 前完成）；
 *  本模块运行期 fillOnly=false（覆盖），找回期 fillOnly=true（仅补缺失）。
 */
import { useProjectStore } from "@/store/projectStore";
import type { StoryboardShot, InferTask } from "@/services/projectFile";
import { runPurpose } from "./purposeRunner";
import { trackTask } from "./taskCenter";
import { parseInferCards, parseInferCardsStream } from "@/lib/smartInferPrompts";
import { stripBlankLines } from "@/lib/storyboardParse";
import type { Purpose } from "@/contract";

const INFER_PURPOSE: Purpose = "storyboard.toVideoPrompt";
/** 单卡推理独立用途（第108轮）：表格单镜按键/一键单卡走它（smart.infer.single 模板的归属用途） */
const SINGLE_PURPOSE: Purpose = "storyboard.singleShot";
const SPLIT_PURPOSE: Purpose = "storyboard.split";
/** 图视同源·多卡/单卡 用途（图片与视频共用一段同源提示词） */
const UNIFIED_PURPOSE: Purpose = "storyboard.unified";
const UNIFIED_SINGLE_PURPOSE: Purpose = "storyboard.unifiedShot";
const INFER_DURATION = 15;

let _seq = 0;
const uid = () => `infer-${Date.now()}-${++_seq}`;

// 单卡推理的邻镜上下文变量 {{上上一分镜}}{{上一分镜}}{{下一分镜}}（纯函数留在 @/lib/inferContext 便于单测）
export { buildNeighborVars } from "@/lib/inferContext";

/** 推理落点（运行 / 找回共用） */
interface InferTarget {
	episodeId: string;
	mode: "multi" | "single" | "split";
	/** 图视同源：产出的同源提示词写 shot.unifiedPrompt（而非 storyboard/video 两段） */
	sameSource?: boolean;
	shotId?: string; // single 模式目标分镜
}
/** 新起一次推理需要的输入（templateId/variables/modelKey 仅运行用，找回不需要）。
 *  sameSource 继承自 InferTarget：图视同源模式产出同源提示词。 */
export interface StartInferSpec extends InferTarget {
	templateId: string;
	variables: Record<string, string>;
	modelKey?: string;
}

interface ShotPatch { index: number; scriptSegment?: string; durationSec?: number; storyboardPrompt?: string; videoPrompt?: string; unifiedPrompt?: string }

// 重排编号：普通镜号 1,2,3…；补镜头(isSupplement)派生自上一个主镜号 → 分镜3-1、3-2…（与 Frame161195.reindex 同算法）
function reindex(shots: StoryboardShot[]): StoryboardShot[] {
	let base = 0, sub = 0;
	return shots.map((s, i) => {
		if (s.isSupplement && base > 0) { sub += 1; return { ...s, index: i + 1, title: `分镜${base}-${sub}` }; }
		base += 1; sub = 0;
		return { ...s, index: i + 1, isSupplement: false, title: `分镜${base}` };
	});
}

/** cards → 分镜补丁（只下发非空字段，避免空串覆盖已填单元格；原文去空行——空行不是分格；
 *  时长：卡带 duration 字段则用它（模板产出的指定时长），缺失回退默认 15s）。
 *  sameSource=true（图视同源）：写 unifiedPrompt（图片与视频共用），不写 storyboard/video 两段。 */
function cardsToPatch(cards: { script: string; storyboardPrompt: string; videoPrompt: string; unifiedPrompt: string; duration?: number }[], sameSource: boolean): ShotPatch[] {
	return cards.map((c, i) => ({
		index: i + 1,
		scriptSegment: stripBlankLines(c.script) || undefined,
		storyboardPrompt: sameSource ? undefined : (c.storyboardPrompt || undefined),
		videoPrompt: sameSource ? undefined : (c.videoPrompt || undefined),
		unifiedPrompt: sameSource ? (c.unifiedPrompt || undefined) : undefined,
		durationSec: c.duration ?? INFER_DURATION,
	}));
}

/**
 * 按 index 合并增量分镜到该集：保留 shot.id（不重挂载行→不回顶）、就地更新变化字段 / 追加缺失镜。
 * fillOnly=true（找回）：仅填**当前为空**的字段，已完成镜头/字段不覆盖。
 */
function mergeShots(epId: string, incoming: ShotPatch[], fillOnly: boolean): void {
	if (!incoming.length) return;
	const ep = useProjectStore.getState().episodes.find((e) => e.id === epId);
	if (!ep) return;
	const out = [...ep.shots];
	const posByIndex = new Map<number, number>();
	out.forEach((s, i) => posByIndex.set(s.index, i));
	let dirty = false;
	for (const inc of incoming) {
		const pos = posByIndex.get(inc.index);
		if (pos !== undefined) {
			const cur = out[pos];
			const patched: StoryboardShot = { ...cur };
			let changed = false;
			const setF = (key: "scriptSegment" | "storyboardPrompt" | "videoPrompt" | "unifiedPrompt", val?: string) => {
				if (val === undefined) return;
				if (fillOnly && (cur[key] ?? "") !== "") return; // 已有内容不覆盖
				if (val !== cur[key]) { patched[key] = val; changed = true; }
			};
			setF("scriptSegment", inc.scriptSegment);
			setF("storyboardPrompt", inc.storyboardPrompt);
			setF("videoPrompt", inc.videoPrompt);
			setF("unifiedPrompt", inc.unifiedPrompt);
			if (inc.durationSec !== undefined && inc.durationSec !== cur.durationSec && !(fillOnly && cur.durationSec)) {
				patched.durationSec = inc.durationSec; changed = true;
			}
			if (changed) { out[pos] = patched; dirty = true; }
		} else {
			out.push({
				id: `shot-${Date.now()}-${inc.index}-${Math.floor(Math.random() * 1e6)}`,
				index: inc.index, title: `分镜${inc.index}`,
				scriptSegment: inc.scriptSegment || "", prompt: "",
				durationSec: inc.durationSec, storyboardPrompt: inc.storyboardPrompt, videoPrompt: inc.videoPrompt, unifiedPrompt: inc.unifiedPrompt,
				materials: [],
			});
			posByIndex.set(inc.index, out.length - 1);
			dirty = true;
		}
	}
	if (!dirty) return;
	out.sort((a, b) => a.index - b.index);
	useProjectStore.getState().setEpisodeShots(epId, out);
}

/**
 * 解析模型文本并落到分镜——智能拆分与智能推理**同一套卡解析**（parseInferCards，含容错抽取，
 * 未闭合也能出部分卡；toCard 兼容 original_script / script / scriptContent）：
 * - split（智能拆分）：只取每卡 original_script → scriptSegment（不填提示词）；
 * - multi（智能推理·多镜）：每卡 原文 + 故事板 + 视频 三字段；
 * - single（智能推理·单镜）：仅回填该镜两段提示词（原文保留）。
 */
function applyInferText(target: InferTarget, text: string, fillOnly: boolean, streaming: boolean): void {
	// 流式 partial 走 parseInferCardsStream（容错抽取，未闭合也能出部分卡，边出边填）；最终走严格优先的 parseInferCards
	const cards = streaming ? parseInferCardsStream(text) : parseInferCards(text);
	if (!cards.length) return;
	if (target.mode === "single") {
		// 单镜推理：仅回填该镜提示词（原文保留，不覆盖 scriptSegment）。
		// 图视同源 → 只回填 unifiedPrompt；否则回填故事板/视频两段。
		const c = cards[0];
		const st = useProjectStore.getState();
		const sh = st.episodes.find((e) => e.id === target.episodeId)?.shots.find((s) => s.id === target.shotId);
		if (!sh) return; // 分镜已删
		const patch: Partial<StoryboardShot> = {};
		if (target.sameSource) {
			if (c.unifiedPrompt && !(fillOnly && (sh.unifiedPrompt ?? "") !== "")) patch.unifiedPrompt = c.unifiedPrompt;
		} else {
			if (c.storyboardPrompt && !(fillOnly && (sh.storyboardPrompt ?? "") !== "")) patch.storyboardPrompt = c.storyboardPrompt;
			if (c.videoPrompt && !(fillOnly && (sh.videoPrompt ?? "") !== "")) patch.videoPrompt = c.videoPrompt;
		}
		// 卡带指定时长 → 回填本镜时长设置（找回期已有时长不覆盖）
		if (c.duration && c.duration !== sh.durationSec && !(fillOnly && sh.durationSec)) patch.durationSec = c.duration;
		if (Object.keys(patch).length) st.updateShot(target.episodeId, target.shotId!, patch);
		return;
	}
	// 多镜推理(multi) 与 智能拆分(split) **同一套流式落盘**（cardsToPatch 不过滤）：
	// 每卡 → 一行（card_number 一出现即建行）、字段出现即填（split 模板通常只产 original_script→只填原文，
	// infer 模板还产故事板/视频提示词→一并填；图视同源产 unified_prompt→填 unifiedPrompt）。逐字段就位。
	mergeShots(target.episodeId, cardsToPatch(cards, !!target.sameSource), fillOnly);
}

/** 收尾：整集操作（多镜推理 / 智能拆分）重排编号(保留 id) + 落盘；单镜仅落盘 */
function finalizeInfer(target: InferTarget): void {
	const st = useProjectStore.getState();
	if (target.mode === "multi" || target.mode === "split") {
		const ep = st.episodes.find((e) => e.id === target.episodeId);
		if (ep && ep.shots.length > 0) st.setEpisodeShots(target.episodeId, reindex(ep.shots));
	}
	void st.save(true);
}

/** 是否产出了内容（用于把"零产出"判失败而非静默成功） */
function producedSomething(target: InferTarget): boolean {
	const ep = useProjectStore.getState().episodes.find((e) => e.id === target.episodeId);
	if (!ep) return false;
	if (target.mode === "single") {
		const sh = ep.shots.find((s) => s.id === target.shotId);
		return !!(sh && (target.sameSource ? sh.unifiedPrompt : (sh.storyboardPrompt || sh.videoPrompt)));
	}
	return ep.shots.length > 0;
}

/**
 * 新起一次推理（异步，不阻塞）。锁定即由 inferTasks 记录承载；提交确认落 taskId 供找回。
 * 调用方需在调用前完成「覆盖」：多镜清空整集分镜、单镜清空该镜两段提示词。
 */
export function startInfer(spec: StartInferSpec): string {
	const st = useProjectStore.getState();
	// 清掉同目标的旧记录（失败残留 / 重复点击），保证一个目标至多一条 running
	st.inferTasks
		.filter((t) => (spec.mode === "single" ? t.shotId === spec.shotId : t.episodeId === spec.episodeId && t.mode === spec.mode))
		.forEach((t) => st.removeInferTask(t.id));
	const id = uid();
	const task: InferTask = { id, episodeId: spec.episodeId, mode: spec.mode, sameSource: spec.sameSource, shotId: spec.shotId, status: "running", createdAt: Date.now() };
	st.addInferTask(task);
	void st.save(true);

	const target: InferTarget = { episodeId: spec.episodeId, mode: spec.mode, sameSource: spec.sameSource, shotId: spec.shotId };
	// 用途：拆分=storyboard.split；单镜=单卡（同源→unifiedShot）；多镜=多卡（同源→unified）
	const purpose: Purpose =
		spec.mode === "split" ? SPLIT_PURPOSE
			: spec.mode === "single" ? (spec.sameSource ? UNIFIED_SINGLE_PURPOSE : SINGLE_PURPOSE)
				: (spec.sameSource ? UNIFIED_PURPOSE : INFER_PURPOSE);
	runPurpose(purpose, {
		modelKey: spec.modelKey || undefined,
		templateId: spec.templateId,
		variables: spec.variables,
		params: { temperature: 0.7, maxTokens: 65535 },
		onTaskId: (taskId, adapterKey) => {
			useProjectStore.getState().updateInferTask(id, { taskId, adapterKey });
			void useProjectStore.getState().save(true);
		},
		onProgress: (_p, _s, partial) => {
			if (typeof partial === "string" && partial.length > 40) applyInferText(target, partial, false, true);
		},
	})
		.then((r) => {
			if (!useProjectStore.getState().inferTasks.find((t) => t.id === id)) return; // 已被清除（切项目/重起新任务）→ 丢弃
			if (r.status === "success") {
				applyInferText(target, r.resultUri || "", false, false);
				finalizeInfer(target);
				if (!producedSomething(target)) {
					useProjectStore.getState().updateInferTask(id, { status: "failed", error: "未能从模型输出解析出结果，请重试或调整原文。" });
					void useProjectStore.getState().save(true);
					return;
				}
				useProjectStore.getState().removeInferTask(id);
				void useProjectStore.getState().save(true);
			} else if (r.status === "no_model") {
				useProjectStore.getState().updateInferTask(id, { status: "failed", error: "无可用文本模型：请检查「设置 → 管理端」连接与目录拉取后重试。" });
				void useProjectStore.getState().save(true);
			} else {
				useProjectStore.getState().updateInferTask(id, { status: "failed", error: r.error || "推理失败", taskId: r.taskId, adapterKey: r.adapterKey });
				void useProjectStore.getState().save(true);
			}
		})
		.catch((err) => {
			useProjectStore.getState().updateInferTask(id, { status: "failed", error: err instanceof Error ? err.message : "推理失败" });
			void useProjectStore.getState().save(true);
		});
	return id;
}

/**
 * App / 项目加载后调用：把上次未完成的推理接回来。
 * - 有 taskId/adapterKey → 重挂轮询，结果**仅补缺失字段**（已完成镜头不覆盖）；
 * - 无 taskId（提交未确认就断）→ 标失败（释放锁，可重新点击）。
 */
export function resumeInferTasks(): void {
	const st = useProjectStore.getState();
	for (const t of st.inferTasks) {
		if (t.status !== "running") continue;
		const target: InferTarget = { episodeId: t.episodeId, mode: t.mode, sameSource: t.sameSource, shotId: t.shotId };
		if (t.taskId && t.adapterKey) {
			trackTask({
				taskId: t.taskId,
				adapterKey: t.adapterKey,
				onUpdate: (_p, status, resultUri, error, _assetId, partial) => {
					if (typeof partial === "string" && partial.length > 40) applyInferText(target, partial, true, true);
					if (status === "success") {
						applyInferText(target, resultUri || "", true, false);
						finalizeInfer(target);
						useProjectStore.getState().removeInferTask(t.id);
						void useProjectStore.getState().save(true);
					} else if (status === "failed" || status === "lost") {
						useProjectStore.getState().updateInferTask(t.id, { status: "failed", error: error || "推理失败：服务端未找到原任务，请重试。" });
						void useProjectStore.getState().save(true);
					}
				},
			});
		} else {
			st.updateInferTask(t.id, { status: "failed", error: "上次推理未完成（提交未确认），请重新点击智能推理。" });
		}
	}
	void st.save(true);
}
