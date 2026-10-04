import { commandBus, type CommandSource } from "./commandBus";
import type { Command } from "./commands";
import type { RunCommandResult } from "./nodeRunEligibility";

/**
 * GUI 侧统一派发入口。Copilot / Agent 可传入各自 source 与 ctx。
 * 所有画布变更都应经此（而非直接调用 store），以保证「同源指令核心」。
 */
export function dispatchCommand(command: Extract<Command, { type: "run" }>, source?: CommandSource): RunCommandResult | undefined;
export function dispatchCommand(command: Command, source?: CommandSource): void;
export function dispatchCommand(
	command: Command,
	source: CommandSource = "gui",
): unknown {
	return commandBus.dispatch(command, { source });
}
