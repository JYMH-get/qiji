/**
 * shotReindex —— 分镜「重排编号」纯函数单一来源（自 Frame161195.reindex / inferRun.reindex 收编，
 * 两处 + 实时剪辑工作台「补镜头」开关共用这一份，算法勿分叉）。
 *
 * 规则：普通镜号 1,2,3…；旧补镜头派生自上一个主镜，首镜无父则降为普通镜。
 * RTC 的显式父镜按 supplementParentId 找，supplementIndex 保留稳定后缀；先解析全部父镜，
 * 再统一分配后缀，避免父镜在后方或新旧补镜混用时串号。无效显式父保留原编号，绝不猜邻镜。
 * index 恒为数组序 1..n（含补镜头），id 与其余字段原样保留。
 */
import type { StoryboardShot } from "@/services/projectFile";

export function reindexShots(shots: StoryboardShot[]): StoryboardShot[] {
	const parents = resolveShotMainParents(shots);
	const mainNumbers = new Map<string, number>();
	for (const s of shots) if (parents.get(s.id) === s.id) mainNumbers.set(s.id, mainNumbers.size + 1);
	const used = new Map<string, Set<number>>();
	const ordinals = new Map<string, number>();
	// 稳定子号先占位，旧隐式补镜与缺少子号的新字段条目再分配空号。
	for (const s of shots) {
		const parent = parents.get(s.id);
		if (!s.isSupplement || !s.supplementParentId || !parent || parent === s.id || !validIndex(s.supplementIndex)) continue;
		const occupied = used.get(parent) ?? new Set<number>();
		if (!occupied.has(s.supplementIndex!)) { occupied.add(s.supplementIndex!); ordinals.set(s.id, s.supplementIndex!); }
		used.set(parent, occupied);
	}
	return shots.map((s, i) => {
		const parent = parents.get(s.id);
		if (!parent) return { ...s, index: i + 1 }; // 已绑定父被删/循环：保留历史，不悄悄改挂邻镜
		if (parent !== s.id) {
			const occupied = used.get(parent) ?? new Set<number>();
			let ordinal = ordinals.get(s.id);
			if (!ordinal) { ordinal = 1; while (occupied.has(ordinal)) ordinal++; occupied.add(ordinal); }
			used.set(parent, occupied);
			return { ...s, index: i + 1, title: `分镜${mainNumbers.get(parent)}-${ordinal}`,
				...(s.supplementParentId ? { supplementIndex: ordinal } : {}) };
		}
		// 表格旧开关只改 isSupplement；关闭时必须清绑定，防再次打开复活旧 RTC 归属。
		const { supplementParentId: _parent, supplementIndex: _ordinal, ...plain } = s;
		return { ...plain, index: i + 1, isSupplement: false, title: `分镜${mainNumbers.get(s.id)}` };
	});
}

/** 每镜所属主镜 ID（普通镜返回自己）；旧补镜按位置，显式绑定允许父镜在数组后面。 */
export function resolveShotMainParents(shots: StoryboardShot[]): ReadonlyMap<string, string | null> {
	const direct = new Map<string, string>();
	const byId = new Map(shots.map(s => [s.id, s]));
	let previousMain: string | undefined;
	for (const s of shots) {
		if (s.isSupplement && s.supplementParentId) direct.set(s.id, s.supplementParentId);
		else if (s.isSupplement && previousMain) direct.set(s.id, previousMain);
		else { direct.set(s.id, s.id); previousMain = s.id; }
	}
	const roots = new Map<string, string | null>();
	for (const s of shots) {
		const seen = new Set<string>();
		let id: string | undefined = s.id, root: string | null = null;
		while (id && !seen.has(id)) {
			seen.add(id);
			const parent = direct.get(id);
			if (parent === id) {
				// 显式自引用是坏绑定，不可把它伪装成普通镜。
				const entry = byId.get(id);
				root = entry?.isSupplement && entry.supplementParentId ? null : id;
				break;
			}
			id = parent;
		}
		roots.set(s.id, root);
	}
	return roots;
}

/** 新补镜取同父现有最大后缀 + 1，包含旧隐式补镜，避免混合项目重号。 */
export function nextSupplementIndex(shots: StoryboardShot[], parentId: string): number {
	const parents = resolveShotMainParents(shots);
	let max = 0;
	for (const s of reindexShots(shots)) {
		if (!s.isSupplement || (parents.get(s.id) !== parentId && s.supplementParentId !== parentId)) continue;
		const suffix = validIndex(s.supplementIndex) ? s.supplementIndex : Number(s.title.match(/^分镜\d+-(\d+)$/)?.[1]);
		if (validIndex(suffix)) max = Math.max(max, suffix);
	}
	return max + 1;
}

function validIndex(value: number | undefined): value is number { return Number.isSafeInteger(value) && (value ?? 0) > 0; }
