/**
 * 引用上报（P1）——把「当前项目还在用哪些服务端资产」告诉管理端。
 *
 * 为什么必须有：服务端的保留策略是「被引用过的资产活得更久，从没被引用过的更早清理」。
 * 判断依据只有一个 —— `last_ref_at`，而它的唯一来源就是这里。**不报 = 服务端认为没人用 = 更早被清掉**。
 *
 * 上报时机：
 *  - 打开项目（一次，最完整的一次引用声明）
 *  - 保存项目（节流：同一项目至少间隔 REPORT_INTERVAL_MS 才再报一次）
 *    —— 自动保存很频繁，而保留策略的粒度是「天」，每次保存都报纯属浪费。
 *
 * 全程 fire-and-forget：网络失败/未登录一律静默，绝不拖慢或阻断打开/保存。
 */
import { managedClient } from "./managedClient";
import { useProjectStore } from "@/store/projectStore";

/** 同一项目两次上报的最小间隔（10 分钟）——保留策略按天算，再密没有意义 */
const REPORT_INTERVAL_MS = 10 * 60_000;

/** projectInstanceId → 上次上报时刻 */
const lastReportAt = new Map<string, number>();

/**
 * 当前项目引用到的服务端资产 id。
 * 取自三元映射 `assetBlobs` 的键——凡是经服务端生成或上传、并在本机注册过的资产都在里面。
 * 已知边界：仅存在于共享素材库、本机从未下载过的素材不在此列（它们由共享库自身的永久保留兜底）。
 */
function collectRefIds(): string[] {
	const blobs = useProjectStore.getState().assetBlobs || {};
	return Object.keys(blobs).filter(Boolean);
}

/**
 * 上报一次。`force=true` 跳过节流（打开项目用）。
 * 返回服务端认为需要走死链自愈的 id（已打墓碑或台账里没有）——调用方可忽略。
 */
export async function reportProjectAssetRefs(force = false): Promise<string[]> {
	try {
		const { projectInstanceId } = useProjectStore.getState();
		const key = projectInstanceId || "(none)";
		const now = Date.now();
		if (!force && now - (lastReportAt.get(key) ?? 0) < REPORT_INTERVAL_MS) return [];
		const ids = collectRefIds();
		if (!ids.length) return [];
		lastReportAt.set(key, now); // 先记时间：失败也不立刻重试，等下一个窗口
		return await managedClient.reportAssetRefs(ids);
	} catch {
		return [];
	}
}

/** 切换/关闭项目时清掉节流记录（下次打开立即可报） */
export function resetAssetRefThrottle(): void {
	lastReportAt.clear();
}
