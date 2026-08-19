/**
 * PromptModal —— 全局提示词放大编辑弹窗（App 根挂一次）。
 * 有素材候选(mentions)时用 PromptMentionEditor（@ImageN 渲染成缩略图胶囊、输入 @ 弹待选框、# 导入项目资产）；
 * 否则退化为纯文本域。取消/保存在顶部；底部为「大模型对话」——按简单指令改写提示词，产出建议可左右对比后选用。
 * 退出语义（第88轮锁定）：**默认保存**——点空白遮罩 / X / Esc / Ctrl+Enter 均保存后关闭；
 * 只有「取消」按钮丢弃修改。
 */
import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { X, Sparkles } from "lucide-react";
import { usePromptModalStore, type PromptModalApi } from "@/store/promptModalStore";
import PromptMentionEditor, { type PromptMentionHandle } from "@/components/PromptMentionEditor";
import { AssetImportDropdown } from "@/components/AssetImportDropdown";
import { effectiveModelKey } from "@/components/ModelPicker";
import { runPurpose } from "@/services/purposeRunner";
import { computeChangedFlags } from "@/lib/wordDiff";
import { presetTag } from "@/lib/presetSchemes";
import type { ShotMaterial } from "@/services/projectFile";

/** 剥掉模型可能包裹的 ```代码块``` 与首尾空白 */
function cleanProposal(s: string): string {
	let t = (s || "").trim();
	const fence = t.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/);
	if (fence) t = fence[1].trim();
	return t;
}

/** 把 text 相对 base 有变化的片段用黄色高亮（对比展示 AI 建议的改动处）*/
function renderDiff(text: string, base: string): React.ReactNode {
	if (!text) return null;
	let flags: boolean[] | undefined;
	try { flags = base && base !== text ? computeChangedFlags(text, base) : undefined; } catch { flags = undefined; }
	if (!flags) return text;
	const out: React.ReactNode[] = [];
	let i = 0, seg = 0;
	while (i < text.length) {
		const on = !!flags[i];
		let j = i + 1; while (j < text.length && !!flags[j] === on) j++;
		const piece = text.slice(i, j);
		out.push(on
			? <mark key={seg++} style={{ background: "rgba(245,196,81,0.28)", color: "#fde68a", borderRadius: 2, padding: "0 1px" }}>{piece}</mark>
			: <span key={seg++}>{piece}</span>);
		i = j;
	}
	return out;
}

/** 把 text 里所有 find 命中处用黄色高亮（一键替换的「将被替换内容」预览） */
function renderFindHighlight(text: string, find: string): React.ReactNode {
	if (!find || !text) return text;
	const parts = text.split(find);
	if (parts.length === 1) return text;
	const out: React.ReactNode[] = [];
	parts.forEach((p, i) => {
		if (i > 0) out.push(<mark key={`m${i}`} style={{ background: "rgba(245,196,81,0.32)", color: "#fde68a", borderRadius: 2, padding: "0 1px" }}>{find}</mark>);
		if (p) out.push(<span key={`s${i}`}>{p}</span>);
	});
	return out;
}

export default function PromptModal() {
	const { open, title, value, placeholder, readOnly, onSave, extra, mentions, onImport, onMatchAssets, presets, close } = usePromptModalStore();
	const [draft, setDraft] = useState(value);
	const taRef = useRef<HTMLTextAreaElement>(null);
	const editorRef = useRef<PromptMentionHandle>(null);
	// 富文本模式(有素材)下：输入 @ 时的待选框屏幕坐标（null=不显示）
	const [mentionPos, setMentionPos] = useState<{ x: number; y: number } | null>(null);
	// 输入 # 时的「导入项目资产」待选框坐标
	const [importPos, setImportPos] = useState<{ x: number; y: number } | null>(null);
	// 「预设方案」下拉坐标
	const [presetPos, setPresetPos] = useState<{ x: number; y: number } | null>(null);
	// 大模型对话：指令输入 / 运行中 / AI 建议（用于对比） / 错误
	const [chatInput, setChatInput] = useState("");
	const [chatBusy, setChatBusy] = useState(false);
	const [proposal, setProposal] = useState<string | null>(null);
	const [chatErr, setChatErr] = useState<string | null>(null);
	// 一键替换：替换栏开关 / 查找串 / 替换串（字面替换非正则）
	const [replOpen, setReplOpen] = useState(false);
	const [findStr, setFindStr] = useState("");
	const [replStr, setReplStr] = useState("");
	// 匹配资产：结果提示（3 秒自动消失）
	const [matchMsg, setMatchMsg] = useState<string | null>(null);
	const matchMsgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const rich = !!mentions;
	const rawCands = mentions ? mentions() : [];
	const presetOptions = presets ? presets() : [];
	// 素材映射给编辑器：id=tag，顺序=候选顺序（materialTags 会据此重算出同样的 @ImageN 编号）
	const mkey = rawCands.map((c) => `${c.tag}|${c.uri}|${c.name}|${c.media}`).join(";");
	const richMaterials = useMemo<ShotMaterial[]>(
		() => rawCands.map((c) => ({ id: c.tag, media: (c.media || "image") as ShotMaterial["media"], name: c.name || "", uri: c.uri || "", kind: "local" } as ShotMaterial)),
		[mkey], // eslint-disable-line react-hooks/exhaustive-deps
	);

	// 供素材栏/拖拽把 @ImageN 插到光标处：富文本走胶囊插入，纯文本走文本插入
	const insertAtCursor = useCallback((text: string) => {
		if (rich) { editorRef.current?.insertMaterial(text.trim(), false); return; }
		const el = taRef.current;
		if (!el) { setDraft((d) => d + text); return; }
		const start = el.selectionStart ?? el.value.length;
		const end = el.selectionEnd ?? start;
		setDraft((d) => d.slice(0, start) + text + d.slice(end));
		requestAnimationFrame(() => { el.focus(); const p = start + text.length; el.setSelectionRange(p, p); });
	}, [rich]);
	const api: PromptModalApi = { insertAtCursor };

	// 插入预设胶囊：富文本走胶囊、纯文本落标记文本（提交时由 resolvePresets 展开成完整预设词）
	const insertPreset = useCallback((id: string, name: string) => {
		if (rich) { editorRef.current?.insertPreset(id, name); return; }
		insertAtCursor(presetTag(id));
	}, [rich, insertAtCursor]);

	useEffect(() => {
		if (open) { setDraft(value); setMentionPos(null); setImportPos(null); setPresetPos(null); setChatInput(""); setProposal(null); setChatBusy(false); setChatErr(null); setReplOpen(false); setFindStr(""); setReplStr(""); setMatchMsg(null); }
	}, [open, value]);

	// @ 候选框开着时：数字键 1-9 快速选中对应候选（capture 拦截，防数字字符落进编辑器）
	useEffect(() => {
		if (!mentionPos || !rich) return;
		const onKey = (e: KeyboardEvent) => {
			const n = Number(e.key);
			if (!Number.isInteger(n) || n < 1 || n > Math.min(9, rawCands.length)) return;
			e.preventDefault();
			e.stopPropagation();
			editorRef.current?.insertMaterial(rawCands[n - 1].tag, true);
			setMentionPos(null);
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [mentionPos, rich, mkey]);

	// 让 AI 按指令改写当前提示词 → 产出建议（流式），供右侧对比后选用
	const askAI = useCallback(async () => {
		const instruction = chatInput.trim();
		if (!instruction || chatBusy) return;
		const modelKey = effectiveModelKey("text") || undefined;
		setChatErr(null); setChatBusy(true); setProposal("");
		const composed = [
			'你是“提示词编辑助手”。根据用户的修改要求，改写下面这段用于 AI 生成的提示词，返回**修改后的完整提示词正文**。',
			'要求：只输出提示词本身，不要任何解释、开场白、引号或代码块标记；尽量保留原有结构、字段与 @素材引用（如 @Image1、{角色:xxx}）。',
			'',
			'【当前提示词】',
			draft,
			'',
			'【修改要求】',
			instruction,
		].join('\n');
		try {
			const res = await runPurpose("script.analyze", {
				prompt: composed,
				modelKey,
				onProgress: (_p, _s, partial) => { if (typeof partial === "string") setProposal(cleanProposal(partial)); },
			});
			if (res.status === "success") setProposal(cleanProposal(res.resultUri || ""));
			else if (res.status === "no_model") { setChatErr("无可用文本模型：请检查「设置 → 管理端」连接与目录拉取后重试。"); setProposal(null); }
			else { setChatErr(`出错了：${res.error || "未知错误"}`); setProposal(null); }
		} catch (e) {
			setChatErr(`出错了：${e instanceof Error ? e.message : "未知错误"}`); setProposal(null);
		} finally {
			setChatBusy(false);
		}
	}, [chatInput, chatBusy, draft]);

	// 一键替换：命中次数按字面子串计（split 计数，不走正则免转义坑）；替换=split/join 全量替换
	const matchCount = findStr ? draft.split(findStr).length - 1 : 0;
	const doReplaceAll = useCallback(() => {
		if (readOnly || !findStr || findStr === replStr) return;
		setDraft((d) => d.split(findStr).join(replStr));
	}, [readOnly, findStr, replStr]);

	const flashMatchMsg = useCallback((msg: string) => {
		setMatchMsg(msg);
		if (matchMsgTimer.current) clearTimeout(matchMsgTimer.current);
		matchMsgTimer.current = setTimeout(() => setMatchMsg(null), 3000);
	}, []);

	// 匹配资产：**委托宿主现成的完整匹配逻辑**（画布=applyAssetMatchToImageNode、资产模式=matchAssets，
	// 含音色声音参考与图例刷新——弹窗不自带匹配规则，单一实现）。宿主以当前草稿为提示词文本执行，
	// 返回更新后的提示词（图例已前置）刷新草稿；素材区（extra 渲染宿主组件）随宿主状态即时更新。
	const doMatchAssets = useCallback(() => {
		if (readOnly || !onMatchAssets) return;
		const r = onMatchAssets(draft);
		if (!r) { flashMatchMsg("未匹配到项目资产（按名称/别名/造型名），且素材区为空"); return; }
		setDraft(r.prompt);
		flashMatchMsg(r.added > 0 ? `已匹配：新增 ${r.added} 条素材，图例已更新` : "已匹配：素材无新增，图例已刷新");
	}, [readOnly, onMatchAssets, draft, flashMatchMsg]);

	// 默认保存退出：除「取消」按钮外，一切退出路径（空白遮罩/X/Esc/Ctrl+Enter）都先落盘再关
	const saveAndClose = useCallback(() => {
		if (!readOnly && onSave && draft !== value) onSave(draft);
		close();
	}, [readOnly, onSave, draft, value, close]);

	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") { if (presetPos) setPresetPos(null); else if (mentionPos) setMentionPos(null); else if (importPos) setImportPos(null); else if (replOpen) setReplOpen(false); else if (proposal !== null) setProposal(null); else saveAndClose(); }
			else if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !readOnly) { onSave?.(draft); close(); }
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, draft, readOnly, onSave, close, saveAndClose, mentionPos, importPos, proposal, replOpen, presetPos]);

	if (!open) return null;

	const btn: React.CSSProperties = {
		padding: "6px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer",
		border: "1px solid rgba(255,255,255,0.12)",
	};
	const smallBtn: React.CSSProperties = { padding: "5px 10px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer", border: "1px solid rgba(255,255,255,0.12)" };
	// 待选框坐标（贴光标下方，防越界）
	const ddLeft = mentionPos ? Math.min(mentionPos.x, window.innerWidth - 272) : 0;
	const ddTop = mentionPos ? Math.min(mentionPos.y + 18, window.innerHeight - 260) : 0;

	const adoptProposal = () => { if (proposal != null) { setDraft(proposal); setProposal(null); } };

	return createPortal(
		<div
			onMouseDown={saveAndClose}
			style={{ position: "fixed", inset: 0, zIndex: 100000, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}
		>
			<div
				onMouseDown={(e) => e.stopPropagation()}
				style={{ position: "relative", width: "min(1000px, 94vw)", height: "min(720px, 88vh)", display: "flex", flexDirection: "column", background: "rgba(22,27,38,0.99)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 16, boxShadow: "0 24px 80px rgba(0,0,0,0.6)", overflow: "hidden" }}
			>
				{/* 匹配资产结果提示（3 秒自动消失） */}
				{matchMsg && (
					<div style={{ position: "absolute", top: 48, right: 16, zIndex: 5, padding: "6px 12px", fontSize: 12, color: "#e6e6e6", background: "rgba(28,33,45,0.98)", border: "1px solid rgba(139,92,246,0.5)", borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.5)", maxWidth: 420 }}>
						{matchMsg}
					</div>
				)}
				{/* 顶栏：标题 + 取消/保存（上移到此）+ 关闭 */}
				<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "12px 16px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
					<span style={{ fontSize: 14, fontWeight: 600, color: "#fff", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
					<div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
						{!readOnly && (
							<>
								{presetOptions.length > 0 && (
									<button
										onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setPresetPos(presetPos ? null : { x: r.left, y: r.bottom }); }}
										title="插入出图预设方案（提交时替换为完整预设词）"
										style={{ ...smallBtn, background: presetPos ? "rgba(245,158,11,0.2)" : "rgba(255,255,255,0.06)", color: presetPos ? "#fcd34d" : "rgba(255,255,255,0.8)", borderColor: presetPos ? "rgba(245,158,11,0.5)" : "rgba(255,255,255,0.12)" }}
									>▦ 预设方案</button>
								)}
								{onMatchAssets && (
									<button
										onClick={doMatchAssets}
										title="扫描当前提示词，把命中的项目资产（含绑定音色）加入素材区并更新图例前缀"
										style={{ ...smallBtn, background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.8)" }}
									>匹配资产</button>
								)}
								<button
									onClick={() => setReplOpen((v) => !v)}
									title="一键替换：把所有指定文本替换为另一文本"
									style={{ ...smallBtn, background: replOpen ? "rgba(139,92,246,0.22)" : "rgba(255,255,255,0.06)", color: replOpen ? "#c4b5fd" : "rgba(255,255,255,0.8)", borderColor: replOpen ? "rgba(139,92,246,0.55)" : "rgba(255,255,255,0.12)" }}
								>替换</button>
								<button onClick={close} title="丢弃本次修改并关闭" style={{ ...smallBtn, background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.8)" }}>取消</button>
								<button onClick={() => { onSave?.(draft); close(); }} style={{ ...smallBtn, background: "#8b5cf6", color: "#fff", borderColor: "#8b5cf6" }}>保存</button>
							</>
						)}
						<button onClick={saveAndClose} title="保存并关闭（丢弃修改请点「取消」）" style={{ background: "transparent", border: "none", color: "rgba(255,255,255,0.6)", cursor: "pointer", display: "flex" }}>
							<X size={16} />
						</button>
					</div>
				</div>

				{extra && (
					<div style={{ padding: "10px 16px", borderBottom: "1px solid rgba(255,255,255,0.08)", maxHeight: 180, overflowY: "auto" }} className="Qiji-scroll-thin">
						<div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", marginBottom: 6 }}>素材（＋上传 · 双击放大 · 右键/✕ 删除）；提示词框输入 <b style={{ color: "#c4b5fd" }}>@</b> 引用已有素材、输入 <b style={{ color: "#7dd3fc" }}>#</b> 导入并引用项目资产</div>
						{extra(api)}
					</div>
				)}

				{/* 一键替换栏：查找 → 替换为，实时命中计数，全部替换 */}
				{!readOnly && replOpen && (
					<div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 16px", borderBottom: "1px solid rgba(255,255,255,0.08)", background: "rgba(139,92,246,0.06)" }}>
						<input
							autoFocus
							value={findStr}
							onChange={(e) => setFindStr(e.target.value)}
							onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); doReplaceAll(); } }}
							placeholder="查找内容"
							spellCheck={false}
							style={{ flex: 1, minWidth: 0, padding: "6px 10px", fontSize: 12, color: "#e6e6e6", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, outline: "none" }}
						/>
						<span style={{ fontSize: 12, color: "rgba(255,255,255,0.45)", flexShrink: 0 }}>→</span>
						<input
							value={replStr}
							onChange={(e) => setReplStr(e.target.value)}
							onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); doReplaceAll(); } }}
							placeholder="替换为（留空=删除）"
							spellCheck={false}
							style={{ flex: 1, minWidth: 0, padding: "6px 10px", fontSize: 12, color: "#e6e6e6", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, outline: "none" }}
						/>
						<span title="输入查找内容后，正文切为预览并黄色高亮所有将被替换处" style={{ fontSize: 11, color: findStr ? (matchCount > 0 ? "#c4b5fd" : "rgba(255,255,255,0.4)") : "rgba(255,255,255,0.3)", flexShrink: 0, minWidth: 44, textAlign: "center" }}>
							{findStr ? `${matchCount} 处` : "—"}
						</span>
						<button
							onClick={doReplaceAll}
							disabled={!findStr || matchCount === 0 || findStr === replStr}
							style={{ ...smallBtn, flexShrink: 0, background: !findStr || matchCount === 0 || findStr === replStr ? "rgba(139,92,246,0.35)" : "#8b5cf6", color: "#fff", borderColor: "#8b5cf6", cursor: !findStr || matchCount === 0 || findStr === replStr ? "not-allowed" : "pointer" }}
						>全部替换</button>
						<button onClick={() => setReplOpen(false)} title="收起替换栏" style={{ background: "transparent", border: "none", color: "rgba(255,255,255,0.5)", cursor: "pointer", display: "flex", flexShrink: 0 }}>
							<X size={14} />
						</button>
					</div>
				)}

				{/* 主体：左=编辑器；有 AI 建议时右侧并排对比 */}
				<div style={{ flex: 1, position: "relative", display: "flex", minHeight: 0 }}>
					<div style={{ flex: 1, display: "flex", minHeight: 0, minWidth: 0, borderRight: proposal !== null ? "1px solid rgba(255,255,255,0.08)" : "none" }}>
						{replOpen && findStr ? (
							/* 一键替换的命中高亮预览（只读）：黄色=将被替换的内容；清空查找串/收起替换栏即恢复编辑 */
							<div className="Qiji-scroll-thin" style={{ flex: 1, overflowY: "auto", padding: 16, fontSize: 14, lineHeight: 1.7, color: "#e6e6e6", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
								{renderFindHighlight(draft, findStr)}
							</div>
						) : rich ? (
							<PromptMentionEditor
								ref={editorRef}
								value={draft}
								materials={richMaterials}
								presets={presetOptions}
								onChange={setDraft}
								onMentionProbe={(pos) => setMentionPos(pos)}
								onImportProbe={(pos) => setImportPos(onImport ? pos : null)}
								placeholder={placeholder}
								style={{ flex: 1, padding: 16, fontSize: 14, lineHeight: 1.7, color: "#e6e6e6", overflowY: "auto" }}
								className="Qiji-scroll-thin"
							/>
						) : (
							<textarea
								ref={taRef}
								autoFocus
								value={draft}
								readOnly={readOnly}
								onChange={(e) => setDraft(e.target.value)}
								placeholder={placeholder}
								spellCheck={false}
								className="Qiji-scroll-thin"
								style={{ flex: 1, resize: "none", padding: 16, background: "transparent", color: "#e6e6e6", fontSize: 14, lineHeight: 1.7, border: "none", outline: "none", fontFamily: "inherit" }}
							/>
						)}
					</div>
					{/* 右侧：AI 修改建议（对比 + 选用）*/}
					{proposal !== null && (
						<div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0 }}>
							<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "8px 12px", borderBottom: "1px solid rgba(255,255,255,0.08)", background: "rgba(139,92,246,0.08)" }}>
								<span style={{ fontSize: 12, fontWeight: 600, color: "#c4b5fd", display: "inline-flex", alignItems: "center", gap: 5 }}>
									<Sparkles size={13} /> AI 修改建议{chatBusy ? "（生成中…）" : "（黄色=改动处）"}
								</span>
								<div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
									<button onClick={() => setProposal(null)} style={{ ...smallBtn, padding: "4px 9px", background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.8)" }}>放弃</button>
									<button onClick={adoptProposal} disabled={chatBusy || !proposal} style={{ ...smallBtn, padding: "4px 9px", background: chatBusy || !proposal ? "rgba(139,92,246,0.4)" : "#8b5cf6", color: "#fff", borderColor: "#8b5cf6", cursor: chatBusy || !proposal ? "not-allowed" : "pointer" }}>采用</button>
								</div>
							</div>
							<div className="Qiji-scroll-thin" style={{ flex: 1, overflowY: "auto", padding: 16, fontSize: 14, lineHeight: 1.7, color: "#e6e6e6", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
								{proposal ? renderDiff(proposal, draft) : <span style={{ color: "rgba(255,255,255,0.4)" }}>{chatBusy ? "正在思考…" : "（无内容）"}</span>}
							</div>
						</div>
					)}
				</div>

				{/* 底栏：大模型对话框（按指令改写提示词）*/}
				{!readOnly && (
					<div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "10px 16px", borderTop: "1px solid rgba(255,255,255,0.08)" }}>
						{chatErr && <div style={{ fontSize: 11, color: "#f87171" }}>{chatErr}</div>}
						<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
							<Sparkles size={15} style={{ color: "#c4b5fd", flexShrink: 0 }} />
							<input
								value={chatInput}
								onChange={(e) => setChatInput(e.target.value)}
								onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void askAI(); } }}
								placeholder="让 AI 修改提示词，如：压缩到 3 个镜头 / 语言更精炼 / 增加环境音效…"
								disabled={chatBusy}
								style={{ flex: 1, minWidth: 0, padding: "7px 10px", fontSize: 12, color: "#e6e6e6", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, outline: "none" }}
							/>
							<button onClick={() => void askAI()} disabled={chatBusy || !chatInput.trim()}
								style={{ ...btn, display: "inline-flex", alignItems: "center", gap: 5, background: chatBusy || !chatInput.trim() ? "rgba(139,92,246,0.4)" : "#8b5cf6", color: "#fff", borderColor: "#8b5cf6", cursor: chatBusy || !chatInput.trim() ? "not-allowed" : "pointer", flexShrink: 0 }}>
								{chatBusy ? <span className="sb-spin">↻</span> : <Sparkles size={13} />}{chatBusy ? "思考中" : "发送"}
							</button>
						</div>
						<span style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>AI 会按指令改写「当前提示词」，产出建议在右侧对比，点「采用」替换 · 关闭即保存（Esc/点空白/X 均保存），丢弃修改请点「取消」</span>
					</div>
				)}
			</div>
			{/* @ 待选框：输入 @ 时弹出，点击把素材以缩略图胶囊插入 */}
			{rich && mentionPos && rawCands.length > 0 && (
				<div
					className="Qiji-scroll-thin"
					style={{ position: "fixed", left: ddLeft, top: ddTop, width: 260, maxHeight: 240, overflowY: "auto", background: "rgba(28,33,45,0.99)", border: "1px solid rgba(255,255,255,0.14)", borderRadius: 10, boxShadow: "0 12px 40px rgba(0,0,0,0.6)", zIndex: 100001, padding: 4 }}
					onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
				>
					{rawCands.map((c, i) => (
						<div
							key={c.tag + i}
							onClick={() => { editorRef.current?.insertMaterial(c.tag, true); setMentionPos(null); }}
							style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 6px", borderRadius: 6, cursor: "pointer" }}
							onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.08)")}
							onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
						>
							<div style={{ width: 34, height: 34, borderRadius: 5, overflow: "hidden", flexShrink: 0, background: "rgba(255,255,255,0.06)", display: "flex", alignItems: "center", justifyContent: "center" }}>
								{c.media === "audio" ? <span style={{ fontSize: 15 }}>🎵</span>
									: c.media === "video" ? <video src={c.uri} style={{ width: "100%", height: "100%", objectFit: "cover" }} muted preload="metadata" />
										: c.uri ? <img src={c.uri} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : null}
							</div>
							<div style={{ minWidth: 0, flex: 1 }}>
								<div style={{ fontSize: 12, color: "#c4b5fd", fontWeight: 600 }}>{c.tag}</div>
								{c.name && <div style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.name}</div>}
							</div>
							{i < 9 && <span style={{ flexShrink: 0, fontSize: 10, color: "rgba(255,255,255,0.4)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 4, padding: "0 4px", lineHeight: "14px" }}>{i + 1}</span>}
						</div>
					))}
				</div>
			)}
			{/* # 待选框：导入项目资产 → 加入素材区 + 光标处插入 @ 胶囊（# 被吃掉） */}
			{rich && onImport && importPos && (
				<AssetImportDropdown
					pos={importPos}
					onClose={() => setImportPos(null)}
					onPick={(a) => { const r = onImport(a); if (r) editorRef.current?.insertMaterial(r.tag, true, r.mat); setImportPos(null); }}
				/>
			)}
			{/* 预设方案下拉：选中即在光标处插入预设胶囊 */}
			{presetPos && presetOptions.length > 0 && (
				<>
					<div style={{ position: "fixed", inset: 0, zIndex: 100002 }} onMouseDown={() => setPresetPos(null)} />
					<div
						className="Qiji-scroll-thin"
						style={{ position: "fixed", left: Math.min(presetPos.x, window.innerWidth - 316), top: Math.min(presetPos.y + 4, window.innerHeight - 300), width: 304, maxHeight: 320, overflowY: "auto", background: "rgba(28,33,45,0.99)", border: "1px solid rgba(255,255,255,0.14)", borderRadius: 10, boxShadow: "0 12px 40px rgba(0,0,0,0.6)", zIndex: 100003, padding: 4 }}
						onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
					>
						{presetOptions.map((p) => (
							<div
								key={p.id}
								onClick={() => { insertPreset(p.id, p.name); setPresetPos(null); }}
								style={{ padding: "7px 9px", borderRadius: 6, cursor: "pointer", fontSize: 12, color: "#fcd34d", fontWeight: 600 }}
								onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.08)")}
								onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
							>▦ {p.name}</div>
						))}
					</div>
				</>
			)}
		</div>,
		document.body,
	);
}
