/**
 * nodeUpload —— 「上传本地」节点的取文件 + 落库 + 写节点数据（单一自适应上传）。
 * 供工具栏新建、面板「重新上传」复用。
 */
import { storeDroppedFile } from "@/services/fileStorage";
import { useLibraryStore } from "@/store/libraryStore";
import { useCanvasStore } from "@/store/canvasStore";
import { saveUploadedLocal } from "@/services/assetPersist";
import { useProjectStore } from "@/store/projectStore";

const isTauri = () => typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

export type LibKind = "image" | "video" | "audio" | "script";

/** 按 mime/扩展名判定素材类型 */
export function uploadKindFromFile(file: File): LibKind {
	if (file.type.startsWith("image/")) return "image";
	if (file.type.startsWith("video/")) return "video";
	if (file.type.startsWith("audio/")) return "audio";
	return "script";
}

/** 文件内容 sha256（十六进制）——用于本地上传去重 */
async function sha256Hex(file: File): Promise<string> {
	try {
		const buf = await file.arrayBuffer();
		const digest = await crypto.subtle.digest("SHA-256", buf);
		return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
	} catch {
		return "";
	}
}

let localSeq = 0;
/** 本地暂存资产 id（懒上传，第194轮）：LC- 前缀标识「未上 OSS 的本地资产」，⚠ 绝不发给服务端 */
export function newLocalAssetId(): string {
	localSeq += 1;
	return `LC-${Date.now().toString(36)}-${localSeq}`;
}
export const isLocalAssetId = (id?: string | null): boolean => !!id && id.startsWith("LC-");

/**
 * 本地**媒体**文件落为画布素材——第194轮起改为**懒上传**（用户定的全局上传规则）：
 * 落地时**只写本地**（saveUploadedLocal 直接写手上的字节 + 注册三元映射，零网络零等待），
 * **不再立即上传 OSS**；真正需要公网 url 的时刻（提交生成请求）由 ensurePublicUrl 统一补传
 * （TP 资产 + srcUri 缓存——同一张图第二次进请求直接命中缓存，链接复用不重复上传）。
 * 返回 {assetId(本地 LC- id), displayUri(本地 uri), localPath}。
 *
 * ⚠ 勿回退的既有教训（第146轮）：本地副本**直接写手上的字节**，绝不「先传 OSS 再下载回来」。
 * ⚠ LC- 本地 id 绝不发给服务端（collectMedia 已过滤；补传后按 blobByUri(srcUri) 换真 TP id）。
 * 已知边界：本地文件丢失且从未被请求引用过（无 OSS 备份）→ 素材真丢；跨设备打开项目看不到
 * LC 资产（无公网链接）——被生成请求引用过一次后即有 OSS 链接，自愈照常。
 */
export async function uploadMediaToCanvasAsset(
	file: File,
	_prefix = "TP", // 懒上传后前缀在补传时由 ensurePublicUrl 统一用 TP；参数保留兼容旧调用面
): Promise<{ assetId: string; displayUri: string; localPath: string | null }> {
	// 去重：相同内容（sha256）此前已落过 且 本地原件还在 → 复用（免重复落盘）
	const hash = await sha256Hex(file);
	if (hash && isTauri()) {
		const dup = Object.values(useProjectStore.getState().assetBlobs).find((b) => b.sha256 === hash);
		if (dup?.localPath) {
			try {
				const { exists } = await import("@tauri-apps/plugin-fs");
				if (await exists(dup.localPath)) {
					const { convertFileSrc } = await import("@tauri-apps/api/core");
					return { assetId: dup.id, displayUri: dup.localUri || convertFileSrc(dup.localPath), localPath: dup.localPath };
				}
			} catch { /* 探不了本地文件 → 按未命中处理，走重新落盘 */ }
		}
	}
	const id = newLocalAssetId();
	const blob = await saveUploadedLocal(file, id, undefined, file.name);
	if (blob?.localUri) {
		useProjectStore.getState().registerAssetBlob({ ...blob, sha256: hash || undefined });
		return { assetId: id, displayUri: blob.localUri, localPath: blob.localPath ?? null };
	}
	// 非 Tauri（浏览器）/写盘失败：objectURL 保本会话显示；提交请求时 ensurePublicUrl 照常可取字节补传
	const objUrl = URL.createObjectURL(file);
	useProjectStore.getState().registerAssetBlob({ id, localUri: objUrl, sha256: hash || undefined });
	return { assetId: id, displayUri: objUrl, localPath: null };
}

/** 弹文件选择器，把所选文件落到指定上传节点 */
export function pickFileToUploadNode(nodeId: string): void {
	const input = document.createElement("input");
	input.type = "file";
	input.accept = "image/*,video/*,audio/*,.txt,.md,.doc,.docx,.pdf,.json";
	input.onchange = async (e: Event) => {
		const file = (e.target as HTMLInputElement).files?.[0];
		if (file) await applyFileToUploadNode(nodeId, file);
	};
	input.click();
}

/**
 * 把一个本地文件入库并写入上传节点的 data（resultAssetId + fileUri/Name/Mime）。
 * 媒体类（图/视频/音频）先传 OSS 拿 id+公网url（请求用），本地副本显示；文本类仅本地落库。
 * 媒体上传失败大声 alert（绝不静默留本地路径——否则上游请求拿不到公网 url）。
 */
export async function applyFileToUploadNode(nodeId: string, file: File): Promise<void> {
	const kind = uploadKindFromFile(file);
	let assetId: string;
	let displayUri: string;
	let localPath: string | null = null;
	if (kind === "script") {
		// 文本类不作上游媒体素材：本地落库即可（不占 OSS）
		const stored = await storeDroppedFile(file);
		if (!stored) return;
		assetId = stored.fileId;
		displayUri = stored.fileUri;
		localPath = stored.localPath;
	} else {
		useCanvasStore.getState().setRuntime(nodeId, { status: "uploading" }); // 节点显示「上传中…」转圈
		try {
			const up = await uploadMediaToCanvasAsset(file);
			assetId = up.assetId;
			displayUri = up.displayUri;
			localPath = up.localPath;
		} catch (err) {
			useCanvasStore.getState().setRuntime(nodeId, { status: "failed", error: err instanceof Error ? err.message : "上传失败" });
			alert(`本地上传失败（未做 OSS 存储）：${err instanceof Error ? err.message : "未知错误"}`);
			return;
		}
		useCanvasStore.getState().setRuntime(nodeId, { status: "idle" });
	}
	useLibraryStore.getState().addAsset({
		id: assetId,
		kind,
		name: file.name,
		uri: displayUri,
		serverAssetId: kind === "script" ? null : assetId,
		thumbnailUri: null,
		createdAt: new Date().toISOString(),
		deletedByUser: false,
		localPath,
		origin: "upload", // 本地上传 → 进「本地素材库」
	});
	const cs = useCanvasStore.getState();
	const n = cs.nodes[nodeId];
	if (!n) return;
	// 同节点多结果一律堆叠：重新上传时旧结果归档进 resultHistory（媒体节点抽屉可回看/切回）
	const hist = [...(n.data.resultHistory || [])];
	if (n.data.resultAssetId && !hist.includes(n.data.resultAssetId)) hist.push(n.data.resultAssetId);
	if (!hist.includes(assetId)) hist.push(assetId);
	useCanvasStore.setState({
		nodes: {
			...cs.nodes,
			[nodeId]: {
				...n,
				data: { ...n.data, resultAssetId: assetId, resultHistory: hist, fileUri: displayUri, fileName: file.name, fileMime: file.type },
			},
		},
	});
}
