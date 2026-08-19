/**
 * mindmapLayout —— 画布"整理"用的思维导图布局（纯函数，无 store/DOM 依赖）。
 *
 * 形态：**主干居中、分支散开**。
 * - 横向(列)：按节点在 DAG 中的「深度」(到根的最长路径)分列，主干水平向右延伸；
 *   **列宽 = 该列最大节点宽度**（宽节点不会探进下一列）。
 * - 纵向(行)：R-T tidy-tree 简化版——叶子按**实际高度**依次占位、父节点纵向居中于其子节点；
 *   故单链=一条居中直线，分叉(如智能推理裂变出多卡)时子树上下散开、父节点居中其间。
 *
 * 不重合保证（第100轮）：节点按「左上/右下」两个坐标（即实际 w/h）占位，而非固定行列步长——
 * 高矮不一的节点不再因只看起始坐标而叠在一起；末尾再做一次同列扫描兜底（父居中钳位后的残留）。
 *
 * 最短连线规则（第121轮）：
 * - 级别逆向传导——有下游的节点右靠贴近消费者（列=min(下游列)-1），额外素材源不再被甩到第 0 列；
 * - 额外素材源（入度 0、无树子、有下游）绕其下游纵向居中附着；
 * - 同类型多分支除外：≥3 个同级图像叶子仍排两行方格（资产拆分场景，不做最短连线）。
 *
 * 入参：nodes(应已排除分组子节点；分组容器可作为普通大节点参与——按映射边连入族群) + edges(source→target)。
 * 返回：每个节点的新坐标(布局原点在 0 附近)；调用方再整体平移/fitView 居中到视口。
 * 整理总入口在 tidyLayout.ts（族群划分+拼图打包），本函数负责单个族群内部布局。
 */
import type { CanvasNode, CanvasEdge } from "@/types";

const DEFAULT_W = 240;
const DEFAULT_H = 200;

export interface MindmapResult {
	id: string;
	x: number;
	y: number;
}

export function mindmapLayout(
	nodes: CanvasNode[],
	edges: CanvasEdge[],
	opts?: { colGap?: number; rowGap?: number },
): MindmapResult[] {
	if (nodes.length === 0) return [];
	const COLGAP = opts?.colGap ?? 140; // 列间距（列宽按各列实际最大宽度另算）
	const ROWGAP = opts?.rowGap ?? 48;  // 纵向节点间距

	const ids = new Set(nodes.map((n) => n.id));
	const byId = new Map(nodes.map((n) => [n.id, n] as const));
	const wOf = (id: string) => byId.get(id)?.w ?? DEFAULT_W;
	const hOf = (id: string) => byId.get(id)?.h ?? DEFAULT_H;

	// ── 同级变体边：u→v 且两者有**共同父** w（w→u 与 w→v 均存在）→ 该边不参与分层/树形。
	// 资产拆分裂变的「主体→变体」连线语义是垫图参考——整理时变体仍按同级图片排（不右移一列），
	// 只影响排序：变体紧跟主体之后（variantAfter）。处理链（图像超分 图→图）无共同父，不受影响。
	const rawParents = new Map<string, Set<string>>();
	for (const e of edges) {
		if (!ids.has(e.source) || !ids.has(e.target) || e.source === e.target) continue;
		(rawParents.get(e.target) ?? rawParents.set(e.target, new Set()).get(e.target)!).add(e.source);
	}
	const variantAfter = new Map<string, string>(); // 变体 → 主体
	const layoutEdges = edges.filter((e) => {
		if (!ids.has(e.source) || !ids.has(e.target) || e.source === e.target) return true; // 无效边由后续构建自然跳过
		const pu = rawParents.get(e.source);
		const pv = rawParents.get(e.target)!;
		if (!pu) return true;
		for (const w of pv) {
			if (w !== e.source && pu.has(w)) {
				variantAfter.set(e.target, e.source);
				return false;
			}
		}
		return true;
	});

	const children = new Map<string, string[]>();
	const parents = new Map<string, string[]>();
	const indeg = new Map<string, number>();
	for (const n of nodes) { children.set(n.id, []); parents.set(n.id, []); indeg.set(n.id, 0); }
	for (const e of layoutEdges) {
		if (!ids.has(e.source) || !ids.has(e.target) || e.source === e.target) continue;
		children.get(e.source)!.push(e.target);
		parents.get(e.target)!.push(e.source);
		indeg.set(e.target, (indeg.get(e.target) || 0) + 1);
	}

	// ── 列：深度 = 到根的最长路径（Kahn 拓扑 + 松弛；环残留按 0 兜底）──
	const roots = nodes.filter((n) => (indeg.get(n.id) || 0) === 0).map((n) => n.id);
	const depth = new Map<string, number>();
	for (const id of ids) depth.set(id, 0);
	const indegCopy = new Map(indeg);
	const queue = [...roots];
	const topo: string[] = [];
	while (queue.length) {
		const u = queue.shift()!;
		topo.push(u);
		for (const v of children.get(u) || []) {
			const d = (indegCopy.get(v) || 0) - 1;
			indegCopy.set(v, d);
			if (d === 0) queue.push(v);
		}
	}
	for (const u of topo) {
		const du = depth.get(u) || 0;
		for (const v of children.get(u) || []) depth.set(v, Math.max(depth.get(v) || 0, du + 1));
	}
	// ── 级别逆向传导（第121轮，最短连线规则）：有下游的节点尽量右靠、贴近其消费者
	// （列 = min(下游列)-1，只增不减，绝不越过下游）。典型：无上游的额外素材节点 B 连给
	// 级别 5 的节点 → B 属级别 4（贴在下游左侧一列，不再被甩到第 0 列当"根"）；
	// 纯源支流 B→C→X 沿链整体右贴。反向拓扑序传播；主干每列连续、不受影响。
	for (let i = topo.length - 1; i >= 0; i--) {
		const u = topo[i];
		const ch = children.get(u) || [];
		if (!ch.length) continue;
		let m = Infinity;
		for (const v of ch) m = Math.min(m, depth.get(v) || 0);
		if (m - 1 > (depth.get(u) || 0)) depth.set(u, m - 1);
	}

	// ── 行：tidy-tree。多父取「列差 1 的父」优先、否则首个父，构造生成树纵向布局 ──
	const treeChildren = new Map<string, string[]>();
	for (const n of nodes) treeChildren.set(n.id, []);
	for (const n of nodes) {
		const ps = parents.get(n.id) || [];
		if (!ps.length) continue;
		const dn = depth.get(n.id) || 0;
		const primary = ps.find((p) => (depth.get(p) || 0) === dn - 1) ?? ps[0];
		treeChildren.get(primary)!.push(n.id);
	}
	// 子节点按原始 y 排序，尽量保留用户原有上下顺序、减少连线交叉
	for (const list of treeChildren.values()) {
		list.sort((a, b) => (byId.get(a)?.y ?? 0) - (byId.get(b)?.y ?? 0));
	}
	// 变体紧跟主体：同一父下，带「主体→变体」边的子项重排到其主体之后（保持各自相对顺序）
	if (variantAfter.size) {
		for (const [pid, list] of treeChildren) {
			const inList = new Set(list);
			const isMoved = (id: string) => {
				const b = variantAfter.get(id);
				return !!b && inList.has(b);
			};
			if (!list.some(isMoved)) continue;
			const outList: string[] = [];
			for (const id of list) {
				if (isMoved(id)) continue;
				outList.push(id);
				for (const v of list) if (isMoved(v) && variantAfter.get(v) === id) outList.push(v);
			}
			for (const v of list) if (!outList.includes(v)) outList.push(v); // 兜底（主体缺失等异常）
			treeChildren.set(pid, outList);
		}
	}

	const yTop = new Map<string, number>();          // 节点顶边 y（像素）
	const colExtra = new Map<string, number>();      // 网格簇：相对所在列的额外列偏移
	const visited = new Set<string>();
	let cursor = 0;                                   // 纵向像素游标（下一个空位的顶边）
	// 图像叶子：同级生成图片节点(无下游)——整理时排成方格而非竖排长列
	const isImageLeaf = (id: string) =>
		byId.get(id)?.type === "image.gen" && (treeChildren.get(id)?.length ?? 0) === 0;
	// 孤岛节点：无任何连线(无上游也无下游)——大量时同类型排成方格(最多两行)，参考同级图片处理
	const isIsland = (id: string) =>
		(parents.get(id)?.length ?? 0) === 0 && (children.get(id)?.length ?? 0) === 0;
	// 同级图像方格 / 孤岛方格共用的网格排布：最多两行、行优先填充；行高 = 该行最大节点高度
	const layoutGrid = (group: string[], base: number) => {
		const cols = Math.ceil(group.length / 2);
		const row0 = group.slice(0, cols);
		const row1 = group.slice(cols);
		const h0 = Math.max(...row0.map(hOf));
		row0.forEach((cid, i) => { visited.add(cid); colExtra.set(cid, i); yTop.set(cid, base); });
		row1.forEach((cid, i) => { visited.add(cid); colExtra.set(cid, i); yTop.set(cid, base + h0 + ROWGAP); });
		const h1 = row1.length ? Math.max(...row1.map(hOf)) : 0;
		return base + h0 + (row1.length ? ROWGAP + h1 : 0) + ROWGAP;
	};
	const dfs = (id: string) => {
		if (visited.has(id)) return;
		visited.add(id);
		const ch = treeChildren.get(id) || [];
		if (!ch.length) { yTop.set(id, cursor); cursor += hOf(id) + ROWGAP; return; }
		const subtreeStart = cursor;
		// 方格簇：≥3 个同级图像叶子 → 最多两行、不限列(行优先填充)；父节点纵向居中于两行
		if (ch.length >= 3 && ch.every(isImageLeaf)) {
			cursor = layoutGrid(ch, subtreeStart);
		} else {
			for (const c of ch) dfs(c);
		}
		// 父节点：垂直居中于子节点占用带（按子节点真实高度求带宽）
		const laid = ch.filter((c) => yTop.get(c) !== undefined);
		if (!laid.length) { yTop.set(id, cursor); cursor += hOf(id) + ROWGAP; return; }
		const bandTop = Math.min(...laid.map((c) => yTop.get(c)!));
		const bandBottom = Math.max(...laid.map((c) => yTop.get(c)! + hOf(c)));
		let top = (bandTop + bandBottom) / 2 - hOf(id) / 2;
		// 高个子父节点（自身高于子树带）：不向上越过子树带起点侵占上一兄弟，向下则推进游标
		if (top < subtreeStart) top = subtreeStart;
		yTop.set(id, top);
		cursor = Math.max(cursor, top + hOf(id) + ROWGAP);
	};
	// ── 额外素材源（第121轮，最短连线规则）：入度 0、没领到树子、但有下游的节点
	// （典型=额外垫图素材，10 个 1 级连 1 个 2 级时除首节点外的其余 9 个源）——
	// 不当根做 DFS（否则按游标顺排、离其消费者很远），主树布局完后贴其下游附着：
	// 同一下游的源群绕该下游纵向居中；与主树同列的碰撞交给末尾同列扫描兜底下推。
	const attachSet = new Set<string>();
	for (const n of nodes) {
		if (
			(parents.get(n.id)?.length ?? 0) === 0 &&
			(children.get(n.id)?.length ?? 0) > 0 &&
			(treeChildren.get(n.id)?.length ?? 0) === 0
		) attachSet.add(n.id);
	}

	// 根优先(按原始 y 稳定排序)。孤岛节点(无连线)单独抽出，按类型分组排成方格、不混入树形 DFS。
	const rootOrder = (roots.length ? roots : nodes.map((n) => n.id))
		.slice()
		.sort((a, b) => (byId.get(a)?.y ?? 0) - (byId.get(b)?.y ?? 0));
	for (const r of rootOrder) if (!isIsland(r) && !attachSet.has(r)) dfs(r);

	// 兜底任何未访问(环)节点（孤岛与附着源除外——孤岛走下面的绝对定位铺排）
	for (const n of nodes) if (!visited.has(n.id) && !isIsland(n.id) && !attachSet.has(n.id)) dfs(n.id);

	// 附着源落位：绕其（已布局的）第一个下游纵向居中
	if (attachSet.size) {
		const byTarget = new Map<string, string[]>();
		for (const id of attachSet) {
			const chList = children.get(id) || [];
			const t = chList.find((c) => yTop.has(c)) ?? chList[0];
			(byTarget.get(t) ?? byTarget.set(t, []).get(t)!).push(id);
		}
		for (const [t, grp] of byTarget) {
			grp.sort((a, b) => (byId.get(a)?.y ?? 0) - (byId.get(b)?.y ?? 0));
			const total = grp.reduce((s, id) => s + hOf(id), 0) + ROWGAP * (grp.length - 1);
			const tTop = yTop.get(t);
			let cur = tTop !== undefined ? tTop + hOf(t) / 2 - total / 2 : cursor;
			for (const id of grp) {
				visited.add(id);
				yTop.set(id, cur);
				cur += hOf(id) + ROWGAP;
			}
			if (tTop === undefined) cursor = cur; // 兜底：下游未布局(异常环)时按游标顺排
		}
	}

	// ── 横向（树/分组场地）：列宽 = 该列最大节点宽度，x = 前缀和（宽节点不探入下一列）──
	const colOf = (id: string) => (depth.get(id) || 0) + (colExtra.get(id) || 0);
	const laidIds = nodes.map((n) => n.id).filter((id) => yTop.has(id));
	let maxCol = 0;
	for (const id of laidIds) maxCol = Math.max(maxCol, colOf(id));
	const colW: number[] = new Array(maxCol + 1).fill(DEFAULT_W);
	for (const id of laidIds) {
		const c = colOf(id);
		colW[c] = Math.max(colW[c], wOf(id));
	}
	const colX: number[] = new Array(maxCol + 1).fill(0);
	for (let c = 1; c <= maxCol; c++) colX[c] = colX[c - 1] + colW[c - 1] + COLGAP;

	// ── 兜底防重合：同列按 y 扫描，矩形相交（含间距）者顺次下推 ──
	// （父居中/钳位极端组合仍可能残留同列相交；不同列因列宽=最大宽度天然不相交）
	const byCol = new Map<number, string[]>();
	for (const id of laidIds) {
		const c = colOf(id);
		(byCol.get(c) ?? byCol.set(c, []).get(c)!).push(id);
	}
	for (const list of byCol.values()) {
		list.sort((a, b) => (yTop.get(a) ?? 0) - (yTop.get(b) ?? 0));
		let bottom = Number.NEGATIVE_INFINITY;
		for (const id of list) {
			let t = yTop.get(id) ?? 0;
			if (bottom !== Number.NEGATIVE_INFINITY && t < bottom + ROWGAP) {
				t = bottom + ROWGAP;
				yTop.set(id, t);
			}
			bottom = Math.max(bottom, t + hOf(id));
		}
	}
	// 树/分组场地实际占位（孤岛铺排的基准）
	let treeBottom = 0;
	let fieldRight = 0;
	for (const id of laidIds) {
		treeBottom = Math.max(treeBottom, (yTop.get(id) ?? 0) + hOf(id));
		fieldRight = Math.max(fieldRight, (colX[colOf(id)] ?? 0) + wOf(id));
	}

	// ── 孤岛节点：**簇打包**（不再一路竖排把整体越排越高）──
	// 每个类型一簇（≥3 排成最多两行的方格、否则簇内竖排），簇序按原始 y（尽量保持用户上下次序）；
	// 铺法：树场地不偏高时先接在其下方竖排，列高超过 targetH（≈让整体接近方形）就到右侧另起一列；
	// 树场地本就偏高（高≥宽）时孤岛直接铺右侧，不再垫高。
	const absPos = new Map<string, { x: number; y: number }>();
	const islandIds = nodes
		.map((n) => n.id)
		.filter((id) => isIsland(id) && !visited.has(id))
		.sort((a, b) => (byId.get(a)?.y ?? 0) - (byId.get(b)?.y ?? 0));
	if (islandIds.length) {
		const islandByType = new Map<string, string[]>();
		for (const id of islandIds) {
			const t = byId.get(id)?.type ?? "";
			(islandByType.get(t) ?? islandByType.set(t, []).get(t)!).push(id);
		}
		interface Cluster { cells: { id: string; dx: number; dy: number }[]; w: number; h: number }
		const buildCluster = (grp: string[], grid: boolean): Cluster => {
			if (!grid) {
				let y = 0;
				let w = 0;
				const cells = grp.map((id) => {
					const cell = { id, dx: 0, dy: y };
					y += hOf(id) + ROWGAP;
					w = Math.max(w, wOf(id));
					return cell;
				});
				return { cells, w, h: Math.max(0, y - ROWGAP) };
			}
			// 方格：最多两行、行优先填充；列宽=该列最大宽、行高=该行最大高
			const cols = Math.ceil(grp.length / 2);
			const colWs: number[] = new Array(cols).fill(0);
			grp.forEach((id, i) => {
				const c = i % cols;
				colWs[c] = Math.max(colWs[c], wOf(id));
			});
			const colXs: number[] = new Array(cols).fill(0);
			for (let c = 1; c < cols; c++) colXs[c] = colXs[c - 1] + colWs[c - 1] + COLGAP;
			const row0 = grp.slice(0, cols);
			const row1 = grp.slice(cols);
			const h0 = Math.max(...row0.map(hOf));
			const cells = [
				...row0.map((id, i) => ({ id, dx: colXs[i], dy: 0 })),
				...row1.map((id, i) => ({ id, dx: colXs[i], dy: h0 + ROWGAP })),
			];
			const h1 = row1.length ? Math.max(...row1.map(hOf)) : 0;
			return { cells, w: colXs[cols - 1] + colWs[cols - 1], h: h0 + (row1.length ? ROWGAP + h1 : 0) };
		};
		const clusters: Cluster[] = [];
		for (const [t, grp] of islandByType) {
			clusters.push(buildCluster(grp, t !== "group" && grp.length >= 3));
		}
		const areaSum = clusters.reduce((s, c) => s + (c.w + COLGAP) * (c.h + ROWGAP), 0);
		const targetH = Math.max(treeBottom, Math.ceil(Math.sqrt(areaSum)));
		let px: number;
		let py: number;
		let colStart: number;
		if (treeBottom > 0 && treeBottom >= fieldRight) {
			// 树场地已偏高 → 孤岛从右侧顶部开始铺
			px = fieldRight > 0 ? fieldRight + COLGAP : 0;
			py = 0;
			colStart = 0;
		} else {
			// 先接在树场地下方（无树时即从原点开始）
			px = 0;
			py = treeBottom > 0 ? treeBottom + ROWGAP : 0;
			colStart = py;
		}
		let colWmax = 0;
		for (const cl of clusters) {
			if (py > colStart && py + cl.h > targetH) {
				// 本列放不下 → 右侧另起一列（从顶部排）
				px = fieldRight + COLGAP;
				py = 0;
				colStart = 0;
				colWmax = 0;
			}
			for (const cell of cl.cells) {
				visited.add(cell.id);
				absPos.set(cell.id, { x: px + cell.dx, y: py + cell.dy });
			}
			py += cl.h + ROWGAP;
			colWmax = Math.max(colWmax, cl.w);
			fieldRight = Math.max(fieldRight, px + colWmax);
		}
	}

	return nodes.map((n) => {
		const abs = absPos.get(n.id);
		return abs
			? { id: n.id, x: abs.x, y: abs.y }
			: { id: n.id, x: colX[colOf(n.id)] ?? 0, y: yTop.get(n.id) || 0 };
	});
}
