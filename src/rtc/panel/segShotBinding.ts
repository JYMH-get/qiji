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

	// 片段挂 shotRef + 名称跟分镜（时间轴「镜」角标/图例命名随之成立）——commitActive 与其它编辑动作同层
	useRtcStore.getState().commitActive((doc) => ({
		...doc,
		tracks: doc.tracks.map((t) => ({
			...t,
			segments: t.segments.map((s) =>
				s.id === segId ? { ...s, shotRef: { episodeId, shotId: shot.id }, ...(title ? { name: title } : {}) } : s,
			),
		})),
	}));
	return { episodeId, shotId: shot.id };
}
