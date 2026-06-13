import type { CSSProperties, DragEvent as ReactDragEvent } from "react";
import { Layers, Settings } from "lucide-react";
import { listPlugins } from "@/nodes/pluginRegistry";
import { dispatchCommand } from "@/command/dispatch";
import { makeNode, NODE_MIME } from "./nodeFactory";
import type { NodeType } from "@/types";
import { useUiStore } from "@/store/uiStore";

function onDragStart(e: ReactDragEvent, type: NodeType) {
	e.dataTransfer.setData(NODE_MIME, type);
	e.dataTransfer.effectAllowed = "move";
}

/** 左侧浮动工具 dock：五类节点。拖入画布或点击在视口中心新建。 */
export function FloatingToolbar() {
	const addAtCenter = (type: NodeType) => {
		const x = 120 + Math.round(Math.random() * 80);
		const y = 120 + Math.round(Math.random() * 80);
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
						draggable
						onDragStart={(e) => onDragStart(e, plugin.type)}
						onClick={() => addAtCenter(plugin.type)}
						style={accentStyle}
						title={`新建${plugin.label}节点`}
						className="group flex h-11 w-11 cursor-grab flex-col items-center justify-center gap-0.5 rounded-xl text-muted-foreground transition-colors hover:bg-secondary hover:text-[color:var(--node-accent)]"
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
