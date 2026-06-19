import { gvlmTextAdapter } from "../../services/adapters/gvlmTextAdapter";

export default {
  id: "text",
  name: "文本",
  version: "1.0.0",
  type: "text",
  iconName: "Type",
  accentVar: "var(--node-text)",
  resultKind: "text",
  defaultModel: "gvlm-text",
  description: "AI 文本生成与编辑，支持提示词扩写、反推等",
  category: "content",
  thumbnail: null,
  inputs: [],
  outputs: [{ name: "text", formats: ["text"] }],
  canStack: false,

  // Models structure for standard UI
  models: [
    {
      id: "compose",
      name: "自己编写",
      color: "text-blue-400 font-bold",
      ratios: ["auto"]
    }
  ],

  // Full adapter modes mapping to render inputs correctly:
  adapter: {
    key: "gvlm-text",
    displayName: "GVLM 3.1",
    vendor: "Lib",
    baseCost: 2,
    modes: [
      {
        key: "compose",
        label: "自己编写",
        inputHint: "直接输入创意文本，作为后续节点的创意种子",
        paramsSchema: [
          {
            key: "tone",
            label: "语气",
            type: "enum",
            options: ["中性", "悬疑", "热血", "治愈", "搞笑"],
            default: "中性"
          },
          {
            key: "length",
            label: "篇幅",
            type: "enum",
            options: ["短", "中", "长"],
            default: "中"
          }
        ]
      },
      {
        key: "to-video-prompt",
        label: "文生视频提示",
        inputHint: "将创意扩写为可直接驱动视频生成的提示词",
        paramsSchema: [
          {
            key: "shotStyle",
            label: "镜头风格",
            type: "enum",
            options: ["电影感", "纪实", "动漫", "广告片"],
            default: "电影感"
          }
        ]
      },
      {
        key: "image-reverse",
        label: "图片反推提示",
        inputHint: "从参考图片反推提示词",
        paramsSchema: []
      },
      {
        key: "to-music-prompt",
        label: "文生音乐提示",
        inputHint: "生成用于音乐/音效节点的描述",
        paramsSchema: [
          {
            key: "mood",
            label: "情绪",
            type: "enum",
            options: ["舒缓", "紧张", "史诗", "温暖"],
            default: "舒缓"
          }
        ]
      }
    ]
  },

  estimateCost(modeKey, params) {
    return 2;
  },

  async createTask(config, params) {
    const res = await gvlmTextAdapter.submit(params, params);
    return res.taskId;
  },

  async queryTask(config, taskId, params = {}) {
    const res = await gvlmTextAdapter.poll(taskId);
    return {
      status: res.status,
      progress: res.progress,
      text: res.resultUri,
      error: res.error
    };
  }
};
