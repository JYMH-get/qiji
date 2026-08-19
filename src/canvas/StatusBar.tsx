import { Coins, Boxes, MousePointerClick } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { useUiStore } from "@/store/uiStore";
import { useConnectionStore } from "@/store/connectionStore";

/** 底部状态栏：积分余额 / 节点数 / 选中数。点积分打开个人中心。 */
export function StatusBar() {
	const nodeCount = useCanvasStore((s) => Object.keys(s.nodes).length);
	const selected = useUiStore((s) => s.selectedNodeIds.length);
	const credits = useConnectionStore((s) => s.user?.credits ?? 0);

	return (
		<div className="Qiji-statusbar pointer-events-auto absolute bottom-4 left-4 z-[10100] flex items-center gap-4 rounded-xl px-3 py-1.5 text-[11px] text-muted-foreground">
			<span
				className="flex items-center gap-1 cursor-pointer hover:text-foreground transition-colors"
				title="查看个人中心 / 兑换积分"
				onClick={() => useUiStore.getState().setPersonalCenterOpen(true)}
			>
				<Coins className="h-3.5 w-3.5" />
				<span className="font-mono text-foreground">
					{credits}
				</span>
				积分
			</span>
			<span className="flex items-center gap-1">
				<Boxes className="h-3.5 w-3.5" />
				{nodeCount} 节点
			</span>
			<span className="flex items-center gap-1">
				<MousePointerClick className="h-3.5 w-3.5" />
				{selected} 选中
			</span>
		</div>
	);
}
