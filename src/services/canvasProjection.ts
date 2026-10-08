/** 资产模式到当前分集画布的手动、幂等投影。只维护带投影身份的节点。 */
import { getDualModeFeature } from '@/store/connectionStore';
import { useProjectStore } from '@/store/projectStore';
import { useCanvasStore } from '@/store/canvasStore';
import { isWebviewLocalUri } from '@/lib/publicUrl';
import { useLibraryStore } from '@/store/libraryStore';
import { syncNodeLegend } from '@/canvas/nodeMaterials';
import { makeNode, NODE_W, NODE_H } from '@/canvas/nodeFactory';
import { getNodeSpec } from '@/nodes/nodeSpecs';
import { inferenceDurationLimit, projectInferenceDuration, projectInferenceStrategy } from '@/lib/inferenceStrategy';
import { resolveCanvasSendSettings } from '@/lib/canvasSendSettings';
import { assetGenParams } from '@/lib/canvasSpawn';
import { episodeAssetForms } from '@/lib/episodeAssetForms';
import { layoutProjection } from '@/lib/canvasProjectionLayout';
import { useUiStore } from '@/store/uiStore';
import { genId } from '@/lib/id';
import type { CanvasNode, CanvasEdge, CanvasGroup, NodeRuntime } from '@/types';
const STEP_X = NODE_W + 120;
const STEP_Y = NODE_H + 48;
const DEFAULT_RUNTIME: NodeRuntime = { status: 'idle', progress: 0, taskId: null, scheduledAt: null, error: null };

/** 把资产模式的媒体（URI）登记为画布素材，返回稳定 assetId（幂等：uri 变了才重登记） */
function regMedia(key: string, uri: string, name: string, kind: "image" | "video"): string {
	const assetId = `proj-${key}`;
	const lib = useLibraryStore.getState();
	// 优先本地副本显示（远程 https 直链会被 Tauri CSP 拦→裂图）；无本地副本则用原 uri，
	// 由 ResultView 的 useDisplayUri 兜底下载到本地再显示。
	const blob = useProjectStore.getState().blobByUri(uri);
	const showUri = blob?.localUri || uri;
	const ex = lib.assets[assetId];
	if (!ex || ex.uri !== showUri || (blob?.id && ex.serverAssetId !== blob.id)) {
		lib.addAsset({
			id: assetId, kind, name, uri: showUri, thumbnailUri: kind === "image" ? showUri : null,
			createdAt: new Date().toISOString(), deletedByUser: false, localPath: blob?.localPath ?? null,
			// 管理端真资产 id（id 是真理）：下游提交时优先凭 id 解析 OSS 直链，不依赖 url 缓存
			serverAssetId: blob?.id ?? ex?.serverAssetId ?? null,
			origin: "generated",
			pixelWidth: ex?.uri === showUri ? ex.pixelWidth : undefined,
			pixelHeight: ex?.uri === showUri ? ex.pixelHeight : undefined,
		});
	}
	// 显示一律走本地文件：投影拿到的还是远程 url（本地副本缺失）→ 趁 url 未过期立刻下载落地，
	// 完成后把库资产升级为本地 uri + 登记三元映射（否则节点显示依赖公网 url，链接过期即永久裂开）。
	// 注意排除 http://asset.localhost/... 本地伪域直链——它已是本地文件的显示态，无需（也不应）再下载。
	if (!blob?.localUri && /^https?:/i.test(showUri) && !isWebviewLocalUri(showUri)) {
		void import("@/services/assetPersist").then(async ({ saveRemoteAsset }) => {
			const saved = await saveRemoteAsset(assetId, showUri);
			if (!saved?.localUri) return;
			useProjectStore.getState().registerAssetBlob({ ...saved, srcUri: showUri });
			const lib2 = useLibraryStore.getState();
			const cur = lib2.assets[assetId];
			if (cur && cur.uri === showUri) {
				lib2.addAsset({ ...cur, uri: saved.localUri, thumbnailUri: kind === "image" ? saved.localUri : null, localPath: saved.localPath ?? null });
			}
		}).catch(() => { /* 非 Tauri/下载失败：保留远程 uri，由 ResultView 的 useDisplayUri 兜底 */ });
	}
	return assetId;
}


/** 调用方先 switchCanvas 到目标分集；仅同步输入，已有产物/历史/在途任务不被表格空值覆盖。 */
export function syncCanvasFromProject(episodeIdArg?: string | null): boolean {
    const ps = useProjectStore.getState();
    const cs = useCanvasStore.getState();
    const wanted = episodeIdArg !== undefined ? episodeIdArg : (ps.canvasEpisodeId ?? ps.uiSnapshot?.video?.episodeId);
    const ep = ps.episodes.find(e => e.id === wanted) ?? ps.episodes[0];
    const options = resolveCanvasSendSettings(ps.mediaSettings.canvasSend);
    const sameSource = !getDualModeFeature() || !!ps.mediaSettings.imgVideoSameSource;
    const shots = ep?.shots ?? [];
    const shotIds = new Set(shots.map(s => s.id));
    const owned = (n: CanvasNode) => {
        const ref = n.data.sourceRef ?? '';
        if (['script', 'episodeSplit', 'assetSplit'].includes(ref) || ref.startsWith('asset:') || ref.startsWith('assetGroup:')) return true;
        if (n.data.episodeRef && n.data.episodeRef !== ep?.id) return false;
        return ref === 'episode:' + ep?.id || ref === 'episodeGroup:' + ep?.id ||
            (/^(shot|shotSb|shotVid|shotUni):/.test(ref) && (n.data.episodeRef === ep?.id || shotIds.has(ref.slice(ref.indexOf(':') + 1))));
    };
    const managed = new Set(Object.values(cs.nodes).filter(owned).map(n => n.id));
    const byRef = new Map(Object.values(cs.nodes).filter(owned).map(n => [n.data.sourceRef!, n]));
    const work: Record<string, CanvasNode> = {};
    const groups: Record<string, CanvasGroup> = {};
    const desiredEdges = new Map<string, CanvasEdge>();
    const existingEdges = new Map(Object.values(cs.edges).map(e => [e.source + '>' + e.target, e]));
    const mediaIds: string[] = [];
    const ensure = (ref: string, type: string, x: number, y: number, fill: (data: CanvasNode['data']) => void) => {
        const old = byRef.get(ref);
        const prior = old?.type === type ? old : undefined;
        const node = prior ? { ...prior, data: { ...prior.data, params: { ...prior.data.params }, input: { ...prior.data.input } } } : makeNode(type, x, y);
        if (prior?.data.projectionPosition) {
            node.x += x - prior.data.projectionPosition.x;
            node.y += y - prior.data.projectionPosition.y;
        } else if (prior) {
            // 历史投影首次迁移到四列布局。
            node.x = x; node.y = y;
        }
        node.data.sourceRef = ref;
        node.data.projectionPosition = { x, y };
        node.data.episodeRef = ep?.id;
        fill(node.data);
        const asset = node.data.resultAssetId ? useLibraryStore.getState().assets[node.data.resultAssetId] : undefined;
        if (asset && (asset.kind === 'image' || asset.kind === 'video') &&
            Number.isFinite(asset.pixelWidth) && Number.isFinite(asset.pixelHeight) && asset.pixelWidth! > 0 && asset.pixelHeight! > 0) {
            node.h = node.data.mediaDisplayHeight ?? NODE_H;
            node.w = Math.max(1, Math.round(node.h * asset.pixelWidth! / asset.pixelHeight!));
            node.data.mediaDisplayHeight = node.h;
        }
        work[node.id] = node;
        return node;
    };
    const connect = (a: CanvasNode | undefined, b: CanvasNode | undefined) => {
        if (!options.connections || !a || !b) return;
        const key = a.id + '>' + b.id;
        desiredEdges.set(key, existingEdges.get(key) ?? {
            id: genId('edge'), kind: 'dataflow', source: a.id,
            sourcePort: getNodeSpec(a.type)?.outputs[0]?.name ?? 'text', target: b.id,
            targetPort: getNodeSpec(b.type)?.inputs[0]?.name ?? 'text',
        });
    };
    const groupNodes = (ref: string, title: string, members: CanvasNode[], kind: 'default' | 'material') => {
        if (!members.length) return;
        // 用户手工放入同步分组的节点继续保留。
        const prior = byRef.get(ref);
        const extra = (prior ? cs.groups[prior.id]?.childIds ?? [] : []).filter(id => !managed.has(id)).map(id => cs.nodes[id]).filter(Boolean);
        const all = [...members, ...extra];
        const x = Math.min(...all.map(n => n.x)) - 20, y = Math.min(...all.map(n => n.y)) - 40;
        const node = ensure(ref, 'group', x, y, d => { d.title = title; });
        node.x = x; node.y = y;
        node.w = Math.max(...all.map(n => n.x + n.w)) - x + 20;
        node.h = Math.max(...all.map(n => n.y + n.h)) - y + 20;
        groups[node.id] = { id: node.id, childIds: all.map(n => n.id), x, y, kind };
        for (const member of members) member.parentId = node.id;
    };
	type ProjMat = { id: string; assetId?: string; media?: "image" | "video" | "audio"; name?: string; uri: string; voiceForAssetId?: string };
	// 分镜垫素材 → 节点 input（图/视频/音频分组；故事板节点只取图像，视频节点取全部），供节点显示+下游引用。
	// ⚠ ref 键空间必须与画布「匹配素材」（assetMatch）完全一致，两侧才互认（判重/matOrder/素材编号）：
	//   id=**台账 blob id**（图生图按 id 取字节；勿写资产实体 id——键互不相认正是「再同步后画布编号错乱」的根源之一）、
	//   url=公网 url 优先（请求用；显示由 listNodeMaterials 凭 id 反查本地副本）、
	//   assetId=项目资产实体 id（音色「声音参考」按此配对）、voiceForAssetId 透传（音频归属角色）。
	const matToInput = (mats: ProjMat[] | undefined, imageOnly: boolean): Record<string, unknown> => {
		const blobOf = useProjectStore.getState().blobByUri;
		const images: any[] = [], videos: any[] = [], audios: any[] = [];
		for (const m of mats || []) {
			if (!m.uri) continue;
			const blob = blobOf(m.uri);
			const ref = {
				id: blob?.id, url: blob?.url || m.uri, name: m.name, assetId: m.assetId,
				...(m.voiceForAssetId ? { voiceForAssetId: m.voiceForAssetId } : {}),
			};
			const media = m.media || "image";
			if (media === "image") images.push(ref);
			else if (!imageOnly && media === "video") videos.push(ref);
			else if (!imageOnly && media === "audio") audios.push(ref);
		}
		const input: Record<string, unknown> = {};
		if (images.length) input.images = images;
		if (videos.length) input.videos = videos;
		if (audios.length) input.audios = audios;
		return input;
	};

    // 五类素材组与本集普通组独立；投影主图及造型，不展开历史出图。
    if (options.assets) {
        const usedForms = episodeAssetForms(ep);
        const categories = [['characters', '角色'], ['scenes', '场景'], ['crowds', '群像'], ['organisms', '生物'], ['items', '物品']] as const;
        let rowY = 0;
        for (const [category, title] of categories) {
            const members: CanvasNode[] = [];
            for (const asset of ps[category]) {
                const forms = [{ id: '', name: asset.name, prompt: asset.prompt, image: asset.image },
                    ...(asset.variants ?? []).map(v => ({ ...v, name: asset.name + ' · ' + (v.name || v.label) }))];
                for (const form of forms) {
                    const key = asset.id + (form.id ? ':' + form.id : '');
                    if (!usedForms.has(key)) continue;
                    const i = members.length;
                    members.push(ensure('asset:' + key, 'image.gen', i % 5 * STEP_X, rowY + Math.floor(i / 5) * STEP_Y, d => {
                        d.title = form.name; d.params.prompt = form.prompt || '';
                        d.projectionLayout = { section: category, row: Math.floor(i / 5), column: i % 5 };
                        Object.assign(d.params, assetGenParams({ cat: category, name: form.name }));
                        if (!d.resultAssetId && !d.task && !d.resultHistory?.length) d.resultAssetId = form.image ? regMedia('asset-' + key, form.image, form.name, 'image') : null;
                    }));
                }
            }
            groupNodes('assetGroup:' + category, title, members, 'material');
            if (members.length) rowY += (Math.ceil(members.length / 5) + 1) * STEP_Y;
        }
    }
    if (ep) {
        const strategy = projectInferenceStrategy(ps.mediaSettings);
        const episodeDuration = projectInferenceDuration(ps.mediaSettings);
        const episodeMembers: CanvasNode[] = [];
        const inferenceData = (d: CanvasNode['data'], single: boolean, duration: number | undefined) => {
            d.params.inferenceStrategy = structuredClone(strategy);
            d.params.inferenceScope = single ? 'single' : 'multi';
            d.params.inferenceMode = sameSource ? 'unified' : 'storyboard';
            if (single) {
                d.params.inferenceDurationLimit = inferenceDurationLimit(duration);
                d.params.inferenceDurationPreset = d.params.inferenceDurationLimit === 30 ? '4-30' : '4-15';
            } else {
                d.params.inferenceDurationLimit = episodeDuration.durationLimit;
                d.params.inferenceDurationPreset = episodeDuration.durationPreset;
                // 连同未完成的自定义草稿一起复制，不能静默量化到15/30秒或与项目共享对象。
                d.params.inferenceCustomDuration = structuredClone(episodeDuration.customDuration);
            }
            d.params.inferenceOutput = sameSource ? (single ? 'storyboard.unifiedShot' : 'storyboard.unified') : (single ? 'storyboard.singleShot' : 'storyboard.toVideoPrompt');
        };
        const infer = options.inference ? ensure('episode:' + ep.id, 'smart.infer', 0, 0, d => {
            d.projectionLayout = { section: 'shots', row: 0, column: 0 };
            d.title = ep.title + '推理';
            d.params.prompt = [ep.title, ep.scriptText].filter(Boolean).join('\n');
            d.resultText = String(d.params.prompt);
            inferenceData(d, false, ps.mediaSettings.maxDuration);
        }) : undefined;
        if (infer) episodeMembers.push(infer);
        shots.forEach((sh, i) => {
            let column = options.inference ? 1 : 0;
            const y = i * STEP_Y;
            const n = sh.index ?? i + 1;
            const original = options.original ? ensure('shot:' + sh.id, 'smart.infer', column++ * STEP_X, y, d => {
                d.projectionLayout = { section: 'shots', row: i, column: column - 1 };
                d.title = '分镜' + n + '原文'; d.params.prompt = sh.scriptSegment || sh.prompt || ''; d.resultText = String(d.params.prompt);
                inferenceData(d, true, sh.overrides?.duration ?? sh.durationSec ?? ps.mediaSettings.maxDuration);
                d.params.inferenceStrategy = { ...structuredClone(strategy), guidance: [strategy.guidance, sh.plotGuidance].filter(Boolean).join('\n\n') };
            }) : undefined;
            if (original) episodeMembers.push(original);
            connect(infer, original);
            // 始终携带正文：无连线、无原文时也能独立使用；同源正文复制到图/视频。
            const sb = options.storyboard ? ensure('shotSb:' + sh.id, 'image.gen', column++ * STEP_X, y, d => {
                d.projectionLayout = { section: 'shots', row: i, column: column - 1 };
                d.title = '分镜' + n + '故事板';
                d.params.prompt = sameSource ? sh.unifiedPrompt || sh.prompt || '' : sh.storyboardPrompt || sh.prompt || '';
                d.input = matToInput(sh.materials, true);
                if (!d.resultAssetId && !d.task && !d.resultHistory?.length) d.resultAssetId = sh.storyboardUri ? regMedia('sb-' + sh.id, sh.storyboardUri, '分镜' + n + '故事板', 'image') : null;
            }) : undefined;
            const vid = options.video ? ensure('shotVid:' + sh.id, 'video.gen', column++ * STEP_X, y, d => {
                d.projectionLayout = { section: 'shots', row: i, column: column - 1 };
                d.title = '分镜' + n + '视频';
                d.params.prompt = sameSource ? sh.unifiedPrompt || sh.prompt || '' : sh.videoPrompt || '';
                d.input = matToInput(sh.materials, false);
                if (!d.resultAssetId && !d.task && !d.resultHistory?.length) d.resultAssetId = sh.videoUri ? regMedia('vid-' + sh.id, sh.videoUri, '分镜' + n + '视频', 'video') : null;
            }) : undefined;
            connect(original, sb);
            connect(sameSource ? original : sb ?? original, vid);
            for (const node of [sb, vid]) if (node) { episodeMembers.push(node); mediaIds.push(node.id); }
        });
        if (options.group) groupNodes('episodeGroup:' + ep.id, ep.title || '本集分镜', episodeMembers, 'default');
    }
    const removed = new Set([...managed].filter(id => !work[id]));
    const finalNodes = { ...cs.nodes };
    const runtime = { ...cs.runtime };
    for (const id of removed) { delete finalNodes[id]; delete runtime[id]; }
    Object.assign(finalNodes, work);
    for (const id of Object.keys(work)) if (!runtime[id]) runtime[id] = { ...DEFAULT_RUNTIME };
    const finalGroups: Record<string, CanvasGroup> = {};
    for (const [id, g] of Object.entries(cs.groups)) {
        if (removed.has(id) || groups[id]) continue;
        const childIds = g.childIds.filter(childId => finalNodes[childId] && (!work[childId] || work[childId].parentId === id));
        finalGroups[id] = { ...g, childIds };
    }
    Object.assign(finalGroups, groups);
    for (const [id, node] of Object.entries(finalNodes)) {
        if (node.parentId && !finalGroups[node.parentId]) finalNodes[id] = { ...node, parentId: null };
    }
    const finalEdges: Record<string, CanvasEdge> = {};
    for (const [id, edge] of Object.entries(cs.edges)) {
        if (removed.has(edge.source) || removed.has(edge.target)) continue;
        // 只重建投影节点之间的边；连接用户手建节点的边保持不变。
        if (managed.has(edge.source) && managed.has(edge.target)) continue;
        finalEdges[id] = edge;
    }
    for (const edge of desiredEdges.values()) finalEdges[edge.id] = edge;
    const layout = layoutProjection(finalNodes, finalGroups, !useUiStore.getState().allowOverlap);
    const dirty = JSON.stringify([layout.nodes, finalEdges, layout.groups]) !== JSON.stringify([cs.nodes, cs.edges, cs.groups]);
    if (dirty) {
        cs.pushHistory();
        useCanvasStore.setState({ ...layout, edges: finalEdges, runtime });
    }
    if (ps.canvasEpisodeId !== (ep?.id ?? null)) ps.setCanvasEpisodeId(ep?.id ?? null);
    // 按实际连线与垫素材重建图例，避免取消故事板或连线后 @ImageN 错位。
    let legendDirty = false;
    for (const id of mediaIds) if (syncNodeLegend(id, undefined, { preserveExisting: false })) legendDirty = true;
    return dirty || legendDirty;
}
