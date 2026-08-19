import { useState, type CSSProperties } from "react";
import {
  Play,
  Trash2,
  Combine,
  Ungroup,
  Wand2,
  CopyPlus,
  Download,
  Camera,
  Film,
  Sparkles,
  Eraser,
  Layers,
  LayoutGrid,
  ScanSearch,
  Scissors,
  Globe,
  Merge,
  Link2,
  Orbit,
  PenLine,
  ShieldCheck,
  Palette,
  Bone,
} from "lucide-react";
import { annotateNode } from "@/canvas/annotate";
import { depthifyNode } from "@/canvas/depthify";
import { depthifyVideoNode } from "@/canvas/videoDepthify";
import { viewAngleNode } from "@/canvas/viewAngleOp";
import { panoramaNode, viewPanoramaNode } from "@/canvas/panoramaOp";
import { directorStageBlank, directorStageNode } from "@/canvas/directorOp";
import { listPresetSchemes } from "@/lib/presetSchemes";
import { imageNodeCount, addPresetToNodes, checkNodesAssets } from "@/canvas/multiSelectOps";
import { nodeSharedItems } from "@/services/sharedPublish";
import { openSharedPick } from "@/store/sharedPickStore";
import { useUiStore } from "@/store/uiStore";
import { useCanvasStore } from "@/store/canvasStore";
import { useLibraryStore } from "@/store/libraryStore";
import { useReactFlow } from "@xyflow/react";
import { dispatchCommand } from "@/command/dispatch";
import { listPlugins, getPlugin } from "@/nodes/pluginRegistry";
import { makeNode } from "./nodeFactory";
import { copyToClipboard, splitEdgesForCopy } from "@/lib/clipboard";
import { copyNodesImageToSystemClipboard } from "@/canvas/copyImage";
import type { NodeType } from "@/types";

/**
 * 画布右键菜单（第87轮精简）：
 *  - 空白处 = **新建节点平铺列表**（与左侧调色板同源 listPlugins），不再套「新建节点▸」二级菜单；
 *    「本地上传素材/插件管理/撤销/重做」已删——上传走「上传本地」节点或拖入文件，撤销重做走快捷键。
 *  - 节点/连线/多选 菜单保持原功能（运行/复制/编辑图像/分组/删除）。
 */
export function ContextMenu() {
  const menu = useUiStore((s) => s.contextMenu);
  const close = useUiStore((s) => s.closeContextMenu);
  const selectedNodeIds = useUiStore((s) => s.selectedNodeIds);
  const selectedEdgeIds = useUiStore((s) => s.selectedEdgeIds);
  const stackDrawerNodeId = useUiStore((s) => s.stackDrawerNodeId);

  const nodesMap = useCanvasStore((s) => s.nodes);

  const { screenToFlowPosition } = useReactFlow();

  // 多选「一键增加预设」子菜单开合
  const [presetSub, setPresetSub] = useState(false);

  if (!menu) return null;

  const nodeId = menu.nodeId;
  const node = nodeId ? nodesMap[nodeId] : null;
  const isGroupNode = node?.type === "group";
  // 匹配资产：图片/视频生成节点可用（规则与资产模式一致：扫 上游原文+节点提示词，归一化精确/80% 相似度命中）
  const nodeDisplay = node ? getPlugin(node.type)?.displayKind : undefined;
  const canMatchAssets = nodeDisplay === "image" || nodeDisplay === "video";
  // 保存到本地：节点有产物即可导出（媒体资产 / 上传文件 / 文本结果）
  const exportAsset = node?.data.resultAssetId ? useLibraryStore.getState().assets[node.data.resultAssetId] : null;
  const exportUri = exportAsset?.uri || node?.data.fileUri || "";
  const exportText = typeof node?.data.resultText === "string" ? node.data.resultText.trim() : "";
  const canSaveLocal = !isGroupNode && !!(exportUri || exportText);
  // 原文拆分：文本类节点（原文节点/文本节点/智能推理）有原文（结果文本或提示词）即可以行为单位拆成多个新原文节点
  const nodePrompt = typeof node?.data.params.prompt === "string" ? node.data.params.prompt.trim() : "";
  const canSplitScript = nodeDisplay === "text" && !!(exportText || nodePrompt);
  // 媒体处理入口：有图片结果 → 图像超分；有视频结果 → 首帧/尾帧/分段/超分/去字幕
  const hasImageResult = exportAsset?.kind === "image";
  const hasVideoResult = exportAsset?.kind === "video";
  // 绑定到资产：图片结果 → 写回资产主图（可新建）；音频结果 → 绑为资产音色（随匹配资产调用）
  const hasAudioResult = exportAsset?.kind === "audio" || (!exportAsset && (node?.data.fileMime || "").startsWith("audio/") && !!node?.data.resultAssetId);
  // 抽屉式堆叠：图片/视频节点**有结果**即可打开抽屉（快捷键 C）——老节点可能只有主图没 history，
  // 抽屉条目按 历史∪主图 计；堆叠外观（卡片纸边+角标）仍要求 ≥2 条。
  const stackHist = node?.data.resultHistory ?? [];
  const stackCount =
    node?.data.resultAssetId && !stackHist.includes(node.data.resultAssetId)
      ? stackHist.length + 1
      : stackHist.length;
  const canOpenStack = canMatchAssets && stackCount > 0;
  const stackOpenHere = !!nodeId && stackDrawerNodeId === nodeId;

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

  // 全能复制：节点 + 内部连线 + **上游连线**一起进剪贴板——粘贴（Ctrl+V）时自动把原上游接回克隆体。
  // Ctrl+C 仍是精准复制（只带选中集内部连线，不带上游）。
  const onSuperCopy = () => {
    const ids = selectedNodeIds.length > 1 ? selectedNodeIds : nodeId ? [nodeId] : [];
    if (!ids.length) return;
    const s = useCanvasStore.getState();
    const set = new Set(ids);
    const nodes = ids.map((id) => s.nodes[id]).filter((n) => n && n.type !== "group");
    const { internal, upstream } = splitEdgesForCopy(set, s.edges);
    copyToClipboard(nodes, internal, upstream);
    copyNodesImageToSystemClipboard(nodes); // 顺带：首个图片结果进系统剪贴板（可粘贴到简一助手）
    close();
  };

  const onMatchAssets = async () => {
    if (!nodeId) return;
    const { applyAssetMatchToImageNode } = await import("@/lib/assetMatch");
    const n = applyAssetMatchToImageNode(nodeId);
    close();
    if (n === 0) alert("未匹配到新资产：上游原文/提示词中没有出现项目资产名（或匹配到的都已在素材区）。");
  };

  // 多选匹配素材：对全部选中的 图片/视频 生成节点执行资产匹配（与 SelectionToolbar「匹配素材」同语义）
  const matchableSelected = selectedNodeIds.filter((id) => {
    const n = nodesMap[id];
    const dk = n ? getPlugin(n.type)?.displayKind : undefined;
    return dk === "image" || dk === "video";
  });
  const onMatchSelected = async () => {
    const { applyAssetMatchToImageNode } = await import("@/lib/assetMatch");
    let added = 0;
    for (const id of matchableSelected) added += applyAssetMatchToImageNode(id);
    close();
    if (added === 0) alert("未匹配到新资产：上游原文/提示词中没有出现项目资产名（或匹配到的都已在素材区）。");
  };

  // 多选：一键增加预设（对选中的图片节点批量插入预设胶囊）+ 一键检查素材（汇总选中节点结果+素材探活自愈）
  const selImageCount = imageNodeCount(selectedNodeIds);
  const presetSchemes = selImageCount > 0 ? listPresetSchemes() : [];
  const onAddPresetSelected = (presetId: string) => {
    const n = addPresetToNodes(selectedNodeIds, presetId);
    close();
    if (n === 0) alert("未增加预设：选中的图片节点提示词已含该预设（或无图片节点）。");
  };
  const onCheckSelected = () => {
    checkNodesAssets(selectedNodeIds);
    close();
  };

  // 添加到共享资产：把节点结果资产（主图/主视频）的 OSS 记录登记进共享文件夹（弹窗选 库→文件夹）
  const onShareToShared = (ids: string[]) => {
    const { items, skipped } = nodeSharedItems(ids);
    close();
    openSharedPick(items, skipped);
  };
  // 多选中有结果资产的节点数（决定入口显示与计数）
  const shareableSelected = selectedNodeIds.filter((id) => !!nodesMap[id]?.data.resultAssetId).length;

  // 二次解析：对节点已存的结果文本重新解析，只补建缺漏的子节点（不重跑模型、不动已有节点）。
  // 智能推理/智能拆分/资产拆分节点有结果时可用——流式竞态漏裂变的行（如尾卡只出了文本节点）由此救回。
  const respawnSpawn = node ? getPlugin(node.type)?.spawn : undefined;
  const canRespawn =
    !!respawnSpawn &&
    (respawnSpawn.source === "cards" || respawnSpawn.source === "assets") &&
    typeof node?.data.resultText === "string" &&
    !!node.data.resultText.trim();
  const onRespawn = async () => {
    if (!nodeId || !respawnSpawn) return;
    close();
    await import("@/lib/splitPresetAttach"); // 第174轮：装饰器自注册（补建资产节点同尺挂预设胶囊）
    const { buildRespawn } = await import("@/lib/canvasSpawn");
    const s = useCanvasStore.getState();
    const n = s.nodes[nodeId];
    if (!n) return;
    const built = buildRespawn(n, respawnSpawn, String(n.data.resultText || ""), s.nodes, s.edges);
    if (built.parsed === 0) {
      alert("二次解析失败：未能从节点结果中解析出任何内容（可在节点内查看原始输出）。");
      return;
    }
    if (!built.nodes.length) {
      alert(`二次解析完成：解析出 ${built.parsed} 项，画布上均已存在，无缺漏。`);
      return;
    }
    dispatchCommand({ type: "spawnNodes", parentId: nodeId, nodes: built.nodes, edges: built.edges });
    alert(`二次解析完成：解析出 ${built.parsed} 项，补建 ${built.nodes.length} 个节点（新增 ${built.added} 行/项、补齐 ${built.patched} 行）。`);
  };

  // 合并为分镜组：≥2 个有图片结果的选中节点
  const mergeableCount = selectedNodeIds.filter((id) => {
    const n = nodesMap[id];
    return n && getPlugin(n.type)?.displayKind === "image" && !!n.data.resultAssetId;
  }).length;

  // 重组文本（拆分的逆）：≥2 个有原文的文本节点（智能推理/文本）——按阅读序合并成一个新原文节点
  const mergeableText = selectedNodeIds.filter((id) => {
    const n = nodesMap[id];
    if (!n || getPlugin(n.type)?.displayKind !== "text") return false;
    const rt = typeof n.data.resultText === "string" ? n.data.resultText.trim() : "";
    const pr = typeof n.data.params.prompt === "string" ? n.data.params.prompt.trim() : "";
    return !!(rt || pr);
  });
  const onMergeText = async () => {
    const { applyMergeTextNodes } = await import("@/canvas/scriptSplitOp");
    const n = applyMergeTextNodes(mergeableText);
    close();
    if (!n) alert("重组失败：需选中至少 2 个含原文的文本节点。");
  };
  const onMergeShotGroup = async () => {
    const { createShotGroupFromNodes } = await import("@/canvas/shotGroupOps");
    const err = createShotGroupFromNodes(selectedNodeIds);
    close();
    if (err) alert(err);
  };

  // 媒体处理：弹窗类走全局 NodeProcessModals；首帧/尾帧直接执行（截取落库+新节点）
  const openProc = (kind: "upscale" | "desub" | "imageUpscale" | "clip" | "gridSplit" | "scriptSplit" | "bindAsset" | "bindVoice") => {
    if (!nodeId) return;
    useUiStore.getState().setNodeProcModal({ nodeId, kind });
    close();
  };
  const onCaptureFrame = (mode: "first" | "last") => {
    if (!nodeId) return;
    close();
    void import("@/canvas/nodeProcess").then(({ captureVideoNodeTo }) =>
      captureVideoNodeTo(nodeId, mode).catch((err) => {
        const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "未知错误";
        alert(`截取失败：${msg}`);
      }),
    );
  };

  // 检查素材：探本节点结果+素材的 OSS 直链是否可达，死链且本机有本地副本则自动重传修复
  const canCheckAssets = !isGroupNode && !!nodeId && (!!node?.data.resultAssetId || canMatchAssets);
  const onCheckAssets = async () => {
    if (!nodeId) return;
    close();
    const { runAssetCheck, nodeCheckTargets } = await import("@/services/assetCheck");
    await runAssetCheck(nodeCheckTargets(nodeId), "检查素材");
  };

  // 保存到本地：媒体产物走 saveUriToLocal（本地原件优先 copyFile）；纯文本结果落 .txt
  const onSaveLocal = async () => {
    if (!node) return;
    close();
    try {
      if (exportUri) {
        const media =
          exportAsset?.kind === "video" || nodeDisplay === "video" ? "video"
          : exportAsset?.kind === "audio" || nodeDisplay === "audio" ? "audio"
          : (node.data.fileMime || "").startsWith("video/") ? "video"
          : (node.data.fileMime || "").startsWith("audio/") ? "audio"
          : "image";
        const { saveUriToLocal } = await import("@/lib/saveMedia");
        const base = (exportAsset?.name || node.data.fileName || `${node.type}_导出`).replace(/\.[^.]+$/, "");
        await saveUriToLocal(exportUri, base, media);
      } else if (exportText) {
        const { saveTextToLocal } = await import("@/lib/saveMedia");
        await saveTextToLocal(exportText, `${getPlugin(node.type)?.label || "节点"}_结果`);
      }
    } catch (err) {
      alert(`保存失败：${err instanceof Error ? err.message : "未知错误"}`);
    }
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
              onClick={onSuperCopy}
              title="复制选中节点+内部连线+上游连线；粘贴（Ctrl+V）时自动接回原上游。Ctrl+C 为精准复制（不带上游）"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
            >
              <CopyPlus className="h-3.5 w-3.5 text-emerald-400" />
              全能复制
            </button>
            {matchableSelected.length > 0 && (
              <button
                onClick={() => void onMatchSelected()}
                title={`为选中的 ${matchableSelected.length} 个图片/视频生成节点匹配资产（扫上游原文+提示词，与资产模式同规则）`}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
              >
                <Sparkles className="h-3.5 w-3.5 text-amber-400" />
                匹配素材（{matchableSelected.length}）
              </button>
            )}
            {presetSchemes.length > 0 && (
              <div
                className="relative"
                onMouseEnter={() => setPresetSub(true)}
                onMouseLeave={() => setPresetSub(false)}
              >
                <button
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
                  title={`把预设胶囊插入选中的 ${selImageCount} 个图片节点提示词`}
                >
                  <Palette className="h-3.5 w-3.5 text-fuchsia-300" />
                  <span className="flex-1 text-left">一键增加预设（{selImageCount}）</span>
                  <span className="text-muted-foreground">▸</span>
                </button>
                {presetSub && (
                  <div className="Qiji-panel absolute left-full top-0 ml-1 max-h-72 w-40 overflow-y-auto rounded-xl p-1 shadow-2xl z-[10402]">
                    {presetSchemes.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => onAddPresetSelected(p.id)}
                        className="flex w-full items-center rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors text-left"
                      >
                        {p.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <button
              onClick={onCheckSelected}
              title="检查选中节点的结果+素材云端（OSS）直链是否正常，死链且本机有本地副本则自动修复"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
            >
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-300" />
              一键检查素材（{selectedNodeIds.length}）
            </button>
            {shareableSelected > 0 && (
              <button
                onClick={() => onShareToShared(selectedNodeIds)}
                title={`把选中 ${shareableSelected} 个节点的结果资产登记到共享文件夹（只存 OSS 记录，不复制文件）`}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
              >
                <CopyPlus className="h-3.5 w-3.5 text-violet-300" />
                添加到共享资产（{shareableSelected}）
              </button>
            )}
            <button
              onClick={onGroup}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
            >
              <Combine className="h-3.5 w-3.5 text-primary" />
              合并打组
            </button>
            {mergeableCount >= 2 && (
              <button
                onClick={() => void onMergeShotGroup()}
                title={`把 ${mergeableCount} 个图片节点的主图合并为一个分镜组节点（宫格布局，源节点删除，可撤销）`}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
              >
                <LayoutGrid className="h-3.5 w-3.5 text-sky-400" />
                合并为分镜组
              </button>
            )}
            {mergeableText.length >= 2 && (
              <button
                onClick={() => void onMergeText()}
                title={`把 ${mergeableText.length} 个文本节点的原文按阅读序（上→下）合并成一个新原文节点，源节点删除（拆分的逆操作，可撤销）`}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
              >
                <Merge className="h-3.5 w-3.5 text-rose-300" />
                重组文本（{mergeableText.length}）
              </button>
            )}
            <button
              onClick={onDeleteSelected}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-destructive hover:bg-secondary cursor-pointer transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />
              删除选中节点
            </button>
          </>
        ) : menu.edgeId ? (
          /* 连线菜单：仅在框选多条连线时出现（单条右击已直删）——一键全部删除 */
          <>
            <button
              onClick={() => {
                const ids = selectedEdgeIds.length > 1 ? selectedEdgeIds : [menu.edgeId!];
                ids.forEach((id) => dispatchCommand({ type: "disconnect", edgeId: id }));
                close();
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-destructive hover:bg-secondary cursor-pointer transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {selectedEdgeIds.length > 1 ? `全部删除（${selectedEdgeIds.length} 条连线）` : "删除连线"}
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
            {!isGroupNode && (
              <button
                onClick={onSuperCopy}
                title="复制该节点并记录上游连线；粘贴（Ctrl+V）时自动接回原上游。Ctrl+C 为精准复制（不带上游）"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
              >
                <CopyPlus className="h-3.5 w-3.5 text-emerald-400" />
                全能复制
              </button>
            )}
            {canOpenStack && (
              <button
                onClick={() => {
                  useUiStore.getState().setStackDrawerNodeId(stackOpenHere ? null : nodeId);
                  close();
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
                title={`抽屉式展开堆叠的 ${stackCount} 条历史结果：右击条目设为主图，拖出抽屉停 1 秒复制为新节点（快捷键 C）`}
              >
                <Layers className="h-3.5 w-3.5 text-violet-300" />
                {stackOpenHere ? "收起堆叠" : "打开堆叠"}
              </button>
            )}
            {canMatchAssets && (
              <button
                onClick={() => void onMatchAssets()}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
                title="扫上游原文+本节点提示词，命中项目资产（80% 相似度）→ 资产图追加进素材区"
              >
                <Wand2 className="h-3.5 w-3.5 text-amber-300" />
                匹配资产
              </button>
            )}
            {canRespawn && (
              <button
                onClick={() => void onRespawn()}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
                title="对本节点已有的解析结果重新解析，只补建缺漏的下游节点（不重跑模型、不重复已有节点）"
              >
                <ScanSearch className="h-3.5 w-3.5 text-teal-300" />
                二次解析（补齐缺漏）
              </button>
            )}
            {canSplitScript && (
              <button
                onClick={() => openProc("scriptSplit")}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
                title="以行为单位把本节点原文拆成多段，每段牵出一个新「原文节点」接在本节点之后（可各自推理）"
              >
                <Scissors className="h-3.5 w-3.5 text-rose-300" />
                拆分…
              </button>
            )}
            {hasImageResult && (
              <button
                onClick={() => openProc("bindAsset")}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
                title="把本节点图片绑定到项目资产（选现有或新建命名）：设为主图+进历史，资产助手/匹配资产即可调用"
              >
                <Link2 className="h-3.5 w-3.5 text-emerald-300" />
                绑定到资产…
              </button>
            )}
            {hasAudioResult && (
              <button
                onClick={() => openProc("bindVoice")}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
                title="把本节点音频绑定为某个资产的音色（与资产模式绑音色同格式）：匹配资产命中该资产时，音频作为声音参考一起加入"
              >
                <Link2 className="h-3.5 w-3.5 text-emerald-300" />
                绑定到资产…
              </button>
            )}
            {hasImageResult && (
              <button
                onClick={() => { annotateNode(nodeId!); close(); }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
                title="涂鸦：笔/箭头/图形/文字画在图上，完成后合成图落为新图片节点（涂鸦产物节点可继续编辑）"
              >
                <PenLine className="h-3.5 w-3.5 text-violet-300" />
                涂鸦…
              </button>
            )}
            {hasImageResult && (
              <button
                onClick={() => {
                  // 转深度节点自身：重新转深度（本地重跑）；其他图片节点：新建转深度节点
                  if (node?.type === "image.depth") dispatchCommand({ type: "run", nodeId: nodeId! });
                  else depthifyNode(nodeId!);
                  close();
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
                title={node?.type === "image.depth"
                  ? "重新转深度：对原图重新本地推理（优先上游连线图片；不调模型零计费）"
                  : "转深度：本地推理生成黑白深度图（近白远黑），在右侧新建转深度节点承载（模型已内置，无需联网）"}
              >
                <Layers className="h-3.5 w-3.5 text-cyan-300" />
                {node?.type === "image.depth" ? "重新转深度" : "转深度"}
              </button>
            )}
            {hasImageResult && (
              <button
                onClick={() => { viewAngleNode(nodeId!); close(); }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
                title="转视角：多角度编辑器选机位（环绕/俯仰/景别/预设），图像编辑模型按新视角重拍，在右侧新建图片节点承载"
              >
                <Orbit className="h-3.5 w-3.5 text-sky-300" />
                转视角…
              </button>
            )}
            {hasImageResult && (
              <button
                onClick={() => { panoramaNode(nodeId!); close(); }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
                title="转全景：以本图为正前方生成 equirect 2:1 的 720°全景图（右侧新建图片节点承载）"
              >
                <Globe className="h-3.5 w-3.5 text-emerald-300" />
                转全景
              </button>
            )}
            {hasImageResult && (
              <button
                onClick={() => { viewPanoramaNode(nodeId!); close(); }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
                title="720°全景查看：拖动转视角、滚轮缩放；可截取当前视角/四/六/八/十二视图落回画布（适用 2:1 全景图）"
              >
                <Globe className="h-3.5 w-3.5 text-teal-300" />
                全景查看
              </button>
            )}
            {hasImageResult && (
              <button
                onClick={() => { directorStageNode(nodeId!); close(); }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
                title="3D导演台：以本图为底图放置 3D 模型（可动人偶/道具/GLB），产出 合成图/姿势图/深度图；产物节点可再编辑"
              >
                <Bone className="h-3.5 w-3.5 text-cyan-300" />
                3D导演台…
              </button>
            )}
            {hasImageResult && (
              <button
                onClick={() => openProc("imageUpscale")}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
                title="图像超分（画质增强，火山引擎）：选目标后在右侧生成新图片节点承载结果"
              >
                <Sparkles className="h-3.5 w-3.5 text-cyan-300" />
                图像超分…
              </button>
            )}
            {hasImageResult && (
              <button
                onClick={() => openProc("gridSplit")}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
                title="按行列均分图片，点选要切出的宫格（≥1）→ 右侧生成分镜组节点承载切图"
              >
                <LayoutGrid className="h-3.5 w-3.5 text-sky-400" />
                宫格切分…
              </button>
            )}
            {hasVideoResult && (
              <>
                <div className="h-px bg-white/8 my-1" />
                <button
                  onClick={() => onCaptureFrame("first")}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
                  title="截取首帧为新图片节点"
                >
                  <Camera className="h-3.5 w-3.5 text-muted-foreground" />
                  首帧
                </button>
                <button
                  onClick={() => onCaptureFrame("last")}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
                  title="截取尾帧为新图片节点"
                >
                  <Camera className="h-3.5 w-3.5 text-muted-foreground" />
                  尾帧
                </button>
                <button
                  onClick={() => openProc("clip")}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
                  title="弹窗选择起止时间，ffmpeg 裁剪为新片段（只读结果节点承载）"
                >
                  <Film className="h-3.5 w-3.5 text-muted-foreground" />
                  分段…
                </button>
                <button
                  onClick={() => openProc("upscale")}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
                  title="超分（画质增强，火山引擎）：选版本后在右侧生成新视频节点承载结果"
                >
                  <Sparkles className="h-3.5 w-3.5 text-cyan-300" />
                  超分…
                </button>
                <button
                  onClick={() => openProc("desub")}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
                  title="去字幕（火山引擎）：在右侧生成新视频节点承载结果"
                >
                  <Eraser className="h-3.5 w-3.5 text-orange-300" />
                  去字幕…
                </button>
                <button
                  onClick={() => {
                    // 视频转深度节点自身：重新转深度（本地重跑）；其他视频节点：新建转深度节点
                    if (node?.type === "video.depth") dispatchCommand({ type: "run", nodeId: nodeId! });
                    else depthifyVideoNode(nodeId!);
                    close();
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
                  title={node?.type === "video.depth"
                    ? "重新转深度：对原视频按原帧率重新逐帧本地推理（优先上游连线视频；不调模型零计费）"
                    : "转深度：按原帧率逐帧本地推理生成灰度深度视频（近白远黑），在右侧新建转深度节点承载（模型已内置，无需联网；耗时随视频时长）"}
                >
                  <Layers className="h-3.5 w-3.5 text-cyan-300" />
                  {node?.type === "video.depth" ? "重新转深度" : "转深度"}
                </button>
                <div className="h-px bg-white/8 my-1" />
              </>
            )}
            {canCheckAssets && (
              <button
                onClick={() => void onCheckAssets()}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
                title="检查本节点结果+素材的云端（OSS）直链是否正常，死链且本机有本地副本则自动重传修复"
              >
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-300" />
                检查素材
              </button>
            )}
            {!!node?.data.resultAssetId && (
              <button
                onClick={() => onShareToShared([nodeId!])}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
                title="把本节点结果资产登记到共享文件夹（只存 OSS 记录，不复制文件）"
              >
                <CopyPlus className="h-3.5 w-3.5 text-violet-300" />
                添加到共享资产
              </button>
            )}
            {canSaveLocal && (
              <button
                onClick={() => void onSaveLocal()}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
                title="导出节点产物：图片/视频/音频存原件（本地原件优先），文本结果存 .txt"
              >
                <Download className="h-3.5 w-3.5 text-sky-400" />
                保存到本地
              </button>
            )}
            <button
              onClick={onDelete}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-destructive hover:bg-secondary cursor-pointer transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {isGroupNode ? "删除分组" : "删除节点"}
            </button>
          </>
        ) : (
          /* 3. 画布空白处：新建节点平铺列表（与左侧调色板同源） */
          <>
            {listPlugins()
              .filter((p) => p.inPalette !== false && p.isActive !== false && p.isDeleted !== true)
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
            <div className="my-1 border-t border-border/60" />
            <button
              onClick={() => { directorStageBlank(); close(); }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors"
              title="3D导演台：空舞台布置 3D 模型（可动人偶/道具/GLB），产出 合成图/姿势图/深度图 落画布"
            >
              <Bone className="h-3.5 w-3.5 text-cyan-300" />
              3D导演台…
            </button>
          </>
        )}
      </div>
    </>
  );
}
