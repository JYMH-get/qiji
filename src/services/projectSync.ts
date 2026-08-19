/**
 * projectSync —— 多窗口实时同步引擎（第205轮）：store 订阅 ↔ 窗口间广播的接线层。
 *
 * 发送侧（只广播自己的归属域，⚠ 勿改成广播整张 canvases 表——会把别的窗口正在编辑的画布
 * 用本窗口的陈旧快照盖掉）：
 *   - canvasStore 变化（节点/连线/分组/运行态）→ 去抖 250ms → 广播**激活画布**快照；
 *   - projectStore 共享字段（SHARED_PROJECT_FIELDS）引用变化 → 去抖 250ms → 广播字段补丁；
 *   - libraryStore.assets 变化 → 去抖广播媒体库；
 *   - 切换画布 → 立即广播**刚离开的画布**的最终快照（归属交接）；
 *   - 打开/切换项目 → hello 报到，写者回 full 全量镜像（磁盘载入可能落后写者内存 3s 去抖窗口）。
 *
 * 接收侧：same-project 消息才应用；应用期间置 applyingRemote 防回声（本窗口订阅回调跳过）。
 *   画布快照：正是我的激活画布 → 直写 canvasStore（含 runtime——另一窗口的「生成中」即时可见）；
 *   否则写 projectStore.canvases，runtime 存 remoteRuntimes，切过去时补挂。
 *   写者收到任何镜像都 scheduleAutoSave（唯一写盘方替全体落盘）。
 */
import { useProjectStore } from "@/store/projectStore";
import { useCanvasStore } from "@/store/canvasStore";
import { useLibraryStore } from "@/store/libraryStore";
import { sanitizeCanvas } from "@/nodes/nodeSpecs";
import {
	SHARED_PROJECT_FIELDS,
	diffByRef,
	pruneCanvasesToEpisodes,
	msgMatchesProject,
	type SyncMsg,
	type CanvasMsg,
} from "@/lib/projectSyncCore";
import {
	windowId,
	initWindowSync,
	broadcastSync,
	onSyncMessage,
	setSyncContext,
	isProjectWriter,
} from "./windowSync";
import { isPopout } from "@/popout/popout";

let inited = false;
/** 应用远端消息期间置位：本窗口的 store 订阅回调据此跳过（防回声/防广播风暴） */
let applyingRemote = false;

/** 其它窗口画布的节点运行态（非激活时暂存；切到该画布时补挂显示「生成中」） */
const remoteRuntimes = new Map<string, Record<string, unknown>>();

const DEBOUNCE_MS = 250;

function currentCanvasKey(): string {
	const ps = useProjectStore.getState();
	return ps.canvasEpisodeId && ps.episodes.some((e) => e.id === ps.canvasEpisodeId)
		? ps.canvasEpisodeId
		: (ps.episodes[0]?.id ?? "");
}

function projectPath(): string {
	return useProjectStore.getState().savePath ?? "";
}

function applyRemote(fn: () => void): void {
	applyingRemote = true;
	try { fn(); } finally { applyingRemote = false; }
}

/** 写者收到镜像后替全体落盘（非写者不写盘，见 projectStore.save 门禁） */
function writerAutoSave(): void {
	if (isProjectWriter()) useProjectStore.getState().scheduleAutoSave("canvas");
}

/* ────────────────────────── 发送侧 ────────────────────────── */

let canvasTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleCanvasBroadcast(): void {
	if (canvasTimer) return;
	canvasTimer = setTimeout(() => {
		canvasTimer = null;
		const path = projectPath();
		if (!path) return;
		const cs = useCanvasStore.getState();
		broadcastSync({
			type: "canvas",
			senderId: windowId,
			projectPath: path,
			canvasKey: currentCanvasKey(),
			nodes: cs.nodes as unknown as Record<string, unknown>,
			edges: cs.edges as unknown as Record<string, unknown>,
			groups: cs.groups as unknown as Record<string, unknown>,
			runtime: cs.runtime as unknown as Record<string, unknown>,
		});
	}, DEBOUNCE_MS);
}

const pendingFields = new Set<string>();
let fieldsTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleFieldsBroadcast(keys: string[]): void {
	for (const k of keys) pendingFields.add(k);
	if (fieldsTimer) return;
	fieldsTimer = setTimeout(() => {
		fieldsTimer = null;
		const path = projectPath();
		const keysNow = [...pendingFields];
		pendingFields.clear();
		if (!path || !keysNow.length) return;
		const ps = useProjectStore.getState() as unknown as Record<string, unknown>;
		const fields: Record<string, unknown> = {};
		for (const k of keysNow) fields[k] = ps[k]; // 发最新值（去抖窗口内多次改动合并）
		broadcastSync({ type: "fields", senderId: windowId, projectPath: path, fields });
	}, DEBOUNCE_MS);
}

let libraryTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleLibraryBroadcast(): void {
	if (libraryTimer) return;
	libraryTimer = setTimeout(() => {
		libraryTimer = null;
		const path = projectPath();
		if (!path) return;
		broadcastSync({
			type: "library",
			senderId: windowId,
			projectPath: path,
			assets: useLibraryStore.getState().assets as unknown as Record<string, unknown>,
		});
	}, DEBOUNCE_MS);
}

/** 归属交接：离开某画布时立即广播它的最终快照（switchCanvas 已把它快照进 canvases）。
 *  也供请求台账在「投递结果到非激活画布」后调用——让其它窗口的该画布快照一并收敛，
 *  防止别的窗口日后切到这块画布时用陈旧快照把投递结果盖掉。 */
export function broadcastCanvasSnapshot(canvasKey: string): void {
	const path = projectPath();
	if (!path || !canvasKey) return;
	const cv = useProjectStore.getState().canvases[canvasKey];
	if (!cv) return;
	broadcastSync({
		type: "canvas",
		senderId: windowId,
		projectPath: path,
		canvasKey,
		nodes: (cv.nodes ?? {}) as unknown as Record<string, unknown>,
		edges: (cv.edges ?? {}) as unknown as Record<string, unknown>,
		groups: (cv.groups ?? {}) as unknown as Record<string, unknown>,
		runtime: {},
	});
}

function sendHello(): void {
	const path = projectPath();
	if (!path) return;
	broadcastSync({ type: "hello", senderId: windowId, projectPath: path });
}

/* ────────────────────────── 接收侧 ────────────────────────── */

function handleMessage(msg: SyncMsg): void {
	const myPath = projectPath();
	if (!msgMatchesProject(msg, myPath)) return;
	const ps = useProjectStore.getState();
	if (ps.isProjectLoading) return; // 载入中不应用（载入完成后 hello/full 会重新对齐）

	switch (msg.type) {
		case "hello": {
			// 写者向新报到的同项目窗口回全量镜像（磁盘载入可能落后写者内存的 3s 去抖窗口）
			if (!isProjectWriter()) return;
			const cs = useCanvasStore.getState();
			const activeKey = currentCanvasKey();
			const canvases = {
				...ps.canvases,
				[activeKey]: { nodes: cs.nodes, edges: cs.edges, groups: cs.groups, viewport: cs.viewport },
			};
			const fields: Record<string, unknown> = {};
			const psAny = ps as unknown as Record<string, unknown>;
			for (const k of SHARED_PROJECT_FIELDS) fields[k] = psAny[k];
			broadcastSync({
				type: "full",
				senderId: windowId,
				projectPath: myPath,
				targetId: msg.senderId,
				fields,
				canvases: canvases as unknown as Record<string, unknown>,
				library: useLibraryStore.getState().assets as unknown as Record<string, unknown>,
				runtimes: { [activeKey]: cs.runtime as unknown as Record<string, unknown> },
			});
			return;
		}
		case "full": {
			if (msg.targetId !== windowId) return;
			applyRemote(() => {
				const canvases = msg.canvases as unknown as typeof ps.canvases;
				useProjectStore.setState({ ...(msg.fields as object), canvases } as never);
				useLibraryStore.setState({ assets: msg.library as never });
				for (const [k, rt] of Object.entries(msg.runtimes ?? {})) remoteRuntimes.set(k, rt);
				// 我的激活画布若在镜像里：以写者版本为准重载（sanitize 同 switchCanvas 规矩）
				const myKey = currentCanvasKey();
				const mine = canvases[myKey];
				if (mine) {
					const cleaned = sanitizeCanvas(mine.nodes || {}, mine.edges || {}, mine.groups || {});
					useCanvasStore.setState({
						nodes: cleaned.nodes, edges: cleaned.edges, groups: cleaned.groups,
						runtime: (remoteRuntimes.get(myKey) ?? {}) as never,
					});
				}
			});
			return;
		}
		case "fields": {
			applyRemote(() => {
				const patch: Record<string, unknown> = { ...msg.fields };
				// 分集被删：画布快照表同步剔除（防写者把已删分集的画布写回文件）
				if (Array.isArray(patch.episodes)) {
					const ids = (patch.episodes as Array<{ id: string }>).map((e) => e.id);
					patch.canvases = pruneCanvasesToEpisodes(useProjectStore.getState().canvases, ids, currentCanvasKey());
				}
				useProjectStore.setState(patch as never);
			});
			writerAutoSave();
			return;
		}
		case "canvas": {
			applyCanvasMsg(msg);
			writerAutoSave();
			return;
		}
		case "library": {
			applyRemote(() => useLibraryStore.setState({ assets: msg.assets as never }));
			writerAutoSave();
			return;
		}
		case "save-request": {
			if (isProjectWriter()) void useProjectStore.getState().save(true);
			return;
		}
	}
}

function applyCanvasMsg(msg: CanvasMsg): void {
	applyRemote(() => {
		const myKey = currentCanvasKey();
		if (msg.canvasKey === myKey) {
			// 正在看的就是这块画布：直写实时层（含 runtime——对方窗口的「生成中」即时可见）。
			// viewport/undo 栈保留本窗口自己的。
			useCanvasStore.setState({
				nodes: msg.nodes as never,
				edges: msg.edges as never,
				groups: msg.groups as never,
				runtime: msg.runtime as never,
			});
			return;
		}
		const ps = useProjectStore.getState();
		const prev = ps.canvases[msg.canvasKey];
		useProjectStore.setState({
			canvases: {
				...ps.canvases,
				[msg.canvasKey]: {
					nodes: msg.nodes as never,
					edges: msg.edges as never,
					groups: msg.groups as never,
					viewport: prev?.viewport,
				},
			},
		});
		remoteRuntimes.set(msg.canvasKey, msg.runtime);
	});
}

/* ────────────────────────── 初始化 ────────────────────────── */

/** 登录后调用（幂等）；弹出窗口（popout 只读视图）不参与同步 */
export function initProjectSync(): void {
	if (inited || isPopout()) return;
	inited = true;
	void initWindowSync().then(() => {
		setSyncContext({ projectPath: projectPath(), activeCanvasKey: currentCanvasKey() });
		sendHello(); // 项目已先于本初始化载入（启动自动恢复）时也能报到
	});
	onSyncMessage(handleMessage);

	// projectStore：共享字段 diff 广播 + 项目/画布切换的报到与归属交接
	let prevPs = useProjectStore.getState();
	useProjectStore.subscribe((next) => {
		const prev = prevPs;
		prevPs = next;
		if (applyingRemote || next.isProjectLoading) return;
		if (next.savePath !== prev.savePath) {
			// 打开/切换/另存项目：更新上下文并向同项目窗口报到（写者会回 full）
			setSyncContext({ projectPath: next.savePath ?? "", activeCanvasKey: currentCanvasKey() });
			sendHello();
			return; // 换项目瞬间的字段变化属载入内容，不作为增量广播
		}
		if (next.canvasEpisodeId !== prev.canvasEpisodeId) {
			// 切画布：广播刚离开画布的最终快照（归属交接）+ 给新画布补挂远端运行态
			const prevKey = prev.canvasEpisodeId && prev.episodes.some((e) => e.id === prev.canvasEpisodeId)
				? prev.canvasEpisodeId
				: (prev.episodes[0]?.id ?? "");
			broadcastCanvasSnapshot(prevKey);
			const newKey = currentCanvasKey();
			setSyncContext({ activeCanvasKey: newKey });
			const rt = remoteRuntimes.get(newKey);
			if (rt && Object.keys(rt).length) {
				applyRemote(() => useCanvasStore.setState({ runtime: rt as never }));
			}
		}
		const changed = diffByRef(
			prev as unknown as Record<string, unknown>,
			next as unknown as Record<string, unknown>,
			SHARED_PROJECT_FIELDS,
		);
		if (changed.length) scheduleFieldsBroadcast(changed);
	});

	// canvasStore：激活画布内容/运行态变化 → 去抖广播快照（viewport/undo 不参与）
	let prevCs = useCanvasStore.getState();
	useCanvasStore.subscribe((next) => {
		const prev = prevCs;
		prevCs = next;
		if (applyingRemote || useProjectStore.getState().isProjectLoading) return;
		if (next.nodes !== prev.nodes || next.edges !== prev.edges || next.groups !== prev.groups || next.runtime !== prev.runtime) {
			scheduleCanvasBroadcast();
		}
	});

	// libraryStore：媒体库镜像
	let prevLib = useLibraryStore.getState();
	useLibraryStore.subscribe((next) => {
		const prev = prevLib;
		prevLib = next;
		if (applyingRemote) return;
		if (next.assets !== prev.assets) scheduleLibraryBroadcast();
	});
}

/** 非写者窗口的手动保存：请求写者落盘（projectStore.save 门禁调用） */
export function requestWriterSave(): void {
	const path = projectPath();
	if (!path) return;
	broadcastSync({ type: "save-request", senderId: windowId, projectPath: path });
}
