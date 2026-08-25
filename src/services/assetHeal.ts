/**
 * assetHeal —— 提交前的 OSS「死链自愈」入口：垫图/素材依赖的 OSS 直链若已失效，
 * 换用服务端当前链接；若云端对象真的丢了而本机存有副本，就把本地字节重传写回、反向修复云端。
 *
 * 触发点：ensurePublicUrl（发上游前把素材公网化的唯一入口）——正是死链会导致生成失败之处。
 * 恢复逻辑本身在 services/assetRecover（与手动「检查素材」共用同一份，勿在此另写一套）。
 *
 * ⚠ 第254轮两处修正（勿回退）：
 *  - 旧实现要求 `blob.localPath` 才肯往下走，把「探活拿到服务端新链接」这种**不需要本地副本**
 *    的分支也挡掉了（别人已桥接恢复过的资产，本机没副本就永远用不上新链）；
 *  - 旧 url 现在由 registerAssetBlob 归档进 `pastUrls`，因此换链后**旧 uri 仍能反查回本 blob**，
 *    项目里散落的历史 url 字符串一次性全部受益。
 */
import { useProjectStore } from "@/store/projectStore";
import { recoverAsset, recoveredUrlOf, LEDGER_ID_RE, _resetAliveCache, type RecoverDeps, type RecoverResult } from "@/services/assetRecover";

export { _resetAliveCache };

export interface HealDeps {
	blobByUri: (uri: string) => { id?: string } | undefined;
	recover: (id: string) => Promise<RecoverResult>;
}

const defaultDeps: HealDeps = {
	blobByUri: (uri) => useProjectStore.getState().blobByUri(uri),
	recover: (id) => recoverAsset(id, { cache: "session" }),
};

/**
 * 若 uri 指向台账资产，探活并返回**当前应当使用的链接**：
 *  - 存活且服务端 url 变过（旧桶桥接恢复 / 别人先恢复过）→ 换用新链（不需要本地副本）；
 *  - 死链且本机有副本 → 重传恢复后返回新链；
 *  - 其余情形（派生 id / 台账无记录 / 无副本可救）→ 原样返回，交由上游明确报错。
 */
export async function healPublicUrlIfDead(uri: string, deps: HealDeps = defaultDeps): Promise<string> {
	if (!uri) return uri;
	const id = deps.blobByUri(uri)?.id;
	if (!id || !LEDGER_ID_RE.test(id)) return uri;
	const r = await deps.recover(id);
	return recoveredUrlOf(r) ?? uri;
}

/** 供测试注入底层依赖（恢复例程的 deps 直通 assetRecover） */
export function healDepsFrom(recoverDeps: RecoverDeps): HealDeps {
	return {
		blobByUri: (uri) => useProjectStore.getState().blobByUri(uri),
		recover: (id) => recoverAsset(id, { cache: "session", deps: recoverDeps }),
	};
}
