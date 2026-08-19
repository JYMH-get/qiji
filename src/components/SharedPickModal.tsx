/**
 * SharedPickModal —— 「添加到共享资产」目标选择弹窗（App 挂载，全局单例）。
 * 选 已加入的共享库 → 文件夹 → 登记 OSS 记录（sharedAddAssets，不复制字节）。
 * 库/文件夹列表用 sharedLibStore 本地缓存，可点「获取」拉取、「＋文件夹」新建（与共享页同一套数据）。
 */
import { useState } from "react";
import { createPortal } from "react-dom";
import { X, Folder, RefreshCw, FolderPlus, Share2, CheckCircle2 } from "lucide-react";
import { useSharedPickStore } from "@/store/sharedPickStore";
import { useSharedLibStore } from "@/store/sharedLibStore";
import { managedClient } from "@/services/managedClient";

const btn: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4, padding: "5px 10px", fontSize: 12, borderRadius: 6, cursor: "pointer", border: "1px solid rgba(255,255,255,0.16)", background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.85)" };
const row = (on: boolean): React.CSSProperties => ({ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 8, cursor: "pointer", border: "1px solid " + (on ? "#8b5cf6" : "rgba(255,255,255,0.1)"), background: on ? "rgba(139,92,246,0.12)" : "rgba(255,255,255,0.03)" });

export default function SharedPickModal() {
	const { open, items, skipped, close } = useSharedPickStore();
	const libs = useSharedLibStore((s) => s.libs);
	const foldersByLib = useSharedLibStore((s) => s.foldersByLib);
	const fetching = useSharedLibStore((s) => s.fetching);
	const [libId, setLibId] = useState<string | null>(null);
	const [folderId, setFolderId] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState<{ added: number; skipped: number } | null>(null);
	const [err, setErr] = useState("");

	if (!open) return null;

	const reset = () => { setLibId(null); setFolderId(null); setDone(null); setErr(""); setBusy(false); };
	const onClose = () => { reset(); close(); };
	const folders = libId ? foldersByLib[libId] ?? [] : [];

	const doShare = async () => {
		if (!folderId || !items.length) return;
		setBusy(true); setErr("");
		const r = await managedClient.sharedAddAssets(folderId, items);
		setBusy(false);
		if (!r.ok) { setErr(r.error || "登记失败"); return; }
		setDone({ added: r.added ?? 0, skipped: r.skipped ?? 0 });
		// 让共享页的文件夹计数/素材列表下次「获取」时拿到最新即可；此处顺手刷新文件夹计数
		if (libId) void useSharedLibStore.getState().fetchFolders(libId).catch(() => {});
	};
	const doCreateFolder = async () => {
		if (!libId) return;
		const name = prompt("新文件夹名称：")?.trim();
		if (!name) return;
		const r = await managedClient.sharedCreateFolder(libId, name);
		if (!r.ok || !r.folder) { setErr(r.error || "创建失败"); return; }
		useSharedLibStore.getState().addFolder(libId, r.folder);
		setFolderId(r.folder.id);
	};

	return createPortal(
		<div style={{ position: "fixed", inset: 0, zIndex: 10600, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.5)" }} onClick={onClose}>
			<div onClick={(e) => e.stopPropagation()}
				style={{ width: 420, maxWidth: "92vw", maxHeight: "80vh", overflowY: "auto", background: "#161b26", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 14, boxShadow: "0 20px 60px rgba(0,0,0,0.6)", padding: 18 }}>
				<div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
					<Share2 size={16} color="#8b5cf6" style={{ marginRight: 8 }} />
					<span style={{ fontSize: 15, fontWeight: 600, color: "#fff" }}>添加到共享资产（{items.length} 项）</span>
					<button onClick={onClose} style={{ marginLeft: "auto", width: 26, height: 26, borderRadius: 6, border: "none", background: "transparent", color: "rgba(255,255,255,0.5)", cursor: "pointer" }}><X size={16} /></button>
				</div>

				{done ? (
					<div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
						<div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#34d399" }}>
							<CheckCircle2 size={16} /> 已登记 {done.added} 条{done.skipped ? `（跳过重复/无直链 ${done.skipped} 条）` : ""}{skipped ? `；另有 ${skipped} 项无 OSS 记录未解析` : ""}
						</div>
						<div style={{ fontSize: 11.5, color: "rgba(255,255,255,0.5)" }}>其他用户在该共享文件夹点「获取」即可看到（只登记 OSS 记录，不复制文件）。</div>
						<button onClick={onClose} style={{ padding: "8px 0", borderRadius: 8, border: "none", background: "#8b5cf6", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>完成</button>
					</div>
				) : items.length === 0 ? (
					<div style={{ fontSize: 12.5, color: "rgba(255,255,255,0.6)", padding: "14px 0" }}>
						所选内容没有可分享的素材{skipped ? `（${skipped} 项无结果图/无 OSS 记录）` : ""}——只有已入库（有 OSS 直链）的生成/上传素材可分享。
					</div>
				) : (
					<div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
						{skipped > 0 && <div style={{ fontSize: 11.5, color: "#fbbf24" }}>{skipped} 项无结果图/无 OSS 记录，将被跳过。</div>}
						<div style={{ display: "flex", alignItems: "center", gap: 6 }}>
							<span style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", flex: 1 }}>① 选择共享库：</span>
							<button style={btn} title="刷新已加入的库" onClick={() => void useSharedLibStore.getState().fetchLibs().catch((e) => setErr(e?.message || "获取失败"))}><RefreshCw size={12} /> 获取</button>
						</div>
						{libs.length === 0 ? (
							<div style={{ fontSize: 12, color: "rgba(255,255,255,0.45)", padding: "6px 0" }}>还没有加入共享库——先到「资产助手 → 共享资产」搜索库名+密码加入。</div>
						) : libs.map((l) => (
							<div key={l.id} style={row(libId === l.id)} onClick={() => { setLibId(l.id); setFolderId(null); }}>
								<Folder size={14} color="#c4b5fd" />
								<span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.name}</span>
								<span style={{ fontSize: 11, color: "rgba(255,255,255,0.45)" }}>{l.folderCount} 文件夹</span>
							</div>
						))}
						{libId && (
							<>
								<div style={{ display: "flex", alignItems: "center", gap: 6 }}>
									<span style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", flex: 1 }}>② 选择文件夹：</span>
									<button style={btn} title="新建文件夹" onClick={() => void doCreateFolder()}><FolderPlus size={12} /> 文件夹</button>
									<button style={btn} disabled={!!fetching[libId]} title="拉取该库文件夹列表" onClick={() => void useSharedLibStore.getState().fetchFolders(libId).catch((e) => setErr(e?.message || "获取失败"))}>
										<RefreshCw size={12} /> {fetching[libId] ? "获取中…" : "获取"}
									</button>
								</div>
								{folders.length === 0 ? (
									<div style={{ fontSize: 12, color: "rgba(255,255,255,0.45)", padding: "4px 0" }}>{fetching[libId] ? "获取中…" : "暂无文件夹缓存——点「获取」加载，或「＋文件夹」新建。"}</div>
								) : folders.map((f) => (
									<div key={f.id} style={row(folderId === f.id)} onClick={() => setFolderId(f.id)}>
										<Folder size={14} color="#fbbf24" />
										<span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
										<span style={{ fontSize: 11, color: "rgba(255,255,255,0.45)" }}>{f.count} 素材</span>
									</div>
								))}
							</>
						)}
						{err && <div style={{ fontSize: 11.5, color: "#f87171" }}>{err}</div>}
						<div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
							<button style={btn} onClick={onClose}>取消</button>
							<button
								style={{ ...btn, background: folderId ? "#8b5cf6" : "rgba(139,92,246,0.3)", borderColor: "#8b5cf6", color: "#fff", cursor: folderId ? "pointer" : "not-allowed" }}
								disabled={!folderId || busy}
								onClick={() => void doShare()}>
								{busy ? "登记中…" : `分享（${items.length}）`}
							</button>
						</div>
					</div>
				)}
			</div>
		</div>,
		document.body,
	);
}
