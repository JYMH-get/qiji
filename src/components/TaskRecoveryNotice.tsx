/**
 * TaskRecoveryNotice —— 任务找回通知（第204轮，App 根挂载的自订阅小组件）。
 *
 * 请求台账（requestLedgerStore）判定某个已完成任务的投递目标（项目/画布/节点）已被删除时，
 * 条目转为 orphaned，本组件在右上角弹出通知：告知「任务已完成但落盘位置已删」并给出找回的
 * 结果链接（媒体=公网直链可复制；文本=正文可复制）。关闭单条=该条销账；不自动消失——
 * 花了积分的结果，必须等用户亲眼看到。
 */
import { useState } from "react";
import { createPortal } from "react-dom";
import { PackageSearch, X, Copy, Check } from "lucide-react";
import { useRequestLedgerStore, dismissLedgerNotice } from "@/store/requestLedgerStore";
import { buildOrphanNoticeText, resultKindLabel, type LedgerEntry } from "@/lib/requestLedgerCore";

async function copyText(text: string): Promise<boolean> {
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch { /* 回退 execCommand */ }
	try {
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.style.position = "fixed";
		ta.style.opacity = "0";
		document.body.appendChild(ta);
		ta.select();
		const ok = document.execCommand("copy");
		document.body.removeChild(ta);
		return ok;
	} catch {
		return false;
	}
}

function NoticeCard({ entry }: { entry: LedgerEntry }) {
	const [copied, setCopied] = useState(false);
	const link = entry.result?.url ?? "";
	const text = entry.result?.text ?? "";
	const payload = link || text;
	const when = new Date(entry.finishedAt ?? entry.submittedAt).toLocaleString();
	return (
		<div
			style={{
				background: "#12151c", border: "1px solid rgba(104,144,248,0.35)", borderRadius: 12,
				padding: "10px 12px", boxShadow: "0 14px 44px rgba(0,0,0,0.55)",
			}}
		>
			<div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
				<PackageSearch size={15} color="#6890F8" style={{ flexShrink: 0, marginTop: 2 }} />
				<div style={{ flex: 1, minWidth: 0 }}>
					<div style={{ fontSize: 12.5, fontWeight: 700, color: "#9db8fa", marginBottom: 3 }}>
						任务找回通知 · {entry.projectName || "未知项目"} / {entry.nodeTitle || entry.nodeType}
					</div>
					<div style={{ fontSize: 11.5, lineHeight: 1.65, color: "rgba(255,255,255,0.78)", wordBreak: "break-all" }}>
						{buildOrphanNoticeText(entry)}
					</div>
					{text && !link && (
						<div
							style={{
								marginTop: 6, maxHeight: 96, overflow: "auto", fontSize: 11, lineHeight: 1.6,
								color: "rgba(255,255,255,0.6)", background: "rgba(255,255,255,0.04)",
								borderRadius: 8, padding: "6px 8px", whiteSpace: "pre-wrap", wordBreak: "break-all",
							}}
						>
							{text.length > 2000 ? `${text.slice(0, 2000)}…` : text}
						</div>
					)}
					<div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
						{payload && (
							<button
								onClick={() => { void copyText(payload).then((ok) => { if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1600); } }); }}
								style={{
									display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer",
									background: "rgba(104,144,248,0.14)", border: "1px solid rgba(104,144,248,0.4)",
									color: "#b9ccfb", borderRadius: 8, padding: "4px 10px", fontSize: 11.5,
								}}
							>
								{copied ? <Check size={12} /> : <Copy size={12} />}
								{copied ? "已复制" : link ? "复制链接" : `复制${resultKindLabel(entry.displayKind)}`}
							</button>
						)}
						<span style={{ fontSize: 10.5, color: "rgba(255,255,255,0.38)" }}>完成于 {when}</span>
					</div>
				</div>
				<button
					onClick={() => dismissLedgerNotice(entry.taskId)}
					title="关闭（该条通知不再显示）"
					style={{ flexShrink: 0, background: "none", border: "none", cursor: "pointer", color: "rgba(255,255,255,0.5)", padding: 2, lineHeight: 0 }}
				>
					<X size={13} />
				</button>
			</div>
		</div>
	);
}

export function TaskRecoveryNotice() {
	// 只订阅 entries 引用（setEntries 才变），渲染期过滤孤儿条目
	const entries = useRequestLedgerStore((s) => s.entries);
	const orphans = entries.filter((e) => e.status === "orphaned");
	if (!orphans.length) return null;
	return createPortal(
		<div
			data-task-recovery-notice={orphans.length}
			style={{
				position: "fixed", top: 84, right: 16, zIndex: 10260,
				display: "flex", flexDirection: "column", gap: 8,
				width: 400, maxWidth: "calc(100vw - 32px)", maxHeight: "70vh", overflowY: "auto",
				pointerEvents: "auto",
			}}
		>
			{orphans.map((e) => <NoticeCard key={e.taskId} entry={e} />)}
		</div>,
		document.body,
	);
}
