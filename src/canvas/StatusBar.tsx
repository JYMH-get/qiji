import { Coins, Boxes, MousePointerClick } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { useUiStore } from "@/store/uiStore";
import { creditLedger } from "@/services/creditLedger";

/** 底部状态栏：积分余额 / 节点数 / 选中数。 */
export function StatusBar() {
	const nodeCount = useCanvasStore((s) => Object.keys(s.nodes).length);
	const selected = useUiStore((s) => s.selectedNodeIds.length);

	return (
		<div className="Qiji-statusbar pointer-events-auto absolute bottom-4 left-4 z-[10100] flex items-center gap-4 rounded-xl px-3 py-1.5 text-[11px] text-muted-foreground">
			<span className="flex items-center gap-1">
				<Coins className="h-3.5 w-3.5" />
				<span className="font-mono text-foreground">
					{creditLedger.available}
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
