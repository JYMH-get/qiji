import { AsyncLocalStorage } from "node:async_hooks";

// Only wraps result-producing translators; reference uploads keep their own protocol rules.
const context = new AsyncLocalStorage<boolean>();
export function withResultStorage<T>(saveToOss: boolean, run: () => T): T {
	return context.run(saveToOss, run);
}
export function returnOriginalResult(): boolean {
	return context.getStore() === false;
}
