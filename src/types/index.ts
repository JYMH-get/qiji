export type NodeType = string;
export type ResultKind = string;

/** 运行态（不入库，临时态） */
export type RuntimeStatus =
	| "idle"
	| "editing"
	| "uploading"
	| "queued"
	| "scheduled"
	| "running"
	| "success"
	| "failed";

/** 连线类型：普通数据流 vs 延续（借用上一片段作参考，强排序依赖） */
export type EdgeKind = "dataflow" | "continuation";

/** 资产 ID：全局唯一、单调递增、永不复用、仅用户可删除 */
export type AssetId = string;

/** AI对话节点的一条消息（持久化在 node.data.messages） */
export interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	/** 用户消息可携带图片（公网 url 发给模型，previewUrl 本地展示） */
	images?: { id?: string; url: string; previewUrl?: string; name?: string }[];
	/** 该条助手消息是否出错 */
	error?: boolean;
	timestamp: number;
}

export interface NodeData {
	input: Record<string, unknown>;
	params: Record<string, unknown>;
	resultAssetId: AssetId | null;
	/**
	 * 节点素材区的**加入顺序**（素材只往后加、不往前插原则）：key = `e:<edgeId>`（上游连线素材）
	 * / `s:<blobId|url>`（自加素材）。@ImageN 编号按此序（同媒体分组内 1-based），先匹配后连线时
	 * 连线素材排在已匹配素材之后，已写入提示词的 @ 引用不错位。缺失/未记录的素材按旧序
	 * （上游前、自加后）补在已记录素材之后——旧项目行为不变。
	 */
	matOrder?: string[];
	/** 图片/视频节点的生成历史（资产 id，旧→新，含当前主图）：堆叠展开可查看/切换主图 */
	resultHistory?: AssetId[];
	/**
	 * 在途生成任务凭据（断连保护，随项目落盘）：提交确认时写入 {taskId, adapterKey}，
	 * 重开项目/切回画布时 resumeCanvasNodeTasks 凭它重挂轮询接回结果（不重新提交、不再扣费）；
	 * 服务端给出终态（success/failed）后清除。
	 */
	task?: { taskId: string; adapterKey: string; startedAt: number };
	/** 分镜组节点（shot.group）：宫格内图片资产 id 的有序列表（顺序即宫格阅读序，可拖动重排） */
	shotAssets?: AssetId[];
	/** 节点自定义标题（节点上方标签优先显示它；智能推理裂变流水线命名「分镜n原文/故事板/视频」用） */
	title?: string;
	/** 文本类节点的生成结果（结果即显示；文本/故事板/拆分节点用） */
	resultText?: string;
	/** AI对话节点的对话历史（多轮记忆） */
	messages?: ChatMessage[];
	/** 文件/上传节点：本地文件的 dataURL 或 objectURL */
	fileUri?: string;
	fileName?: string;
	fileMime?: string;
	/**
	 * 资产模式投影来源标识（单数据源双视图）：该节点由资产模式的哪个实体投影而来
	 * （如 `asset:C01-...` / `episode:ep1` / `assetSplit`）。canvasProjection 据此幂等去重、就地更新。
	 */
	sourceRef?: string;
	/** 投影归属分集 id（仅分集流水线节点带）：画布按「当前分集」筛选/清理投影节点，降低节点数与卡顿 */
	episodeRef?: string;
	/** 预留：脏传播版本号，当前不消费 */
	sourceVersion?: number;
	/**
	 * 图片标注（标注产物节点带）：sourceAssetId=被标注的原图资产、doc=矢量标注 JSON
	 * （只存矢量描述，绝不存 base64——合成图走 resultAssetId）。再次「标注」= 凭原图+doc 继续编辑。
	 */
	annotation?: { sourceAssetId?: string; doc: import("@/lib/annotation").AnnotationDoc };
	/**
	 * 3D 导演台场景（产物节点带）：scene=模型场景 JSON（只存引用与变换，绝不存位图/base64）、
	 * mode=舞台背景模式、srcAssetId=底图/全景资产。再点「3D导演台」= 凭场景继续编辑。
	 */
	stage3d?: { scene: import("@/lib/stageScene").StageSceneDoc; mode: "stage" | "image" | "pano"; srcAssetId?: string };
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

