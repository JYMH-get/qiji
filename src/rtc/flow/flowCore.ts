/**
 * flowCore —— 实时剪辑「AI 生成」分步工作台的**纯逻辑**（零 store/React 依赖，可单测）。
 *
 * 四步工作台（剧本 → 剧集拆分 → 资产拆分 → 分镜）各步的状态派生与模板变量组装：
 *  - scriptBrief：剧本摘要（字数 + 前几行预览），第①步折叠区块显示；
 *  - episodesBrief：分集概览（集数/分镜数/是否已有成果——重拆覆盖确认用，语义与 Frame1693 hasContent 一致）；
 *  - buildExtractVariables：资产拆分模板变量（与 Frame1693 handleExtractAssets/handleContinueExtraction
 *    同构：编号+名称+变体的紧凑查重清单；续提模式把群像并入角色列表）。
 *
 * ⚠ 提示词正文只在服务端——这里只组装 templateId 之外的**变量数据**，不含任何模板正文。
 */

/** "C01-<ts>-<n>" → "C01"（与 Frame1693/assetVars 同规） */
export function codeFromId(id: string): string {
	const m = String(id || "").match(/^([A-Za-z]+\d+[A-Za-z]*)/);
	return m ? m[1] : "";
}

function compactAssetLine(a: any): string {
	const code = codeFromId(a?.id);
	const vs = Array.isArray(a?.variants) && a.variants.length
		? `（变体: ${a.variants.map((v: any) => v.label || v.name).filter(Boolean).join(" / ")}）`
		: "";
	return `${[code, a?.name].filter(Boolean).join(" ")}${vs}`;
}

/** 资产查重清单：编号 + 名称 +（变体标签），空数组回退占位文案（与 Frame1693 formatAssetsForDedup 同构） */
export function fmtAssetList(arr: any[] | undefined, emptyHint: string): string {
	if (!arr || arr.length === 0) return emptyHint;
	return arr.map(compactAssetLine).join("、");
}

/** 当前时间变量（与 Frame1693 同格式 YYYY/MM/DD HH:MM:SS） */
export function nowVariable(now: Date = new Date()): string {
	const p = (v: number) => String(v).padStart(2, "0");
	return `${now.getFullYear()}/${p(now.getMonth() + 1)}/${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
}

export interface ExtractVarsInput {
	scriptText: string;
	visualStyle: string;
	characters: any[]; scenes: any[]; items: any[]; organisms: any[]; crowds: any[];
	/** 续提模式（handleContinueExtraction 同构）：角色列表 = 角色 + 群像 */
	continueMode?: boolean;
	now?: Date;
}

/** 资产拆分模板变量（首提/续提共用；正文权威在服务端，这里只发数据变量） */
export function buildExtractVariables(inp: ExtractVarsInput): Record<string, string> {
	return {
		视觉风格: inp.visualStyle,
		原文: inp.scriptText,
		角色列表: fmtAssetList(inp.continueMode ? [...(inp.characters || []), ...(inp.crowds || [])] : inp.characters, "无角色数据"),
		场景列表: fmtAssetList(inp.scenes, "无场景数据"),
		物品列表: fmtAssetList(inp.items, "无物品/道具数据"),
		生物列表: fmtAssetList(inp.organisms, "无生物数据"),
		当前时间: nowVariable(inp.now),
	};
}

export interface ScriptBrief {
	/** 去首尾空白后的字数 */
	chars: number;
	/** 前几行预览（截断加省略号） */
	preview: string;
	empty: boolean;
}

/** 剧本摘要：字数 + 前 maxLines 个非空行（合并展示，超 maxChars 截断） */
export function scriptBrief(text: string, maxLines = 2, maxChars = 72): ScriptBrief {
	const t = (text || "").trim();
	if (!t) return { chars: 0, preview: "", empty: true };
	const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, maxLines);
	let preview = lines.join(" / ");
	if (preview.length > maxChars) preview = `${preview.slice(0, maxChars)}…`;
	return { chars: t.length, preview, empty: false };
}

export interface EpisodesBrief {
	count: number;
	shotCount: number;
	/**
	 * 已有拆分成果（多集、或任一集带正文/分镜）——再次拆分=整体覆盖须确认。
	 * 新项目的单个空默认分集不算（与 Frame1693 handleSplitEpisodes 同语义）。
	 */
	hasContent: boolean;
}

export function episodesBrief(episodes: Array<{ scriptText?: string; shots?: any[] }>): EpisodesBrief {
	const eps = episodes || [];
	const shotCount = eps.reduce((s, e) => s + (e.shots?.length || 0), 0);
	const hasContent = eps.length > 1 || eps.some((e) => (e.shots?.length || 0) > 0 || !!e.scriptText?.trim());
	return { count: eps.length, shotCount, hasContent };
}

/** 重拆覆盖确认文案（与 Frame1693 同款） */
export function splitOverwriteMessage(b: EpisodesBrief): string {
	return (
		`⚠ 再次拆分将覆盖现有 ${b.count} 集分集` +
		`${b.shotCount ? `及其全部 ${b.shotCount} 个分镜（含推理结果/故事板图/视频引用）` : ""}，覆盖后无法恢复。\n\n确定要重新拆分吗？`
	);
}
