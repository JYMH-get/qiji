import { useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import type { SharedAssetRecord, SharedFolderInfo } from "@/contract";
import { confirmDialog } from "@/lib/confirmDialog";
import { managedClient } from "@/services/managedClient";
import { useConnectionStore } from "@/store/connectionStore";
import { useSharedLibStore } from "@/store/sharedLibStore";

type DeleteTarget = { kind: "folder"; folder: SharedFolderInfo }
	| { kind: "asset"; folderId: string; asset: SharedAssetRecord };

/** 两个共享入口复用同一权限、确认与缓存更新路径。服务端再次校验真实团长身份。 */
export function SharedLibraryDeleteButton({ libId, target, overlay = false, onDeleted }: {
	libId: string;
	target: DeleteTarget;
	overlay?: boolean;
	onDeleted?: () => void;
}) {
	const canDelete = useConnectionStore(s => s.loggedIn && s.user?.team?.role === "leader" && s.user.team.sharedLibId === libId);
	const pending = useRef(false);
	const [phase, setPhase] = useState<"confirming" | "deleting" | null>(null);
	const busy = phase !== null;
	if (!canDelete) return null;
	const name = target.kind === "folder" ? target.folder.name : target.asset.name;
	const label = `删除${target.kind === "folder" ? "文件夹" : "素材"}「${name}」`;
	const remove = async () => {
		if (pending.current) return;
		pending.current = true;
		setPhase("confirming");
		const before = useConnectionStore.getState();
		const sameSession = () => {
			const now = useConnectionStore.getState();
			return now.loggedIn && now.user?.id === before.user?.id && now.accessKey === before.accessKey
				&& now.serverUrl === before.serverUrl && now.user?.team?.role === "leader" && now.user.team.sharedLibId === libId;
		};
		try {
			const message = target.kind === "folder"
				? `删除文件夹「${name}」及其中全部共享素材？\n团队成员将无法再从共享库获取这些素材。已添加到项目或下载到本地的素材保留。此操作不可撤销。`
				: `从共享素材库删除「${name}」？\n团队成员将无法再从共享库获取此素材。已添加到项目或下载到本地的素材保留。`;
			if (!(await confirmDialog(message, "删除确认")) || !sameSession()) return;
			setPhase("deleting");
			if (target.kind === "folder") {
				await managedClient.sharedDeleteFolder(target.folder.id);
				if (!sameSession()) return;
				useSharedLibStore.getState().removeFolder(libId, target.folder.id);
			} else {
				await managedClient.sharedDeleteAsset(target.asset.id);
				if (!sameSession()) return;
				useSharedLibStore.getState().removeAsset(target.folderId, target.asset.id);
			}
			onDeleted?.();
		} catch (error) {
			if (sameSession()) alert(error instanceof Error ? error.message : "删除失败，请重试");
		} finally {
			pending.current = false;
			setPhase(null);
		}
	};
	return <button
		type="button" title={label} aria-label={label} disabled={busy} draggable={false}
		onPointerDown={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}
		onDoubleClick={e => e.stopPropagation()} onContextMenu={e => { e.preventDefault(); e.stopPropagation(); }}
		onDragStart={e => { e.preventDefault(); e.stopPropagation(); }}
		onClick={e => { e.stopPropagation(); void remove(); }}
		style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 4, flexShrink: 0,
			padding: overlay ? 4 : "3px 7px", minWidth: 24, minHeight: 24, borderRadius: 5,
			border: "1px solid rgba(248,113,113,0.3)", background: "rgba(24,16,20,0.88)", color: "#fca5a5",
			fontSize: 11, cursor: busy ? "wait" : "pointer", opacity: busy ? 0.6 : 1,
			...(overlay ? { position: "absolute", top: 4, right: 4, zIndex: 2 } : {}) }}>
		<Trash2 size={12} />{!overlay && (phase === "deleting" ? "删除中…" : "删除")}
	</button>;
}
