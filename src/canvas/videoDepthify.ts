/**
 * videoDepthify —— 「视频转深度」的入口与收尾（碰 store 与网络；与图片侧 depthify.ts 同构）。
 *
 *  - depthifyVideoNode：画布视频节点 → 右侧新建**专用转深度节点**（video.depth）承载灰度深度视频，连线承接原视频。
 *  - depthifyVideoUri：灯箱等「只有显示 uri」的场景 → 视口中心新建转深度节点。
 *  - rerunVideoDepthNode：转深度节点「运行」= 重新逐帧推理（pluginRegistry script 分支调入）。
 * 管线（第206轮定稿，纯客户端零服务端零计费）：fetch 字节 → <video> 逐帧 seek 抽帧（帧率=节点参数，
 * 默认 16fps）→ 逐帧本地深度推理（复用图片侧模型单例）→ 归一化（设置里选 时间平滑防闪烁/每帧独立）
 * → WebCodecs 编码回灰度 mp4（无音轨）。⚠ 与 image.depth 同规矩：**永不走生视频管线**，
 * 占位节点是专用 video.depth（capability null），杜绝「失败后点生成=真调视频模型扣费」。
 */
import { useCanvasStore } from "@/store/canvasStore";
import { useLibraryStore } from "@/store/libraryStore";
import { useProjectStore } from "@/store/projectStore";
import { useSettingsStore } from "@/store/settingsStore";
import { dispatchCommand } from "@/command/dispatch";
import { uploadMediaToCanvasAsset } from "@/canvas/nodeUpload";
import { avoidOverlap, makeNode, NODE_W } from "@/canvas/nodeFactory";
import { fetchUriOf } from "@/canvas/annotate";
import { genId } from "@/lib/id";
import { grayToRgba } from "@/lib/depthMap";
import {
	DEPTH_INFER_BATCH_GPU,
	FrameQueue,
	MAX_DEPTH_FRAMES,
	clampSourceFps,
	grayWithBounds,
	inferSize,
	planFrameTimes,
	rawDepthBounds,
	smoothDepthBounds,
	type DepthBounds,
} from "@/lib/videoDepthCore";
import { parseMp4VideoInfo } from "@/lib/mp4Meta";

/** 画布视频节点 → 转深度（产物落在节点右侧，连线承接原视频；重跑优先取上游连线的最新视频） */
export function depthifyVideoNode(nodeId: string): void {
	const cs = useCanvasStore.getState();
	const node = cs.nodes[nodeId];
	const resultAssetId = node?.data.resultAssetId;
	if (!node || !resultAssetId) return;
	const asset = useLibraryStore.getState().assets[resultAssetId];
	const baseName = baseNameOf(asset?.name);

	let depth = makeNode("video.depth", node.x + node.w + 64, node.y);
	depth = avoidOverlap(depth, Object.values(cs.nodes));
	depth.data.title = `深度-${baseName}`;
	depth.data.params = { ...depth.data.params, depthSrcAssetId: resultAssetId, depthSrcName: baseName };
	dispatchCommand({
		type: "spawnNodes",
		parentId: node.id,
		nodes: [depth],
		edges: [{ id: genId("edge"), kind: "dataflow", source: node.id, sourcePort: "out", target: depth.id, targetPort: "in" }],
	});
	void runVideoDepthInto(depth.id, fetchUriOf(resultAssetId), baseName);
}

/** 灯箱等场景：只有显示 uri（凭三元映射反查本地副本；产物落视口中心，无连线） */
export function depthifyVideoUri(uri: string, name?: string): void {
	const cs = useCanvasStore.getState();
	const blob = useProjectStore.getState().blobByUri(uri);
	const baseName = baseNameOf(name || blob?.id);
	const vp = cs.viewport;
	const x = (-vp.x + window.innerWidth / 2) / vp.zoom - NODE_W / 2;
	const y = (-vp.y + window.innerHeight / 2) / vp.zoom - 100;

	let depth = makeNode("video.depth", x, y);
	depth = avoidOverlap(depth, Object.values(cs.nodes));
	depth.data.title = `深度-${baseName}`;
	depth.data.params = {
		...depth.data.params,
		depthSrcUri: blob?.localUri || uri,
		...(blob?.id ? { depthSrcAssetId: blob.id } : {}),
		depthSrcName: baseName,
	};
	dispatchCommand({ type: "addNode", node: depth });
	void runVideoDepthInto(depth.id, blob?.localUri || uri, baseName);
}

/**
 * 转深度节点「运行」= 重新转深度（executionHandlers → runScriptNode 调入）。
 * 原视频解析优先级：上游连线的视频结果（可换片重跑）→ 创建时记录的资产 id（现查活映射）→ 记录的 uri。
 */
export async function rerunVideoDepthNode(nodeId: string): Promise<void> {
	const cs = useCanvasStore.getState();
	const node = cs.nodes[nodeId];
	if (!node) return;
	if (cs.runtime[nodeId]?.status === "running") return; // 逐帧循环在跑：忽略重复运行
	const params = node.data.params as Record<string, unknown>;

	let uri = "";
	// ① 上游连线的视频结果（用户可换接任意视频节点后重跑）
	for (const edge of Object.values(cs.edges)) {
		if (edge.target !== nodeId) continue;
		const up = cs.nodes[edge.source];
		const upAssetId = up?.data.resultAssetId;
		if (!upAssetId) continue;
		const kind = useLibraryStore.getState().assets[upAssetId]?.kind;
		if (kind && kind !== "video") continue;
		uri = fetchUriOf(upAssetId);
		if (uri) break;
	}
	// ② 创建时记录的原视频资产 id（fetchUriOf 现查三元映射，本地副本优先）
	const srcAssetId = typeof params.depthSrcAssetId === "string" ? params.depthSrcAssetId : "";
	if (!uri && srcAssetId) uri = fetchUriOf(srcAssetId);
	// ③ 创建时记录的显示 uri（灯箱路径；按当前活映射刷新本地副本）
	const srcUri = typeof params.depthSrcUri === "string" ? params.depthSrcUri : "";
	if (!uri && srcUri) {
		const blob = useProjectStore.getState().blobByUri(srcUri);
		uri = blob?.localUri || srcUri;
	}
	if (!uri) {
		useCanvasStore.getState().setRuntime(nodeId, {
			status: "failed",
			progress: 100,
			error: "找不到原视频：请把一个视频节点连到本节点输入口后再运行",
		});
		return;
	}

	// 运行即清场（与标准媒体节点同语义）：旧深度视频归档进堆叠历史，不压在运行态下面
	const cur = useCanvasStore.getState().nodes[nodeId];
	if (cur?.data.resultAssetId) {
		const hist = [...(cur.data.resultHistory || [])];
		if (!hist.includes(cur.data.resultAssetId)) hist.push(cur.data.resultAssetId);
		useCanvasStore.setState({
			nodes: {
				...useCanvasStore.getState().nodes,
				[nodeId]: { ...cur, data: { ...cur.data, resultAssetId: null, resultHistory: hist } },
			},
		});
	}

	const baseName = typeof params.depthSrcName === "string" && params.depthSrcName
		? params.depthSrcName
		: baseNameOf((node.data.title || "").replace(/^深度-/, ""));
	await runVideoDepthInto(nodeId, uri, baseName);
}

function baseNameOf(name: string | undefined | null): string {
	return (name || "视频").replace(/\.[a-z0-9]+$/i, "");
}

/** 加载 <video> 元数据（含 MediaRecorder webm「时长 Infinity」修正——尾段截取产物就是这种） */
async function loadVideoMeta(v: HTMLVideoElement, objectUrl: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		let done = false;
		const ok = () => { if (!done) { done = true; resolve(); } };
		const bad = () => { if (!done) { done = true; reject(new Error("视频解码失败（格式不受支持或文件损坏）")); } };
		v.onloadedmetadata = ok;
		v.onerror = bad;
		setTimeout(() => { if (!done) { done = true; reject(new Error("视频元数据加载超时")); } }, 20000);
		v.src = objectUrl;
	});
	if (!Number.isFinite(v.duration) || v.duration <= 0) {
		// Chromium 对 MediaRecorder webm 报 duration=Infinity：seek 到超大时间强制算出真实时长
		await seekTo(v, 1e7);
		await seekTo(v, 0);
	}
}

/** seek 并等帧可绘：seeked 后再等一次 rVFC（Chromium 保证帧已呈现），全程带超时兜底不卡死 */
function seekTo(v: HTMLVideoElement, t: number): Promise<void> {
	return new Promise((resolve) => {
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			v.removeEventListener("seeked", onSeeked);
			resolve();
		};
		const onSeeked = () => {
			const rvfc = (v as unknown as { requestVideoFrameCallback?: (cb: () => void) => void }).requestVideoFrameCallback?.bind(v);
			if (rvfc) {
				rvfc(finish);
				setTimeout(finish, 250);
			} else finish();
		};
		v.addEventListener("seeked", onSeeked);
		setTimeout(finish, 3000);
		try {
			v.currentTime = t;
		} catch {
			finish();
		}
	});
}

/**
 * 逐帧推理并把深度视频填进目标节点（节点已存在；失败置 failed，节点被删则中断丢弃产物）。
 * 进度：模型加载 1-14 → 逐帧 15-96 → 编码收尾 97-99。
 */
async function runVideoDepthInto(nodeId: string, uri: string, baseName: string): Promise<void> {
	const setRt = (patch: Parameters<ReturnType<typeof useCanvasStore.getState>["setRuntime"]>[1]) =>
		useCanvasStore.getState().setRuntime(nodeId, patch);
	const nodeAlive = () => !!useCanvasStore.getState().nodes[nodeId];
	setRt({ status: "running", progress: 1, error: null });

	const video = document.createElement("video");
	video.preload = "auto";
	video.muted = true;
	video.playsInline = true;
	let objectUrl = "";
	let encoder: import("@/lib/videoDepthEncode").DepthVideoEncoder | null = null;

	try {
		if (!uri) throw new Error("找不到原视频");
		const resp = await fetch(uri);
		if (!resp.ok) throw new Error(`原视频读取失败（HTTP ${resp.status}）`);
		// 统一转 blob objectURL：同源解码，远程直链也不受 canvas 跨域污染限制（涂鸦/缩略图同款教训）
		const srcBlob = await resp.blob();
		objectUrl = URL.createObjectURL(srcBlob);
		// 原帧率（不抽帧，第206轮补充用户定稿）：从 mp4 容器解析视频轨真实 fps；
		// 解析不出（webm/碎片化）回退 30，>60 夹到 60（深度视频无增益纯烧时）。
		const mp4Info = parseMp4VideoInfo(new Uint8Array(await srcBlob.arrayBuffer()));
		const fps = clampSourceFps(mp4Info?.fps);
		await loadVideoMeta(video, objectUrl);

		const vw = video.videoWidth;
		const vh = video.videoHeight;
		if (!vw || !vh) throw new Error("视频没有可用画面轨道");
		const duration = video.duration;
		const times = planFrameTimes(duration, fps);
		if (!times.length) throw new Error("读不到视频时长，无法逐帧转深度");
		if (times.length > MAX_DEPTH_FRAMES) {
			throw new Error(`视频过长（${Math.round(duration)}s @ ${fps}fps = ${times.length} 帧，上限 ${MAX_DEPTH_FRAMES} 帧）：请先截取片段再转深度`);
		}

		// 重模块到这里才加载：模型（与图片转深度共享单例）+ 编码器（mp4-muxer）
		const { preloadDepthModel, estimateDepthRawFrames } = await import("@/lib/depthEstimator");
		await preloadDepthModel((pct) => {
			if (nodeAlive()) setRt({ status: "running", progress: Math.max(1, Math.min(14, Math.round(1 + (pct / 100) * 13))) });
		});
		const { createDepthVideoEncoder } = await import("@/lib/videoDepthEncode");
		encoder = await createDepthVideoEncoder(vw, vh, fps);
		const enc = encoder; // 非空捕获：闭包（consumer/drainOne）里用它，外层 encoder 变量供 catch 兜底释放

		// 三块画布：抽帧降采样（推理输入）/ 深度小图（模型输出分辨率）/ 编码输出（原视频尺寸偶数化）
		const { w: iw, h: ih } = inferSize(vw, vh);
		const inferCanvas = document.createElement("canvas");
		inferCanvas.width = iw;
		inferCanvas.height = ih;
		const inferCtx = inferCanvas.getContext("2d", { willReadFrequently: true })!;
		const grayCanvas = document.createElement("canvas");
		const grayCtx = grayCanvas.getContext("2d")!;
		const outCanvas = document.createElement("canvas");
		outCanvas.width = encoder.width;
		outCanvas.height = encoder.height;
		const outCtx = outCanvas.getContext("2d")!;
		outCtx.imageSmoothingEnabled = true;
		outCtx.imageSmoothingQuality = "high";

		// 防闪烁模式（设置→生成偏好）：时间平滑归一化（默认）/ 每帧独立归一化
		const smooth = useSettingsStore.getState().depthVideoSmooth !== false;
		let bounds: DepthBounds | null = null;

		// ── GPU 吃满（第206轮补充2，用户实测串行版 GPU 只吃到 ~20%）──
		// 抽帧（seek/解码=CPU 活）与推理（GPU 活）改**并行流水**：生产者持续 seek 抽帧进有界队列，
		// 消费者从队列凑批**批量推理**（GPU 一次喂 8 帧——518 系 ViT-S 单帧算子太小喂不满 GPU）。
		// 凑批用 pullImmediate 非阻塞：生产快=满批吃满 GPU，生产慢=小批不干等（延迟自适应）。
		const gpuOn = useSettingsStore.getState().depthGpu !== false && !!(navigator as { gpu?: unknown }).gpu;
		const BATCH = gpuOn ? DEPTH_INFER_BATCH_GPU : 1; // WASM CPU 批量无增益，恒 1（流水线照样重叠 seek 与推理）
		const CANCELLED = new Error("__video_depth_cancelled__");
		const queue = new FrameQueue<{ index: number; frame: ImageData }>(BATCH * 2 + 2);

		const producer = (async () => {
			try {
				for (let i = 0; i < times.length; i++) {
					if (!nodeAlive()) throw CANCELLED;
					await seekTo(video, times[i]);
					inferCtx.drawImage(video, 0, 0, iw, ih);
					await queue.push({ index: i, frame: inferCtx.getImageData(0, 0, iw, ih) });
				}
				queue.close();
			} catch (err) {
				if (err !== CANCELLED) queue.fail(err);
				else queue.fail(CANCELLED);
			}
		})();

		const consumer = (async () => {
			let doneFrames = 0;
			type Item = { index: number; frame: ImageData };
			// 双批在飞：GPU 算上一批的同时，下一批做 CPU 预处理（pipe 内部）——批与批之间 GPU 不空转
			const inflight: Array<{ batch: Item[]; promise: Promise<Awaited<ReturnType<typeof estimateDepthRawFrames>>> }> = [];
			const MAX_INFLIGHT = 2;
			const drainOne = async () => {
				const job = inflight.shift()!;
				const depths = await job.promise;
				for (let k = 0; k < job.batch.length; k++) {
					const depth = depths[k];
					const cur = rawDepthBounds(depth.data);
					const used: DepthBounds | null = cur ? (smooth ? smoothDepthBounds(bounds, cur) : cur) : bounds;
					if (used) bounds = used;
					const gray = used ? grayWithBounds(depth.data, used) : new Uint8ClampedArray(depth.width * depth.height).fill(128);

					if (grayCanvas.width !== depth.width || grayCanvas.height !== depth.height) {
						grayCanvas.width = depth.width;
						grayCanvas.height = depth.height;
					}
					grayCtx.putImageData(new ImageData(grayToRgba(gray), depth.width, depth.height), 0, 0);
					outCtx.drawImage(grayCanvas, 0, 0, outCanvas.width, outCanvas.height);
					await enc.addFrame(outCanvas, job.batch[k].index);
					doneFrames++;
				}
				if (nodeAlive()) setRt({ status: "running", progress: Math.min(96, Math.round(15 + (doneFrames / times.length) * 81)) });
			};
			for (;;) {
				// 用户可能已删掉节点：让两端立即终止、丢弃产物（不再烧推理）
				if (!nodeAlive()) {
					queue.fail(CANCELLED);
					throw CANCELLED;
				}
				const first = await queue.pull();
				if (!first) break;
				const batch: Item[] = [first];
				while (batch.length < BATCH) {
					const nxt = queue.pullImmediate();
					if (!nxt) break;
					batch.push(nxt);
				}
				const promise = estimateDepthRawFrames(batch.map((b) => b.frame));
				promise.catch(() => {}); // 防「未及 await 先 reject」的 unhandled rejection（错误仍由 drainOne 抛出）
				inflight.push({ batch, promise });
				if (inflight.length >= MAX_INFLIGHT) await drainOne();
			}
			while (inflight.length) await drainOne();
		})();

		try {
			await Promise.all([producer, consumer]);
		} catch (err) {
			if (err === CANCELLED) {
				encoder.cancel();
				return;
			}
			throw err;
		}

		if (!nodeAlive()) {
			encoder.cancel();
			return;
		}
		setRt({ status: "running", progress: 97 });
		const mp4 = await encoder.finish();
		encoder = null;

		const file = new File([mp4], `深度-${baseName}.mp4`, { type: "video/mp4" });
		const up = await uploadMediaToCanvasAsset(file, "TP");
		useLibraryStore.getState().addAsset({
			id: up.assetId,
			kind: "video",
			name: file.name,
			uri: up.displayUri,
			serverAssetId: up.assetId,
			thumbnailUri: null,
			createdAt: new Date().toISOString(),
			deletedByUser: false,
			localPath: up.localPath,
		});
		const cs2 = useCanvasStore.getState();
		const cur = cs2.nodes[nodeId];
		if (cur) {
			const hist = [...(cur.data.resultHistory || [])];
			if (!hist.includes(up.assetId)) hist.push(up.assetId);
			useCanvasStore.setState({
				nodes: {
					...cs2.nodes,
					[nodeId]: { ...cur, data: { ...cur.data, resultAssetId: up.assetId, resultHistory: hist } },
				},
			});
			setRt({ status: "success", progress: 100 });
		}
	} catch (err) {
		encoder?.cancel();
		const msg = err instanceof Error ? err.message : "视频转深度失败";
		if (nodeAlive()) setRt({ status: "failed", progress: 100, error: `${msg}（模型已内置无需联网，可再点「运行」重试）` });
	} finally {
		try {
			video.removeAttribute("src");
			video.load();
		} catch {
			/* 释放失败可忽略 */
		}
		if (objectUrl) URL.revokeObjectURL(objectUrl);
	}
}
