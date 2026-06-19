import type { NodeType } from "@/types";

export type ParamType = "text" | "textarea" | "enum" | "number" | "boolean";

export interface ParamField {
  key: string;
  label: string;
  type: ParamType;
  options?: string[];
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  group?: string;
}

/** 能力模式（面板顶部 tab）：一个模型可带多个能力，各自一套参数表单。 */
export interface CapabilityMode {
  key: string;
  label: string;
  inputHint?: string;
  paramsSchema: ParamField[];
}

export interface SubmitResult {
  taskId: string;
}

export interface PollResult {
  status: "queued" | "running" | "success" | "failed";
  progress: number;
  resultUri?: string;
  error?: string;
}

export interface ModelAdapter {
  key: string;
  displayName: string;
  vendor: string;
  /** 该模型可服务的节点类型 */
  nodeTypes: NodeType[];
  modes: CapabilityMode[];
  /** 基准积分（单次/单位） */
  baseCost: number;
  estimateCost(modeKey: string, params: Record<string, unknown>): number;
  submit(
    input: Record<string, unknown>,
    params: Record<string, unknown>,
    nodeType?: NodeType,
  ): Promise<SubmitResult>;
  poll(taskId: string): Promise<PollResult>;
}