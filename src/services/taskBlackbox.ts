/**
 * 任务黑匣子 — 记录每个节点执行的完整请求/响应生命周期。
 *
 * 设计为纯模块级状态，不触发 React 重渲染。
 * 通过 getBlackbox(nodeId) 获取某节点的完整轨迹。
 * 通过 getBlackboxLog() 导出全部日志（供调试面板消费）。
 */

export interface RequestEntry {
  timestamp: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface ResponseEntry {
  timestamp: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
  durationMs: number;
}

export interface ErrorEntry {
  timestamp: string;
  message: string;
  stack?: string;
}

export interface TaskBlackboxRecord {
  nodeId: string;
  nodeType: string;
  adapterKey: string;
  modelName: string;
  startedAt: string;
  endedAt?: string;
  request?: RequestEntry;
  response?: ResponseEntry;
  error?: ErrorEntry;
  pollCount?: number;
  pollHistory?: { timestamp: string; status: string; progress: number; body?: unknown }[];
}

/** 节点 → 黑匣子记录（保留最近 200 条） */
const records = new Map<string, TaskBlackboxRecord>();
const MAX_RECORDS = 200;

/** 开始一条新的追踪 */
export function startTrace(nodeId: string, nodeType: string, adapterKey: string, modelName: string): TaskBlackboxRecord {
  const record: TaskBlackboxRecord = {
    nodeId,
    nodeType,
    adapterKey,
    modelName,
    startedAt: new Date().toISOString(),
    pollHistory: [],
  };
  records.set(nodeId, record);
  if (records.size > MAX_RECORDS) {
    const firstKey = records.keys().next().value;
    if (firstKey) records.delete(firstKey);
  }
  return record;
}

/** 记录请求发送 */
export function recordRequest(nodeId: string, req: RequestEntry): void {
  const r = records.get(nodeId);
  if (r) r.request = req;
}

/** 记录响应 */
export function recordResponse(nodeId: string, res: ResponseEntry): void {
  const r = records.get(nodeId);
  if (r) {
    r.response = res;
    r.endedAt = new Date().toISOString();
  }
}

/** 记录错误 */
export function recordError(nodeId: string, err: Error | string): void {
  const r = records.get(nodeId);
  if (r) {
    r.error = {
      timestamp: new Date().toISOString(),
      message: typeof err === "string" ? err : err.message,
      stack: typeof err === "string" ? undefined : err.stack,
    };
    r.endedAt = new Date().toISOString();
  }
}

/** 记录一次轮询 */
export function recordPoll(nodeId: string, status: string, progress: number, body?: unknown): void {
  const r = records.get(nodeId);
  if (r) {
    r.pollCount = (r.pollCount ?? 0) + 1;
    r.pollHistory?.push({ timestamp: new Date().toISOString(), status, progress, body });
  }
}

/** 获取单个节点的黑匣子记录 */
export function getBlackbox(nodeId: string): TaskBlackboxRecord | undefined {
  return records.get(nodeId);
}

/** 获取全部日志（按时间倒序） */
export function getBlackboxLog(): TaskBlackboxRecord[] {
  return [...records.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** 清空全部日志 */
export function clearBlackbox(): void {
  records.clear();
}