import { useCanvasStore } from "@/store/canvasStore";
import { useUiStore } from "@/store/uiStore";
import { enforceNoOverlap } from "@/lib/branchPush";
import { isNodeDragging } from "@/canvas/interaction";
import type { Command, CommandType } from "./commands";
import { AGENT_AUTO_ALLOWED, STRUCTURAL_COMMANDS } from "./commands";

export type CommandSource = "gui" | "copilot" | "agent";

export interface DispatchContext {
	source: CommandSource;
	/** Agent 是否处于错峰自动模式（仅允许 white名单命令） */
	agentAutoMode?: boolean;
}

export type CommandHandler = (command: Command, ctx: DispatchContext) => void;

/**
 * 会改变节点几何（位置/尺寸/新增）的结构命令——执行后跑「严格不重叠」收口。
 * undo/redo 不在列（恢复的是历史快照，不得再改写）；updateNodeParams 等非几何命令不扫（省 O(n²)）。
 */
const GEOMETRY_COMMANDS: ReadonlySet<CommandType> = new Set<CommandType>([
	"addNode",
	"updateNodePosition",
	"resizeNode",
	"pasteNodes",
	"insertOnEdge",
	"burstScript",
	"spawnNodes",
	"ungroup",
	"createShotGroup",
	"dissolveShotGroup",
	"extractShotGroupItem",
	"mergeTextNodes",
]);

/**
 * 同源指令核心：GUI / Copilot / Agent 三入口都汇聚到这里。
 * - 结构命令 → 进入撤销栈（由 store 历史中间件处理）。
 * - Agent 自动模式 → 仅放行白名单命令。
 * - 几何命令收尾 → 「重叠」开关关闭时强制全画布不重叠（enforceNoOverlap，随本命令一次撤销）。
 */
export class CommandBus {
	private handlers = new Map<CommandType, CommandHandler[]>();

	register(type: CommandType, handler: CommandHandler): () => void {
		const list = this.handlers.get(type) ?? [];
		list.push(handler);
		this.handlers.set(type, list);
		return () => {
			this.handlers.set(
				type,
				(this.handlers.get(type) ?? []).filter((h) => h !== handler),
			);
		};
	}

	dispatch(command: Command, ctx: DispatchContext): void {
		if (ctx.agentAutoMode && !AGENT_AUTO_ALLOWED.has(command.type)) {
			throw new Error(
				`[CommandBus] 错峰自动模式禁止结构命令: ${command.type}（仅允许 ${[...AGENT_AUTO_ALLOWED].join(", ")}）`,
			);
		}

		// 结构命令执行前，将当前状态推入历史栈
		if (this.isStructural(command.type)) {
			useCanvasStore.getState().pushHistory();
		}

		const handlers = this.handlers.get(command.type) ?? [];
		if (handlers.length === 0) {
			console.warn(`[CommandBus] 未注册的命令处理器: ${command.type}`);
		}
		for (const handler of handlers) handler(command, ctx);

		// 严格不重叠收口（用户定：不开「重叠」时整个画布不允许任何重叠）：几何命令落地后，
		// 若仍存在相交 → 按生成时间裁决（晚者留位、早者同枝干向下让位、多级级联）。
		// 历史快照已在命令前压栈 → 收口移动与命令本体**一次撤销**整体回退。
		// 拖拽进行中跳过（ALT 拖动复制的 pasteNodes 发生在拖拽起步，克隆与原节点瞬时重叠是预期，
		// 拖拽收尾的 updateNodePosition 会再收口）。
		const st0 = useCanvasStore.getState();
		if (
			GEOMETRY_COMMANDS.has(command.type) &&
			st0?.nodes &&
			!useUiStore.getState().allowOverlap &&
			!isNodeDragging()
		) {
			const s = st0;
			const moves = enforceNoOverlap(
				Object.values(s.nodes).map((n) => ({
					id: n.id,
					type: n.type,
					x: n.x,
					y: n.y,
					w: n.w,
					h: n.h,
					parentId: n.parentId,
				})),
				Object.values(s.edges ?? {}),
			);
			if (moves) {
				const nodes = { ...useCanvasStore.getState().nodes };
				let changed = false;
				for (const [id, p] of moves) {
					const n = nodes[id];
					if (n) {
						nodes[id] = { ...n, x: Math.round(p.x), y: Math.round(p.y) };
						changed = true;
					}
				}
				if (changed) useCanvasStore.setState({ nodes });
			}
		}
	}

	isStructural(type: CommandType): boolean {
		return STRUCTURAL_COMMANDS.has(type);
	}
}

export const commandBus = new CommandBus();
