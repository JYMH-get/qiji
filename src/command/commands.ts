import type { CanvasEdge, CanvasNode, NodeType } from "@/types";

/**
 * 所有对画布的改动都表示为「命令」。GUI / Copilot / Agent 三入口统一发命令。
 * 结构命令会进入撤销栈；运行类命令（run）不入撤销栈。
 */
export type Command =
  | { type: "addNode"; node: CanvasNode }
  | {
      type: "updateNodePosition";
      updates: { id: string; x: number; y: number; w?: number; h?: number }[];
    }
  | { type: "resizeNode"; id: string; w: number; h: number }
  | { type: "updateNodeParams"; id: string; params: Record<string, unknown> }
  | { type: "deleteNode"; id: string }
  | { type: "connect"; edge: CanvasEdge }
  | { type: "disconnect"; edgeId: string }
  | {
      type: "pasteNodes";
      nodes: CanvasNode[];
      edges: CanvasEdge[];
    }
  | {
      type: "insertOnEdge";
      edgeId: string;
      node: CanvasNode;
      nodeType: NodeType;
    }
  | { type: "group"; nodeIds: string[] }
  | { type: "ungroup"; groupId: string; nodeId?: string }
  | {
      type: "burstScript";
      scriptId: string;
      shots: CanvasNode[];
      edges: CanvasEdge[];
    }
  | {
      type: "spawnNodes";
      parentId: string;
      nodes: CanvasNode[];
      edges: CanvasEdge[];
      /** 严格不重叠：落位压到的已有节点让位后的坐标（随本命令一并应用=一次撤销整体回退） */
      pushed?: { id: string; x: number; y: number }[];
    }
  | { type: "executeNodeAction"; nodeId: string; actionName: string }
  | { type: "setNodeResultAsset"; nodeId: string; assetId: string | null }
  /** 自定义结果：把（已上传好的）资产追加为节点结果——已有主图归档进堆叠历史，最后一个新资产设为主图（一次撤销） */
  | { type: "addNodeResults"; nodeId: string; assetIds: string[] }
  /** 抽屉式堆叠：把 source 节点的结果（含其历史）并入 target 同类节点的堆叠，并删除 source 节点（一次撤销） */
  | { type: "mergeNodeIntoStack"; sourceId: string; targetId: string }
  /** 分镜组：UI 构建好的 shot.group 节点落子；deleteSourceIds=被合并的源图片节点（连线级联删除，一次撤销） */
  | { type: "createShotGroup"; node: CanvasNode; deleteSourceIds?: string[] }
  /** 分镜组：整组替换宫格资产列表（拖动排序/清空，一次撤销） */
  | { type: "updateShotGroup"; nodeId: string; assets: string[] }
  /** 分镜组：解组——每张图裂变一个 image.gen 节点承载，删除分镜组节点（一次撤销） */
  | { type: "dissolveShotGroup"; nodeId: string }
  /** 分镜组：单独解除——把第 index 格的图移出宫格并裂变 image.gen 节点承载，组节点保留（一次撤销） */
  | { type: "extractShotGroupItem"; nodeId: string; index: number }
  /** 重组文本（拆分的逆）：多个文本节点合并成一个新原文节点 node，删除源节点 deleteSourceIds（连线级联，一次撤销） */
  | { type: "mergeTextNodes"; node: CanvasNode; deleteSourceIds: string[] }
  | { type: "run"; nodeId: string }
  | { type: "schedule"; nodeId: string; scheduledAt: string }
  | { type: "cancelSchedule"; nodeId: string }
  | { type: "undo" }
  | { type: "redo" };

export type CommandType = Command["type"];

/** 结构命令：进入撤销栈 */
export const STRUCTURAL_COMMANDS: ReadonlySet<CommandType> =
  new Set<CommandType>([
    "addNode",
    "updateNodePosition",
    "resizeNode",
    "deleteNode",
    "connect",
    "disconnect",
    "pasteNodes",
    "insertOnEdge",
    "group",
    "ungroup",
    "burstScript",
    "spawnNodes",
    "setNodeResultAsset",
    "addNodeResults",
    "mergeNodeIntoStack",
    "createShotGroup",
    "updateShotGroup",
    "dissolveShotGroup",
    "extractShotGroupItem",
    "mergeTextNodes",
  ]);

/**
 * Agent 错峰自动模式命令白名单 = 仅生成/调度类，禁止一切结构命令。
 * 把 Agent 自动行为牢牢限制在「执行既有图」。
 */
export const AGENT_AUTO_ALLOWED: ReadonlySet<CommandType> = new Set<CommandType>([
  "run",
  "schedule",
  "cancelSchedule",
]);