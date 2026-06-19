import type { ModelAdapter } from "./types";
import { mockIO, num } from "./utils";

/** Lib Image — 图片节点（文生图 / 图生图编辑） */
export const libImageAdapter: ModelAdapter = {
  key: "lib-image",
  displayName: "Lib Image",
  vendor: "Lib",
  nodeTypes: ["image"],
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
          options: ["写实", "动漫", "水彩", "赛博朗克", "国风"],
          default: "动漫",
        },
        {
          key: "ratio",
          label: "比例",
          type: "enum",
          options: ["自适应", "1:1", "16:9", "9:16", "4:3"],
          default: "自适应",
        },
        {
          key: "quality",
          label: "画质",
          type: "enum",
          options: ["标准", "高清", "2K"],
          default: "标准",
        },
        {
          key: "quantity",
          label: "数量",
          type: "number",
          default: 1,
          min: 1,
          max: 4,
          step: 1,
        },
      ],
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
          step: 0.05,
        },
        {
          key: "quality",
          label: "画质",
          type: "enum",
          options: ["标准", "高清", "2K"],
          default: "标准",
        },
        {
          key: "quantity",
          label: "数量",
          type: "number",
          default: 1,
          min: 1,
          max: 4,
          step: 1,
        },
      ],
    },
  ],
  estimateCost(_modeKey, params) {
    return this.baseCost * num(params, "quantity", 1);
  },
  ...mockIO(),
};