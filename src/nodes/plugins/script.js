import { gvlmScriptAdapter } from "../../services/adapters/gvlmScriptAdapter";

export default {
  id: "script",
  name: "脚本",
  version: "1.0.0",
  type: "script",
  iconName: "ScrollText",
  accentVar: "var(--node-script)",
  resultKind: "script",
  defaultModel: "gvlm-script",
  description: "剧本拆分为分镜脚本，支持角色驱动",
  category: "content",
  thumbnail: null,
  inputs: [{ name: "text", formats: ["text"] }],
  outputs: [{ name: "shot", formats: ["shot", "text"] }],
  canStack: false,

  models: [
    {
      id: "script-to-shots",
      name: "剧本→分镜脚本",
      color: "text-blue-400 font-bold",
      ratios: ["auto"]
    }
  ],

  adapter: {
    key: "gvlm-script",
    displayName: "GVLM 3.1",
    vendor: "Lib",
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
            step: 1
          }
        ]
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
            step: 1
          }
        ]
      }
    ]
  },

  estimateCost(modeKey, params) {
    return 6;
  },

  async createTask(config, params) {
    const res = await gvlmScriptAdapter.submit(params, params);
    return res.taskId;
  },

  async queryTask(config, taskId, params = {}) {
    const res = await gvlmScriptAdapter.poll(taskId);
    return {
      status: res.status,
      progress: res.progress,
      text: res.resultUri,
      error: res.error
    };
  }
};
