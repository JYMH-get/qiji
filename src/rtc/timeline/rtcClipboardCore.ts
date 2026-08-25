/**
 * rtcClipboardCore —— 时间轴复制/剪切/粘贴/副本的**纯逻辑**（不碰 store、不生成副作用，全部可单测）。
 *
 * 剪贴板条目 = 「片段模板 + 原轨道身份 + 相对锚点的偏移」：
 *   - 模板**不带 id**——粘贴时现分配新 id，绝不复用原 id（同一 id 出现两次会让选中/落笔/替换全乱套）；
 *   - ⚠ **绝不复制素材实体**：assetId / uri 原样共享，副本与原片段引用同一素材（导出仍按 assetId
 *     去重为单条 material，见 types/rtc 素材唯一性）；
 *   - offsetUs = 该片段起点 − 整批最早起点 ⇒ 粘贴时 `锚点 + offset` 即**保持片段之间的相对时间关系**。
 *
 * ⚠ 在途状态一律不继承（用户定稿的红线）：`status/progress/taskRef/error/originSegId` 全部剥掉。
 *   理由：那是**某一次具体生成任务**的在途状态——taskRef 指向台账里的某一单，复制过去就成了两个
 *   片段抢同一个任务（placeholderSwap 按 segId 接管、终态只能落一处，另一个会被判孤儿转失败）；
 *   originSegId 是「重新生成」的血缘，副本并不是那次重生成，留着会让超分/去字幕误沿用别人的源窗口。
 *   取舍：**允许复制在途占位，但副本落成干净的 pending 占位**（不禁止操作——用户复制占位多半是想
 *   多要一版；把它变成「还没提交过」的占位，用户点生成即可，语义清晰且不会抢别人的任务）。
 * ⚠ **shotRef 不继承（第251轮需求⑧，推翻第240轮补充6 的「两个占位指向同一分镜」，勿回退）**：
 *   用户实报「目前是完全复制，导致俩个素材接收同一结果，失去了复制出来同时出两套结果选择的机会」。
 *   共用同一分镜时，两个片段的提示词/垫图/历史都是同一份，改一个动两个、生成结果也只落一处。
 *   现改为：模板里剥掉 shotRef，落位后由 [segShotBinding.deriveShotForCopy](../panel/segShotBinding.ts)
 *   **派生一个独立分镜**（内容整份复制、标记补镜头、插在源分镜之后 → 重排出「分镜3-1」）。
 *   为此模板旁边留一个 {@link RtcClipEntry.srcShotRef} 只读线索——它**不是**副本的 shotRef，
 *   只是「从哪个分镜派生」的出处；纯素材片段（无 shotRef）不受影响，仍是纯时间窗口复制。
 */
import type { RtcPasteEntry } from "@/lib/rtcOps";
import type { RtcDoc, RtcSegment, RtcTrackType } from "@/types/rtc";

/** 剪贴板里的一条（会话级，不落盘、不跨窗口） */
export interface RtcClipEntry {
	/** 片段模板（无 id，粘贴时现分配） */
	seg: Omit<RtcSegment, "id">;
	/** 复制来源轨道 id（粘贴优先落回原轨） */
	trackId: string;
	trackType: RtcTrackType;
	/** 相对整批最早起点的偏移（微秒） */
	offsetUs: number;
	/**
	 * 源片段的分镜出处（需求⑧）——**副本不继承它作为 shotRef**，仅供落位后派生一个独立分镜。
	 * 源片段没有分镜（纯素材/字幕/复合）时缺省。
	 */
	srcShotRef?: { episodeId: string; shotId: string };
}

/**
 * 片段 → 剪贴板模板：剥 id、在途状态与 **shotRef**；占位片段统一落成干净的 pending。
 * 其余字段（assetId/uri/name/source 窗口/speed/volume/muted/genKind/groupId）原样保留。
 * ⚠ shotRef 剥掉的理由见文件头「需求⑧」：副本要有**自己的**分镜（落位后由调用方派生），
 *   共用会让两个片段抢同一份提示词与同一处结果。
 */
export function copiedSegTemplate(seg: RtcSegment): Omit<RtcSegment, "id"> {
	const { id: _id, status: _s, progress: _p, taskRef: _t, error: _e, originSegId: _o, shotRef: _sr, ...rest } = seg;
	void _id; void _s; void _p; void _t; void _e; void _o; void _sr;
	const template: Omit<RtcSegment, "id"> = { ...rest };
	if (template.kind === "placeholder") template.status = "pending"; // 干净占位：还没提交过，用户点生成即可
	return template;
}

/**
 * 按选中 id 收集剪贴板条目（跨轨道，按起点升序；锚点=整批最早起点）。
 * 一条都没命中返回空数组（调用方据此不动剪贴板——避免一次误操作把已存的剪贴板清空）。
 */
export function buildClipEntries(doc: RtcDoc, ids: string[]): RtcClipEntry[] {
	const want = new Set(ids);
	const picked: Array<{ seg: RtcSegment; trackId: string; trackType: RtcTrackType }> = [];
	for (const t of doc.tracks) {
		for (const s of t.segments) {
			if (want.has(s.id)) picked.push({ seg: s, trackId: t.id, trackType: t.type });
		}
	}
	if (picked.length === 0) return [];
	picked.sort((a, b) => a.seg.targetStartUs - b.seg.targetStartUs);
	const base = picked[0].seg.targetStartUs;
	return picked.map((p) => ({
		seg: copiedSegTemplate(p.seg),
		trackId: p.trackId,
		trackType: p.trackType,
		offsetUs: Math.max(0, p.seg.targetStartUs - base),
		...(p.seg.shotRef ? { srcShotRef: { ...p.seg.shotRef } } : {}),
	}));
}

/** 剪贴板条目 → 可落位的粘贴条目（现分配新 id；newId 由调用方注入以便单测断言） */
export function materializePasteEntries(entries: RtcClipEntry[], newId: () => string): RtcPasteEntry[] {
	return entries.map((e) => ({
		seg: { ...e.seg, id: newId() } as RtcSegment,
		trackId: e.trackId,
		trackType: e.trackType,
		offsetUs: e.offsetUs,
	}));
}

/**
 * 「创建副本」（Ctrl+D）的落点锚点 = 选区**最右缘**——副本紧接选区右侧铺开，
 * 与播放头无关（副本是对选区自身的复制，不该受播放头在哪影响）。选区为空返回 null。
 */
export function duplicateAnchorUs(doc: RtcDoc, ids: string[]): number | null {
	const want = new Set(ids);
	let max: number | null = null;
	for (const t of doc.tracks) {
		for (const s of t.segments) {
			if (!want.has(s.id)) continue;
			const end = s.targetStartUs + s.targetDurationUs;
			if (max == null || end > max) max = end;
		}
	}
	return max;
}
