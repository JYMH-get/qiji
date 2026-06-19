import { useState, useRef, useEffect } from "react";
import type { LucideIcon } from "lucide-react";
import { Search, Upload, Folder, Type, ScrollText, Image as ImageIcon, Clapperboard, AudioLines } from "lucide-react";
import { useLibraryStore } from "@/store/libraryStore";
import { useCanvasStore } from "@/store/canvasStore";
import { dispatchCommand } from "@/command/dispatch";
import { makeNode } from "@/canvas/nodeFactory";
import { genId } from "@/lib/id";
import { getPlugin } from "./pluginRegistry";
import { storeDroppedFile } from "@/services/fileStorage";
import { fuzzyFilterMulti } from "@/lib/fuzzyMatch";
import type { NodeType } from "@/types";

interface HandleMenuState {
  handleId: string;
  type: "source" | "target";
  formats: string[];
  topPercent: number;
}

interface HandleOption {
  type: "node" | "upload" | "asset";
  nodeType?: string;
  kind?: "image" | "video" | "audio" | "script";
  label: string;
  icon: LucideIcon;
  description?: string;
}

type Direction = "input" | "output";

const FORMAT_COMPATIBILITY: Record<Direction, Record<string, HandleOption[]>> = {
  input: {
    text: [
      { type: "node", nodeType: "text", label: "文本生成", icon: Type, description: "AI 文本生成与编辑" },
      { type: "upload", kind: "script", label: "上传文档素材", icon: Upload },
      { type: "asset", kind: "script", label: "从素材库选用", icon: Folder }
    ],
    shot: [
      { type: "node", nodeType: "script", label: "脚本生成", icon: ScrollText, description: "剧本拆分为分镜" }
    ],
    frame: [
      { type: "node", nodeType: "image", label: "图像生成", icon: ImageIcon, description: "AI 图片生成" },
      { type: "upload", kind: "image", label: "上传图片素材", icon: Upload },
      { type: "asset", kind: "image", label: "从素材库选用", icon: Folder }
    ],
    image: [
      { type: "node", nodeType: "image", label: "图像生成", icon: ImageIcon, description: "AI 图片生成" },
      { type: "upload", kind: "image", label: "上传图片素材", icon: Upload },
      { type: "asset", kind: "image", label: "从素材库选用", icon: Folder }
    ],
    clip: [
      { type: "node", nodeType: "video", label: "视频生成", icon: Clapperboard, description: "AI 视频生成" },
      { type: "upload", kind: "video", label: "上传视频素材", icon: Upload },
      { type: "asset", kind: "video", label: "从素材库选用", icon: Folder }
    ],
    video: [
      { type: "node", nodeType: "video", label: "视频生成", icon: Clapperboard, description: "AI 视频生成" },
      { type: "upload", kind: "video", label: "上传视频素材", icon: Upload },
      { type: "asset", kind: "video", label: "从素材库选用", icon: Folder }
    ],
    audio: [
      { type: "node", nodeType: "audio", label: "音频生成", icon: AudioLines, description: "AI 音频生成" },
      { type: "upload", kind: "audio", label: "上传音频素材", icon: Upload },
      { type: "asset", kind: "audio", label: "从素材库选用", icon: Folder }
    ]
  },
  output: {
    text: [
      { type: "node", nodeType: "script", label: "脚本生成", icon: ScrollText, description: "剧本拆分为分镜" }
    ],
    shot: [
      { type: "node", nodeType: "image", label: "图像生成", icon: ImageIcon, description: "AI 图片生成" }
    ],
    frame: [
      { type: "node", nodeType: "video", label: "视频生成", icon: Clapperboard, description: "AI 视频生成" }
    ],
    image: [
      { type: "node", nodeType: "video", label: "视频生成", icon: Clapperboard, description: "AI 视频生成" }
    ],
    clip: [
      { type: "node", nodeType: "audio", label: "音频生成", icon: AudioLines, description: "AI 音频生成" }
    ],
    video: [
      { type: "node", nodeType: "audio", label: "音频生成", icon: AudioLines, description: "AI 音频生成" }
    ],
    audio: []
  }
};

const KIND_LABEL: Record<string, string> = {
  image: "图片素材",
  video: "视频素材",
  audio: "音频素材",
  script: "文档素材",
};

const KIND_ICON: Record<string, LucideIcon> = {
  image: ImageIcon,
  video: Clapperboard,
  audio: AudioLines,
  script: Type,
};

export function HandlePopup({
  state,
  nodeId,
  onClose,
}: {
  state: HandleMenuState;
  nodeId: string;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [showAssetSubmenu, setShowAssetSubmenu] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const libraryAssets = useLibraryStore((s) => s.assets);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [onClose]);

  const currentNode = useCanvasStore((s) => s.nodes[nodeId]);
  if (!currentNode) return null;

  // Resolve compatible options (deduplicated)
  const rawOptions: HandleOption[] = [];
  const direction: Direction = state.type === "target" ? "input" : "output";

  for (const fmt of state.formats) {
    const list = FORMAT_COMPATIBILITY[direction][fmt];
    if (list) {
      for (const item of list) {
        if (!rawOptions.find(o => o.label === item.label)) {
          rawOptions.push(item);
        }
      }
    }
  }

  const isSearching = search.trim().length > 0;

  // Fuzzy filter options by label AND description
  const filtered = isSearching
    ? fuzzyFilterMulti(rawOptions, search, [(o) => o.label, (o) => o.description])
    : rawOptions.map((o) => ({ item: o, score: 0 }));

  const options = filtered.map((r) => r.item);

  // When searching, also fuzzy-match library assets by name for inline display
  const assetKinds = [...new Set(
    rawOptions.filter(o => o.type === "asset").map(o => o.kind!)
  )];

  const inlineAssets = isSearching
    ? assetKinds.flatMap(kind => {
        const all = getAssetsOfKind(kind);
        const matched = fuzzyFilterMulti(all, search, [(a) => a.name]);
        return matched.slice(0, 8).map(r => ({
          id: r.item.id,
          name: r.item.name,
          kind,
        }));
      })
    : [];

  const hasAnyResult = options.length > 0 || inlineAssets.length > 0;

  // Spawns a generator node
  const handleSelectNode = (targetNodeType: string) => {
    const isInputPort = state.type === "target";
    const nodeW = 240;

    const newX = isInputPort
      ? currentNode.x - nodeW - 100
      : currentNode.x + (currentNode.w || nodeW) + 100;
    const newY = currentNode.y;

    const newNode = makeNode(targetNodeType as NodeType, newX, newY);
    if (currentNode.parentId) {
      newNode.parentId = currentNode.parentId;
    }
    dispatchCommand({ type: "addNode", node: newNode });

    if (isInputPort) {
      const srcPlugin = getPlugin(targetNodeType);
      const sourcePort = srcPlugin?.outputs[0]?.name || "out";
      dispatchCommand({
        type: "connect",
        edge: {
          id: genId("edge"),
          kind: "dataflow",
          source: newNode.id,
          sourcePort,
          target: nodeId,
          targetPort: state.handleId,
        }
      });
    } else {
      const tgtPlugin = getPlugin(targetNodeType);
      const targetPort = tgtPlugin?.inputs[0]?.name || "in";
      dispatchCommand({
        type: "connect",
        edge: {
          id: genId("edge"),
          kind: "dataflow",
          source: nodeId,
          sourcePort: state.handleId,
          target: newNode.id,
          targetPort,
        }
      });
    }

    onClose();
  };

  const handleUploadFile = (kind: "image" | "video" | "audio" | "script") => {
    const input = document.createElement("input");
    input.type = "file";

    if (kind === "image") {
      input.accept = "image/*";
    } else if (kind === "video") {
      input.accept = "video/*";
    } else if (kind === "audio") {
      input.accept = "audio/*";
    } else if (kind === "script") {
      input.accept = ".txt,.doc,.docx,.pdf,.json";
    }

    input.onchange = async (e: Event) => {
      const target = e.target as HTMLInputElement;
      if (target.files && target.files[0]) {
        const file = target.files[0];
        const fileInfo = await storeDroppedFile(file);
        if (!fileInfo) return;

        const assetId = fileInfo.fileId;
        useLibraryStore.getState().addAsset({
          id: assetId,
          kind,
          name: fileInfo.fileName,
          uri: fileInfo.fileUri,
          thumbnailUri: null,
          createdAt: new Date().toISOString(),
          deletedByUser: false,
          localPath: fileInfo.localPath,
        });

        const nodeType = `file_${kind === "script" ? "document" : kind}`;
        const nodeW = 240;
        const newX = currentNode.x - nodeW - 100;
        const newY = currentNode.y;

        const newNode = makeNode(nodeType as NodeType, newX, newY);
        newNode.data.resultAssetId = assetId;
        if (currentNode.parentId) {
          newNode.parentId = currentNode.parentId;
        }

        dispatchCommand({ type: "addNode", node: newNode });

        const filePlugin = getPlugin(nodeType);
        const sourcePort = filePlugin?.outputs[0]?.name || "out";
        dispatchCommand({
          type: "connect",
          edge: {
            id: genId("edge"),
            kind: "dataflow",
            source: newNode.id,
            sourcePort,
            target: nodeId,
            targetPort: state.handleId,
          }
        });
      }
    };
    input.click();
    onClose();
  };

  const handleSelectAsset = (assetId: string, kind: "image" | "video" | "audio" | "script") => {
    const nodeType = `file_${kind === "script" ? "document" : kind}`;
    const nodeW = 240;
    const newX = currentNode.x - nodeW - 100;
    const newY = currentNode.y;

    const newNode = makeNode(nodeType as NodeType, newX, newY);
    newNode.data.resultAssetId = assetId;
    if (currentNode.parentId) {
      newNode.parentId = currentNode.parentId;
    }

    dispatchCommand({ type: "addNode", node: newNode });

    const filePlugin = getPlugin(nodeType);
    const sourcePort = filePlugin?.outputs[0]?.name || "out";
    dispatchCommand({
      type: "connect",
      edge: {
        id: genId("edge"),
        kind: "dataflow",
        source: newNode.id,
        sourcePort,
        target: nodeId,
        targetPort: state.handleId,
      }
    });

    onClose();
  };

  const getAssetsOfKind = (kind: "image" | "video" | "audio" | "script") => {
    return Object.values(libraryAssets).filter(
      (a) => a.kind === kind && !a.deletedByUser
    );
  };

  const popupStyle: React.CSSProperties = {
    position: "absolute",
    top: `${state.topPercent}%`,
    transform: "translateY(-50%)",
  };

  if (state.type === "target") {
    popupStyle.right = "calc(100% + 35px)";
  } else {
    popupStyle.left = "calc(100% + 35px)";
  }

  const generators = options.filter(o => o.type === "node");
  const uploadActions = options.filter(o => o.type === "upload");
  const assetActions = options.filter(o => o.type === "asset");

  // Group inline assets by kind for display
  const inlineByKind = assetKinds
    .map(kind => ({ kind, items: inlineAssets.filter(a => a.kind === kind) }))
    .filter(g => g.items.length > 0);

  return (
    <>
      <div className="fixed inset-0 z-40 bg-transparent" onClick={onClose} />

      <div
        ref={menuRef}
        style={popupStyle}
        className="Qiji-panel absolute z-50 flex flex-col gap-1 rounded-xl p-1.5 shadow-2xl w-52 text-[11px] border border-white/10 nodrag"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search Input */}
        <div className="flex items-center gap-1.5 px-2 py-1 bg-secondary/40 border border-border/40 rounded-lg mb-1">
          <Search className="h-3 w-3 text-muted-foreground shrink-0" />
          <input
            type="text"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setShowAssetSubmenu(null);
            }}
            placeholder="搜索节点/素材（支持拼音）..."
            className="w-full bg-transparent focus:outline-none text-[10px] text-foreground"
            autoFocus
          />
        </div>

        {/* Options List */}
        <div className="flex flex-col gap-0.5 overflow-y-auto max-h-60 Qiji-scroll-thin pr-0.5">
          {/* Generator nodes */}
          {generators.length > 0 && (
            <>
              <div className="px-2 py-0.5 text-muted-foreground font-semibold text-[8px] uppercase select-none">
                生成节点
              </div>
              {generators.map((opt) => {
                const Icon = opt.icon;
                return (
                  <button
                    key={opt.nodeType}
                    onClick={() => handleSelectNode(opt.nodeType!)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-foreground hover:bg-secondary transition-colors cursor-pointer"
                    title={opt.description}
                  >
                    <Icon className="h-3.5 w-3.5 text-primary shrink-0" />
                    <div className="flex flex-col min-w-0">
                      <span className="font-medium truncate">{opt.label}</span>
                      {opt.description && (
                        <span className="text-[9px] text-muted-foreground truncate">{opt.description}</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </>
          )}

          {/* Upload actions */}
          {uploadActions.length > 0 && (
            <>
              <div className="px-2 py-0.5 text-muted-foreground font-semibold text-[8px] uppercase select-none mt-1">
                {isSearching ? "上传操作" : "媒体素材"}
              </div>
              {uploadActions.map((opt) => {
                const Icon = opt.icon;
                return (
                  <button
                    key={opt.label}
                    onClick={() => handleUploadFile(opt.kind!)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-foreground hover:bg-secondary transition-colors cursor-pointer"
                  >
                    <Icon className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                    <span>{opt.label}</span>
                  </button>
                );
              })}
            </>
          )}

          {/* Asset picker — hover submenu when NOT searching */}
          {!isSearching && assetActions.length > 0 && (
            <>
              <div className="px-2 py-0.5 text-muted-foreground font-semibold text-[8px] uppercase select-none mt-1">
                媒体素材
              </div>
              {assetActions.map((opt) => {
                const Icon = opt.icon;
                const items = getAssetsOfKind(opt.kind!);
                const isHovered = showAssetSubmenu === opt.kind;
                return (
                  <div
                    key={opt.label}
                    className="relative"
                    onMouseEnter={() => setShowAssetSubmenu(opt.kind!)}
                    onMouseLeave={() => setShowAssetSubmenu(null)}
                  >
                    <button
                      className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-foreground hover:bg-secondary transition-colors cursor-pointer ${isHovered ? "bg-secondary" : ""}`}
                    >
                      <div className="flex items-center gap-2">
                        <Icon className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                        <span>{opt.label}</span>
                      </div>
                      <span className="text-[8px] opacity-60">▶</span>
                    </button>

                    {isHovered && (
                      <div
                        className="Qiji-panel absolute left-full top-0 ml-1.5 w-44 rounded-xl p-1 text-[10px] text-foreground shadow-2xl border border-white/10 flex flex-col gap-0.5 max-h-44 overflow-y-auto Qiji-scroll-thin"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="px-2 py-0.5 text-muted-foreground font-semibold text-[8px] uppercase border-b border-border/40 mb-1 select-none">
                          选择库内素材
                        </div>
                        {items.length === 0 ? (
                          <div className="px-2 py-1 text-muted-foreground text-center italic">
                            素材库为空
                          </div>
                        ) : (
                          items.map((asset) => (
                            <button
                              key={asset.id}
                              onClick={() => handleSelectAsset(asset.id, opt.kind!)}
                              className="w-full text-left truncate rounded px-2 py-1.5 hover:bg-secondary/80 text-foreground transition-colors cursor-pointer font-medium"
                              title={asset.name}
                            >
                              {asset.name}
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          )}

          {/* Inline asset search results — shown when searching */}
          {isSearching && inlineByKind.length > 0 && (
            <>
              {inlineByKind.map(({ kind, items }) => {
                const Icon = KIND_ICON[kind] || Folder;
                return (
                  <div key={kind} className="flex flex-col mt-0.5">
                    <div className="px-2 py-0.5 text-muted-foreground font-semibold text-[8px] uppercase select-none mt-1 flex items-center gap-1">
                      <Icon className="h-2.5 w-2.5" />
                      {KIND_LABEL[kind] || kind}
                      <span className="text-muted-foreground/60 ml-auto">{items.length}</span>
                    </div>
                    {items.map((asset) => (
                      <button
                        key={asset.id}
                        onClick={() => handleSelectAsset(asset.id, asset.kind)}
                        className="w-full text-left truncate rounded px-3 py-1 hover:bg-secondary/80 text-foreground transition-colors cursor-pointer font-medium"
                        title={asset.name}
                      >
                        <span className="text-emerald-500 mr-1.5">●</span>
                        {asset.name}
                      </button>
                    ))}
                  </div>
                );
              })}
            </>
          )}

          {!hasAnyResult && (
            <div className="px-2 py-3 text-muted-foreground text-center italic">
              无匹配结果
            </div>
          )}
        </div>
      </div>
    </>
  );
}