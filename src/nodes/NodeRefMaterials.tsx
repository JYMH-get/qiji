import { useCanvasStore } from "@/store/canvasStore";
import { useLibraryStore } from "@/store/libraryStore";

/**
 * 节点「素材（输入）」面板展示：上游连线节点的媒体结果 + 本节点自定义 input 垫图（图/视频/音频）。
 * 素材即**输入**，显示在操作面板顶部素材行（不再叠在节点体上）。无素材时返回 null。
 * 自带数据收集（不依赖面板的端口逻辑）——单输入口模型下端口按格式过滤会漏掉合并口，故独立扫描。
 */
export function NodeRefMaterials({ nodeId }: { nodeId: string }) {
	const node = useCanvasStore((s) => s.nodes[nodeId]);
	const edges = useCanvasStore((s) => s.edges);
	const nodes = useCanvasStore((s) => s.nodes);
	const assets = useLibraryStore((s) => s.assets);
	if (!node) return null;
	type R = { url: string; media: "image" | "video" | "audio"; name?: string };
	const refs: R[] = [];
	const seen = new Set<string>();
	const add = (url: string | undefined | null, media: R["media"], name?: string) => {
		if (url && !seen.has(url)) { seen.add(url); refs.push({ url, media, name }); }
	};
	// 上游连线媒体：连入本节点的上游节点的媒体结果（图/视频/音频）
	for (const e of Object.values(edges)) {
		if (e.target !== nodeId) continue;
		const up = nodes[e.source];
		const a = up?.data.resultAssetId ? assets[up.data.resultAssetId] : null;
		if (a?.uri && (a.kind === "image" || a.kind === "video" || a.kind === "audio")) add(a.uri, a.kind, a.name);
	}
	// 自定义 input 垫图：node.data.input.{images,videos,audios}（资产匹配 / 资产模式投影写入）
	const input = (node.data.input || {}) as Record<string, Array<{ url?: string; id?: string; name?: string }>>;
	for (const im of input.images || []) add(im?.url || (im?.id ? assets[im.id]?.uri : undefined), "image", im?.name);
	for (const v of input.videos || []) add(v?.url || (v?.id ? assets[v.id]?.uri : undefined), "video", v?.name);
	for (const au of input.audios || []) add(au?.url || (au?.id ? assets[au.id]?.uri : undefined), "audio", au?.name);
	if (!refs.length) return null;
	return (
		<div className="flex flex-row flex-wrap gap-2 mb-3 shrink-0">
			{refs.map((r, i) => (
				<div
					key={i}
					className="relative w-11 h-11 rounded-xl border border-white/10 bg-white/5 overflow-hidden shrink-0"
					title={r.name ? `素材: ${r.name}` : "素材（输入）"}
				>
					{r.media === "video" ? (
						<video src={r.url} className="w-full h-full object-cover" muted preload="metadata" />
					) : r.media === "audio" ? (
						<span className="flex h-full w-full items-center justify-center text-base">🎵</span>
					) : (
						<img src={r.url} className="w-full h-full object-cover" draggable={false} />
					)}
				</div>
			))}
		</div>
	);
}
