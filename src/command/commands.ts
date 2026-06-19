import type { CanvasEdge, CanvasNode, NodeType } from "@/types";

/**
 * 所有对画布的改动都表示为「命令」。GUI / Copilot / Agent 三入口统一发命令。
 * 结构命令会进入撤销栈；运行类命令（run）不入撤销栈。
 */
export type Command =
  | { type: "addNode"; node: CanvasNode }
  | {
      type: "updateNodePosition";
      updates: { id: string; x: number; y: number }[];
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
  | { type: "executeNodeAction"; nodeId: string; actionName: string }
  | { type: "setNodeResultAsset"; nodeId: string; assetId: string | null }
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
    "setNodeResultAsset",
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