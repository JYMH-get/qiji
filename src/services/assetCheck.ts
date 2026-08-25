/**
 * assetCheck —— 手动「检查素材」：逐个资产探 OSS 直链是否可达，链接换过就换用新链、
 * 死链且本机有本地副本则自动重传修复。
 *
 * 三处入口共用：画布节点右键（本节点结果+素材）/ 资产界面·资产助手右键（单资产的图）/ 资产界面一键检查全部。
 * ⚠ 恢复逻辑本身在 services/assetRecover（与提交前自愈 assetHeal 共用同一份，勿在此另写一套）；
 *   本模块只负责「目标解析 + 状态映射 + 报告汇总」。
 */
import { useProjectStore } from "@/store/projectStore";
import { useCanvasStore } from "@/store/canvasStore";
import { useLibraryStore } from "@/store/libraryStore";
import { getNodeMaterialItems } from "@/canvas/nodeMaterials";
import { recoverAsset, LEDGER_ID_RE, type RecoverOptions } from "@/services/assetRecover";
import { useAssetCheckStore, type CheckStatus, type CheckItemResult, type CheckReport } from "@/store/assetCheckStore";

/** 恢复例程的可注入项（cache 由本模块钉死为 "none"——手动检查必须真探） */
export type CheckOpts = Omit<RecoverOptions, "cache">;

export interface CheckTarget {
	id: string;
	name?: string;
	/** 反查不到台账资产 id（无 OSS 记录）——不发探活请求，直接报「missing」异常。
	 * ⚠ 全面「OSS 提交+本地预览」模式下软件内素材都应有 OSS 记录，这类项是问题本身，
	 * 解析层必须保留进报告（勿再静默丢弃/跳过，第121轮用户定）。id 此时=显示 uri（仅作去重键）。 */
	noLedger?: boolean;
}

/**
 * 单个资产：探活 → 换链 / 本地副本重传修复。
 *
 * ⚠ 第254轮（勿回退）：「本机无副本」(dead) 与「有副本但重传失败」(failed) **必须分开**——
 * 旧实现两者都返回 dead，弹窗一律显示「云端已丢失且本机无副本」，而真实失败多是对象存储
 * PUT 抖动（第197轮已实锤），用户看到的是彻底误导的结论。
 *
 * 手动检查一律 `cache:"none"` 真探——用户点「检查素材」就是要一个当下的结论，
 * 不能被提交路径的会话缓存跳过。
 */
export async function checkOne(target: CheckTarget, opts?: CheckOpts): Promise<{ status: CheckStatus; reason?: string }> {
	if (target.noLedger || !LEDGER_ID_RE.test(target.id)) return { status: "missing" }; // 无 OSS 记录=异常（非"跳过"）
	const r = await recoverAsset(target.id, { ...opts, cache: "none" });
	// adopted（服务端链接换过、已回写本机映射）对用户就是「正常」
	const status: CheckStatus = r.status === "adopted" ? "ok" : r.status;
	return { status, reason: r.reason };
}

/** 对结果计数汇总（纯函数） */
export function summarize(items: CheckItemResult[]): CheckReport {
	return {
		total: items.length,
		ok: items.filter((i) => i.status === "ok").length,
		healed: items.filter((i) => i.status === "healed").length,
		dead: items.filter((i) => i.status === "dead").length,
		failed: items.filter((i) => i.status === "failed").length,
		missing: items.filter((i) => i.status === "missing").length,
		items,
	};
}

/** 去重（按 id）+ 并发受限地逐个检查，onProgress 报进度。 */
export async function checkAssetTargets(
	targets: CheckTarget[],
	onProgress?: (done: number, total: number) => void,
	opts?: CheckOpts,
): Promise<CheckReport> {
	const list = dedupById(targets);
	const items: CheckItemResult[] = [];
	let done = 0;
	let idx = 0;
	const CONC = 6;
	const worker = async () => {
		while (idx < list.length) {
			const t = list[idx++];
			const { status, reason } = await checkOne(t, opts);
			items.push({ id: t.id, name: t.name, status, reason });
			done += 1;
			onProgress?.(done, list.length);
		}
	};
	await Promise.all(Array.from({ length: Math.min(CONC, list.length) }, worker));
	return summarize(items);
}

/** 编排：开进度弹窗 → 检查 → 出报告。UI 入口统一调这个。 */
export async function runAssetCheck(targets: CheckTarget[], title: string): Promise<void> {
	const list = dedupById(targets);
	const store = useAssetCheckStore.getState();
	if (!list.length) {
		store.showEmpty(title);
		return;
	}
	store.start(title, list.length);
	const report = await checkAssetTargets(list, (done) => useAssetCheckStore.getState().setProgress(done));
	useAssetCheckStore.getState().finish(report);
}

// ── 各入口的目标解析（uri → 台账资产 id；反查不到=noLedger 异常项，保留进报告不丢弃） ──

/** 由显示 uri 解析检查目标：三元映射反查台账 id；查不到 → noLedger 异常项（id=uri 作去重键）。空 uri（无图）返回 undefined。 */
function targetFromUri(uri: string | undefined, name?: string): CheckTarget | undefined {
	if (!uri) return undefined;
	const b = useProjectStore.getState().blobByUri(uri);
	if (b?.id && LEDGER_ID_RE.test(b.id)) return { id: b.id, name };
	return { id: uri, name, noLedger: true };
}

/** 由画布库资产 id 解析检查目标。⚠ 节点 resultAssetId/resultHistory 存的是**库资产派生 id**
 * （`asset-<taskId>`，libraryStore 的键）——真台账 id 在库资产的 serverAssetId / uri 三元映射里，
 * 不解析直接当台账 id 用会把有 OSS 记录的生成图误报「无 OSS 记录」（第121轮用户实测踩中）。 */
function targetFromLibraryAssetId(libId: string, name?: string): CheckTarget {
	if (LEDGER_ID_RE.test(libId)) return { id: libId, name }; // 本就是台账 id（拖入资产等场景）
	const asset = useLibraryStore.getState().assets[libId];
	if (asset) {
		if (asset.serverAssetId && LEDGER_ID_RE.test(asset.serverAssetId)) return { id: asset.serverAssetId, name: name || asset.name };
		const t = targetFromUri(asset.uri, name || asset.name);
		if (t) return t;
	}
	return { id: libId, name, noLedger: true }; // 库资产已删/无任何 OSS 线索 → 异常项如实报告
}

export function dedupById(targets: CheckTarget[]): CheckTarget[] {
	const seen = new Map<string, CheckTarget>();
	for (const t of targets) if (t.id && !seen.has(t.id)) seen.set(t.id, t);
	return [...seen.values()];
}

/** 画布节点：本节点结果资产（+历史）+ 全部素材（上游连线+自加）对应的台账资产 */
export function nodeCheckTargets(nodeId: string): CheckTarget[] {
	const node = useCanvasStore.getState().nodes[nodeId];
	if (!node) return [];
	const name = (typeof node.data.title === "string" && node.data.title) || node.type;
	const out: CheckTarget[] = [];
	// 结果资产（含历史）：resultAssetId 是库资产派生 id，须解析出真台账 id（serverAssetId/uri 反查）
	if (node.data.resultAssetId) out.push(targetFromLibraryAssetId(node.data.resultAssetId, name));
	for (const h of node.data.resultHistory ?? []) out.push(targetFromLibraryAssetId(h, name));
	for (const m of getNodeMaterialItems(nodeId)) {
		const t = targetFromUri(m.uri, m.name || m.tag);
		if (t) out.push(t);
	}
	return dedupById(out);
}

interface AssetEntityLike {
	name?: string;
	image?: string;
	images?: string[];
	variants?: Array<{ image?: string; label?: string; name?: string }>;
	/** 音色绑定（角色/五类均可选，voiceAssetId=台账 id、voiceUri=显示 uri） */
	voiceUri?: string;
	voiceAssetId?: string;
}

/** 单个资产实体（角色/场景/…）：主图 + 历史图 + 造型图 + 音色 对应的台账资产 */
export function assetEntityTargets(a: AssetEntityLike): CheckTarget[] {
	const out: CheckTarget[] = [];
	const push = (uri?: string, nm?: string) => {
		const t = targetFromUri(uri, nm || a.name);
		if (t) out.push(t);
	};
	push(a.image, a.name);
	for (const u of a.images ?? []) push(u, a.name);
	for (const v of a.variants ?? []) push(v.image, v.label || v.name || a.name);
	// 音色音频：voiceAssetId 优先（台账 id 直取），否则走 uri 反查
	if (a.voiceAssetId && LEDGER_ID_RE.test(a.voiceAssetId)) {
		out.push({ id: a.voiceAssetId, name: `${a.name}（音色）` });
	} else if (a.voiceUri) {
		const t = targetFromUri(a.voiceUri, `${a.name}（音色）`);
		if (t) out.push(t);
	}
	return dedupById(out);
}

/** 任意一组显示 uri（资产助手条目：主图 + 造型图） */
export function uriCheckTargets(entries: Array<{ uri?: string; name?: string }>): CheckTarget[] {
	const out: CheckTarget[] = [];
	for (const e of entries) {
		const t = targetFromUri(e.uri, e.name);
		if (t) out.push(t);
	}
	return dedupById(out);
}

/** 本项目全部资产（五类实体各自的主图/历史/造型） */
export function allProjectAssetTargets(): CheckTarget[] {
	const s = useProjectStore.getState();
	const arrays: AssetEntityLike[][] = [s.characters, s.scenes, s.items, s.organisms, s.crowds].map((a) => (a ?? []) as AssetEntityLike[]);
	return dedupById(arrays.flat().flatMap((a) => assetEntityTargets(a)));
}
