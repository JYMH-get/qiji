import { libAudioAdapter } from "../../services/adapters/libAudioAdapter";

export default {
  id: "audio",
  name: "音频",
  version: "1.0.0",
  type: "audio",
  iconName: "AudioLines",
  accentVar: "var(--node-audio)",
  resultKind: "audio",
  defaultModel: "lib-audio",
  description: "AI 音频生成，支持配音、音效、BGM",
  category: "media",
  thumbnail: null,
  inputs: [
    { name: "clip", formats: ["clip", "video"] },
    { name: "text", formats: ["shot", "text"] }
  ],
  outputs: [{ name: "audio", formats: ["audio"] }],
  canStack: false,

  models: [
    {
      id: "voice",
      name: "配音",
      color: "text-blue-400 font-bold",
      ratios: ["auto"]
    }
  ],

  adapter: {
    key: "lib-audio",
    displayName: "Lib Audio",
    vendor: "Lib",
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
            default: "旁白"
          }
        ]
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
            unit: "s"
          }
        ]
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
            default: "舒缓"
          }
        ]
      }
    ]
  },

  estimateCost(modeKey, params) {
    return 12;
  },

  async createTask(config, params) {
    const res = await libAudioAdapter.submit(params, params);
    return res.taskId;
  },

  async queryTask(config, taskId, params = {}) {
    const res = await libAudioAdapter.poll(taskId);
    return {
      status: res.status,
      progress: res.progress,
      audio_url: res.resultUri,
      error: res.error
    };
  }
};
