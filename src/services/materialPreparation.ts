import type { AssetRef, MaterialPrepareResponse } from "@/contract";

export type MaterialPreparationState = Pick<MaterialPrepareResponse, "status" | "error" | "checkedAt" | "assetId"> & { accelerationUrl?: string; phase?: 'checking' | 'uploading' };
type Listener = (state: MaterialPreparationState) => void;
export interface MaterialPrepareControl {
	phase: (phase: 'checking' | 'uploading') => void;
	upload: <T>(work: () => Promise<T>, stage?: string) => Promise<T>;
}
type Prepare = (model: string, asset: AssetRef, retry?: boolean, control?: MaterialPrepareControl) => Promise<MaterialPrepareResponse & { accelerationUrl?: string }>;
type Entry = {
	model: string;
	asset: AssetRef;
	scope?: string;
	listeners: Set<Listener>;
	timer?: ReturnType<typeof setTimeout>;
	pending?: Promise<void>;
	state: MaterialPreparationState;
	uploadAttempts?: Record<string, number>;
 checkers?: number;
};

/** Ephemeral UI state only. Shared cards merge concurrent requests, never persist upstream IDs. */
export function createMaterialPreparationController(prepare: Prepare, options: { maxAgeMs?: number; recheckOnSubscribe?: boolean } = {}) {
	const entries = new Map<string, Entry>();
	const fresh = (state: MaterialPreparationState) => state.status !== 'Processing' && state.checkedAt > 0 && (options.maxAgeMs !== undefined
		? Date.now() - state.checkedAt < options.maxAgeMs
		: Math.floor((state.checkedAt + 8 * 3600000) / 86400000) === Math.floor((Date.now() + 8 * 3600000) / 86400000));
	const prune = () => {
  for (const [key, entry] of entries) if (!entry.listeners.size && !entry.pending && !entry.timer && (!fresh(entry.state) || entries.size > 512)) entries.delete(key);
 };
	const emit = (entry: Entry, state: MaterialPreparationState) => {
		entry.state = state;
		for (const listener of entry.listeners) listener(state);
	};
	const schedule = (key: string, entry: Entry, delay: number) => {
		if (entry.timer || entry.pending || !entry.listeners.size) return;
		entry.timer = setTimeout(() => { entry.timer = undefined; void run(key, entry); }, delay);
	};
	const run = async (key: string, entry: Entry, retry = false) => {
		if (entry.pending) return entry.pending;
		if (entry.timer) { clearTimeout(entry.timer); entry.timer = undefined; }
		if (retry) entry.uploadAttempts = {};
		emit(entry, { status: "Processing", checkedAt: 0, phase: entry.state.phase ?? 'checking' });
		entry.pending = (async () => {
			try {
				const phase = (phase: 'checking' | 'uploading') => emit(entry, { status: 'Processing', checkedAt: 0, phase });
				const result = await prepare(entry.model, entry.asset, retry, {
					phase,
					async upload(work, stage = 'asset') {
						phase('uploading');
						const attempts = entry.uploadAttempts ??= {};
						while ((attempts[stage] ?? 0) < 4) {
							attempts[stage] = (attempts[stage] ?? 0) + 1;
							try { return await work(); }
							catch (error) {
								if (attempts[stage] >= 4) throw error;
								await new Promise(resolve => setTimeout(resolve, 300 * attempts[stage]));
								if (!entry.listeners.size && !entry.checkers) throw error;
							}
						}
						throw new Error('素材上传重试3次后仍未成功，请点击红标重试');
					},
				});
				if (entry.scope && result.scopeKey !== entry.scope) throw new Error("线路配置已更新，请刷新模型后重试");
					emit(entry, { status: result.status, error: result.error, checkedAt: result.checkedAt, assetId: result.assetId, accelerationUrl: result.accelerationUrl, phase: result.status === 'Processing' ? 'uploading' : undefined });
			} catch (error) {
				emit(entry, { status: "Failed", error: error instanceof Error ? error.message : String(error), checkedAt: Date.now() });
			}
		})().finally(() => {
			entry.pending = undefined;
				if (!entry.listeners.size && entry.state.status === 'Processing') entries.delete(key);
			else if (entry.state.status === "Processing") schedule(key, entry, 3000);
		});
		return entry.pending;
	};
	return {
		clear() {
   for (const entry of entries.values()) { if (entry.timer) clearTimeout(entry.timer); entry.listeners.clear(); }
   entries.clear();
  },
		peek(key: string): MaterialPreparationState | undefined {
			const entry = entries.get(key);
			return entry && fresh(entry.state) ? entry.state : undefined;
		},
		async check(key: string, model: string, asset: AssetRef, scope?: string): Promise<MaterialPreparationState> {
			prune();
			let entry = entries.get(key);
			if (entry && fresh(entry.state)) return entry.state;
			if (!entry) {
				entry = { model, asset: { ...asset }, scope, listeners: new Set(), state: { status: "Processing", checkedAt: 0 } };
				entries.set(key, entry);
			}
			entry.checkers = (entry.checkers ?? 0) + 1;
   try { await run(key, entry); return entry.state; }
   finally { entry.checkers--; }
		},
		subscribe(key: string, model: string, asset: AssetRef, scope: string | undefined, listener: Listener) {
			prune();
			let entry = entries.get(key);
			if (!entry) {
				entry = { model, asset: { ...asset }, scope, listeners: new Set(), state: { status: "Processing", checkedAt: 0 } };
				entries.set(key, entry);
			}
			if (options.recheckOnSubscribe && !entry.listeners.size && !entry.pending) {
				entry.state = { status: 'Processing', checkedAt: 0, phase: 'checking' };
				entry.uploadAttempts = {};
			}
			entry.listeners.add(listener);
			if (!fresh(entry.state) && !entry.pending) entry.state = { status: 'Processing', checkedAt: 0, phase: 'checking' };
			listener(entry.state);
			if (!fresh(entry.state)) schedule(key, entry, 3000);
			const current = entry;
			return () => {
				current.listeners.delete(listener);
				if (!current.listeners.size) {
					if (current.timer) { clearTimeout(current.timer); current.timer = undefined; }
					if (!current.pending && current.state.status === 'Processing') entries.delete(key);
				}
			};
		},
		retry(key: string) {
			const entry = entries.get(key);
			if (entry) void run(key, entry, true);
		},
	};
}
