import type { ModelAdapter } from "./types";
import { mockIO } from "./utils";

/** GVLM 3.1 — 脚本生成器（剧本→分镜脚本 / 角色→分镜脚本） */
export const gvlmScriptAdapter: ModelAdapter = {
  key: "gvlm-script",
  displayName: "GVLM 3.1",
  vendor: "Lib",
  nodeTypes: ["script"],
  baseCost: 6,
  modes: [
    {
      key: "script-to-shots",
      label: "剧本→分镜脚本",
      inputHint: "输入剧本/文案，生成可爆破的分镜脚本",
      paramsSchema: [
        {
          key: "shotCount",
          label: "分镜数量",
          type: "number",
          default: 6,
          min: 1,
          max: 30,
          step: 1,
        },
      ],
    },
    {
      key: "role-to-shots",
      label: "角色→分镜脚本",
      inputHint: "从角色设定出发生成分镜脚本",
      paramsSchema: [
        {
          key: "shotCount",
          label: "分镜数量",
          type: "number",
          default: 6,
          min: 1,
          max: 30,
          step: 1,
        },
      ],
    },
  ],
  estimateCost() {
    return this.baseCost;
  },
  ...mockIO(),
};