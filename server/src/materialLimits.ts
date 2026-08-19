/**
 * materialLimits —— 模型素材数量硬闸（第145轮）。
 *
 * 管理端可按模型限制 图/视/音 素材数量（ModelDef.matLimits）：键缺省=不限（按翻译器/上游既有守卫）、
 * 0=不允许该类素材——如把 933（图9视3音3）收紧为 903，即「视=0」该模型不再收参考视频。
 * 语义=只能收紧：设 935 也不会放宽上游原生能力（翻译器静态能力表仍是最后一道闸）。
 * 超限一律**明确拒单绝不静默裁剪**（素材与提示词 @ImageN 图例按位对齐，丢一个=整段错位，第118/142轮同尺）。
 * ⚠ 客户端有同尺副本 src/lib/materialLimits.ts（提交前预检，文案一致）——改判定/文案两处同步。
 */

export interface MatLimits {
	/** 图片素材上限 */
	img?: number;
	/** 视频素材上限 */
	vid?: number;
	/** 音频素材上限 */
	aud?: number;
}

/** 清洗管理端输入：仅收 img/vid/aud 三键、非负整数（负数/非数丢弃）；全空/非对象 → undefined（=不限） */
export function normMatLimits(v: unknown): MatLimits | undefined {
	if (!v || typeof v !== "object") return undefined;
	const src = v as Record<string, unknown>;
	const out: MatLimits = {};
	for (const k of ["img", "vid", "aud"] as const) {
		const raw = src[k];
		if (raw == null || raw === "") continue;
		const n = Math.floor(Number(raw));
		if (!Number.isFinite(n) || n < 0) continue;
		out[k] = n;
	}
	return Object.keys(out).length ? out : undefined;
}

/** 校验一次生成请求的素材数量；返回错误文案（明确指名类型与数量），通过返回 null */
export function checkMaterialLimits(
	modelLabel: string,
	lim: MatLimits | undefined,
	inputs?: { images?: unknown[]; videos?: unknown[]; audios?: unknown[] } | null,
): string | null {
	if (!lim) return null;
	const kinds = [
		{ n: inputs?.images?.length ?? 0, cap: lim.img, label: "图片" },
		{ n: inputs?.videos?.length ?? 0, cap: lim.vid, label: "视频" },
		{ n: inputs?.audios?.length ?? 0, cap: lim.aud, label: "音频" },
	] as const;
	for (const k of kinds) {
		if (k.cap == null || k.n <= k.cap) continue;
		return k.cap === 0
			? `模型「${modelLabel}」不支持${k.label}素材（本次携带 ${k.n} 个），请移除${k.label}素材或换用支持的模型`
			: `模型「${modelLabel}」最多支持 ${k.cap} 个${k.label}素材（本次携带 ${k.n} 个），请删减后重试`;
	}
	return null;
}
