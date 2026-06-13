import {
  Type,
  ScrollText,
  Image as ImageIcon,
  Clapperboard,
  AudioLines,
  type LucideIcon,
} from "lucide-react";
import { genId } from "@/lib/id";

export interface PortType {
  name: string;
  formats: string[]; // e.g. ["image", "video"]
}

export interface NodeAction {
  name: string;
  label: string;
  targetNodeType: string;
  handler: (
    nodeId: string,
    context: {
      store: any;
      dispatch: (command: any) => void;
    }
  ) => void;
}

export interface NodePlugin {
  type: string;
  label: string;
  code: string;
  icon: LucideIcon;
  accentVar: string;
  resultKind: string;
  defaultModel: string;
  inputs: PortType[];
  outputs: PortType[];
  canStack?: boolean;
  actions?: NodeAction[];
}

const plugins = new Map<string, NodePlugin>();

export function registerPlugin(plugin: NodePlugin) {
  plugins.set(plugin.type, plugin);
}

export function getPlugin(type: string): NodePlugin | undefined {
  return plugins.get(type);
}

export function listPlugins(): NodePlugin[] {
  return Array.from(plugins.values());
}

// ── 注册默认核心节点插件 ──

registerPlugin({
  type: "text",
  label: "文本",
  code: "TEXT",
  icon: Type,
  accentVar: "var(--node-text)",
  resultKind: "text",
  defaultModel: "gvlm-text",
  inputs: [],
  outputs: [{ name: "text", formats: ["text"] }],
});

registerPlugin({
  type: "script",
  label: "脚本",
  code: "SCRIPT",
  icon: ScrollText,
  accentVar: "var(--node-script)",
  resultKind: "script",
  defaultModel: "gvlm-script",
  inputs: [{ name: "text", formats: ["text"] }],
  outputs: [{ name: "shot", formats: ["shot", "text"] }],
});

registerPlugin({
  type: "image",
  label: "图片",
  code: "IMAGE",
  icon: ImageIcon,
  accentVar: "var(--node-image)",
  resultKind: "image",
  defaultModel: "lib-image",
  inputs: [{ name: "shot", formats: ["shot", "text"] }],
  outputs: [{ name: "frame", formats: ["frame", "image"] }],
  canStack: true,
});

registerPlugin({
  type: "video",
  label: "视频",
  code: "VIDEO",
  icon: Clapperboard,
  accentVar: "var(--node-video)",
  resultKind: "video",
  defaultModel: "seedance-2",
  inputs: [
    { name: "frame", formats: ["frame", "image"] },
    { name: "clip", formats: ["clip", "video"] },
    { name: "audio", formats: ["audio"] },
    { name: "text", formats: ["shot", "text"] },
  ],
  outputs: [{ name: "clip", formats: ["clip", "video"] }],
  canStack: true,
  actions: [
    {
      name: "hd_upscale",
      label: "超分高清",
      targetNodeType: "video",
      handler: (nodeId, { store, dispatch }) => {
        const parentNode = store.nodes[nodeId];
        if (!parentNode) return;

        const newX = parentNode.x + (parentNode.w || 240) + 100;
        const newY = parentNode.y;

        const newId = genId("video");
        const hdNode = {
          id: newId,
          type: "video",
          x: newX,
          y: newY,
          w: parentNode.w || 240,
          h: parentNode.h || 200,
          parentId: parentNode.parentId || null,
          parentScriptId: parentNode.parentScriptId || null,
          data: {
            input: {},
            params: {
              model: "seedance-2",
              mode: "hd",
              prompt: parentNode.data.params?.prompt || "",
            },
            resultAssetId: null,
            sourceVersion: 0,
          },
        };

        // 1. 自动生成高清视频节点
        dispatch({ type: "addNode", node: hdNode });

        // 2. 自动连接新节点输入与旧节点输出
        dispatch({
          type: "connect",
          edge: {
            id: genId("edge"),
            kind: "dataflow",
            source: nodeId,
            sourcePort: "clip",
            target: newId,
            targetPort: "frame",
          },
        });
      },
    },
  ],
});

registerPlugin({
  type: "audio",
  label: "音频",
  code: "AUDIO",
  icon: AudioLines,
  accentVar: "var(--node-audio)",
  resultKind: "audio",
  defaultModel: "lib-audio",
  inputs: [
    { name: "clip", formats: ["clip", "video"] },
    { name: "text", formats: ["shot", "text"] },
  ],
  outputs: [{ name: "audio", formats: ["audio"] }],
});

registerPlugin({
  type: "file_image",
  label: "图片素材",
  code: "FILE_IMAGE",
  icon: ImageIcon,
  accentVar: "var(--node-image)",
  resultKind: "image",
  defaultModel: "",
  inputs: [],
  outputs: [{ name: "frame", formats: ["frame", "image"] }],
});

registerPlugin({
  type: "file_video",
  label: "视频素材",
  code: "FILE_VIDEO",
  icon: Clapperboard,
  accentVar: "var(--node-video)",
  resultKind: "video",
  defaultModel: "",
  inputs: [],
  outputs: [{ name: "clip", formats: ["clip", "video"] }],
});

registerPlugin({
  type: "file_audio",
  label: "音频素材",
  code: "FILE_AUDIO",
  icon: AudioLines,
  accentVar: "var(--node-audio)",
  resultKind: "audio",
  defaultModel: "",
  inputs: [],
  outputs: [{ name: "audio", formats: ["audio"] }],
});

registerPlugin({
  type: "file_document",
  label: "文档素材",
  code: "FILE_DOCUMENT",
  icon: ScrollText,
  accentVar: "var(--node-script)",
  resultKind: "script",
  defaultModel: "",
  inputs: [],
  outputs: [{ name: "text", formats: ["text"] }],
});


