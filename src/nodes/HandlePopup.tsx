import { useState, useRef, useEffect } from "react";
import { useLibraryStore } from "@/store/libraryStore";
import { useCanvasStore } from "@/store/canvasStore";
import { dispatchCommand } from "@/command/dispatch";
import { makeNode } from "@/canvas/nodeFactory";
import { genId } from "@/lib/id";
import { getPlugin } from "./pluginRegistry";
import { storeDroppedFile } from "@/services/fileStorage";
import { Search, Upload, Folder, Type, Image as ImageIcon, Clapperboard, AudioLines } from "lucide-react";
import type { NodeType } from "@/types";

interface HandleMenuState {
  handleId: string;
  type: "source" | "target";
  formats: string[];
  topPercent: number;
}

const FORMAT_COMPATIBILITY = {
  input: {
    text: [
      { type: "node" as const, nodeType: "text", label: "文本生成", icon: Type },
      { type: "upload" as const, kind: "script" as const, label: "上传文档素材", icon: Upload },
      { type: "asset" as const, kind: "script" as const, label: "从素材库选用", icon: Folder }
    ],
    shot: [
      { type: "node" as const, nodeType: "script", label: "脚本生成", icon: ScrollText }
    ],
    frame: [
      { type: "node" as const, nodeType: "image", label: "图像生成", icon: ImageIcon },
      { type: "upload" as const, kind: "image" as const, label: "上传图片素材", icon: Upload },
      { type: "asset" as const, kind: "image" as const, label: "从素材库选用", icon: Folder }
    ],
    image: [
      { type: "node" as const, nodeType: "image", label: "图像生成", icon: ImageIcon },
      { type: "upload" as const, kind: "image" as const, label: "上传图片素材", icon: Upload },
      { type: "asset" as const, kind: "image" as const, label: "从素材库选用", icon: Folder }
    ],
    clip: [
      { type: "node" as const, nodeType: "video", label: "视频生成", icon: Clapperboard },
      { type: "upload" as const, kind: "video" as const, label: "上传视频素材", icon: Upload },
      { type: "asset" as const, kind: "video" as const, label: "从素材库选用", icon: Folder }
    ],
    video: [
      { type: "node" as const, nodeType: "video", label: "视频生成", icon: Clapperboard },
      { type: "upload" as const, kind: "video" as const, label: "上传视频素材", icon: Upload },
      { type: "asset" as const, kind: "video" as const, label: "从素材库选用", icon: Folder }
    ],
    audio: [
      { type: "node" as const, nodeType: "audio", label: "音频生成", icon: AudioLines },
      { type: "upload" as const, kind: "audio" as const, label: "上传音频素材", icon: Upload },
      { type: "asset" as const, kind: "audio" as const, label: "从素材库选用", icon: Folder }
    ]
  },
  output: {
    text: [
      { type: "node" as const, nodeType: "script", label: "脚本生成", icon: ScrollText }
    ],
    shot: [
      { type: "node" as const, nodeType: "image", label: "图像生成", icon: ImageIcon }
    ],
    frame: [
      { type: "node" as const, nodeType: "video", label: "视频生成", icon: Clapperboard }
    ],
    image: [
      { type: "node" as const, nodeType: "video", label: "视频生成", icon: Clapperboard }
    ],
    clip: [
      { type: "node" as const, nodeType: "audio", label: "音频生成", icon: AudioLines }
    ],
    video: [
      { type: "node" as const, nodeType: "audio", label: "音频生成", icon: AudioLines }
    ],
    audio: []
  }
};

// ScrollText helper since it might not be in the direct import list in FORMAT_COMPATIBILITY
import { ScrollText } from "lucide-react";

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

  // Close when clicking outside
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [onClose]);

  // Find current node positioning
  const currentNode = useCanvasStore((s) => s.nodes[nodeId]);
  if (!currentNode) return null;

  // Resolve compatible options
  const rawOptions: any[] = [];
  const direction = state.type === "target" ? "input" : "output";
  
  for (const fmt of state.formats) {
    const list = FORMAT_COMPATIBILITY[direction][fmt as keyof typeof FORMAT_COMPATIBILITY[typeof direction]];
    if (list) {
      for (const item of list) {
        if (!rawOptions.find(o => o.label === item.label)) {
          rawOptions.push(item);
        }
      }
    }
  }

  // Filter options by search input
  const options = rawOptions.filter(opt => 
    opt.label.toLowerCase().includes(search.toLowerCase())
  );

  // Spawns a generator node
  const handleSelectNode = (targetNodeType: string) => {
    const isInputPort = state.type === "target";
    const nodeW = 240;
    
    // Position offset
    const newX = isInputPort
      ? currentNode.x - nodeW - 100
      : currentNode.x + (currentNode.w || nodeW) + 100;
    const newY = currentNode.y;

    const newNode = makeNode(targetNodeType as NodeType, newX, newY);
    if (currentNode.parentId) {
      newNode.parentId = currentNode.parentId;
    }
    dispatchCommand({ type: "addNode", node: newNode });

    // Connect them
    if (isInputPort) {
      // New node (source) -> Current node (target)
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
      // Current node (source) -> New node (target)
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

  // Triggers file picker upload
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

        // Spawn file node
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

        // Connect
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

  // Selects an existing asset from the library
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
  const mediaActions = options.filter(o => o.type !== "node");

  return (
    <>
      {/* Backdrop overlay for focus containment */}
      <div className="fixed inset-0 z-40 bg-transparent" onClick={onClose} />
      
      <div
        ref={menuRef}
        style={popupStyle}
        className="Qiji-panel absolute z-50 flex flex-col gap-1 rounded-xl p-1.5 shadow-2xl w-48 text-[11px] border border-white/10 nodrag"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search Input */}
        <div className="flex items-center gap-1.5 px-2 py-1 bg-secondary/40 border border-border/40 rounded-lg mb-1">
          <Search className="h-3 w-3 text-muted-foreground shrink-0" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索节点..."
            className="w-full bg-transparent focus:outline-none text-[10px] text-foreground"
            autoFocus
          />
        </div>

        {/* Categories */}
        <div className="flex flex-col gap-0.5 overflow-y-auto max-h-60 Qiji-scroll-thin pr-0.5">
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
                    onClick={() => handleSelectNode(opt.nodeType)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-foreground hover:bg-secondary transition-colors cursor-pointer"
                  >
                    <Icon className="h-3.5 w-3.5 text-primary shrink-0" />
                    <span>{opt.label}</span>
                  </button>
                );
              })}
            </>
          )}

          {mediaActions.length > 0 && (
            <>
              <div className="px-2 py-0.5 text-muted-foreground font-semibold text-[8px] uppercase select-none mt-1">
                媒体素材
              </div>
              {mediaActions.map((opt) => {
                const Icon = opt.icon;
                const isAsset = opt.type === "asset";
                
                if (isAsset) {
                  const items = getAssetsOfKind(opt.kind);
                  const isHovered = showAssetSubmenu === opt.kind;
                  return (
                    <div
                      key={opt.label}
                      className="relative"
                      onMouseEnter={() => setShowAssetSubmenu(opt.kind)}
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
                                onClick={() => handleSelectAsset(asset.id, opt.kind)}
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
                }

                return (
                  <button
                    key={opt.label}
                    onClick={() => handleUploadFile(opt.kind)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-foreground hover:bg-secondary transition-colors cursor-pointer"
                  >
                    <Icon className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                    <span>{opt.label}</span>
                  </button>
                );
              })}
            </>
          )}

          {options.length === 0 && (
            <div className="px-2 py-3 text-muted-foreground text-center italic">
              无匹配节点
            </div>
          )}
        </div>
      </div>
    </>
  );
}
