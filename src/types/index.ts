export type NodeType = string;
export type ResultKind = string;

/** 运行态（不入库，临时态） */
export type RuntimeStatus =
	| "idle"
	| "editing"
	| "queued"
	| "scheduled"
	| "running"
	| "success"
	| "failed";

/** 连线类型：普通数据流 vs 延续（借用上一片段作参考，强排序依赖） */
export type EdgeKind = "dataflow" | "continuation";

/** 资产 ID：全局唯一、单调递增、永不复用、仅用户可删除 */
export type AssetId = string;

export interface NodeData {
	input: Record<string, unknown>;
	params: Record<string, unknown>;
	resultAssetId: AssetId | null;
	/** 文件节点：本地文件的 dataURL 或 objectURL */
	fileUri?: string;
	fileName?: string;
	fileMime?: string;
	/** 预留：脏传播版本号，当前不消费 */
	sourceVersion?: number;
}

export interface CanvasNode {
	id: string;
	type: NodeType;
	x: number;
	y: number;
	w: number;
	h: number;
	parentId: string | null;
	/** 由脚本爆破产生的镜头节点回指脚本节点 */
	parentScriptId: string | null;
	data: NodeData;
}

export interface CanvasEdge {
	id: string;
	kind: EdgeKind;
	source: string;
	sourcePort: string;
	target: string;
	targetPort: string;
}

export interface CanvasGroup {
	id: string;
	childIds: string[];
	x: number;
	y: number;
}

export interface NodeRuntime {
	status: RuntimeStatus;
	progress: number;
	taskId: string | null;
	scheduledAt: string | null;
	error: string | null;
}

/** 错峰自动模式配置（人机协作） */
export interface AutoSchedule {
	startAt: string | null;
	endAt: string | null;
	mode: "agentAuto";
	scopeNodeIds: string[];
	interruptible: boolean;
	authExpiresAt: string | null;
}

export interface Project {
	id: string;
	name: string;
	canvasId: string;
	autoSchedule: AutoSchedule | null;
}

export interface FileInfo {
	fileId: string;
	fileName: string;
	fileMime: string;
	fileUri: string;
	localPath: string | null;
}

