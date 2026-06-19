export default {
  id: "file_video",
  name: "视频素材",
  version: "1.0.0",
  type: "file_video",
  iconName: "Clapperboard",
  accentVar: "var(--node-video)",
  resultKind: "video",
  defaultModel: "",
  description: "导入视频文件作为素材",
  category: "file",
  thumbnail: null,
  inputs: [],
  outputs: [{ name: "clip", formats: ["clip", "video"] }],
  canStack: false
};
