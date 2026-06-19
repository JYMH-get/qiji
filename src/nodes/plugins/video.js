import { seedanceAdapter } from "../../services/adapters/seedanceAdapter";

export default {
  id: "video",
  name: "视频",
  version: "1.0.0",
  type: "video",
  iconName: "Clapperboard",
  accentVar: "var(--node-video)",
  resultKind: "video",
  defaultModel: "seedance-2",
  description: "AI 视频生成，支持文生视频、动作模仿、全能参考",
  category: "media",
  thumbnail: null,
  inputs: [
    { name: "frame", formats: ["frame", "image"] },
    { name: "clip", formats: ["clip", "video"] },
    { name: "audio", formats: ["audio"] },
    { name: "text", formats: ["shot", "text"] }
  ],
  outputs: [{ name: "clip", formats: ["clip", "video"] }],
  canStack: true,

  models: [
    {
      id: "text2video",
      name: "文生视频",
      color: "text-blue-400 font-bold",
      ratios: ["auto", "16:9", "9:16", "1:1"]
    }
  ],

  adapter: {
    key: "seedance-2",
    displayName: "Seedance 2.0",
    vendor: "字节跳动 / 简梦",
    baseCost: 9,
    modes: [
      {
        key: "text2video",
        label: "文生视频",
        inputHint: "输入视频描述提示词，支持在文本中插入 @Image1, @Video1, @Audio1 等引用素材...",
        paramsSchema: [
          {
            key: "resolution",
            label: "分辨率",
            type: "enum",
            options: ["480p", "720p（标清）", "1080p（高清）"],
            default: "480p"
          },
          {
            key: "aspect_ratio",
            label: "宽高比",
            type: "enum",
            options: ["横屏（16:9）", "竖屏（9:16）", "方形（1:1）", "21:9", "3:4", "4:3"],
            default: "横屏（16:9）"
          },
          {
            key: "duration",
            label: "时长",
            type: "number",
            min: 4,
            max: 15,
            step: 1,
            default: 4,
            unit: "s"
          }
        ]
      },
      {
        key: "motion-imitation",
        label: "动作模仿",
        inputHint: "上传一段参考视频，AI 将模仿其中的动作生成新视频...",
        paramsSchema: [
          {
            key: "resolution",
            label: "分辨率",
            type: "enum",
            options: ["480p", "720p（标清）", "1080p（高清）"],
            default: "480p"
          },
          {
            key: "aspect_ratio",
            label: "宽高比",
            type: "enum",
            options: ["横屏（16:9）", "竖屏（9:16）", "方形（1:1）"],
            default: "横屏（16:9）"
          },
          {
            key: "duration",
            label: "时长",
            type: "number",
            min: 4,
            max: 15,
            step: 1,
            default: 4,
            unit: "s"
          }
        ]
      },
      {
        key: "all-reference",
        label: "全能参考",
        inputHint: "多图/角色库参考生成，在提示词中用 @Image1 @Video1 @Audio1 引用素材...",
        paramsSchema: [
          {
            key: "resolution",
            label: "分辨率",
            type: "enum",
            options: ["480p", "720p（标清）", "1080p（高清）"],
            default: "480p"
          },
          {
            key: "aspect_ratio",
            label: "宽高比",
            type: "enum",
            options: ["横屏（16:9）", "竖屏（9:16）", "方形（1:1）"],
            default: "横屏（16:9）"
          },
          {
            key: "duration",
            label: "时长",
            type: "number",
            min: 4,
            max: 15,
            step: 1,
            default: 4,
            unit: "s"
          }
        ]
      },
      {
        key: "video-edit",
        label: "视频编辑",
        inputHint: "对已有视频进行风格转换、重绘或编辑...",
        paramsSchema: [
          {
            key: "resolution",
            label: "分辨率",
            type: "enum",
            options: ["480p", "720p（标清）", "1080p（高清）"],
            default: "480p"
          },
          {
            key: "aspect_ratio",
            label: "宽高比",
            type: "enum",
            options: ["横屏（16:9）", "竖屏（9:16）", "方形（1:1）"],
            default: "横屏（16:9）"
          },
          {
            key: "duration",
            label: "时长",
            type: "number",
            min: 4,
            max: 15,
            step: 1,
            default: 4,
            unit: "s"
          }
        ]
      }
    ]
  },

  estimateCost(modeKey, params) {
    var res = params.resolution || "480p";
    var dur = Number(params.duration) || 4;
    if (dur < 4) dur = 4;
    if (dur > 15) dur = 15;
    if (res === "1080p（高清）") return dur * 20;
    if (res === "720p（标清）") return dur * 9;
    return dur * 5;
  },

  async createTask(config, params) {
    const res = await seedanceAdapter.submit(params, params);
    return res.taskId;
  },

  async queryTask(config, taskId, params = {}) {
    const res = await seedanceAdapter.poll(taskId);
    return {
      status: res.status,
      progress: res.progress,
      video_url: res.resultUri,
      error: res.error
    };
  }
};
