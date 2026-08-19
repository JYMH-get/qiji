/**
 * materialLimits —— 模型素材数量预检（第145轮，客户端侧）。
 *
 * 管理端可按模型限制 图/视/音 素材数量（catalog 下发 CatalogModel.matLimits）：
 * 键缺省=不限、0=不允许该类素材（如 933 收紧为 903 即「vid:0」禁垫视频）。
 * 客户端在 managedAdapter.submit 组装完 inputs 后同尺预检——超限**请求不发出、明确报错**
 * （绝不静默裁剪：素材与提示词 @ImageN 图例按位对齐，丢一个=整段错位）；服务端 generate/batch 有同款硬闸兜底。
 * ⚠ 与服务端 server/src/materialLimits.ts 同尺（判定与文案一致）——改动两处同步。
 */

export interface MatLimits {
	img?: number;
	vid?: number;
	aud?: number;
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
