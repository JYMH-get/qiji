export default {
  id: "file_audio",
  name: "音频素材",
  version: "1.0.0",
  type: "file_audio",
  iconName: "AudioLines",
  accentVar: "var(--node-audio)",
  resultKind: "audio",
  defaultModel: "",
  description: "导入音频文件作为素材",
  category: "file",
  thumbnail: null,
  inputs: [],
  outputs: [{ name: "audio", formats: ["audio"] }],
  canStack: false
};
