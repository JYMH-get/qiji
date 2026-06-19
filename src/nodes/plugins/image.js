import { libImageAdapter } from "../../services/adapters/libImageAdapter";

export default {
  id: "image",
  name: "图片",
  version: "1.0.0",
  type: "image",
  iconName: "ImageIcon",
  accentVar: "var(--node-image)",
  resultKind: "image",
  defaultModel: "lib-image",
  description: "AI 图片生成，支持文生图、图生图编辑",
  category: "media",
  thumbnail: null,
  inputs: [{ name: "shot", formats: ["shot", "text"] }],
  outputs: [{ name: "frame", formats: ["frame", "image"] }],
  canStack: true,

  models: [
    {
      id: "text2image",
      name: "文生图",
      color: "text-blue-400 font-bold",
      ratios: ["auto", "1:1", "16:9", "9:16", "4:3"]
    }
  ],

  adapter: {
    key: "lib-image",
    displayName: "Lib Image",
    vendor: "Lib",
    baseCost: 18,
    modes: [
      {
        key: "text2image",
        label: "文生图",
        inputHint: "根据提示词生成图片",
        paramsSchema: [
          {
            key: "style",
            label: "风格",
            type: "enum",
            options: ["写实", "动漫", "水彩", "赛博朋克", "国风"],
            default: "动漫"
          },
          {
            key: "ratio",
            label: "比例",
            type: "enum",
            options: ["自适应", "1:1", "16:9", "9:16", "4:3"],
            default: "自适应"
          },
          {
            key: "quality",
            label: "画质",
            type: "enum",
            options: ["标准", "高清", "2K"],
            default: "标准"
          },
          {
            key: "quantity",
            label: "数量",
            type: "number",
            default: 1,
            min: 1,
            max: 4,
            step: 1
          }
        ]
      },
      {
        key: "image2image",
        label: "图生图编辑",
        inputHint: "基于参考图做重绘/编辑",
        paramsSchema: [
          {
            key: "strength",
            label: "重绘强度",
            type: "number",
            default: 0.6,
            min: 0,
            max: 1,
            step: 0.05
          },
          {
            key: "quality",
            label: "画质",
            type: "enum",
            options: ["标准", "高清", "2K"],
            default: "标准"
          },
          {
            key: "quantity",
            label: "数量",
            type: "number",
            default: 1,
            min: 1,
            max: 4,
            step: 1
          }
        ]
      }
    ]
  },

  estimateCost(modeKey, params) {
    return 18 * (params.quantity || 1);
  },

  async createTask(config, params) {
    const res = await libImageAdapter.submit(params, params);
    return res.taskId;
  },

  async queryTask(config, taskId, params = {}) {
    const res = await libImageAdapter.poll(taskId);
    return {
      status: res.status,
      progress: res.progress,
      image_url: res.resultUri,
      error: res.error
    };
  }
};
