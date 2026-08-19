/**
 * JianyiWindow —— 单个「简一助手」对话窗口（可同时打开多个=分身）。
 *
 * 每个窗口独立持有：当前浏览的会话 id、输入框内容、待发图片/文件、面板坐标。
 * 所有会话数据在 jianyiAssistantStore 共享，写操作按 sessionId 定位，故多窗口互不串扰。
 * 功能：流式对话、上传图片、上传文件（文本类文件抽正文喂模型/二进制按文件名引用）、
 *       会话切换/新建/重命名/删除、输入框高度自适应、消息复制/重新回答/回退。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
	Bot,
	Send,
	Plus,
	Trash2,
	ImagePlus,
	Paperclip,
	FileText,
	X,
	MessageSquare,
	ChevronsRight,
	Loader2,
	Pencil,
	Check,
	CopyPlus,
	Copy,
	RefreshCw,
	Undo2,
	AlertTriangle,
} from "lucide-react";
import { useJianyiStore, feedStream, endStream, type JyMessage, type JyImage, type JyFile } from "@/store/jianyiAssistantStore";
import {
	JY_WARN_CHARS,
	JY_BLOCK_CHARS,
	SUMMARY_TEMPLATE_ID,
	HANDOFF_TEMPLATE_ID,
	sessionContextChars,
	formatConversation,
} from "@/lib/jianyiContext";
import { useCatalogStore } from "@/store/catalogStore";
import { managedClient } from "@/services/managedClient";
import { runPurpose } from "@/services/purposeRunner";
import { openLightbox } from "@/store/lightboxStore";
import { confirmDialog } from "@/lib/confirmDialog";
import { usePromptModalStore } from "@/store/promptModalStore";
import { mediaFilesFromClipboard } from "@/lib/clipboardMedia";

const accent = "#22c55e";
const panel: React.CSSProperties = { background: "#12151c", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10 };
const PANEL_W = 400;
const MEMORY_TURNS = 12; // 记忆窗口：最近 N 条消息作上下文
const MAX_INPUT_H = 200; // 输入框自适应最大高度（超出滚动）

// 窗口尺寸（拖右下角缩放）：全局记忆，所有简一助手窗口共用上次大小
const SIZE_KEY = "Qiji:jianyiSize";
const MIN_W = 320;
const MIN_H = 360;
const clampN = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
export function loadSize(): { w: number; h: number } {
	try {
		const r = localStorage.getItem(SIZE_KEY);
		if (r) {
			const s = JSON.parse(r);
			if (s?.w && s?.h) return { w: s.w, h: s.h };
		}
	} catch {
		/* ignore */
	}
	const vh = typeof window !== "undefined" ? window.innerHeight : 800;
	return { w: PANEL_W, h: Math.min(740, Math.round(vh * 0.86)) };
}
function saveSize(s: { w: number; h: number }) {
	try {
		localStorage.setItem(SIZE_KEY, JSON.stringify(s));
	} catch {
		/* ignore */
	}
}

const SYSTEM_PROMPT =
	"你是「简一助手」，奇迹漫剧创作平台内置的中文 AI 助手，擅长创作、剧本、绘画构思与通用问答。请用简洁、专业、友好的中文回答用户。";

let _mid = 0;
function mid(role: string): string {
	_mid += 1;
	return `${role}-${Date.now().toString(36)}-${_mid}`;
}

function fmtTime(ts: number): string {
	const d = new Date(ts);
	return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

/**
 * 生成可展示的本地缩略图（data: URL）。
 * Tauri CSP 的 img-src 只允许 'self'/blob:/data:/asset:，不允许 http(s)，故上传后的服务器 url
 * 不能直接 <img>；这里把本地原图降采样成小 data URL 用于展示（同时可持久化、重开仍在）。
 */
function fileToThumb(file: File, max = 512): Promise<string> {
	return new Promise((resolve, reject) => {
		const objUrl = URL.createObjectURL(file);
		const img = new Image();
		img.onload = () => {
			try {
				const scale = Math.min(1, max / Math.max(img.width || max, img.height || max));
				const w = Math.max(1, Math.round((img.width || max) * scale));
				const h = Math.max(1, Math.round((img.height || max) * scale));
				const canvas = document.createElement("canvas");
				canvas.width = w;
				canvas.height = h;
				const ctx = canvas.getContext("2d");
				if (!ctx) throw new Error("no 2d ctx");
				ctx.drawImage(img, 0, 0, w, h);
				URL.revokeObjectURL(objUrl);
				resolve(canvas.toDataURL("image/webp", 0.82));
			} catch (e) {
				URL.revokeObjectURL(objUrl);
				reject(e);
			}
		};
		img.onerror = () => {
			URL.revokeObjectURL(objUrl);
			reject(new Error("缩略图生成失败"));
		};
		img.src = objUrl;
	});
}

/** 文本类文件（可抽取正文喂给模型）判定：按 MIME 或扩展名。 */
const TEXT_EXT =
	/\.(txt|md|markdown|json|jsonl|csv|tsv|log|xml|yaml|yml|html?|css|js|jsx|mjs|cjs|ts|tsx|py|java|c|cc|cpp|h|hpp|cs|go|rs|rb|php|sh|bat|ps1|ini|conf|cfg|toml|sql|vue|svelte|srt|ass|vtt|tex)$/i;
function isTextFile(f: File): boolean {
	return (
		f.type.startsWith("text/") ||
		f.type === "application/json" ||
		f.type === "application/xml" ||
		f.type === "application/javascript" ||
		TEXT_EXT.test(f.name)
	);
}

const FILE_TEXT_CAP = 60000; // 单个附件注入模型的正文上限（字符），超出截断

function capText(t: string): string {
	return t.length > FILE_TEXT_CAP
		? `${t.slice(0, FILE_TEXT_CAP)}\n…（文件过长，已截断，原文共 ${t.length} 字）`
		: t;
}

/** Word .docx 判定（ZIP 容器，非纯文本，需解包 word/document.xml 抽正文） */
function isDocx(f: File): boolean {
	return (
		f.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
		/\.docx$/i.test(f.name)
	);
}

/** 解码 XML 实体（数字实体 + 常见命名实体；&amp; 最后解，避免二次解码） */
function decodeXmlEntities(s: string): string {
	return s
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

/** 解包 .docx 抽取正文：段落 <w:p> → 换行、<w:tab/> → 制表、<w:br/> → 换行，其余标签剥除。 */
async function extractDocxText(f: File): Promise<string | undefined> {
	try {
		const { default: JSZip } = await import("jszip");
		const zip = await JSZip.loadAsync(await f.arrayBuffer());
		const doc = zip.file("word/document.xml");
		if (!doc) return undefined;
		const xml = await doc.async("string");
		const text = xml
			.replace(/<w:tab\b[^>]*\/?>/g, "\t")
			.replace(/<w:br\b[^>]*\/?>/g, "\n")
			.replace(/<\/w:p>/g, "\n")
			.replace(/<[^>]+>/g, "");
		return decodeXmlEntities(text).replace(/\n{3,}/g, "\n\n").trim() || undefined;
	} catch {
		return undefined;
	}
}

/** 读取文件正文（喂模型用）：.docx 解包抽正文、文本类直读；其余（二进制）返回 undefined。 */
async function readFileText(f: File): Promise<string | undefined> {
	if (isDocx(f)) {
		const t = await extractDocxText(f);
		return t ? capText(t) : undefined;
	}
	if (!isTextFile(f)) return undefined;
	try {
		return capText(await f.text());
	} catch {
		return undefined;
	}
}

/** 人类可读的文件大小 */
function fmtSize(n?: number): string {
	if (!n && n !== 0) return "";
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function copyText(t: string): Promise<boolean> {
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(t);
			return true;
		}
	} catch {
		/* fall through */
	}
	try {
		const ta = document.createElement("textarea");
		ta.value = t;
		ta.style.position = "fixed";
		ta.style.opacity = "0";
		document.body.appendChild(ta);
		ta.select();
		document.execCommand("copy");
		document.body.removeChild(ta);
		return true;
	} catch {
		return false;
	}
}

/** 把会话历史拼成喂给文本模型的单条提示词（会话记忆） */
function buildConversationPrompt(msgs: JyMessage[]): string {
	const recent = msgs.slice(-MEMORY_TURNS);
	const lines = recent.map((m) => {
		const who = m.role === "user" ? "用户" : "助手";
		let c = m.content || "";
		if (m.role === "user" && m.images?.length) c = `${c}（附带 ${m.images.length} 张图片，见上传内容）`.trim();
		if (m.role === "user" && m.files?.length) {
			const parts = m.files.map((f) =>
				f.text
					? `【附件：${f.name}】\n${f.text}\n【附件结束】`
					: `（附带文件：${f.name}，为二进制文件，内容无法读取）`,
			);
			c = `${c}\n${parts.join("\n")}`.trim();
		}
		return `${who}：${c}`;
	});
	return `${SYSTEM_PROMPT}\n\n【对话】\n${lines.join("\n\n")}\n\n助手：`;
}

interface RowProps {
	msg: JyMessage;
	streaming: boolean;
	isLastAssistant: boolean;
	copiedId: string | null;
	onCopy: (m: JyMessage) => void;
	onRegen: () => void;
	onRollback: () => void;
}

function MessageRow({ msg, streaming, isLastAssistant, copiedId, onCopy, onRegen, onRollback }: RowProps) {
	const isUser = msg.role === "user";
	const hasText = !!msg.content;
	const showActions = hasText && !(isLastAssistant && streaming); // 流式中的占位不显示
	return (
		<div className="group" style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: isUser ? "flex-end" : "flex-start" }}>
			{msg.images && msg.images.length > 0 && (
				<div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: isUser ? "flex-end" : "flex-start", maxWidth: "92%" }}>
					{msg.images.map((im, i) => {
						const shown = im.previewUrl || im.url;
						return (
							<img
								key={i}
								src={shown}
								alt={im.name || "图片"}
								onDoubleClick={() => openLightbox({ uri: shown, name: im.name || "图片", media: "image" })}
								title="双击放大"
								style={{ width: 84, height: 84, objectFit: "cover", borderRadius: 8, border: "1px solid rgba(255,255,255,0.12)", cursor: "zoom-in" }}
							/>
						);
					})}
				</div>
			)}
			{msg.files && msg.files.length > 0 && (
				<div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: isUser ? "flex-end" : "flex-start", maxWidth: "92%" }}>
					{msg.files.map((f, i) => (
						<div
							key={i}
							title={`${f.name}${f.size ? ` · ${fmtSize(f.size)}` : ""}${f.text ? "（正文已随消息发送）" : "（二进制文件，仅按文件名引用）"}`}
							style={{ display: "flex", alignItems: "center", gap: 6, maxWidth: 200, padding: "6px 9px", borderRadius: 8, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)" }}
						>
							<FileText size={14} color={accent} style={{ flexShrink: 0 }} />
							<span style={{ fontSize: 11.5, color: "rgba(255,255,255,0.85)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.name}</span>
						</div>
					))}
				</div>
			)}
			{(msg.content || (!msg.images?.length && !msg.files?.length)) && (
				<div
					style={{
						maxWidth: "92%",
						borderRadius: 12,
						padding: "8px 11px",
						fontSize: 12.5,
						lineHeight: 1.6,
						whiteSpace: "pre-wrap",
						wordBreak: "break-word",
						background: isUser ? accent : msg.error ? "rgba(239,68,68,0.12)" : "rgba(255,255,255,0.06)",
						color: isUser ? "#06280f" : msg.error ? "#fca5a5" : "rgba(255,255,255,0.92)",
						border: msg.error ? "1px solid rgba(239,68,68,0.4)" : "none",
					}}
				>
					{msg.content || "…"}
				</div>
			)}
			{/* 操作行：复制（所有消息）/ 重新回答·回退（末条助手）。末条助手常显，其余悬停显示。 */}
			{showActions && (
				<div
					className={isLastAssistant ? "" : "opacity-0 group-hover:opacity-100 transition-opacity"}
					style={{ display: "flex", gap: 2, alignItems: "center", padding: "0 2px" }}
				>
					<button title="复制" onClick={() => onCopy(msg)} style={rowBtn}>
						{copiedId === msg.id ? <Check size={12} color={accent} /> : <Copy size={12} />}
					</button>
					{isLastAssistant && !streaming && (
						<>
							<button title="重新回答" onClick={onRegen} style={rowBtn}>
								<RefreshCw size={12} />
							</button>
							<button title="回退（撤回这一轮，文本回到输入框）" onClick={onRollback} style={rowBtn}>
								<Undo2 size={12} />
							</button>
						</>
					)}
					<span style={{ fontSize: 9.5, color: "rgba(255,255,255,0.3)", marginLeft: 2 }}>{fmtTime(msg.timestamp)}</span>
				</div>
			)}
		</div>
	);
}

interface JianyiWindowProps {
	initialSessionId: string;
	initX: number;
	initY: number;
	onClose: () => void;
	onClone: () => void;
	/** 弹出模式：占满独立窗口、无拖动/缩放/关闭/分身（由 OS 窗口承载） */
	popout?: boolean;
}

export default function JianyiWindow({ initialSessionId, initX, initY, onClose, onClone, popout = false }: JianyiWindowProps) {
	const sessions = useJianyiStore((s) => s.sessions);
	const streamingIds = useJianyiStore((s) => s.streamingIds);
	const promptModalOpen = usePromptModalStore((s) => s.open);

	const [sessionId, setSessionId] = useState(initialSessionId);
	const session = useMemo(() => sessions.find((s) => s.id === sessionId), [sessions, sessionId]);
	const messages = session?.messages ?? [];
	const streaming = streamingIds.includes(sessionId);

	// 会话被删/失效 → 回退到第一个会话
	useEffect(() => {
		if (sessions.length && !sessions.some((s) => s.id === sessionId)) setSessionId(sessions[0].id);
	}, [sessions, sessionId]);

	// 输入 / 待发图片 / 待发文件 / 上传态
	const [input, setInput] = useState("");
	const [pending, setPending] = useState<JyImage[]>([]);
	const [pendingFiles, setPendingFiles] = useState<JyFile[]>([]);
	const [uploading, setUploading] = useState(false);
	const [copiedId, setCopiedId] = useState<string | null>(null);
	// 上下文总结进行中（summary=总结本次对话 / handoff=总结至新窗口继续）
	const [summarizing, setSummarizing] = useState<null | "summary" | "handoff">(null);
	const fileRef = useRef<HTMLInputElement>(null);
	const attachRef = useRef<HTMLInputElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const taRef = useRef<HTMLTextAreaElement>(null);

	// 会话列表 / 重命名
	const [listOpen, setListOpen] = useState(false);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editTitle, setEditTitle] = useState("");

	// 面板拖动（每窗口独立坐标，初始为分身/打开时的级联坐标）
	const [panelPos, setPanelPos] = useState<{ x: number; y: number }>({ x: initX, y: initY });
	const panelDragRef = useRef<{ offX: number; offY: number } | null>(null);
	const [panelDrag, setPanelDrag] = useState<{ x: number; y: number } | null>(null);

	// 面板尺寸（拖右下角缩放，全局记忆）
	const [size, setSize] = useState(loadSize);

	// 文本模型
	const catalog = useCatalogStore((s) => s.catalog);
	const textModels = useMemo(() => (catalog?.models ?? []).filter((m) => m.capability === "text"), [catalog]);
	// 第132轮：设置面板无全局默认模型——未指定时自动取第一个文本模型
	const wantModel = session?.model || textModels[0]?.id || "";
	const modelValue = textModels.some((m) => m.id === wantModel) ? wantModel : "";

	// 上下文上限（用户定稿）：≥6 万字提示新开窗口；≥8 万字禁止继续对话，只留两个总结按钮
	const ctxChars = useMemo(() => sessionContextChars(messages), [messages]);
	const ctxBlocked = ctxChars >= JY_BLOCK_CHARS;
	const ctxWarned = !ctxBlocked && ctxChars >= JY_WARN_CHARS;

	// 自动滚到底部
	useEffect(() => {
		if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
	}, [messages, streaming]);

	// 输入框高度自适应（auto → scrollHeight，封顶 MAX_INPUT_H）
	useEffect(() => {
		const ta = taRef.current;
		if (!ta) return;
		ta.style.height = "auto";
		ta.style.height = `${Math.min(ta.scrollHeight, MAX_INPUT_H)}px`;
	}, [input]);

	const startPanelDrag = (e: React.MouseEvent) => {
		const rect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
		panelDragRef.current = { offX: e.clientX - rect.left, offY: e.clientY - rect.top };
		setPanelDrag({ x: rect.left, y: rect.top });
		const onMove = (ev: MouseEvent) => {
			const d = panelDragRef.current;
			if (!d) return;
			setPanelDrag({ x: ev.clientX - d.offX, y: ev.clientY - d.offY });
		};
		const onUp = (ev: MouseEvent) => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
			const d = panelDragRef.current;
			panelDragRef.current = null;
			if (d) {
				// 自由拖动（不做硬边界）：仅保留 ~40px 可抓取区，防止窗口被拖到完全不可见而无法找回
				const x = Math.min(Math.max(ev.clientX - d.offX, 40 - size.w), window.innerWidth - 40);
				const y = Math.min(Math.max(ev.clientY - d.offY, 4), Math.max(4, window.innerHeight - 40));
				setPanelPos({ x, y });
			}
			setPanelDrag(null);
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
	};

	// 右下角缩放：拖动改宽高，松手落盘（全局记忆）
	const startResize = (e: React.MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		const sx = e.clientX;
		const sy = e.clientY;
		const w0 = size.w;
		const h0 = size.h;
		let latest = { w: w0, h: h0 };
		const onMove = (ev: MouseEvent) => {
			latest = {
				w: clampN(w0 + (ev.clientX - sx), MIN_W, window.innerWidth - 24),
				h: clampN(h0 + (ev.clientY - sy), MIN_H, window.innerHeight - 24),
			};
			setSize(latest);
		};
		const onUp = () => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
			saveSize(latest);
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
	};

	/** 图片文件 → 上传 OSS（TP 临时资产）→ 加入待发区。文件选择与粘贴共用。 */
	const addImageFiles = async (files: File[]) => {
		const imgs = files.filter((f) => f.type.startsWith("image/"));
		if (imgs.length === 0) return;
		setUploading(true);
		try {
			for (const f of imgs) {
				const previewUrl = await fileToThumb(f).catch(() => undefined); // CSP 安全的本地展示图
				const res = await managedClient.uploadAsset(f, f.name || "chat-image.png", "TP");
				setPending((prev) => [...prev, { id: res.id, url: res.url, previewUrl, name: f.name }]);
			}
		} catch (e) {
			alert(`图片上传失败：${(e as Error).message}`);
		} finally {
			setUploading(false);
			if (fileRef.current) fileRef.current.value = "";
		}
	};

	const onPickImages = (files: FileList | null) => {
		if (files && files.length > 0) void addImageFiles(Array.from(files));
	};

	/** 非图片文件 → 上传 OSS（TP 临时资产）→ 加入待发区。文本类文件同时抽取正文喂给模型。 */
	const addAttachFiles = async (files: File[]) => {
		if (files.length === 0) return;
		setUploading(true);
		try {
			for (const f of files) {
				const text = await readFileText(f); // 文本类文件抽正文，二进制为 undefined
				const res = await managedClient.uploadAsset(f, f.name || "file", "TP");
				setPendingFiles((prev) => [...prev, { id: res.id, url: res.url, name: f.name || "文件", size: f.size, mime: f.type, text }]);
			}
		} catch (e) {
			alert(`文件上传失败：${(e as Error).message}`);
		} finally {
			setUploading(false);
			if (attachRef.current) attachRef.current.value = "";
		}
	};

	/** 通用文件选择（「上传文件」按钮）：图片走垫图路径、其余走附件路径。 */
	const onPickFiles = (files: FileList | null) => {
		if (!files || files.length === 0) return;
		const arr = Array.from(files);
		const imgs = arr.filter((f) => f.type.startsWith("image/"));
		const others = arr.filter((f) => !f.type.startsWith("image/"));
		if (imgs.length) void addImageFiles(imgs);
		if (others.length) void addAttachFiles(others);
	};

	/** 粘贴 → 图片转垫图、其余文件转附件（挂在窗口根上，输入框粘贴冒泡到这里） */
	const onPaste = (e: React.ClipboardEvent) => {
		if (ctxBlocked) return; // 封锁态不再收新素材（纯文本粘贴由 textarea disabled 天然拦截）
		const media = mediaFilesFromClipboard(e.nativeEvent);
		const clipFiles = Array.from(e.nativeEvent.clipboardData?.files ?? []);
		const imgs = media.filter((f) => f.type.startsWith("image/"));
		const others = clipFiles.filter((f) => !f.type.startsWith("image/"));
		if (imgs.length === 0 && others.length === 0) return; // 纯文本粘贴走原生行为
		e.preventDefault();
		if (imgs.length) void addImageFiles(imgs);
		if (others.length) void addAttachFiles(others);
	};

	/** 生成（流式）：会话历史须以用户消息结尾；追加助手占位后跑模型。send/重新回答 共用。 */
	const doGenerate = async (sid: string) => {
		const store = useJianyiStore.getState();
		const sess = store.getSession(sid);
		if (!sess) return;
		const history = sess.messages;
		const prompt = buildConversationPrompt(history);
		const lastUser = [...history].reverse().find((m) => m.role === "user");
		const imgs = lastUser?.images?.map((i) => ({ id: i.id, url: i.url })) ?? undefined;

		store.addMessage(sid, { id: mid("assistant"), role: "assistant", content: "", timestamp: Date.now() });
		store.setStreaming(sid, true); // 先标记，首 token 前显示「正在思考」

		const res = await runPurpose("script.analyze", {
			prompt,
			modelKey: sess.model || undefined,
			input: imgs && imgs.length ? { images: imgs } : undefined,
			// 每 ~5s 一跳的流式全文 → 交给打字机逐字揭示
			onProgress: (_p, _s, partial) => {
				if (typeof partial === "string" && partial) feedStream(sid, partial);
			},
		});

		if (res.status === "success") {
			endStream(sid, res.resultUri || "（模型未返回内容）", false);
		} else if (res.status === "no_model") {
			endStream(sid, "⚠️ 无可用文本模型。请检查「设置 → 管理端」连接与目录拉取后重试。", true);
		} else {
			endStream(sid, `⚠️ 出错了：${res.error}`, true);
		}
	};

	/**
	 * 【总结本次对话】：完整对话转录原样发服务端（零采样零截断），提示词组装在服务端
	 * （模板 jianyi.summary）；总结性语言作为助手消息落回当前会话（流式打字机）。
	 */
	const runSummary = async () => {
		if (streaming || summarizing) return;
		const sid = sessionId;
		const store = useJianyiStore.getState();
		const sess = store.getSession(sid);
		if (!sess || sess.messages.length === 0) return;
		const transcript = formatConversation(sess.messages);
		setSummarizing("summary");
		try {
			store.addMessage(sid, { id: mid("assistant"), role: "assistant", content: "", timestamp: Date.now() });
			store.setStreaming(sid, true);
			const res = await runPurpose("chat.summarize", {
				templateId: SUMMARY_TEMPLATE_ID,
				variables: { 对话内容: transcript },
				modelKey: sess.model || undefined,
				onProgress: (_p, _s, partial) => {
					if (typeof partial === "string" && partial) feedStream(sid, partial);
				},
			});
			if (res.status === "success") {
				endStream(sid, res.resultUri || "（模型未返回内容）", false);
			} else if (res.status === "no_model") {
				endStream(sid, "⚠️ 无可用文本模型。请检查「设置 → 管理端」连接与目录拉取后重试。", true);
			} else {
				endStream(sid, `⚠️ 总结失败：${res.error}`, true);
			}
		} finally {
			setSummarizing(null);
		}
	};

	/**
	 * 【总结至新窗口继续】：完整对话转录原样发服务端（零采样零截断），提示词组装在服务端
	 * （模板 jianyi.handoff）；生成提示性语言（交接提示词）→ 新建会话并切换过去，
	 * 交接词预填输入框，用户确认后发送即续。
	 */
	const runHandoff = async () => {
		if (streaming || summarizing) return;
		const store = useJianyiStore.getState();
		const sess = store.getSession(sessionId);
		if (!sess || sess.messages.length === 0) return;
		const transcript = formatConversation(sess.messages);
		setSummarizing("handoff");
		try {
			const res = await runPurpose("chat.summarize", {
				templateId: HANDOFF_TEMPLATE_ID,
				variables: { 对话内容: transcript },
				modelKey: sess.model || undefined,
			});
			if (res.status === "success" && res.resultUri) {
				const st = useJianyiStore.getState();
				const newId = st.newSession();
				if (sess.model) st.setSessionModel(newId, sess.model); // 延续原会话的模型选择
				const base = (sess.title || "对话").slice(0, 15);
				st.renameSession(newId, `${base} · 续`);
				setSessionId(newId);
				setListOpen(false);
				setInput(res.resultUri);
				setPending([]);
				setPendingFiles([]);
			} else if (res.status === "no_model") {
				alert("无可用文本模型。请检查「设置 → 管理端」连接与目录拉取后重试。");
			} else {
				alert(`总结失败：${res.status === "failed" ? res.error : "模型未返回内容"}`);
			}
		} finally {
			setSummarizing(null);
		}
	};

	const send = async () => {
		const text = input.trim();
		if ((!text && pending.length === 0 && pendingFiles.length === 0) || streaming || uploading || ctxBlocked) return;
		const sid = sessionId;
		useJianyiStore.getState().addMessage(sid, {
			id: mid("user"),
			role: "user",
			content: text,
			images: pending.length ? pending : undefined,
			files: pendingFiles.length ? pendingFiles : undefined,
			timestamp: Date.now(),
		});
		setInput("");
		setPending([]);
		setPendingFiles([]);
		await doGenerate(sid);
	};

	const regenerate = async () => {
		if (streaming || ctxBlocked) return;
		const sid = sessionId;
		useJianyiStore.getState().dropLastAssistant(sid);
		await doGenerate(sid);
	};

	const rollback = () => {
		if (streaming) return;
		const popped = useJianyiStore.getState().popLastExchange(sessionId);
		if (popped) {
			setInput(popped.text);
			setPending(popped.images ?? []);
			setPendingFiles(popped.files ?? []);
		}
	};

	const copyMessage = async (m: JyMessage) => {
		if (await copyText(m.content)) {
			setCopiedId(m.id);
			setTimeout(() => setCopiedId((c) => (c === m.id ? null : c)), 1200);
		}
	};

	const onKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			void send();
		}
	};

	const commitRename = () => {
		if (editingId) useJianyiStore.getState().renameSession(editingId, editTitle);
		setEditingId(null);
	};

	const lastAssistantId = useMemo(() => {
		for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "assistant") return messages[i].id;
		return null;
	}, [messages]);

	// 「正在思考」仅在首 token 前显示；一旦开始逐字输出就隐藏
	const lastMsg = messages[messages.length - 1];
	const showThinking = streaming && lastMsg?.role === "assistant" && !lastMsg.content;

	const panelStyle: React.CSSProperties = panelDrag ? { left: panelDrag.x, top: panelDrag.y } : { left: panelPos.x, top: panelPos.y };
		const rootStyle: React.CSSProperties = popout
			? { position: "fixed", inset: 0, width: "100%", height: "100%", display: "flex", flexDirection: "column", background: panel.background, border: "none", borderRadius: 0 }
			: { position: "fixed", zIndex: promptModalOpen ? 100100 : 9000, width: size.w, height: size.h, display: "flex", flexDirection: "column", ...panel, boxShadow: "0 10px 40px rgba(0,0,0,0.55)", ...panelStyle };

	return (
		<div className="jy-window" style={rootStyle} onPaste={onPaste}>
			{/* 标题栏（弹出模式不可拖动，由 OS 窗口承载移动/关闭） */}
			<div onMouseDown={popout ? undefined : startPanelDrag} title={popout ? undefined : "拖动标题栏可移动"} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", borderBottom: "1px solid rgba(255,255,255,0.08)", cursor: popout ? "default" : panelDrag ? "grabbing" : "grab", userSelect: "none" }}>
				<div style={{ display: "flex", alignItems: "center", gap: 8, color: "#fff", fontSize: 14, fontWeight: 600 }}>
					<Bot size={17} color={accent} /> 简一助手
				</div>
				<div style={{ display: "flex", alignItems: "center", gap: 6 }} onMouseDown={(e) => e.stopPropagation()}>
					<button title="会话列表" onClick={() => setListOpen((v) => !v)} style={iconBtn(listOpen)}>
						<MessageSquare size={15} />
					</button>
					<button title="新对话" onClick={() => { const id = useJianyiStore.getState().newSession(); setSessionId(id); setListOpen(false); }} style={iconBtn(false)}>
						<Plus size={15} />
					</button>
					{!popout && (
						<>
							<button title="分身（新开一个简一助手窗口）" onClick={onClone} style={iconBtn(false)}>
								<CopyPlus size={15} />
							</button>
							<button title="关闭此窗口" onClick={onClose} style={iconBtn(false)}>
								<ChevronsRight size={15} />
							</button>
						</>
					)}
				</div>
			</div>

			{/* 顶部：当前会话名 + 模型选择 */}
			<div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
				<span title={session?.title} style={{ flex: 1, fontSize: 12, color: "rgba(255,255,255,0.6)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
					{session?.title || "新对话"}
				</span>
				<select
					value={modelValue}
					onChange={(e) => session && useJianyiStore.getState().setSessionModel(session.id, e.target.value)}
					title="选择文本模型"
					style={{ fontSize: 11.5, background: "#1b1f29", color: "rgba(255,255,255,0.8)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6, padding: "3px 6px", maxWidth: 150 }}
				>
					<option value="">{textModels.length ? "请选择模型…" : "无可用模型"}</option>
					{textModels.map((m) => (
						<option key={m.id} value={m.id}>{m.label}</option>
					))}
				</select>
			</div>

			{/* 会话列表（下拉） */}
			{listOpen && (
				<div style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", maxHeight: 240, overflowY: "auto", background: "rgba(0,0,0,0.2)" }}>
					{sessions.map((s) => {
						const active = s.id === sessionId;
						return (
							<div
								key={s.id}
								onClick={() => { setSessionId(s.id); setListOpen(false); }}
								style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", cursor: "pointer", background: active ? "rgba(34,197,94,0.12)" : "transparent", borderLeft: "2px solid " + (active ? accent : "transparent") }}
							>
								{editingId === s.id ? (
									<>
										<input
											autoFocus
											value={editTitle}
											onClick={(e) => e.stopPropagation()}
											onChange={(e) => setEditTitle(e.target.value)}
											onKeyDown={(e) => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") setEditingId(null); }}
											style={{ flex: 1, fontSize: 12, background: "#1b1f29", color: "#fff", border: "1px solid rgba(255,255,255,0.18)", borderRadius: 5, padding: "3px 6px" }}
										/>
										<button title="确定" onClick={(e) => { e.stopPropagation(); commitRename(); }} style={miniBtn}><Check size={13} /></button>
									</>
								) : (
									<>
										<MessageSquare size={13} color={active ? accent : "rgba(255,255,255,0.4)"} />
										<span style={{ flex: 1, fontSize: 12, color: active ? "#fff" : "rgba(255,255,255,0.7)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.title || "新对话"}</span>
										<button title="重命名" onClick={(e) => { e.stopPropagation(); setEditingId(s.id); setEditTitle(s.title); }} style={miniBtn}><Pencil size={12} /></button>
										<button title="删除会话" onClick={(e) => { e.stopPropagation(); void (async () => { if (await confirmDialog(`删除会话「${s.title || "新对话"}」？`)) useJianyiStore.getState().deleteSession(s.id); })(); }} style={{ ...miniBtn, color: "#f87171" }}><Trash2 size={12} /></button>
									</>
								)}
							</div>
						);
					})}
				</div>
			)}

			{/* 消息区 */}
			<div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
				{messages.length === 0 ? (
					<div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, color: "rgba(255,255,255,0.4)", textAlign: "center" }}>
						<Bot size={36} color="rgba(34,197,94,0.4)" />
						<p style={{ fontSize: 12.5, lineHeight: 1.6, maxWidth: 240 }}>我是简一助手，可以陪你聊创作、写剧本、出点子。<br />支持上传图片和文件（文本类文件会读给我），会话会被记住。</p>
					</div>
				) : (
					messages.map((m) => (
						<MessageRow
							key={m.id}
							msg={m}
							streaming={streaming}
							isLastAssistant={m.id === lastAssistantId}
							copiedId={copiedId}
							onCopy={copyMessage}
							onRegen={() => void regenerate()}
							onRollback={rollback}
						/>
					))
				)}
				{showThinking && (
					<div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "rgba(255,255,255,0.5)" }}>
						<Loader2 size={13} className="animate-spin" /> 正在思考…
					</div>
				)}
			</div>

			{/* 待发图片 / 文件预览 */}
			{(pending.length > 0 || pendingFiles.length > 0 || uploading) && (
				<div style={{ display: "flex", gap: 6, flexWrap: "wrap", padding: "8px 14px 0", alignItems: "center" }}>
					{pending.map((im, i) => (
						<div key={i} style={{ position: "relative", width: 48, height: 48 }}>
							<img src={im.previewUrl || im.url} alt={im.name} style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 6, border: "1px solid rgba(255,255,255,0.14)" }} />
							<button title="移除" onClick={() => setPending((prev) => prev.filter((_, j) => j !== i))} style={{ position: "absolute", top: -6, right: -6, width: 18, height: 18, borderRadius: "50%", border: "none", background: "#ef4444", color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
								<X size={11} />
							</button>
						</div>
					))}
					{pendingFiles.map((f, i) => (
						<div key={`f-${i}`} title={`${f.name}${f.size ? ` · ${fmtSize(f.size)}` : ""}${f.text ? "（正文将发给模型）" : "（二进制文件，仅按文件名引用）"}`} style={{ position: "relative", display: "flex", alignItems: "center", gap: 6, maxWidth: 180, height: 48, padding: "0 10px", borderRadius: 8, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.14)" }}>
							<FileText size={16} color={accent} style={{ flexShrink: 0 }} />
							<div style={{ minWidth: 0 }}>
								<div style={{ fontSize: 11, color: "rgba(255,255,255,0.85)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.name}</div>
								<div style={{ fontSize: 9.5, color: f.text ? accent : "rgba(255,255,255,0.4)" }}>{f.text ? "可读取" : fmtSize(f.size)}</div>
							</div>
							<button title="移除" onClick={() => setPendingFiles((prev) => prev.filter((_, j) => j !== i))} style={{ position: "absolute", top: -6, right: -6, width: 18, height: 18, borderRadius: "50%", border: "none", background: "#ef4444", color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
								<X size={11} />
							</button>
						</div>
					))}
					{uploading && (
						<div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "rgba(255,255,255,0.5)" }}>
							<Loader2 size={13} className="animate-spin" /> 上传中…
						</div>
					)}
				</div>
			)}

			{/* 上下文上限提示：≥6万字提示新开窗口；≥8万字封锁输入，只留两个总结按钮 */}
			{(ctxWarned || ctxBlocked) && (
				<div
					style={{
						margin: "8px 12px 0",
						padding: "8px 10px",
						borderRadius: 10,
						border: `1px solid ${ctxBlocked ? "rgba(239,68,68,0.4)" : "rgba(245,158,11,0.4)"}`,
						background: ctxBlocked ? "rgba(239,68,68,0.10)" : "rgba(245,158,11,0.10)",
						display: "flex",
						flexDirection: "column",
						gap: 8,
					}}
				>
					<div style={{ display: "flex", alignItems: "flex-start", gap: 7 }}>
						<AlertTriangle size={14} color={ctxBlocked ? "#f87171" : "#fbbf24"} style={{ flexShrink: 0, marginTop: 1 }} />
						<span style={{ fontSize: 11.5, lineHeight: 1.55, color: ctxBlocked ? "#fca5a5" : "#fcd34d" }}>
							{ctxBlocked
								? `本对话上下文已达 ${(ctxChars / 10000).toFixed(1)} 万字（上限 ${JY_BLOCK_CHARS / 10000} 万），无法继续发送消息。可总结本次对话留档，或总结后到新窗口继续。`
								: `本对话上下文已达 ${(ctxChars / 10000).toFixed(1)} 万字，建议新开窗口继续，以免影响回复质量。`}
						</span>
					</div>
					{ctxBlocked && (
						<div style={{ display: "flex", gap: 8 }}>
							<button
								onClick={() => void runSummary()}
								disabled={streaming || !!summarizing}
								style={ctxActBtn(streaming || !!summarizing)}
							>
								{summarizing === "summary" ? <Loader2 size={12} className="animate-spin" /> : null}
								总结本次对话
							</button>
							<button
								onClick={() => void runHandoff()}
								disabled={streaming || !!summarizing}
								style={ctxActBtn(streaming || !!summarizing)}
							>
								{summarizing === "handoff" ? <Loader2 size={12} className="animate-spin" /> : null}
								总结至新窗口继续
							</button>
						</div>
					)}
				</div>
			)}

			{/* 输入区（高度自适应） */}
			<div style={{ padding: 12, borderTop: "1px solid rgba(255,255,255,0.06)" }}>
				<div style={{ display: "flex", alignItems: "flex-end", gap: 8, background: "rgba(255,255,255,0.05)", borderRadius: 12, padding: "8px 10px" }}>
					<input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => onPickImages(e.target.files)} />
					<input ref={attachRef} type="file" multiple hidden onChange={(e) => onPickFiles(e.target.files)} />
					<button title="上传图片" onClick={() => fileRef.current?.click()} disabled={uploading || ctxBlocked} style={{ ...iconBtn(false), flexShrink: 0, opacity: uploading || ctxBlocked ? 0.4 : 1 }}>
						<ImagePlus size={16} />
					</button>
					<button title="上传文件（Word/文本/字幕/代码等，可读取的会把正文发给模型）" onClick={() => attachRef.current?.click()} disabled={uploading || ctxBlocked} style={{ ...iconBtn(false), flexShrink: 0, opacity: uploading || ctxBlocked ? 0.4 : 1 }}>
						<Paperclip size={16} />
					</button>
					<textarea
						ref={taRef}
						value={input}
						onChange={(e) => setInput(e.target.value)}
						onKeyDown={onKeyDown}
						disabled={ctxBlocked}
						placeholder={ctxBlocked ? "上下文已达上限，请使用上方按钮总结本次对话，或总结后到新窗口继续" : "给简一助手发消息…（Enter 发送，Shift+Enter 换行，可粘贴图片/文件）"}
						rows={1}
						style={{ flex: 1, resize: "none", background: "transparent", border: "none", outline: "none", color: "#fff", fontSize: 12.5, maxHeight: MAX_INPUT_H, lineHeight: 1.5, overflowY: "auto", opacity: ctxBlocked ? 0.5 : 1 }}
					/>
					{(() => {
						const hasPayload = !!input.trim() || pending.length > 0 || pendingFiles.length > 0;
						const active = hasPayload && !streaming && !ctxBlocked;
						return (
							<button
								onClick={() => void send()}
								disabled={!hasPayload || streaming || uploading || ctxBlocked}
								style={{ flexShrink: 0, width: 30, height: 30, borderRadius: 8, border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", background: active ? accent : "rgba(255,255,255,0.08)", color: active ? "#06280f" : "rgba(255,255,255,0.3)" }}
							>
								<Send size={15} />
							</button>
						);
					})()}
				</div>
			</div>

			{/* 右下角缩放手柄：拖动调整宽高（全局记忆）。弹出模式由 OS 窗口缩放，不显示。 */}
			{!popout && (
				<div onMouseDown={startResize} title="拖动调整窗口大小" style={{ position: "absolute", right: 0, bottom: 0, width: 18, height: 18, cursor: "nwse-resize", zIndex: 3 }}>
					<svg width="18" height="18" viewBox="0 0 18 18" style={{ display: "block" }}>
						<path d="M13 17 L17 13 M8 17 L17 8" stroke="rgba(255,255,255,0.4)" strokeWidth="1.6" fill="none" />
					</svg>
				</div>
			)}
		</div>
	);
}

/** 上下文封锁条上的动作按钮（总结本次对话 / 总结至新窗口继续） */
function ctxActBtn(disabled: boolean): React.CSSProperties {
	return {
		flex: 1,
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		gap: 5,
		padding: "6px 8px",
		borderRadius: 8,
		border: "1px solid rgba(34,197,94,0.45)",
		background: "rgba(34,197,94,0.12)",
		color: disabled ? "rgba(255,255,255,0.35)" : accent,
		fontSize: 11.5,
		fontWeight: 600,
		cursor: disabled ? "default" : "pointer",
		opacity: disabled ? 0.6 : 1,
	};
}

function iconBtn(active: boolean): React.CSSProperties {
	return {
		width: 28,
		height: 28,
		borderRadius: 6,
		border: "1px solid " + (active ? accent : "rgba(255,255,255,0.14)"),
		background: active ? "rgba(34,197,94,0.15)" : "rgba(255,255,255,0.05)",
		color: active ? accent : "rgba(255,255,255,0.75)",
		cursor: "pointer",
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
	};
}

const miniBtn: React.CSSProperties = {
	width: 22,
	height: 22,
	borderRadius: 5,
	border: "none",
	background: "transparent",
	color: "rgba(255,255,255,0.6)",
	cursor: "pointer",
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	flexShrink: 0,
};

const rowBtn: React.CSSProperties = {
	width: 22,
	height: 20,
	borderRadius: 5,
	border: "none",
	background: "transparent",
	color: "rgba(255,255,255,0.55)",
	cursor: "pointer",
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	flexShrink: 0,
};
