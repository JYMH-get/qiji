/** NodeInfoPopover — 以当前结果为中心的节点信息面板。 */
import { useMemo, type ComponentType } from "react";
import { Activity, Box, Cloud, Cpu, FileText, HardDrive, Hash, Ratio, Timer, X } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { useLibraryStore } from "@/store/libraryStore";
import { useProjectStore } from "@/store/projectStore";
import { useUiStore } from "@/store/uiStore";
import { useCatalogStore } from "@/store/catalogStore";
import { getPlugin } from "@/nodes/pluginRegistry";
import { getChannelModelsForNodeType } from "@/services/adapters/channelAdapter";
import { buildNodeInfoSnapshot } from "@/lib/nodeInfo";

const STATUS_TONE = {
	node: { color: "#aeb7ca", background: "rgba(174,183,202,0.10)", border: "rgba(174,183,202,0.20)" },
	running: { color: "#c4b5fd", background: "rgba(139,92,246,0.13)", border: "rgba(167,139,250,0.28)" },
	result: { color: "#86efac", background: "rgba(34,197,94,0.11)", border: "rgba(74,222,128,0.24)" },
	failed: { color: "#fca5a5", background: "rgba(239,68,68,0.11)", border: "rgba(248,113,113,0.24)" },
} as const;

export function NodeInfoPopover() {
	const infoNodeId = useUiStore((s) => s.nodeInfoNodeId);
	const node = useCanvasStore((s) => (infoNodeId ? s.nodes[infoNodeId] : null));
	const runtime = useCanvasStore((s) => (infoNodeId ? s.runtime[infoNodeId] : null));
	const assets = useLibraryStore((s) => s.assets);
	const assetBlobs = useProjectStore((s) => s.assetBlobs);
	const catalogModels = useCatalogStore((s) => s.catalog?.models);
	const plugin = node ? getPlugin(node.type) : null;

	const info = useMemo(() => {
		if (!node) return null;
		const shots = node.data.shotAssets ?? [];
		const resultId = node.data.resultAssetId ?? shots[shots.length - 1] ?? "";
		const resultModel = resultId ? node.data.resultMetaByAssetId?.[resultId]?.model : undefined;
		const rawModel = typeof resultModel === "string"
			? resultModel
			: typeof node.data.params?.model === "string" ? node.data.params.model : "";
		const modelLabel = rawModel
			? getChannelModelsForNodeType(node.type).find((m) => m.id === rawModel)?.modelName
				|| catalogModels?.find((m) => m.id === rawModel)?.label
				|| rawModel
			: "";
		const rawType = plugin?.label ?? node.type;
		const typeLabel = rawType.endsWith("节点") ? rawType : `${rawType}节点`;
		return buildNodeInfoSnapshot({ node, runtime, typeLabel, modelLabel, assets, assetBlobs });
	}, [node, runtime, plugin, assets, assetBlobs, catalogModels]);

	if (!infoNodeId || !node || !info) return null;
	const tone = STATUS_TONE[info.status.kind];
	const close = () => useUiStore.getState().setNodeInfoNodeId(null);

	return (
		<div className="fixed inset-0 z-[20000] flex items-center justify-center bg-black/45 backdrop-blur-[2px] animate-in fade-in duration-150" onClick={close}>
			<section
				aria-label="节点信息"
				className="Qiji-panel flex w-[640px] max-w-[calc(100vw-32px)] max-h-[76vh] flex-col overflow-hidden rounded-2xl border border-white/10 text-foreground shadow-2xl animate-in zoom-in-95 duration-150"
				style={{ background: "rgba(25,31,45,0.985)", boxShadow: "0 24px 70px rgba(0,0,0,0.62), 0 1px 0 rgba(255,255,255,0.04) inset" }}
				onClick={(event) => event.stopPropagation()}
			>
				<header className="flex items-center justify-between border-b border-white/[0.07] px-5 py-4">
					<div className="min-w-0">
						<h2 className="text-[15px] font-semibold tracking-[0.01em] text-white">节点信息</h2>
						<p className="mt-0.5 truncate font-mono text-[10px] text-white/35" title={node.id}>{node.id}</p>
					</div>
					<button type="button" onClick={close} aria-label="关闭节点信息" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white/45 transition-colors duration-150 hover:bg-white/[0.07] hover:text-white cursor-pointer">
						<X className="h-4 w-4" />
					</button>
				</header>

				<div className="Qiji-scroll-thin flex-1 overflow-y-auto px-5 py-5">
					<div className="grid grid-cols-2 gap-3">
						<SummaryCard icon={Box} label="节点类型" value={info.typeLabel} />
						<div className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-3.5">
							<div className="flex items-center gap-2 text-[10px] font-medium tracking-[0.08em] text-white/38"><Activity className="h-3.5 w-3.5" />节点状态</div>
							<div className="mt-2.5 flex items-center justify-between gap-3">
								<span className="rounded-full border px-2.5 py-1 text-xs font-semibold tabular-nums" style={{ color: tone.color, background: tone.background, borderColor: tone.border }}>{info.status.label}</span>
								{info.status.progress !== null && <span className="font-mono text-[11px] tabular-nums text-white/45">{info.status.progress}%</span>}
							</div>
							{info.status.progress !== null && <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/[0.07]"><div className="h-full rounded-full bg-violet-400 transition-[width] duration-200 ease-out" style={{ width: `${info.status.progress}%` }} /></div>}
						</div>
					</div>

					<section className="mt-5">
						<div className="mb-2.5 flex items-center justify-between">
							<h3 className="text-xs font-semibold text-white/85">当前结果</h3>
							{info.currentResult?.assetId && <span className="font-mono text-[10px] text-white/30">ID 是资产身份</span>}
						</div>
						<div className="overflow-hidden rounded-xl border border-white/[0.07] bg-black/[0.13]">
							<AddressRow icon={Hash} label="资产 ID" value={info.currentResult?.assetId} />
							<AddressRow icon={Cloud} label="服务地址" value={info.currentResult?.remoteUrl} />
							<AddressRow icon={HardDrive} label="本地路径" value={info.currentResult?.localPath} last />
						</div>
					</section>

					<section className="mt-5 rounded-xl border border-white/[0.07] bg-white/[0.025] p-4">
						<div className="flex items-center justify-between gap-4">
							<div className="flex min-w-0 items-center gap-2.5">
								<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-violet-300/15 bg-violet-400/10 text-violet-200"><Cpu className="h-4 w-4" /></div>
								<div className="min-w-0">
									<div className="text-[10px] text-white/38">使用模型</div>
									<div className="mt-0.5 truncate text-[13px] font-semibold text-white" title={info.modelLabel || "未记录"}>{info.modelLabel || "—"}</div>
								</div>
							</div>
							<div className="flex shrink-0 items-center gap-2">
								<AttributePill icon={Ratio} value={info.aspect} fallback="未记录比例" />
								<AttributePill icon={Timer} value={info.duration} fallback="未记录时长" />
							</div>
						</div>
						<div className="mt-4 border-t border-white/[0.06] pt-4">
							<div className="mb-2 flex items-center gap-2 text-[10px] font-medium tracking-[0.08em] text-white/38"><FileText className="h-3.5 w-3.5" />提示词内容</div>
							<div className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-white/[0.06] bg-black/20 px-3.5 py-3 text-[12px] leading-6 text-white/78 Qiji-scroll-thin" style={{ textWrap: "pretty" }}>
								{info.prompt || <span className="text-white/30">未记录提示词</span>}
							</div>
						</div>
					</section>

					{runtime?.status === "failed" && runtime.error && <div className="mt-4 rounded-xl border border-red-300/15 bg-red-400/[0.07] px-3.5 py-3 text-[11px] leading-5 text-red-200/85">{runtime.error}</div>}
				</div>
			</section>
		</div>
	);
}

function SummaryCard({ icon: Icon, label, value }: { icon: ComponentType<{ className?: string }>; label: string; value: string }) {
	return <div className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-3.5"><div className="flex items-center gap-2 text-[10px] font-medium tracking-[0.08em] text-white/38"><Icon className="h-3.5 w-3.5" />{label}</div><div className="mt-2.5 truncate text-[13px] font-semibold text-white" title={value}>{value}</div></div>;
}

function AddressRow({ icon: Icon, label, value, last }: { icon: ComponentType<{ className?: string }>; label: string; value?: string | null; last?: boolean }) {
	return <div className={`grid grid-cols-[92px_minmax(0,1fr)] items-start gap-3 px-3.5 py-3 ${last ? "" : "border-b border-white/[0.055]"}`}><div className="flex items-center gap-2 text-[10px] text-white/38"><Icon className="h-3.5 w-3.5" />{label}</div><div className="select-text break-all font-mono text-[10px] leading-5 text-white/68" title={value || "未记录"}>{value || "—"}</div></div>;
}

function AttributePill({ icon: Icon, value, fallback }: { icon: ComponentType<{ className?: string }>; value: string; fallback: string }) {
	return <span title={value || fallback} className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 font-mono text-[10px] tabular-nums ${value ? "border-white/10 bg-white/[0.04] text-white/68" : "border-white/[0.06] text-white/25"}`}><Icon className="h-3.5 w-3.5" />{value || "—"}</span>;
}
