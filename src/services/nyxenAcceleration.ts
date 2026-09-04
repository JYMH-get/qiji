import type { Catalog, CatalogModel, GenerateRequest, AssetRef } from "@/contract";

export type NyxenMaterialKind = "image" | "video" | "audio";

type ProgressCallback = (
	progress: number,
	status: string,
	partialText?: string,
	extra?: { stageText?: string },
) => void;

export interface NyxenAccelerationDeps {
	resolveAssetUrl: (assetId: string) => Promise<string>;
	upload: (sourceUrl: string, kind: NyxenMaterialKind) => Promise<string>;
	onProgress?: ProgressCallback;
	/** 让“上传成功”状态至少经过一次可见渲染；测试可注入空实现。 */
	afterSuccess?: () => Promise<void>;
}

type MutableCandidate = {
	kind: NyxenMaterialKind;
	ref?: AssetRef;
	directUrl?: string;
	setAccelerationUrl: (url: string) => void;
};

/** 仅存在于稳定模式单次生成的内存请求；绝不进入项目文件或通用 AssetRef 契约。 */
export type NyxenAcceleratedAssetRef = AssetRef & { accelerationUrl?: string };
type NyxenAcceleratedParams = Record<string, unknown> & { firstFrameAccelerationUrl?: string };

const KIND_LABEL: Record<NyxenMaterialKind, string> = {
	image: "张图片",
	video: "个视频",
	audio: "段音频",
};

const isHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value);

/** 生产数据里稳定模式的 id 可调整；客户端以 catalog 下发的显示名为准。 */
export function shouldUseNyxenAcceleration(model: CatalogModel, catalog: Catalog | null): boolean {
	if (model.capability !== "video" || !model.modeId) return false;
	return catalog?.modes?.find((mode) => mode.id === model.modeId)?.name.trim() === "稳定";
}

async function sourceUrlOf(candidate: MutableCandidate, deps: NyxenAccelerationDeps): Promise<string> {
	const ref = candidate.ref;
	if (ref?.id) {
		try {
			const fresh = await deps.resolveAssetUrl(ref.id);
			if (isHttpUrl(fresh)) return fresh;
		} catch {
			// URL 只是缓存，但在服务端暂时无法重解析时，仍允许使用现有公网缓存。
		}
	}
	const cached = candidate.directUrl ?? ref?.url ?? "";
	if (isHttpUrl(cached)) return cached;
	throw new Error("素材没有可供加速桶读取的公网地址");
}

function clonedRequest(req: GenerateRequest): GenerateRequest {
	return {
		...req,
		params: req.params ? { ...req.params } : undefined,
		inputs: req.inputs
			? {
				...req.inputs,
				texts: req.inputs.texts?.map((ref) => ({ ...ref })),
				images: req.inputs.images?.map((ref) => ({ ...ref })),
				videos: req.inputs.videos?.map((ref) => ({ ...ref })),
				audios: req.inputs.audios?.map((ref) => ({ ...ref })),
			}
			: undefined,
	};
}

function candidatesOf(req: GenerateRequest): MutableCandidate[] {
	const out: MutableCandidate[] = [];
	const firstFrame = typeof req.params?.firstFrameUrl === "string" ? req.params.firstFrameUrl : "";
	if (isHttpUrl(firstFrame)) {
		out.push({
			kind: "image",
			directUrl: firstFrame,
			setAccelerationUrl: (url) => {
				if (req.params) (req.params as NyxenAcceleratedParams).firstFrameAccelerationUrl = url;
			},
		});
	}
	const addRefs = (kind: NyxenMaterialKind, refs: AssetRef[] | undefined) => {
		for (const ref of refs ?? []) {
			// fromTask 尚无真实字节地址，只能继续交由服务端依赖链处理。
			if (!ref.id && !ref.url) continue;
			out.push({
				kind,
				ref,
				setAccelerationUrl: (url) => {
					(ref as NyxenAcceleratedAssetRef).accelerationUrl = url;
				},
			});
		}
	};
	addRefs("image", req.inputs?.images);
	addRefs("video", req.inputs?.videos);
	addRefs("audio", req.inputs?.audios);
	return out;
}

const defaultAfterSuccess = () => new Promise<void>((resolve) => setTimeout(resolve, 250));

/**
 * 逐个把本次请求的素材搬到 nyxen 加速桶。
 * 在稳定模式请求副本中增加 accelerationUrl，原 id/url 不动；素材顺序、名称和项目数据保持不变。
 */
export async function accelerateNyxenRequest(
	req: GenerateRequest,
	deps: NyxenAccelerationDeps,
): Promise<GenerateRequest> {
	const next = clonedRequest(req);
	const candidates = candidatesOf(next);
	if (!candidates.length) return next;

	const sourceByCandidate: string[] = [];
	for (const candidate of candidates) sourceByCandidate.push(await sourceUrlOf(candidate, deps));
	const uniqueCount = new Set(sourceByCandidate).size;
	const accelerated = new Map<string, string>();
	const ordinal: Record<NyxenMaterialKind, number> = { image: 0, video: 0, audio: 0 };
	let completed = 0;

	for (let index = 0; index < candidates.length; index += 1) {
		const candidate = candidates[index];
		const sourceUrl = sourceByCandidate[index];
		const cached = accelerated.get(sourceUrl);
		if (cached) {
			candidate.setAccelerationUrl(cached);
			continue;
		}

		ordinal[candidate.kind] += 1;
		const itemLabel = `第${ordinal[candidate.kind]}${KIND_LABEL[candidate.kind]}`;
		const before = 10 + Math.floor((completed / uniqueCount) * 25);
		deps.onProgress?.(before, "running", undefined, {
			stageText: `${itemLabel}上传中（共 ${uniqueCount} 个素材）`,
		});

		try {
			const acceleratedUrl = await deps.upload(sourceUrl, candidate.kind);
			if (!isHttpUrl(acceleratedUrl)) throw new Error("加速桶未返回有效地址");
			accelerated.set(sourceUrl, acceleratedUrl);
			candidate.setAccelerationUrl(acceleratedUrl);
			completed += 1;
			const after = 10 + Math.floor((completed / uniqueCount) * 25);
			deps.onProgress?.(after, "running", undefined, { stageText: `${itemLabel}上传成功` });
			await (deps.afterSuccess ?? defaultAfterSuccess)();
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(`${itemLabel}上传加速桶失败：${reason}`);
		}
	}

	deps.onProgress?.(38, "running", undefined, { stageText: "素材上传完成，正在提交生成" });
	return next;
}

/**
 * 把稳定模式的“四元素材”投影成服务端现有协议。
 * 服务端按 id 优先解析，所以有 accelerationUrl 的副本在上线路前需只发该临时 URL；
 * 四元对象本身仍保留前三元信息，且只活到本次 submit 结束。
 */
export function nyxenRequestForWire(req: GenerateRequest): GenerateRequest {
	const next = clonedRequest(req);
	const firstFrameAccelerationUrl = (next.params as NyxenAcceleratedParams | undefined)?.firstFrameAccelerationUrl;
	if (next.params && firstFrameAccelerationUrl) {
		next.params.firstFrameUrl = firstFrameAccelerationUrl;
		delete (next.params as NyxenAcceleratedParams).firstFrameAccelerationUrl;
	}
	const project = (refs: AssetRef[] | undefined): AssetRef[] | undefined => refs?.map((ref) => {
		const accelerated = (ref as NyxenAcceleratedAssetRef).accelerationUrl;
		if (!accelerated) return ref;
		const { id: _id, accelerationUrl: _accelerationUrl, ...rest } = ref as NyxenAcceleratedAssetRef;
		return { ...rest, url: accelerated };
	});
	if (next.inputs) {
		next.inputs.images = project(next.inputs.images);
		next.inputs.videos = project(next.inputs.videos);
		next.inputs.audios = project(next.inputs.audios);
	}
	return next;
}

/** Tauri 原生上传：密钥只存在于 Rust 编译产物，不进入前端 JS 或生成请求。 */
export async function uploadToNyxenAccelerationBucket(
	sourceUrl: string,
	kind: NyxenMaterialKind,
): Promise<string> {
	const isTauri =
		typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
	if (!isTauri) throw new Error("稳定素材加速仅支持 Qiji 桌面客户端");
	const { invoke } = await import("@tauri-apps/api/core");
	return invoke<string>("nyxen_accelerate_upload", { sourceUrl, kind });
}
