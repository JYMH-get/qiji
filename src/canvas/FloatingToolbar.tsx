import type { CSSProperties } from "react";
import { Layers, Settings } from "lucide-react";
import { listPlugins } from "@/nodes/pluginRegistry";
import { dispatchCommand } from "@/command/dispatch";
import { makeNode, NODE_W, NODE_H } from "./nodeFactory";
import type { NodeType } from "@/types";
import { useUiStore } from "@/store/uiStore";
import { useDragToCanvas } from "./useDragToCanvas";
import { useReactFlow } from "@xyflow/react";

/** 左侧浮动工具 dock：五类节点。拖入画布或点击在视口中心新建。 */
export function FloatingToolbar() {
	const startDragToCanvas = useDragToCanvas();
	const { screenToFlowPosition } = useReactFlow();

	const addAtCenter = (type: NodeType) => {
		const screenCenterX = window.innerWidth / 2;
		const screenCenterY = window.innerHeight / 2;
		const flowPos = screenToFlowPosition({ x: screenCenterX, y: screenCenterY });
		const x = flowPos.x - NODE_W / 2;
		const y = flowPos.y - NODE_H / 2;
		dispatchCommand({ type: "addNode", node: makeNode(type, x, y) });
	};

	const plugins = listPlugins().filter((p) => !p.type.startsWith("file_"));

	return (
		<div className="Qiji-toolbar pointer-events-auto absolute left-4 top-1/2 z-20 flex -translate-y-1/2 flex-col gap-1 rounded-2xl p-1.5">
			<div className="flex flex-col items-center gap-0.5 px-1 pb-1.5 pt-1 text-muted-foreground">
				<Layers className="h-4 w-4" />
			</div>
			{plugins.map((plugin) => {
				const Icon = plugin.icon;
				const accentStyle = { "--node-accent": plugin.accentVar } as CSSProperties;
				return (
					<button
						key={plugin.type}
						onMouseDown={(e) =>
							startDragToCanvas(
								e,
								{ type: "sidebar", nodeType: plugin.type },
								() => addAtCenter(plugin.type)
							)
						}
						style={accentStyle}
						title={`新建${plugin.label}节点`}
						className="group flex h-11 w-11 cursor-grab flex-col items-center justify-center gap-0.5 rounded-xl text-muted-foreground transition-colors hover:bg-secondary hover:text-[color:var(--node-accent)] select-none"
					>
						<Icon className="h-4 w-4" />
						<span className="text-[9px]">{plugin.label}</span>
					</button>
				);
			})}
			
			<div className="h-[1px] bg-border/40 my-1 w-full" />
			
			<button
				onClick={() => useUiStore.getState().setSettingsOpen(true)}
				title="系统设置"
				className="group flex h-11 w-11 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-xl text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
			>
				<Settings className="h-4.5 w-4.5" />
				<span className="text-[9px]">设置</span>
			</button>
		</div>
	);
}
