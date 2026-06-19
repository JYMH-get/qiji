import { useState, useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import {
  Play,
  Trash2,
  Copy,
  Plus,
  Undo2,
  Redo2,
  Combine,
  Ungroup,
  Upload,
  Image as ImageIcon,
  Clapperboard,
  AudioLines,
  ScrollText,
  Sparkles,
  Scissors,
  Download,
  UploadCloud,
} from "lucide-react";
import { useUiStore } from "@/store/uiStore";
import { useCanvasStore } from "@/store/canvasStore";
import { useReactFlow } from "@xyflow/react";
import { dispatchCommand } from "@/command/dispatch";
import { listPlugins } from "@/nodes/pluginRegistry";
import { makeNode } from "./nodeFactory";
import type { NodeType } from "@/types";
import { storeDroppedFile } from "@/services/fileStorage";
import { useLibraryStore } from "@/store/libraryStore";
import { useAssistantStore } from "@/store/assistantStore";
import { exportPlugin, importPlugin } from "@/nodes/pluginShare";
import { copyToClipboard } from "@/lib/clipboard";

export function ContextMenu() {
  const menu = useUiStore((s) => s.contextMenu);
  const close = useUiStore((s) => s.closeContextMenu);
  const selectedNodeIds = useUiStore((s) => s.selectedNodeIds);
  const setImageEditNodeId = useUiStore((s) => s.setImageEditNodeId);

  const canUndo = useCanvasStore((s) => s.past.length > 0);
  const canRedo = useCanvasStore((s) => s.future.length > 0);
  const nodesMap = useCanvasStore((s) => s.nodes);

  const [activeSubmenu, setActiveSubmenu] = useState<
    "create" | "upload" | "plugins" | null
  >(null);
  const submenuTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { screenToFlowPosition } = useReactFlow();

  useEffect(() => {
    return () => {
      if (submenuTimerRef.current) clearTimeout(submenuTimerRef.current);
    };
  }, []);

  // Rules of hooks require early returns to be placed after all React hooks have run
  if (!menu) return null;

  const nodeId = menu.nodeId;
  const node = nodeId ? nodesMap[nodeId] : null;
  const isGroupNode = node?.type === "group";
  const isImageNode = node?.type === "image" || node?.type === "file_image";

  const pos: CSSProperties = { left: menu.x, top: menu.y };

  const onRun = () => {
    if (nodeId) {
      dispatchCommand({ type: "run", nodeId });
      close();
    }
  };

  const onDelete = () => {
    if (nodeId) {
      dispatchCommand({ type: "deleteNode", id: nodeId });
      close();
    }
  };

  const onDeleteEdge = () => {
    if (menu.edgeId) {
      dispatchCommand({ type: "disconnect", edgeId: menu.edgeId });
      close();
    }
  };

  const onGroup = () => {
    dispatchCommand({ type: "group", nodeIds: selectedNodeIds });
    close();
  };

  const onUngroup = () => {
    if (nodeId) {
      dispatchCommand({ type: "ungroup", groupId: nodeId });
      close();
    }
  };

  const onDeleteSelected = () => {
    selectedNodeIds.forEach((id) => {
      dispatchCommand({ type: "deleteNode", id });
    });
    close();
  };

  const onCreateNode = (type: NodeType) => {
    const flowPos = screenToFlowPosition({ x: menu.x, y: menu.y });
    const newNode = makeNode(type, flowPos.x, flowPos.y);
    dispatchCommand({ type: "addNode", node: newNode });
    close();
  };

  const onUndo = () => {
    dispatchCommand({ type: "undo" });
    close();
  };

  const onRedo = () => {
    dispatchCommand({ type: "redo" });
    close();
  };

  const onCopyNode = () => {
    if (!nodeId || !node) return;
    copyToClipboard([node], []);
    close();
  };

  const onEditImage = () => {
    if (!nodeId) return;
    setImageEditNodeId(nodeId);
    close();
  };

  const onSendToAssistant = () => {
    if (!nodeId) return;
    const node = nodesMap[nodeId];
    const typeLabel = node?.type ?? "unknown";
    useAssistantStore.getState().addMessage({
      id: `user-${Date.now()}`,
      role: "user",
      content: `[引用节点 ${typeLabel}: ${nodeId.slice(0, 8)}]`,
      refNodeIds: [nodeId],
      timestamp: Date.now(),
    });
    useAssistantStore.getState().setOpen(true);
    close();
  };

  const onExportPlugin = async (type?: string) => {
    await exportPlugin(type);
    close();
  };

  const onImportPlugin = async () => {
    const result = await importPlugin();
    if (result.success) {
      console.log(`插件 ${result.type} 导入成功`);
    } else {
      console.error(`插件导入失败: ${result.error}`);
    }
    close();
  };

  const handleMouseEnter = (submenu: "create" | "upload" | "plugins") => {
    if (submenuTimerRef.current) clearTimeout(submenuTimerRef.current);
    setActiveSubmenu(submenu);
  };

  const handleMouseLeave = () => {
    submenuTimerRef.current = setTimeout(() => {
      setActiveSubmenu(null);
    }, 300);
  };

  const handleUpload = (kind: "image" | "video" | "audio" | "script") => {
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
        const stored = await storeDroppedFile(file);
        if (!stored) return;
        const assetId = stored.fileId;

        useLibraryStore.getState().addAsset({
          id: assetId,
          kind,
          name: stored.fileName,
          uri: stored.fileUri,
          thumbnailUri: null,
          createdAt: new Date().toISOString(),
          deletedByUser: false,
          localPath: stored.localPath,
        });

        // 在右键点击位置自动创建对应多媒体节点
        const nodeType = `file_${kind === "script" ? "document" : kind}`;
        const flowPos = screenToFlowPosition({ x: menu.x, y: menu.y });
        const newNode = makeNode(nodeType, flowPos.x, flowPos.y);
        newNode.data.resultAssetId = assetId;

        dispatchCommand({ type: "addNode", node: newNode });
      }
    };
    input.click();
    close();
  };

  return (
    <>
      <div
        className="fixed inset-0 z-[10400]"
        onClick={close}
        onContextMenu={(e) => {
          e.preventDefault();
          close();
        }}
      />
      <div
        className="Qiji-panel fixed z-[10401] w-36 rounded-xl p-1 text-xs text-foreground shadow-2xl"
        style={pos}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 1. 多选模式下的操作 */}
        {selectedNodeIds.length > 1 ? (
          <>
            <button
              onClick={onGroup}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
            >
              <Combine className="h-3.5 w-3.5 text-primary" />
              合并打组
            </button>
            <button
              onClick={onDeleteSelected}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-destructive hover:bg-secondary cursor-pointer transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />
              删除选中节点
            </button>
          </>
        ) : menu.edgeId ? (
          <>
            <button
              onClick={onDeleteEdge}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-destructive hover:bg-secondary cursor-pointer transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />
              删除连线
            </button>
          </>
        ) : nodeId ? (
          /* 2. 单选节点时的操作 */
          <>
            {isGroupNode ? (
              <button
                onClick={onUngroup}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
              >
                <Ungroup className="h-3.5 w-3.5 text-primary" />
                解散分组
              </button>
            ) : (
              <>
                <button
                  onClick={onRun}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
                >
                  <Play className="h-3.5 w-3.5" />
                  运行节点
                </button>
                {node?.parentId && (
                  <>
                    <button
                      onClick={() => {
                        dispatchCommand({
                          type: "ungroup",
                          groupId: node.parentId!,
                          nodeId: node.id,
                        });
                        close();
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
                    >
                      <Ungroup className="h-3.5 w-3.5 text-primary" />
                      移出当前分组
                    </button>
                    <button
                      onClick={() => {
                        dispatchCommand({
                          type: "ungroup",
                          groupId: node.parentId!,
                        });
                        close();
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
                    >
                      <Ungroup className="h-3.5 w-3.5 text-primary" />
                      解散所属分组
                    </button>
                  </>
                )}
              </>
            )}
            <button
              onClick={onCopyNode}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
            >
              <Copy className="h-3.5 w-3.5" />
              复制节点
            </button>
            {isImageNode && (
              <button
                onClick={onEditImage}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
              >
                <Scissors className="h-3.5 w-3.5 text-blue-400" />
                编辑图像
              </button>
            )}
            <button
              onClick={onSendToAssistant}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
            >
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              发送到助手
            </button>
            <button
              onClick={onDelete}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-destructive hover:bg-secondary cursor-pointer transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {isGroupNode ? "删除分组" : "删除节点"}
            </button>
          </>
        ) : (
          /* 3. 画布空白处的右键菜单 */
          <>
            <div
              className="relative flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
              onMouseEnter={() => handleMouseEnter("create")}
              onMouseLeave={handleMouseLeave}
            >
              <Plus className="h-3.5 w-3.5 text-primary" />
              <span>新建节点</span>
              <span className="ml-auto text-[9px] opacity-65">▶</span>

              {activeSubmenu === "create" && (
                <div
                  className="Qiji-panel absolute left-full top-0 ml-1 w-28 rounded-xl p-1 text-xs text-foreground shadow-2xl animate-in fade-in slide-in-from-left-1 duration-150"
                  onMouseEnter={() => handleMouseEnter("create")}
                  onMouseLeave={handleMouseLeave}
                >
                  {listPlugins()
                    .filter((p) => !p.type.startsWith("file_") && p.isActive !== false && p.isDeleted !== true)
                    .map((plugin) => {
                      const Icon = plugin.icon;
                      return (
                        <button
                          key={plugin.type}
                          onClick={() => onCreateNode(plugin.type)}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
                        >
                          <Icon className="h-3.5 w-3.5" />
                          {plugin.label}
                        </button>
                      );
                    })}
                </div>
              )}
            </div>

            <div
              className="relative flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
              onMouseEnter={() => handleMouseEnter("upload")}
              onMouseLeave={handleMouseLeave}
            >
              <Upload className="h-3.5 w-3.5 text-primary" />
              <span>本地上传素材</span>
              <span className="ml-auto text-[9px] opacity-65">▶</span>

              {activeSubmenu === "upload" && (
                <div
                  className="Qiji-panel absolute left-full top-0 ml-1 w-28 rounded-xl p-1 text-xs text-foreground shadow-2xl animate-in fade-in slide-in-from-left-1 duration-150"
                  onMouseEnter={() => handleMouseEnter("upload")}
                  onMouseLeave={handleMouseLeave}
                >
                  <button
                    onClick={() => handleUpload("image")}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
                  >
                    <ImageIcon className="h-3.5 w-3.5 text-blue-400" />
                    上传图片
                  </button>
                  <button
                    onClick={() => handleUpload("video")}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
                  >
                    <Clapperboard className="h-3.5 w-3.5 text-orange-400" />
                    上传视频
                  </button>
                  <button
                    onClick={() => handleUpload("audio")}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
                  >
                    <AudioLines className="h-3.5 w-3.5 text-purple-400" />
                    上传音频
                  </button>
                  <button
                    onClick={() => handleUpload("script")}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
                  >
                    <ScrollText className="h-3.5 w-3.5 text-red-400" />
                    上传文档
                  </button>
                </div>
              )}
            </div>

            <div
              className="relative flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
              onMouseEnter={() => handleMouseEnter("plugins")}
              onMouseLeave={handleMouseLeave}
            >
              <Sparkles className="h-3.5 w-3.5 text-cyan-400" />
              <span>插件管理</span>
              <span className="ml-auto text-[9px] opacity-65">▶</span>

              {activeSubmenu === "plugins" && (
                <div
                  className="Qiji-panel absolute left-full top-0 ml-1 w-32 rounded-xl p-1 text-xs text-foreground shadow-2xl animate-in fade-in slide-in-from-left-1 duration-150"
                  onMouseEnter={() => handleMouseEnter("plugins")}
                  onMouseLeave={handleMouseLeave}
                >
                  <button
                    onClick={onImportPlugin}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
                  >
                    <UploadCloud className="h-3.5 w-3.5 text-green-400" />
                    导入插件
                  </button>
                  <button
                    onClick={() => onExportPlugin()}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
                  >
                    <Download className="h-3.5 w-3.5 text-yellow-400" />
                    导出所有自定义插件
                  </button>
                </div>
              )}
            </div>

            <button
              onClick={onUndo}
              disabled={!canUndo}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left cursor-pointer transition-colors ${
                canUndo
                  ? "hover:bg-secondary text-foreground"
                  : "text-muted-foreground opacity-50 cursor-not-allowed"
              }`}
            >
              <Undo2 className="h-3.5 w-3.5" />
              撤销
              <span className="ml-auto text-[9px] font-mono opacity-50">
                Ctrl+Z
              </span>
            </button>
            <button
              onClick={onRedo}
              disabled={!canRedo}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left cursor-pointer transition-colors ${
                canRedo
                  ? "hover:bg-secondary text-foreground"
                  : "text-muted-foreground opacity-50 cursor-not-allowed"
              }`}
            >
              <Redo2 className="h-3.5 w-3.5" />
              重做
              <span className="ml-auto text-[9px] font-mono opacity-50">
                Ctrl+Y
              </span>
            </button>
          </>
        )}
      </div>
    </>
  );
}