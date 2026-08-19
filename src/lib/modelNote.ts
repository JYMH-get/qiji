/**
 * 模型备注（第166轮）：画布面板悬浮「积分消耗」图标时显示的说明文案。
 * 取值：管理端「模型 → 设置 → 备注」优先（catalog note 字段，用户可见、≤30s 热更）；
 * 未设=默认按 matLimits 派生「参考素材上限」文案（键缺省=不限、0=不允许该类素材）。
 * 本地 CLI 渠道（LibTV/即梦）无 catalog 模型 → 返回空串=不显示提示。
 */
export function modelNoteText(
	m?: { note?: string; matLimits?: { img?: number; vid?: number; aud?: number } } | null,
): string {
	if (!m) return "";
	const note = m.note?.trim();
	if (note) return note;
	const L = m.matLimits;
	if (!L || (L.img == null && L.vid == null && L.aud == null)) return "参考素材数量：不限（按模型能力）";
	const t = (v?: number) => (v == null ? "不限" : v === 0 ? "不支持" : String(v));
	return `参考素材上限：图 ${t(L.img)} · 视频 ${t(L.vid)} · 音频 ${t(L.aud)}`;
}
