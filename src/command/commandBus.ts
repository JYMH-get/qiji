import { useCanvasStore } from "@/store/canvasStore";
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
 * 同源指令核心：GUI / Copilot / Agent 三入口都汇聚到这里。
 * - 结构命令 → 进入撤销栈（由 store 历史中间件处理）。
 * - Agent 自动模式 → 仅放行白名单命令。
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
	}

	isStructural(type: CommandType): boolean {
		return STRUCTURAL_COMMANDS.has(type);
	}
}

export const commandBus = new CommandBus();

