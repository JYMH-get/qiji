import type { DragEvent } from "react";

export const QIJI_ASSET_MIME = "application/x-qiji-asset";
export type PromptMediaDropHandler = (transfer: DataTransfer) => boolean;
export type PromptMediaDrop =
	| { asset: { uri: string; assetId?: string; name: string; media: "image" | "video" | "audio"; cat?: unknown } }
	| { files: File[] };

/** 只识别素材协议和媒体文件；普通文字/预设胶囊仍交给编辑器自己的拖放。 */
export function readPromptMediaDrop(transfer: DataTransfer): PromptMediaDrop | null {
	const custom = transfer.getData(QIJI_ASSET_MIME);
	const raw = custom || transfer.getData("text/plain");
	if (raw) {
		try {
			const value = JSON.parse(raw);
			if (value && (custom || value.source === "qiji-asset")) {
				const uri = [value.localUri, value.uri, value.url].find((v) => typeof v === "string" && v.length > 0);
				if (uri) {
					const kind = value.media || value.kind;
					return { asset: {
						uri, assetId: typeof (value.assetId || value.id) === "string" ? value.assetId || value.id : undefined,
						name: typeof value.name === "string" ? value.name : "素材",
						media: kind === "video" || kind === "audio" ? kind : "image", cat: value.cat,
					} };
				}
			}
		} catch { /* 普通文本保持原生拖入语义。 */ }
	}
	const files = Array.from(transfer.files ?? []).filter((file) => /^(image|video|audio)\//.test(file.type));
	return files.length ? { files } : null;
}

export function promptMediaDropHandlers(handler?: PromptMediaDropHandler) {
	return {
		onDragOverCapture: (event: DragEvent<HTMLElement>) => {
			if (!handler) return;
			const types = Array.from(event.dataTransfer.types);
			if (types.includes(QIJI_ASSET_MIME) || types.includes("Files")) {
				event.preventDefault();
				event.dataTransfer.dropEffect = "copy";
			}
		},
		onDropCapture: (event: DragEvent<HTMLElement>) => {
			if (handler?.(event.dataTransfer)) {
				event.preventDefault();
				event.stopPropagation();
			}
		},
	};
}
