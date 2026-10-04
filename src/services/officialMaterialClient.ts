import type { AssetRef, CatalogModel, GenerateRequest, MaterialPrepareResponse } from "@/contract";
import { managedClient } from "@/services/managedClient";
import { useConnectionStore } from "@/store/connectionStore";
import { createMaterialPreparationController } from "./materialPreparation";
import { supportsOfficialMaterials } from "./materialPolicy";

function requirePreparedAssetId(result: MaterialPrepareResponse): MaterialPrepareResponse {
	if (result.status === 'Active' && !result.assetId?.trim()) throw new Error('官方素材已就绪但未返回素材库 ID，请重试素材准备');
	return result;
}

export const officialMaterialController = createMaterialPreparationController(async (model, asset, retry, control) => {
 control?.phase('checking');
	if (!asset.id || asset.id.startsWith("LC-")) {
		control?.phase('uploading');
		const { ensurePublicUrl, isPublicUrl } = await import("@/lib/publicUrl");
		const { useProjectStore } = await import("@/store/projectStore");
		const source = asset.url ?? "";
		const uploadSource = () => ensurePublicUrl(source, { name: asset.name });
		const url = await (control ? control.upload(uploadSource, 'source') : uploadSource());
		if (!url) throw new Error("素材暂无可用地址，无法上传官方素材库");
		// 公网 URL 可能被多个不同资产复用，不能据此猜测资产身份；仅本地上传回填 ID。
		const blob = isPublicUrl(source) ? undefined : useProjectStore.getState().blobByUri(source);
		asset = { ...asset, id: blob?.id && !blob.id.startsWith("LC-") ? blob.id : undefined, url };
	}
	control?.phase('checking');
 const body = { model, asset: { ...asset, usage: 'identity' as const } };
 const inspected = await managedClient.prepareMaterial({ ...body, action: 'inspect' });
 if (!inspected.uploadRequired && !(retry && inspected.status === 'Failed')) return requirePreparedAssetId(inspected);
 const upload = async () => {
  const result = await managedClient.prepareMaterial({ ...body, action: 'upload', retry: true });
  if (result.status === 'Failed') throw new Error(result.error || '官方素材上传失败');
  return requirePreparedAssetId(result);
 };
 return control ? control.upload(upload) : upload();
}, { recheckOnSubscribe: true, maxAgeMs: Infinity });

/** Keys are in-memory only; include session and the library scope without persisting upstream IDs. */
export function officialMaterialKey(session: string, model: CatalogModel | undefined, asset: AssetRef | undefined): string {
	return JSON.stringify([session, model?.id, model?.materialPolicy?.scopeKey, asset?.id || asset?.url, asset?.officialAssetType ?? 'Image']);
}

type MaterialEntry = { asset: AssetRef; label: string; retryOnSubmit?: boolean };
async function prepareGroup(model: CatalogModel, session: string, images: MaterialEntry[], assetType: NonNullable<AssetRef['officialAssetType']>): Promise<string[]> {
	// Separate types in both deduplication and cache keys, including URL-only media.
	images = images.map(item => ({ ...item, asset: assetType === 'Image' && !item.asset.officialAssetType ? item.asset : { ...item.asset, officialAssetType: assetType } }));
	const assetsById = new Map<string, AssetRef>();
	const idsByUrl = new Map<string, Set<string>>();
	for (const { asset } of images) {
		if (!asset.id) continue;
		if (!assetsById.has(asset.id)) assetsById.set(asset.id, asset);
		const url = asset.url?.trim();
		if (url) {
			const ids = idsByUrl.get(url) ?? new Set<string>();
			ids.add(asset.id);
			idsByUrl.set(url, ids);
		}
	}
	const positionsBySource = new Map<string, number>();
	const unique: typeof images = [];
	const positions = images.map(item => {
		const { asset } = item;
		const url = asset.url?.trim();
		const relatedIds = url ? idsByUrl.get(url) : undefined;
		const id = asset.id || (relatedIds?.size === 1 ? relatedIds.values().next().value : undefined);
		// ID 是身份；不同 ID 不能按 URL 合并。URL-only 只复用无歧义的对应 ID。
		const source = id ? `id:${id}` : url ? `url:${url}` : `empty:${unique.length}`;
		const existing = positionsBySource.get(source);
		const index = existing ?? unique.length;
		if (existing === undefined) {
			unique.push(id ? { ...item, asset: assetsById.get(id)! } : item);
			positionsBySource.set(source, index);
		}
		return index;
	});
	const preparedIds = await Promise.all(unique.map(async ({ asset, label, retryOnSubmit }) => {
		const key = officialMaterialKey(session, model, asset);
		// 附加首帧没有独立素材卡可点红标；下一次提交即是用户重试。
		if (retryOnSubmit && officialMaterialController.peek(key)?.status === 'Failed') officialMaterialController.retry(key);
		const state = await officialMaterialController.check(key, model.id, asset, model.materialPolicy?.scopeKey);
		if (state.status !== "Active") throw new Error(`${label}${state.status === "Processing" ? "正在预处理，尚不可使用" : `处理失败：${state.error || (retryOnSubmit ? "请重新提交以重试" : "请在素材图标处重试")}`}`);
		if (!state.assetId?.trim()) throw new Error(`${label}缺少官方素材库 ID，请重新准备素材`);
		return state.assetId.trim();
	}));
	return positions.map(index => preparedIds[index]);
}

/** Attach certified IDs to a request copy; project assets and their original URLs stay untouched. */
export async function checkOfficialRequestMaterials(model: CatalogModel, req: GenerateRequest): Promise<GenerateRequest> {
	if (!supportsOfficialMaterials(model)) return req;
	const connection = useConnectionStore.getState();
	const session = `${connection.serverUrl}\n${connection.accessKey}`;
	const images: MaterialEntry[] = (req.inputs?.images ?? []).map((asset, index) => ({ asset, label: `第${index + 1}张图片素材` }));
	const firstFrameUrl = typeof req.params?.firstFrameUrl === 'string' ? req.params.firstFrameUrl.trim() : '';
	if (/^https?:\/\//i.test(firstFrameUrl)) images.push({ asset: { url: firstFrameUrl }, label: '首帧/故事板图片素材', retryOnSubmit: true });
	const [imageIds, videoIds, audioIds] = await Promise.all([
		prepareGroup(model, session, images, 'Image'),
		prepareGroup(model, session, (req.inputs?.videos ?? []).map((asset, index) => ({ asset, label: `第${index + 1}个视频素材` })), 'Video'),
		prepareGroup(model, session, (req.inputs?.audios ?? []).map((asset, index) => ({ asset, label: `第${index + 1}段音频素材` })), 'Audio'),
	]);
	const attach = (refs: AssetRef[], ids: string[]) => refs.map((asset, index) => ({ ...asset, officialAssetId: ids[index] }));
	const imageCount = req.inputs?.images?.length ?? 0;
	return {
		...req,
		...(req.inputs ? { inputs: { ...req.inputs,
			...(req.inputs.images ? { images: attach(req.inputs.images, imageIds) } : {}),
			...(req.inputs.videos ? { videos: attach(req.inputs.videos, videoIds) } : {}),
			...(req.inputs.audios ? { audios: attach(req.inputs.audios, audioIds) } : {}),
		} } : {}),
		...(images.length > imageCount ? { params: { ...req.params, firstFrameAssetId: imageIds[imageCount] } } : {}),
	};
}
