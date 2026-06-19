import { registerNodeHandlers } from "./handlers/nodeHandlers";
import { registerDeleteHandlers } from "./handlers/deleteHandlers";
import {
  registerConnectionHandlers,
  registerGroupHandlers,
} from "./handlers/connectionHandlers";
import {
  registerExecutionHandlers,
  registerHistoryHandlers,
} from "./handlers/executionHandlers";

let registered = false;

/**
 * 把命令处理器接到画布 store 上。GUI / Copilot / Agent 三入口最终都在这里落库。
 * 模块级单次注册（StrictMode 双调用安全）。
 */
export function registerCanvasHandlers(): void {
  if (registered) return;
  registered = true;

  registerNodeHandlers();
  registerDeleteHandlers();
  registerConnectionHandlers();
  registerGroupHandlers();
  registerExecutionHandlers();
  registerHistoryHandlers();
}