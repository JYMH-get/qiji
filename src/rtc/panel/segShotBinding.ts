/**
 * segShotBinding —— 普通结果占位（无 shotRef 的视频/图片占位）→ **真实分镜** 的一次性升级。
 * 第240轮补充6 用户定稿：「普通占位要和有原文占位完全一致，包含各种功能键和功能，
 * 不要出现两个样式，不要使用两种实现方法」——统一的办法不是复制 UI，而是**统一数据**：
 * 视频/图片占位从此必有分镜（scriptSegment 空 =「没有原文就空着」），工作台/右栏属性/
 * 生成/断连找回全部走分镜唯一路径（shotGenActions + generationQueue + placeholderSwap）。
 *
 * 两个调用点：
 *   - 时间轴空白右键「添加占位」（segActions）：创建即挂分镜；
 *   - 中栏工作台绑定（RtcCenterStage.WorkbenchBody）：**存量旧占位**选中那一刻补挂（幂等）。
 *
 * 另有一条**派生**路径 {@link deriveShotForCopy}（第251轮需求⑧）：复制/再制/Alt+拖动复制出来的
 * 片段不再共用源分镜，而是派生一个内容相同的独立补镜头（「分镜1」→「分镜1-1」）。
 *
 * ⚠ 三类**绝不升级**（freeGen 链的残余服务对象，内部判定拒绝）：
 *   - 超分/去字幕/重新生成坑位（originSegId 血缘——它们的生成语义在 segActions/派生记录上）；
 *   - 音频占位（库内无音频生成能力，挂分镜=给一排死按钮）；
 *   - 正在生成中的存量自由占位（在途任务记在片段自身 taskRef 上，升级会断它的找回链）。
 *
 * 分镜落在**当前实时剪辑分集**（rtcEpisodeId），编号经 reindexShots 统一（与表格模式一把尺）；
 * 会话草稿（rtcFreeGenStore）里编辑过的提示词随分镜带走（垫素材形状不同不迁移，重拖即可）。
 */
import { resolveEpisodeKey, useProjectStore } from "@/store/projectStore";
import { useRtcStore } from "@/store/rtcStore";
import { reindexShots } from "@/lib/shotReindex";
import type { StoryboardShot } from "@/services/projectFile";
import { liveSegment } from "./rtcGenSink";
import { useRtcFreeGenStore } from "./rtcFreeGenStore";

/**
 * 给占位片段挂真实分镜（幂等：已有 shotRef 直接返回它）。
 * 返回挂上/已有的 {episodeId, shotId}；不该升级（三类拒绝项/片段不存在/非占位符）返回 null。
 */
export function ensureShotForPlaceholder(segId: string): { episodeId: string; shotId: string } | null {
	const seg = liveSegment(segId);
	if (!seg || seg.kind !== "placeholder") return null;
	if (seg.shotRef) return seg.shotRef;
	if (seg.originSegId) return null; // 超分/去字幕/重新生成坑位：血缘语义，勿动
	const kind = seg.genKind ?? seg.media ?? "video";
	if (kind === "audio") return null; // 音频占位：无生成能力
	if (seg.status === "running") return null; // 在途的存量自由占位：升级会断 taskRef 找回链

	const st = useProjectStore.getState();
	const episodeId = resolveEpisodeKey(st.rtcEpisodeId, st.episodes);
	const ep = st.episodes.find((e) => e.id === episodeId);
	if (!ep) return null;

	// 会话草稿迁移：旧「自由占位」编辑过的提示词按产物类型落进对应栏位（同源模式落同源栏）
	const draftPrompt = (useRtcFreeGenStore.getState().drafts[segId]?.prompt ?? "").trim();
	const sameSource = !!st.mediaSettings?.imgVideoSameSource;
	const shot: StoryboardShot = {
		id: `shot-${Date.now()}-x-${Math.floor(Math.random() * 1e6)}`,
		index: ep.shots.length + 1,
		title: "", // 由 reindexShots 统一编号（普通镜 1,2,3…）
		scriptSegment: "", // 用户定稿：没有原文就空着
		prompt: "",
		materials: [],
		durationSec: Math.max(1, Math.round(seg.targetDurationUs / 1_000_000)),
		...(draftPrompt
			? sameSource
				? { unifiedPrompt: draftPrompt }
				: kind === "image"
					? { storyboardPrompt: draftPrompt }
					: { videoPrompt: draftPrompt }
			: {}),
	};
	const shots = reindexShots([...ep.shots, shot]);
	st.setEpisodeShots(episodeId, shots); // 自带去抖落盘（scheduleAutoSave）
	const title = shots.find((s) => s.id === shot.id)?.title || "";

	bindSegToShot(segId, episodeId, shot.id, title);
	return { episodeId, shotId: shot.id };
}

/** 片段挂 shotRef + 名称跟分镜（时间轴「镜」角标/图例命名随之成立）——commitActive 与其它编辑动作同层 */
function bindSegToShot(segId: string, episodeId: string, shotId: string, title: string): void {
	useRtcStore.getState().commitActive((doc) => ({
		...doc,
		tracks: doc.tracks.map((t) => ({
			...t,
			segments: t.segments.map((s) =>
				s.id === segId ? { ...s, shotRef: { episodeId, shotId }, ...(title ? { name: title } : {}) } : s,
			),
		})),
	}));
}

/* ────────────────────────── 复制片段 → 派生独立分镜（第251轮需求⑧） ────────────────────────── */

/**
 * 给「复制出来的片段」派生一个**独立分镜**（用户定稿：「改成复制出来的是独立的，
 * 从分镜1复制出来的是分镜1.1」——即补镜头编号 `分镜1-1`）。
 *
 * 为什么不共用源分镜（推翻第240轮补充6，勿回退）：共用时两个片段的 提示词/垫图/结果历史 是同一份，
 * 改一个动两个、生成结果也只落一处——用户「失去了复制出来同时出两套结果选择的机会」。
 *
 * 派生规则：
 *   - **用户填过的内容整份复制**：原文 / 三种提示词（含 Base 基线）/ 垫图素材（深拷贝数组）/
 *     时长 / 单镜覆盖 overrides；
 *   - **生成结果一律不复制**（storyboardUri·Images / videoUri·Uris / videoActiveKey / 两种派生记录）
 *     ——副本正是「再要一版」的新坑位，各自的结果互不相干；
 *   - 标 `isSupplement` 并**插在源分镜之后**，再走 reindexShots → 编号自然成为「分镜N-1、分镜N-2…」
 *     （⚠ 沿用既有 `-` 分隔符：表格模式与存量项目共用同一把尺，勿改格式）；
 *   - 分镜落在**源分镜所属分集**（不是当前激活分集）——副本是它的派生，跟着源走才不会串集。
 *
 * 幂等/守卫：片段已被删 / 已有 shotRef / 源分镜已删 → 不派生（返回 null，片段保持无 shotRef，
 * 之后进工作台时由 {@link ensureShotForPlaceholder} 兜底挂一个空分镜）。
 */
export function deriveShotForCopy(
	segId: string,
	src: { episodeId: string; shotId: string } | undefined,
): { episodeId: string; shotId: string } | null {
	if (!src) return null;
	const seg = liveSegment(segId);
	if (!seg || seg.shotRef) return null;
	const st = useProjectStore.getState();
	const ep = st.episodes.find((e) => e.id === src.episodeId);
	const srcIdx = ep?.shots.findIndex((s) => s.id === src.shotId) ?? -1;
	if (!ep || srcIdx < 0) return null;
	const from = ep.shots[srcIdx];

	const copy: StoryboardShot = {
		// 身份与编号（title 由 reindexShots 统一重排，这里先留空）
		id: `shot-${Date.now()}-c-${Math.floor(Math.random() * 1e6)}`,
		index: srcIdx + 2,
		title: "",
		isSupplement: true,
		// 用户填过的内容整份带走
		scriptSegment: from.scriptSegment ?? "",
		prompt: from.prompt ?? "",
		materials: from.materials.map((m) => ({ ...m })),
		...(from.storyboardPrompt != null ? { storyboardPrompt: from.storyboardPrompt } : {}),
		...(from.videoPrompt != null ? { videoPrompt: from.videoPrompt } : {}),
		...(from.unifiedPrompt != null ? { unifiedPrompt: from.unifiedPrompt } : {}),
		...(from.storyboardPromptBase != null ? { storyboardPromptBase: from.storyboardPromptBase } : {}),
		...(from.videoPromptBase != null ? { videoPromptBase: from.videoPromptBase } : {}),
		...(from.unifiedPromptBase != null ? { unifiedPromptBase: from.unifiedPromptBase } : {}),
		...(from.durationSec != null ? { durationSec: from.durationSec } : {}),
		...(from.overrides ? { overrides: { ...from.overrides } } : {}),
		// ⚠ 生成结果刻意不带（副本=另一套结果的新坑位）
	};

	const shots = reindexShots([...ep.shots.slice(0, srcIdx + 1), copy, ...ep.shots.slice(srcIdx + 1)]);
	st.setEpisodeShots(ep.id, shots); // 自带去抖落盘
	const title = shots.find((s) => s.id === copy.id)?.title || "";
	bindSegToShot(segId, ep.id, copy.id, title);
	return { episodeId: ep.id, shotId: copy.id };
}

/**
 * 批量版（一次粘贴/再制可能落多段）：逐条派生，返回真派生出来的条数。
 * ⚠ 逐条 setEpisodeShots+commitActive（每条一次编号重排）——粘贴一批的量级很小，
 *   换取「源分镜位置逐条现算」的正确性（前一条插入后，后一条的源下标会变）。
 */
export function deriveShotsForCopies(
	items: { segId: string; src?: { episodeId: string; shotId: string } }[],
): number {
	let n = 0;
	for (const it of items) {
		if (deriveShotForCopy(it.segId, it.src)) n += 1;
	}
	return n;
}
