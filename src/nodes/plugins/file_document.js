export default {
  id: "file_document",
  name: "文档素材",
  version: "1.0.0",
  type: "file_document",
  iconName: "ScrollText",
  accentVar: "var(--node-script)",
  resultKind: "script",
  defaultModel: "",
  description: "导入文本文档作为素材",
  category: "file",
  thumbnail: null,
  inputs: [],
  outputs: [{ name: "text", formats: ["text"] }],
  canStack: false
};
