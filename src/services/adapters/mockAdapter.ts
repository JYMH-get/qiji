import type { ModelAdapter } from "./types";
import { mockIO } from "./utils";

/** Phase 0 遗留：回声占位适配器，便于本地联调 */
export const mockAdapter: ModelAdapter = {
  key: "mock",
  displayName: "Mock 模型（占位）",
  vendor: "—",
  nodeTypes: [],
  baseCost: 1,
  modes: [
    {
      key: "echo",
      label: "回声",
      paramsSchema: [],
    },
  ],
  estimateCost() {
    return this.baseCost;
  },
  ...mockIO(),
};