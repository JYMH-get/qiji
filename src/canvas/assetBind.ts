/**
 * assetBind —— 画布节点产物「绑定到资产」的落地操作（第113轮）。
 *
 *  - 图片节点主图 → 绑到现有资产（addAssetImage：追加历史+设为主图）或新建资产后绑定；
 *    绑定后资产在资产助手「项目资产」出现（有图才显示），可被「匹配资产」按名调用。
 *  - 音频节点产物 → 绑到现有资产的音色（voiceUri/voiceAssetId/voiceName，与资产模式
 *    绑定音色同格式）；匹配资产命中该资产时，音频自动作为「声音参考」进素材区并进图例
 *    「@ImageN的声音参考@AudioM」（assetMatch 既有链路，零改动）。
 *
 * uri 语义：写入资产记录的是 libraryStore 资产的显示 uri（本地副本优先）；请求时经
 * assetBlobs 三元映射解析公网 url（与资产模式出图/绑音色同一套约定）。
 */
import { useCanvasStore } from "@/store/canvasStore";
import { useLibraryStore } from "@/store/libraryStore";
import { useProjectStore, type AssetCat } from "@/store/projectStore";

export const BIND_CATS: { cat: AssetCat; label: string }[] = [
	{ cat: "characters", label: "角色" },
	{ cat: "crowds", label: "群像" },
	{ cat: "scenes", label: "场景" },
	{ cat: "organisms", label: "生物" },
	{ cat: "items", label: "物品" },
];

export type BindResult = { ok: true; assetName: string } | { ok: false; error: string };

/** 绑定源（源无关核心用）：画布节点结果 / 共享资产 / 任意有显示 uri 的素材 */
export interface BindSource {
	uri: string;
	name?: string;
	/** 音色绑定用：服务端台账 id（写 voiceAssetId） */
	serverAssetId?: string;
	/** 新建资产时带入的出图提示词（画布节点=节点提示词；其他源可空） */
	prompt?: string;
}

/** 节点结果在素材库的记录（图/音频通用；无结果 → null） */
export function nodeResultLibAsset(nodeId: string) {
	const node = useCanvasStore.getState().nodes[nodeId];
	const aid = node?.data.resultAssetId;
	return aid ? useLibraryStore.getState().assets[aid] ?? null : null;
}

// ── 源无关核心（第120轮抽出：画布节点与共享资产卡共用同一实现）──

/** 把图片绑到现有资产：追加历史 + 设为主图 */
export function bindImageToAsset(src: BindSource, cat: AssetCat, assetId: string): BindResult {
	if (!src.uri) return { ok: false, error: "没有可绑定的图片" };
	const s = useProjectStore.getState();
	const target = (s[cat] as Array<{ id: string; name: string }>).find((a) => a.id === assetId);
	if (!target) return { ok: false, error: "目标资产不存在（可能已被删除）" };
	s.addAssetImage(cat, assetId, null, src.uri, true);
	return { ok: true, assetName: target.name };
}

/** 新建资产并绑上图片（记录形态与资产工作台「+ 新建」一致；prompt 便于后续在资产页重生成） */
export function bindImageToNewAsset(src: BindSource, cat: AssetCat, name: string): BindResult {
	const nm = name.trim();
	if (!nm) return { ok: false, error: "请输入资产名称" };
	if (!src.uri) return { ok: false, error: "没有可绑定的图片" };
	const s = useProjectStore.getState();
	const dup = (s[cat] as Array<{ name: string }>).some((a) => a.name.trim() === nm);
	if (dup) return { ok: false, error: `该分类下已有同名资产「${nm}」，请换个名字或直接选择它绑定` };
	const id = `${cat}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
	const textField = cat === "characters" || cat === "crowds" ? "features" : "description";
	const asset: Record<string, unknown> = { id, name: nm, philosophy: "", prompt: src.prompt ?? "", image: undefined, images: [], variants: [] };
	asset[textField] = "";
	s.addAsset(cat, asset);
	s.addAssetImage(cat, id, null, src.uri, true);
	return { ok: true, assetName: nm };
}

/** 把音频绑为资产音色（与资产模式绑定音色同字段格式；已有音色则替换） */
export function bindAudioToAsset(src: BindSource, cat: AssetCat, assetId: string): BindResult {
	if (!src.uri) return { ok: false, error: "没有可绑定的音频" };
	const s = useProjectStore.getState();
	const target = (s[cat] as Array<{ id: string; name: string }>).find((a) => a.id === assetId);
	if (!target) return { ok: false, error: "目标资产不存在（可能已被删除）" };
	s.updateAsset(cat, assetId, {
		voiceUri: src.uri,
		voiceAssetId: src.serverAssetId,
		voiceName: `${target.name}的声音`,
	});
	return { ok: true, assetName: target.name };
}

// ── 画布节点包装（语义不变：源=节点结果资产）──

/** 把图片节点主图绑到现有资产：追加历史 + 设为主图 */
export function bindNodeImageToAsset(nodeId: string, cat: AssetCat, assetId: string): BindResult {
	const lib = nodeResultLibAsset(nodeId);
	if (!lib?.uri) return { ok: false, error: "节点没有可绑定的图片结果" };
	return bindImageToAsset({ uri: lib.uri, name: lib.name }, cat, assetId);
}

/** 新建资产并把图片节点主图绑上（prompt 带入节点出图提示词） */
export function bindNodeImageToNewAsset(nodeId: string, cat: AssetCat, name: string): BindResult {
	const lib = nodeResultLibAsset(nodeId);
	if (!lib?.uri) return { ok: false, error: "节点没有可绑定的图片结果" };
	const node = useCanvasStore.getState().nodes[nodeId];
	const prompt = typeof node?.data.params.prompt === "string" ? node.data.params.prompt : "";
	return bindImageToNewAsset({ uri: lib.uri, name: lib.name, prompt }, cat, name);
}

/** 把音频节点产物绑为资产音色 */
export function bindNodeAudioToAsset(nodeId: string, cat: AssetCat, assetId: string): BindResult {
	const lib = nodeResultLibAsset(nodeId);
	if (!lib?.uri) return { ok: false, error: "节点没有可绑定的音频结果" };
	return bindAudioToAsset({ uri: lib.uri, name: lib.name, serverAssetId: lib.serverAssetId || lib.id }, cat, assetId);
}
