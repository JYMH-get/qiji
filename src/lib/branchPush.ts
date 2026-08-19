/**
 * branchPush —— 拖动节点(可多选)压到节点 B 时，把 B **连同同枝干节点**整体挤开（思维导图式让位，第100轮）。
 * 纯函数：只计算被挤节点的目标坐标；实时预览/回原位/松手提交由拖拽 hook 落地。
 *
 * 枝干语义（"同枝干 B0B1B2（上下游）"）：
 *   B 的全部下游子树 + 「所有下游都在枝干内」的**独占上游链**（如 文本→图→视频 流水线整行）；
 *   共享上游（一父多枝的裂变源）不动——挤一行不动主干。
 * 方向：压 B 最多的拖动矩形中心在 B 中心上方（或持平）→ 枝干下移让位（"多加一行"）；反之上移。
 * 多选：全部被压住的节点（可属不同枝干）逐个让位，方向整手势一致。
 * 级联：被挤的枝干若压到别的节点，按同方向继续挤该节点的枝干（有限轮次防环）。
 * 目标判定用**实际相交**（不含间距）——贴边不触发；让位后按 GAP 留间距。
 */

export interface PushRect {
	id: string;
	type: string;
	x: number;
	y: number;
	w?: number;
	h?: number;
	parentId?: string | null;
}

export interface PushEdge {
	source: string;
	target: string;
}

const DEFAULT_W = 240;
const DEFAULT_H = 200;
const GAP = 16;

const wOf = (n: { w?: number }) => n.w ?? DEFAULT_W;
const hOf = (n: { h?: number }) => n.h ?? DEFAULT_H;

/** 两矩形（各加 GAP 间距）是否过近（与拖拽避让 rectsTooClose 同尺） */
function tooClose(a: PushRect, b: PushRect): boolean {
	return (
		a.x < b.x + wOf(b) + GAP &&
		b.x < a.x + wOf(a) + GAP &&
		a.y < b.y + hOf(b) + GAP &&
		b.y < a.y + hOf(a) + GAP
	);
}

/**
 * 收集 rootId 的「同枝干」节点集：下游闭包 + 独占上游（其**全部**下游都已在集合内才纳入，
 * 反复松弛到不动点——保证共享上游/主干不被拖入）。
 */
export function collectBranch(rootId: string, edges: PushEdge[]): Set<string> {
	const down = new Map<string, string[]>();
	for (const e of edges) {
		if (e.source === e.target) continue;
		(down.get(e.source) ?? down.set(e.source, []).get(e.source)!).push(e.target);
	}
	const set = new Set<string>([rootId]);
	const q = [rootId];
	while (q.length) {
		const u = q.shift()!;
		for (const v of down.get(u) ?? []) {
			if (!set.has(v)) {
				set.add(v);
				q.push(v);
			}
		}
	}
	let grew = true;
	while (grew) {
		grew = false;
		for (const [u, vs] of down) {
			if (set.has(u)) continue;
			if (vs.length && vs.every((v) => set.has(v))) {
				set.add(u);
				grew = true;
			}
		}
	}
	return set;
}

export interface BranchPushResult {
	/** 被挤节点 id → 让位后的目标坐标 */
	moved: Map<string, { x: number; y: number }>;
	/** 主目标（被拖动矩形压得最多的节点） */
	targetId: string;
}

/**
 * 计算「拖动矩形(可多个=多选整组拖动)压到谁 → 谁的枝干挤到哪」。无压住任何节点（或主目标被
 * skipTarget 排除，如堆叠并入候选）时返回 null。nodes 传**原始坐标**（预览中的节点用其拖前
 * 坐标），保证同一拖动位置的计算结果稳定、拖走即可整体回原位。
 */
export function computeBranchPush(
	drags: { id: string; x: number; y: number; w?: number; h?: number }[],
	nodes: PushRect[],
	edges: PushEdge[],
	opts?: {
		skipTarget?: (n: PushRect) => boolean;
		/** 强制让位方向（1=下移 / -1=上移）；缺省按拖动矩形与主目标的中心关系判定。裂变落位挤开用恒向下。 */
		forceDir?: 1 | -1;
		/** 恒不动的节点（如裂变的父节点）——既不作目标也不被级联波及 */
		exclude?: Set<string>;
	},
): BranchPushResult | null {
	if (drags.length === 0) return null;
	const dragIds = new Set(drags.map((d) => d.id));
	// 可被挤开的对象：非分组容器、非分组子节点、非拖动者本身（工作副本，级联时就地更新 y）
	const movable = new Map<string, PushRect>();
	for (const n of nodes) {
		if (dragIds.has(n.id) || n.type === "group" || n.parentId || opts?.exclude?.has(n.id)) continue;
		movable.set(n.id, { ...n });
	}

	// 与全部拖动矩形的**实际相交面积**之和（真压上才算，贴边不挤）
	const overlapArea = (n: PushRect) => {
		let area = 0;
		for (const d of drags) {
			const ix = Math.min(d.x + wOf(d), n.x + wOf(n)) - Math.max(d.x, n.x);
			const iy = Math.min(d.y + hOf(d), n.y + hOf(n)) - Math.max(d.y, n.y);
			if (ix > 0 && iy > 0) area += ix * iy;
		}
		return area;
	};

	// 主目标：相交面积最大者
	let target: PushRect | null = null;
	let bestArea = 0;
	for (const n of movable.values()) {
		const area = overlapArea(n);
		if (area > bestArea) {
			bestArea = area;
			target = n;
		}
	}
	if (!target || opts?.skipTarget?.(target)) return null;

	// 方向按「压主目标最多的那个拖动矩形」与主目标中心比较（整个手势方向一致）；forceDir 显式覆盖
	let dirRect = drags[0];
	let dirArea = -1;
	for (const d of drags) {
		const ix = Math.min(d.x + wOf(d), target.x + wOf(target)) - Math.max(d.x, target.x);
		const iy = Math.min(d.y + hOf(d), target.y + hOf(target)) - Math.max(d.y, target.y);
		const a = ix > 0 && iy > 0 ? ix * iy : 0;
		if (a > dirArea) {
			dirArea = a;
			dirRect = d;
		}
	}
	const dir = opts?.forceDir ?? (dirRect.y + hOf(dirRect) / 2 <= target.y + hOf(target) / 2 ? 1 : -1);

	const moved = new Map<string, { x: number; y: number }>();
	// 每个被挤节点的累计 y 位移——级联「保距」用：受害者按推动者的累计位移平移，保留原有间距（不压到最小 GAP）
	const delta = new Map<string, number>();
	const branchCache = new Map<string, Set<string>>();
	const branchOf = (id: string) => {
		let b = branchCache.get(id);
		if (!b) {
			b = collectBranch(id, edges);
			branchCache.set(id, b);
		}
		return b;
	};
	const pushBranch = (rootId: string, dy: number) => {
		for (const id of branchOf(rootId)) {
			const n = movable.get(id);
			if (!n || moved.has(id)) continue; // 已被挤过的不再叠加（防环/防重复挤）
			n.y += dy;
			moved.set(id, { x: n.x, y: n.y });
			delta.set(id, (delta.get(id) ?? 0) + dy);
		}
	};
	// 级联再推：整枝干（含已让位成员）无条件再位移 dy——两条已让位枝干互相重叠时用它分开
	const pushBranchAgain = (rootId: string, dy: number) => {
		for (const id of branchOf(rootId)) {
			const n = movable.get(id);
			if (!n) continue;
			n.y += dy;
			moved.set(id, { x: n.x, y: n.y });
			delta.set(id, (delta.get(id) ?? 0) + dy);
		}
	};
	// 让节点 n 完全让出**所有**横向交叠（含 GAP）的拖动矩形（带 GAP 间距）
	const clearDy = (n: PushRect) => {
		let dy = 0;
		for (const d of drags) {
			if (!(d.x < n.x + wOf(n) + GAP && n.x < d.x + wOf(d) + GAP)) continue;
			const cand = dir > 0 ? d.y + hOf(d) + GAP - n.y : d.y - GAP - hOf(n) - n.y;
			dy = dir > 0 ? Math.max(dy, cand) : Math.min(dy, cand);
		}
		return dy;
	};

	// 首推 + 追加目标：主目标先让位；多选拖动可能同时压住多个节点（各属不同枝干）→
	// 仍与拖动矩形相交的未让位节点逐个挤开（有限轮次）
	pushBranch(target.id, clearDy(target));
	for (let round = 0; round < 8; round++) {
		let next: PushRect | null = null;
		let area = 0;
		for (const n of movable.values()) {
			if (moved.has(n.id) || opts?.skipTarget?.(n)) continue;
			const a = overlapArea(n);
			if (a > area) {
				area = a;
				next = n;
			}
		}
		if (!next) break;
		const dy = clearDy(next);
		if (!dy) break;
		pushBranch(next.id, dy);
	}

	// 级联：已让位节点若压到别的节点 → 后者的枝干按同方向继续让位（轮次上限防环）。
	// **保距**（第104轮修）：受害者按「推动者的累计位移」平移（`delta`），保留与推动者的原有间距——
	// 整条下游随插入的行**整体下移同一距离**，不再压到最小 GAP 挤成一团（用户反馈「新增一行导致其他
	// 节点挤在一起」）。同时兜底至少清出 GAP（原本挨得比 GAP 更近/重叠的才收敛到 GAP）：取二者更大的位移。
	// ⚠ 受害者**允许是已让位枝干**（pushBranchAgain 整枝干再推）——多选/大节点可能同时压住两行，主目标
	// 与追加目标会算出**相同坐标**（完全重叠=「节点丢失」假象，实测踩坑）；只跳过同枝干配对（空转）。
	for (let round = 0; round < 24; round++) {
		let hit: { victimId: string; dy: number; again: boolean } | null = null;
		outer: for (const mid of moved.keys()) {
			const mn = movable.get(mid)!;
			for (const n of movable.values()) {
				if (n.id === mid || !tooClose(mn, n)) continue;
				const isMoved = moved.has(n.id);
				if (isMoved && branchOf(n.id).has(mid)) continue; // 同枝干内部重叠：整枝再推分不开，跳过
				const clearGap = dir > 0 ? mn.y + hOf(mn) + GAP - n.y : mn.y - GAP - hOf(n) - n.y; // 清出 GAP 的最小位移
				const keepDist = delta.get(mid) ?? 0; // 保距：跟随推动者整体位移，保留原间距
				// 取「更大」的位移（下移取 max、上移取 min）：优先保距，原本比 GAP 更近的才收敛到 GAP
				const dy = dir > 0 ? Math.max(clearGap, keepDist) : Math.min(clearGap, keepDist);
				// 只顺推（同方向才算被压），避免把反方向的节点拽过来
				if (dir > 0 ? dy > 0 : dy < 0) {
					hit = { victimId: n.id, dy, again: isMoved };
					break outer;
				}
			}
		}
		if (!hit) break;
		(hit.again ? pushBranchAgain : pushBranch)(hit.victimId, hit.dy);
	}

	return { moved, targetId: target.id };
}

/**
 * 全局严格不重叠（「重叠」开关关闭时的硬约束，结构命令后由 commandBus 统一收口）：
 * 画布上任意两个顶层节点（非分组容器/非分组子节点）**实际相交**即冲突。
 * 裁决规则（用户定）：按**生成时间**——晚生成的（nodes 数组序=加入画布顺序）留在原位，
 * 早生成的连同**同枝干**向下让位到晚者下方（+GAP）；被挤枝干压到别人 → 多级级联
 * （每一步都严格向下、单调收敛，轮次上限兜底）。同枝干内部重叠只挪冲突节点自身（整枝推不开）。
 * 返回让位坐标（null=本就无重叠）。纯函数，不碰 store。
 */
export function enforceNoOverlap(
	nodes: PushRect[],
	edges: PushEdge[],
	maxRounds = 200,
): Map<string, { x: number; y: number }> | null {
	const tops: PushRect[] = [];
	const seq = new Map<string, number>();
	nodes.forEach((n, i) => {
		if (n.type === "group" || n.parentId) return;
		tops.push({ ...n });
		seq.set(n.id, i);
	});
	const byId = new Map(tops.map((n) => [n.id, n]));
	const intersects = (a: PushRect, b: PushRect) =>
		a.x < b.x + wOf(b) && b.x < a.x + wOf(a) && a.y < b.y + hOf(b) && b.y < a.y + hOf(a);
	const branchCache = new Map<string, Set<string>>();
	const branchOf = (id: string) => {
		let b = branchCache.get(id);
		if (!b) {
			b = collectBranch(id, edges);
			branchCache.set(id, b);
		}
		return b;
	};
	const moved = new Map<string, { x: number; y: number }>();
	for (let round = 0; round < maxRounds; round++) {
		let mover: PushRect | null = null;
		let keeper: PushRect | null = null;
		outer: for (let i = 0; i < tops.length; i++) {
			for (let j = i + 1; j < tops.length; j++) {
				const a = tops[i];
				const b = tops[j];
				if (!intersects(a, b)) continue;
				// 晚生成的留位（keeper），早生成的让位（mover）
				const aOlder = seq.get(a.id)! < seq.get(b.id)!;
				mover = aOlder ? a : b;
				keeper = aOlder ? b : a;
				break outer;
			}
		}
		if (!mover || !keeper) break;
		const dy = keeper.y + hOf(keeper) + GAP - mover.y; // 恒向下让到 keeper 下方（相交⇒dy>0，单调收敛）
		let branch = branchOf(mover.id);
		if (branch.has(keeper.id)) branch = new Set([mover.id]); // 同枝干重叠：整枝推不开，只挪冲突者
		for (const id of branch) {
			const n = byId.get(id);
			if (!n || id === keeper.id) continue;
			n.y += dy;
			moved.set(id, { x: n.x, y: n.y });
		}
	}
	return moved.size ? moved : null;
}
