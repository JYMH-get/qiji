import {
	Type,
	ScrollText,
	Image as ImageIcon,
	Clapperboard,
	AudioLines,
	FileUp,
	type LucideIcon,
} from "lucide-react";
import type { NodeType, ResultKind } from "@/types";

export type BusinessNodeType = Exclude<NodeType, "group">;

export interface NodeTypeDef {
	type: NodeType;
	label: string;
	code: string;
	icon: LucideIcon;
	accentVar: string;
	resultKind: ResultKind;
	defaultModel: string;
	inputPorts: string[];
	outputPorts: string[];
}

export const NODE_REGISTRY: Record<string, NodeTypeDef> = {
	text: {
		type: "text",
		label: "文本",
		code: "TEXT",
		icon: Type,
		accentVar: "var(--node-text)",
		resultKind: "text",
		defaultModel: "gvlm-text",
		inputPorts: [],
		outputPorts: ["text"],
	},
	script: {
		type: "script",
		label: "脚本",
		code: "SCRIPT",
		icon: ScrollText,
		accentVar: "var(--node-script)",
		resultKind: "script",
		defaultModel: "gvlm-script",
		inputPorts: ["text"],
		outputPorts: ["shot"],
	},
	image: {
		type: "image",
		label: "图片",
		code: "IMAGE",
		icon: ImageIcon,
		accentVar: "var(--node-image)",
		resultKind: "image",
		defaultModel: "lib-image",
		inputPorts: ["shot"],
		outputPorts: ["frame"],
	},
	video: {
		type: "video",
		label: "视频",
		code: "VIDEO",
		icon: Clapperboard,
		accentVar: "var(--node-video)",
		resultKind: "video",
		defaultModel: "seedance-2",
		inputPorts: ["frame"],
		outputPorts: ["clip"],
	},
	audio: {
		type: "audio",
		label: "音频",
		code: "AUDIO",
		icon: AudioLines,
		accentVar: "var(--node-audio)",
		resultKind: "audio",
		defaultModel: "lib-audio",
		inputPorts: ["clip"],
		outputPorts: ["audio"],
	},
	file: {
		type: "file",
		label: "文件",
		code: "FILE",
		icon: FileUp,
		accentVar: "var(--node-file)",
		resultKind: "file",
		defaultModel: "",
		inputPorts: [],
		outputPorts: ["file"],
	},
};

export const NODE_ORDER: BusinessNodeType[] = [
	"text",
	"script",
	"image",
	"video",
	"audio",
	"file",
];
