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
  /** lost：服务端可达但找不到该任务（多因服务端重启丢了内存任务）——终态，但可凭原 taskId 重连找回 */
  status: "queued" | "running" | "success" | "failed" | "lost";
  progress: number;
  resultUri?: string;
  /** 管理端分配的资产 id（图像/视频成功时；用于三元映射与本地落盘） */
  assetId?: string;
  /** 进行中任务的部分正文（文本流式：服务端 partialText 经 task.result.text 透出，供边收边解析） */
  partialText?: string;
  /** 服务端未能转存结果（meta.rehosted=false，resultUri=上游原始时效直链）——
   *  客户端应自行下载（本机网络）并经 POST /v1/assets 上传回服务端落 OSS 替换成永久直链（第158轮） */
  rawLink?: boolean;
  error?: string;
}

export interface ModelAdapter {
  key: string;
  displayName: string;
  vendor: string;
  /** 该模型可服务的节点类型 */
  nodeTypes: NodeType[];
  modes: CapabilityMode[];
  /** 参数表单以 mode.paramsSchema 为准（第三方本地渠道：参数按第三方要求，覆盖节点 spec 的固定参数） */
  paramsFromMode?: boolean;
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