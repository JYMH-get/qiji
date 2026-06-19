import type { ModelAdapter } from "./types";
import { mockIO } from "./utils";

/** Lib Audio — 音频节点（配音 / 音效 / BGM） */
export const libAudioAdapter: ModelAdapter = {
  key: "lib-audio",
  displayName: "Lib Audio",
  vendor: "Lib",
  nodeTypes: ["audio"],
  baseCost: 12,
  modes: [
    {
      key: "voice",
      label: "配音",
      inputHint: "文本转语音",
      paramsSchema: [
        {
          key: "voiceType",
          label: "音色",
          type: "enum",
          options: ["青年男", "青年女", "少年", "旁白"],
          default: "旁白",
        },
      ],
    },
    {
      key: "sfx",
      label: "音效",
      inputHint: "生成环境/动效音效",
      paramsSchema: [
        {
          key: "duration",
          label: "时长",
          type: "number",
          default: 5,
          min: 1,
          max: 30,
          step: 1,
          unit: "s",
        },
      ],
    },
    {
      key: "bgm",
      label: "BGM",
      inputHint: "生成背景音乐",
      paramsSchema: [
        {
          key: "mood",
          label: "情绪",
          type: "enum",
          options: ["舒缓", "紧张", "史诗", "温暖"],
          default: "舒缓",
        },
      ],
    },
  ],
  estimateCost() {
    return this.baseCost;
  },
  ...mockIO(),
};