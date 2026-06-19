export default {
  id: "file_image",
  name: "图片素材",
  version: "1.0.0",
  type: "file_image",
  iconName: "ImageIcon",
  accentVar: "var(--node-image)",
  resultKind: "image",
  defaultModel: "",
  description: "导入图片文件作为素材",
  category: "file",
  thumbnail: null,
  inputs: [],
  outputs: [{ name: "frame", formats: ["frame", "image"] }],
  canStack: false
};
