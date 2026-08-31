import { forwardRef, type ImgHTMLAttributes } from "react";
import { useDisplayUri } from "@/nodes/ResultView";
import { isWebviewLocalUri } from "@/lib/publicUrl";

export interface AssetDisplayImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> {
	uri?: string | null;
	/** 远程资产恢复中的占位样式：主展示区用 bar，缩略图默认 compact。 */
	recovery?: "bar" | "compact";
}

/** 资产工作台图片统一走三元映射显示解析，避免项目快照里的旧 URI 直接形成裂图。 */
export const AssetDisplayImage = forwardRef<HTMLImageElement, AssetDisplayImageProps>(function AssetDisplayImage(
	{ uri, alt = "", recovery = "compact", ...props },
	ref,
) {
	const displayUri = useDisplayUri(uri);
	const waitingForLocal = typeof window !== "undefined"
		&& ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
		&& !!uri
		&& /^https?:/i.test(uri)
		&& !isWebviewLocalUri(uri)
		&& displayUri === uri;
	if (waitingForLocal) {
		return recovery === "bar" ? (
			<span role="status" aria-live="polite" style={{ width: "min(320px, 60%)", display: "flex", flexDirection: "column", alignItems: "center", gap: 8, color: "rgba(255,255,255,0.62)", fontSize: 12 }}>
				<span>正在从服务端恢复图片…</span>
				<progress aria-label="图片恢复中" style={{ width: "100%", height: 8, accentColor: "#8b5cf6" }} />
			</span>
		) : (
			<span role="status" title="正在从服务端恢复图片" aria-label="正在从服务端恢复图片" style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
				<progress aria-label="图片恢复中" style={{ width: "70%", height: 6, accentColor: "#8b5cf6" }} />
			</span>
		);
	}
	if (!displayUri) return null;
	return <img {...props} ref={ref} src={displayUri} alt={alt} />;
});
