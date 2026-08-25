/**
 * AssetCheckModal —— 「检查素材」的进度 + 报告弹窗（全局单例，App 挂载）。
 * 检查中显示进度条；完成后显示 正常/已修复/重传失败/无副本/无OSS记录 计数，并逐类列出资产名。
 * ⚠「重传失败」与「无本地副本」必须分栏（第254轮）：前者本机有文件、可重试，
 *   旧版混成一栏显示成「本机无副本」，是彻底误导的结论（用户实报）。
 */
import { createPortal } from "react-dom";
import { CheckCircle2, Wrench, AlertTriangle, RefreshCw, X, Loader2 } from "lucide-react";
import { useAssetCheckStore } from "@/store/assetCheckStore";

export default function AssetCheckModal() {
	const { open, title, running, total, done, report, empty, close } = useAssetCheckStore();
	if (!open) return null;

	const pct = total > 0 ? Math.round((done / total) * 100) : 0;
	const dead = report?.items.filter((i) => i.status === "dead") ?? [];
	const failed = report?.items.filter((i) => i.status === "failed") ?? [];
	const healed = report?.items.filter((i) => i.status === "healed") ?? [];
	const missing = report?.items.filter((i) => i.status === "missing") ?? [];

	const stat = (label: string, n: number, color: string, Icon: React.ElementType) => (
		<div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 8, background: "rgba(255,255,255,0.04)" }}>
			<Icon size={15} color={color} />
			<span style={{ fontSize: 12, color: "rgba(255,255,255,0.7)" }}>{label}</span>
			<span style={{ marginLeft: "auto", fontSize: 14, fontWeight: 700, color, fontFamily: "monospace" }}>{n}</span>
		</div>
	);

	return createPortal(
		<div style={{ position: "fixed", inset: 0, zIndex: 10600, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.5)" }}
			onClick={() => { if (!running) close(); }}>
			<div onClick={(e) => e.stopPropagation()}
				style={{ width: 420, maxWidth: "92vw", maxHeight: "80vh", overflowY: "auto", background: "#161b26", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 14, boxShadow: "0 20px 60px rgba(0,0,0,0.6)", padding: 18 }}>
				<div style={{ display: "flex", alignItems: "center", marginBottom: 14 }}>
					<span style={{ fontSize: 15, fontWeight: 600, color: "#fff" }}>{title}</span>
					<button onClick={close} disabled={running} title={running ? "检查中…" : "关闭"}
						style={{ marginLeft: "auto", width: 26, height: 26, borderRadius: 6, border: "none", background: "transparent", color: "rgba(255,255,255,0.5)", cursor: running ? "not-allowed" : "pointer", opacity: running ? 0.4 : 1 }}>
						<X size={16} />
					</button>
				</div>

				{empty ? (
					<div style={{ fontSize: 13, color: "rgba(255,255,255,0.6)", padding: "20px 4px", textAlign: "center" }}>没有可检查的素材（该范围内没有带图/带媒体的素材）。</div>
				) : running ? (
					<div>
						<div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "rgba(255,255,255,0.8)", marginBottom: 10 }}>
							<Loader2 size={15} color="#8b7cf7" className="animate-spin" />
							正在检查 OSS 直链… {done}/{total}
						</div>
						<div style={{ height: 8, borderRadius: 999, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
							<div style={{ height: "100%", width: `${pct}%`, background: "linear-gradient(90deg,#8b7cf7,#a78bfa)", transition: "width .2s" }} />
						</div>
					</div>
				) : report ? (
					<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
						<div style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", marginBottom: 2 }}>共检查 {report.total} 项素材：</div>
						{stat("直链正常", report.ok, "#34d399", CheckCircle2)}
						{report.healed > 0 && stat("死链·已用本地副本修复", report.healed, "#8b7cf7", Wrench)}
						{report.failed > 0 && stat("本机有副本·重传失败（可重试）", report.failed, "#fb923c", RefreshCw)}
						{report.dead > 0 && stat("死链·无本地副本无法修复", report.dead, "#f87171", AlertTriangle)}
						{report.missing > 0 && stat("无 OSS 记录（异常）", report.missing, "#fbbf24", AlertTriangle)}

						{healed.length > 0 && (
							<div style={{ marginTop: 6 }}>
								<div style={{ fontSize: 11.5, color: "#a78bfa", marginBottom: 4 }}>已修复：</div>
								<div style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", lineHeight: 1.6, maxHeight: 120, overflowY: "auto" }}>
									{healed.map((i, k) => <div key={k}>· {i.name || i.id}</div>)}
								</div>
							</div>
						)}
						{failed.length > 0 && (
							<div style={{ marginTop: 6, padding: 10, borderRadius: 8, background: "rgba(251,146,60,0.08)", border: "1px solid rgba(251,146,60,0.3)" }}>
								<div style={{ fontSize: 11.5, color: "#fb923c", marginBottom: 4 }}>以下素材本机有副本，但重传回云端失败（多为对象存储临时抖动，可再点一次「检查素材」重试）：</div>
								<div style={{ fontSize: 11, color: "rgba(255,255,255,0.7)", lineHeight: 1.6, maxHeight: 140, overflowY: "auto" }}>
									{failed.map((i, k) => (
										<div key={k}>
											· {i.name || i.id}
											{i.reason && <span style={{ color: "rgba(255,255,255,0.45)" }}>（{i.reason}）</span>}
										</div>
									))}
								</div>
							</div>
						)}
						{dead.length > 0 && (
							<div style={{ marginTop: 6, padding: 10, borderRadius: 8, background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.25)" }}>
								<div style={{ fontSize: 11.5, color: "#f87171", marginBottom: 4 }}>以下素材云端已丢失且本机无副本，无法修复（需重新生成/上传）：</div>
								<div style={{ fontSize: 11, color: "rgba(255,255,255,0.7)", lineHeight: 1.6, maxHeight: 140, overflowY: "auto" }}>
									{dead.map((i, k) => <div key={k}>· {i.name || i.id}</div>)}
								</div>
							</div>
						)}
						{missing.length > 0 && (
							<div style={{ marginTop: 6, padding: 10, borderRadius: 8, background: "rgba(251,191,36,0.08)", border: "1px solid rgba(251,191,36,0.3)" }}>
								<div style={{ fontSize: 11.5, color: "#fbbf24", marginBottom: 4 }}>以下素材没有 OSS 记录（软件内素材都应有 OSS 链接——属异常，建议重新上传/生成使其入库）：</div>
								<div style={{ fontSize: 11, color: "rgba(255,255,255,0.7)", lineHeight: 1.6, maxHeight: 140, overflowY: "auto" }}>
									{missing.map((i, k) => <div key={k}>· {i.name || i.id}</div>)}
								</div>
							</div>
						)}

						<button onClick={close}
							style={{ marginTop: 10, padding: "8px 0", borderRadius: 8, border: "none", background: "#8b7cf7", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
							完成
						</button>
					</div>
				) : null}
			</div>
		</div>,
		document.body,
	);
}
