/**
 * shotReindex —— 分镜「重排编号」纯函数单一来源（自 Frame161195.reindex / inferRun.reindex 收编，
 * 两处 + 实时剪辑工作台「补镜头」开关共用这一份，算法勿分叉）。
 *
 * 规则：普通镜号 1,2,3…；补镜头(isSupplement)派生自上一个主镜号 → 「分镜3-1、3-2…」；
 * 首镜为补镜头（前面没有主镜可派生）则降级为主镜（isSupplement 清 false）。
 * index 恒为数组序 1..n（含补镜头），id 与其余字段原样保留。
 */
import type { StoryboardShot } from "@/services/projectFile";

export function reindexShots(shots: StoryboardShot[]): StoryboardShot[] {
	let base = 0, sub = 0;
	return shots.map((s, i) => {
		if (s.isSupplement && base > 0) {
			sub += 1;
			return { ...s, index: i + 1, title: `分镜${base}-${sub}` };
		}
		base += 1; sub = 0;
		return { ...s, index: i + 1, isSupplement: false, title: `分镜${base}` };
	});
}
