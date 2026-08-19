/**
 * jianyingExport —— 实时剪辑（第三模式）「导出剪映草稿」编排层。
 *
 * 流程：取 doc → 被引用素材确保本地原件（缺失走既有下载机制 saveRemoteAsset/ensureLocalOriginal）
 *      → 探测媒体元信息（时长/宽高，best-effort）→ Rust 探测剪映草稿根目录并建草稿文件夹
 *      → 素材复制进草稿文件夹 assets\（拷贝而非引用原路径：Qiji 项目 assets 在 AppData、
 *        用户清项目/搬项目后草稿会「媒体丢失」；自包含拷贝一次到位，且写入面天然限定草稿根内）
 *      → buildDraftContent 纯函数构建两份 JSON → Rust 白名单写盘。
 *
 * 安全边界（红线）：前端不做任意路径读写——目录探测/建夹/复制/写文件全在 Rust 命令内完成，
 *   目标恒限剪映草稿根目录下、素材源文件恒限项目 assets 目录下；绝不经手 base64。
 *
 * UI 接线（工具条按钮）由协调方收口——本文件只导出 exportRtcDocToJianying() 一个干净入口。
 */
import { buildDraftContent, type JyMaterialKind, type JyResolvedAsset } from "@/lib/jianyingDraft";
import { saveRemoteAsset, ensureLocalOriginal } from "@/services/assetPersist";
import { useProjectStore, activeRtcProjectDoc, resolveEpisodeKey } from "@/store/projectStore";
import { useRtcStore } from "@/store/rtcStore";
import { docCanvas, type RtcDoc } from "@/types/rtc";
import type { AssetBlob } from "@/services/projectFile";

export interface JianyingExportResult {
	ok: boolean;
	/** 成功时：草稿文件夹绝对路径 / 最终草稿名（重名自动加序号后可能与请求名不同） */
	draftPath?: string;
	draftName?: string;
	warnings?: string[];
	error?: string;
}

function isTauri(): boolean {
	return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

/** 收集 doc 中被引用的 assetId（media 片段；placeholder/text 轨由构建器跳过，无需素材）。
 *  第四批：复合片段子时间轴（doc.subDocs）内的 media 片段一并收集——内联素材同样要
 *  下载本地原件并复制进草稿 assets\（按 assetId 全局去重，文件只复制一份）。 */
function collectAssetRefs(doc: RtcDoc): Map<string, { media?: "image" | "video" | "audio"; uri?: string }> {
	const refs = new Map<string, { media?: "image" | "video" | "audio"; uri?: string }>();
	const collectTracks = (tracks: RtcDoc["tracks"]) => {
		for (const t of tracks) {
			if (t.type === "text") continue;
			for (const s of t.segments) {
				if (s.kind !== "media" || !s.assetId) continue;
				const prev = refs.get(s.assetId);
				refs.set(s.assetId, { media: prev?.media ?? s.media, uri: prev?.uri ?? s.uri });
			}
		}
	};
	collectTracks(doc.tracks);
	for (const sub of Object.values(doc.subDocs ?? {})) collectTracks(sub.tracks);
	return refs;
}

/** 按 片段声明 → mime → 扩展名 推断剪映素材大类 */
function kindOf(media: "image" | "video" | "audio" | undefined, blob: AssetBlob | undefined): JyMaterialKind {
	if (media === "image") return "photo";
	if (media === "audio") return "audio";
	if (media === "video") return "video";
	const mime = blob?.mime || "";
	if (mime.startsWith("image/")) return "photo";
	if (mime.startsWith("audio/")) return "audio";
	if (mime.startsWith("video/")) return "video";
	const ext = (blob?.ext || "").toLowerCase();
	if (["png", "jpg", "jpeg", "webp", "gif", "bmp"].includes(ext)) return "photo";
	if (["mp3", "wav", "ogg", "m4a", "flac", "aac"].includes(ext)) return "audio";
	return "video";
}

/** <video>/<audio> 元数据探测（微秒 + 视频宽高）；失败/超时返回 null（构建器有 source 终点兜底） */
function probeMediaMeta(uri: string, kind: "video" | "audio"): Promise<{ durationUs: number; width?: number; height?: number } | null> {
	return new Promise((resolve) => {
		if (typeof document === "undefined" || !uri) return resolve(null);
		const el = document.createElement(kind);
		if (el instanceof HTMLVideoElement) el.muted = true;
		el.preload = "metadata";
		let settled = false;
		const done = (v: { durationUs: number; width?: number; height?: number } | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			el.onloadedmetadata = null;
			el.onerror = null;
			el.removeAttribute("src");
			try { el.load(); } catch { /* 释放解码器，失败无碍 */ }
			resolve(v);
		};
		const timer = setTimeout(() => done(null), 15000);
		el.onloadedmetadata = () => {
			const d = el.duration;
			if (!Number.isFinite(d) || d <= 0) return done(null);
			const out: { durationUs: number; width?: number; height?: number } = { durationUs: Math.round(d * 1e6) };
			if (el instanceof HTMLVideoElement && el.videoWidth > 0) {
				out.width = el.videoWidth;
				out.height = el.videoHeight;
			}
			done(out);
		};
		el.onerror = () => done(null);
		el.src = uri;
	});
}

/** 图片宽高探测：读本地原件字节 → createImageBitmap（同源字节，避免 asset:// 跨源限制） */
async function probeImageSize(localPath: string, mime?: string): Promise<{ width: number; height: number } | null> {
	try {
		const { readFile } = await import("@tauri-apps/plugin-fs");
		const bytes = await readFile(localPath);
		const bmp = await createImageBitmap(new Blob([bytes as unknown as BlobPart], { type: mime || "image/png" }));
		const size = bmp.width > 0 ? { width: bmp.width, height: bmp.height } : null;
		bmp.close?.();
		return size;
	} catch {
		return null;
	}
}

/** Windows 非法文件名字符置换（Rust 端还会再消毒一遍，这里先给个可读的名字） */
function sanitizeName(name: string): string {
	return Array.from(name)
		.map((ch) => (ch.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(ch) ? "_" : ch))
		.join("")
		.trim();
}

interface PreparedDraft { path: string; name: string }

/**
 * 导出当前实时剪辑文档为剪映草稿。
 * 返回 {ok, draftPath?, draftName?, warnings?, error?}——错误信息面向用户可直显。
 */
export async function exportRtcDocToJianying(): Promise<JianyingExportResult> {
	if (!isTauri()) return { ok: false, error: "导出剪映草稿仅在桌面版可用" };

	const ps0 = useProjectStore.getState();
	const doc = useRtcStore.getState().doc ?? activeRtcProjectDoc(ps0);
	if (!doc) return { ok: false, error: "当前项目没有剪辑文档" };
	const refs = collectAssetRefs(doc);
	// 第四批：主轨全是复合片段（素材都在子时间轴里）也算有可导内容
	const hasAnyMedia = doc.tracks.some(
		(t) => t.type !== "text" && t.segments.some((s) => s.kind === "media" || s.kind === "compound"),
	);
	if (!hasAnyMedia) return { ok: false, error: "剪辑里还没有可导出的素材片段（占位符与文本暂不导出）" };

	const warnings: string[] = [];
	const { invoke } = await import("@tauri-apps/api/core");

	// ① 草稿根目录探测（不存在时 Rust 返回带探测路径的明确错误，直接透传给用户；
	//    先探一次=素材下载前尽早失败，prepare 时 Rust 还会再验一遍）
	try {
		await invoke<string>("jianying_draft_root");
	} catch (e) {
		return { ok: false, error: String(e) };
	}

	// ② 每个被引用素材确保本地有原件（AssetBlob.localPath；缺失走既有下载机制落地）
	const st = useProjectStore.getState();
	const fs = await import("@tauri-apps/plugin-fs");
	const localByAsset = new Map<string, AssetBlob>();
	for (const [assetId, ref] of refs) {
		let blob: AssetBlob | undefined = st.assetBlobs[assetId];
		if (blob?.localPath && !(await fs.exists(blob.localPath).catch(() => false))) {
			blob = { ...blob, localPath: undefined }; // 映射里的本地路径已失效（用户清过缓存等）
		}
		if (!blob?.localPath) {
			// 既有下载机制：优先按 公网 url 原生下载（saveRemoteAsset），退回按显示 uri 落地（ensureLocalOriginal）
			const url = blob?.url;
			let saved: AssetBlob | null = null;
			if (url) saved = await saveRemoteAsset(assetId, url).catch(() => null);
			if (!saved?.localPath && ref.uri) saved = await ensureLocalOriginal(ref.uri, { hintId: assetId }).catch(() => null);
			if (saved?.localPath) blob = saved;
		}
		if (blob?.localPath) localByAsset.set(assetId, blob);
		else warnings.push(`素材 ${assetId} 无法取得本地原件（下载失败或来源已失效），相关片段将被跳过`);
	}
	if (localByAsset.size === 0) return { ok: false, error: "没有任何素材能取得本地原件，无法导出", warnings };

	// ③ 探测媒体元信息（best-effort：失败时构建器按片段 source 终点兜底素材时长）
	const metaByAsset = new Map<string, { durationUs: number; width?: number; height?: number; kind: JyMaterialKind }>();
	for (const [assetId, blob] of localByAsset) {
		const kind = kindOf(refs.get(assetId)?.media, blob);
		if (kind === "photo") {
			const size = blob.localPath ? await probeImageSize(blob.localPath, blob.mime) : null;
			metaByAsset.set(assetId, { durationUs: 0, ...(size || {}), kind });
		} else {
			const probed = blob.localUri ? await probeMediaMeta(blob.localUri, kind === "audio" ? "audio" : "video") : null;
			metaByAsset.set(assetId, { durationUs: probed?.durationUs ?? 0, width: probed?.width, height: probed?.height, kind });
		}
	}

	// ④ 建草稿文件夹（Rust 消毒草稿名并自动避让重名，返回最终路径/名）
	let prepared: PreparedDraft;
	try {
		// 草稿名 = 项目名·分集名（用户定稿：分集影响导出名字；分集缺失时退项目名/文档名）
		const ep = ps0.episodes.find((e) => e.id === resolveEpisodeKey(ps0.rtcEpisodeId, ps0.episodes));
		const base = ps0.name || doc.name || "Qiji剪辑";
		prepared = await invoke<PreparedDraft>("jianying_prepare_draft", {
			draftName: sanitizeName(ep ? `${base}·${ep.title}` : base) || "Qiji剪辑",
		});
	} catch (e) {
		return { ok: false, error: String(e), warnings };
	}

	// ⑤ 构建两份 JSON：素材 path 指向草稿文件夹内 assets\<assetId>.<ext> 的最终绝对路径；
	//    画幅走 docCanvas（唯一入口，含 1920×1080 缺省回退）写进草稿 canvas_config
	const canvas = docCanvas(doc);
	const sep = prepared.path.includes("\\") ? "\\" : "/";
	const fileNameOf = (assetId: string) => `${assetId}.${localByAsset.get(assetId)?.ext || "bin"}`;
	const built = buildDraftContent(
		doc,
		(assetId) => {
			const meta = metaByAsset.get(assetId);
			if (!meta) return null;
			const r: JyResolvedAsset = {
				absPath: `${prepared.path}${sep}assets${sep}${fileNameOf(assetId)}`,
				durationUs: meta.durationUs,
				width: meta.width,
				height: meta.height,
				kind: meta.kind,
			};
			return r;
		},
		// 第四批：draftFolderPath 供复合片段 wrapper 内的绝对路径引用
		{ draftName: prepared.name, canvasWidth: canvas.width, canvasHeight: canvas.height, draftFolderPath: prepared.path },
	);
	warnings.push(...built.warnings);
	if ((built.draftContent.tracks as unknown[]).length === 0) {
		return { ok: false, error: "没有可导出的片段（素材缺失或全是占位符）", warnings };
	}

	// ⑥ 素材复制进草稿 assets\（按 assetId 去重后逐个拷贝，绝不重复导出）+ 写两份 JSON
	try {
		const { dirname, join } = await import("@tauri-apps/api/path");
		const savePath = st.savePath || (await st.ensureProjectPath());
		const srcRoot = await join(await dirname(savePath), "assets");
		await invoke("jianying_copy_assets", {
			draftPath: prepared.path,
			srcRoot,
			items: built.usedAssetIds.map((assetId) => ({
				src: localByAsset.get(assetId)!.localPath!,
				fileName: fileNameOf(assetId),
			})),
		});
		await invoke("jianying_write_draft_file", {
			draftPath: prepared.path,
			fileName: "draft_content.json",
			content: JSON.stringify(built.draftContent),
		});
		await invoke("jianying_write_draft_file", {
			draftPath: prepared.path,
			fileName: "draft_meta_info.json",
			content: JSON.stringify(built.draftMetaInfo),
		});
		/* 第四批：复合片段 → subdraft/<uuid>/ 两件 JSON + 松散副本（§1 磁盘布局；封面 jpg 为
		 * 可选观感件，没有就不写）。松散副本 = 剪映自己会写的一套，我们照写同内容防新版按此路径找。 */
		for (const sd of built.subdrafts) {
			const wrapper = JSON.stringify(sd.wrapperJson);
			const config = JSON.stringify(sd.configJson);
			await invoke("jianying_write_draft_file", {
				draftPath: prepared.path,
				fileName: `subdraft/${sd.uuid}/draft_content.json`,
				content: wrapper,
			});
			await invoke("jianying_write_draft_file", {
				draftPath: prepared.path,
				fileName: `subdraft/${sd.uuid}/sub_draft_config.json`,
				content: config,
			});
			await invoke("jianying_write_draft_file", {
				draftPath: prepared.path,
				fileName: "subdraft/draft_content.json",
				content: wrapper,
			});
			await invoke("jianying_write_draft_file", {
				draftPath: prepared.path,
				fileName: "subdraft/sub_draft_config.json",
				content: config,
			});
		}
	} catch (e) {
		return { ok: false, error: `写入草稿失败：${String(e)}`, warnings };
	}

	return { ok: true, draftPath: prepared.path, draftName: prepared.name, warnings };
}
