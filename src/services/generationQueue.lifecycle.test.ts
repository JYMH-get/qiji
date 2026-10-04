import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskUpdate } from './taskCenter';

const io = vi.hoisted(() => ({ state: {} as any, submit: vi.fn(), track: vi.fn(), dispatch: undefined as undefined | ((id: string, ...args: Parameters<TaskUpdate>) => void), stored: new Map<string, string>() }));
vi.mock('@/store/projectStore', () => ({ useProjectStore: { getState: () => io.state } }));
vi.mock('./adapters/registry', () => ({ getAdapter: () => ({ key: 'fixture-image', submit: io.submit }) }));
vi.mock('./adapters/channelAdapter', () => ({ resolveAssetModelKey: () => 'fixture-image' }));
// Exercise real purposeRunner, taskCenter and clientUpdateActivity. Only replace polling I/O.
vi.mock('./taskTracker', () => ({ TaskTracker: class {
  constructor(callback: NonNullable<typeof io.dispatch>) { io.dispatch = callback; }
  track(options: unknown) { io.track(options); }
} }));
vi.mock('./assetPersist', () => ({ saveRemoteAsset: vi.fn(async () => null), uploadBlobToOss: vi.fn() }));
vi.mock('./managedClient', () => ({ managedClient: { rehost: vi.fn() } }));
vi.mock('@/lib/presetSchemes', () => ({ resolvePresets: (prompt: string) => prompt }));

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const spec = { cat: 'characters' as const, assetId: 'character', variantId: null, purpose: 'asset.character.image' as const, prompt: 'synthetic', modelKey: 'fixture-image', label: 'fixture' };
const flush = async () => { await new Promise(r => setTimeout(r, 0)); };

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); io.stored.clear(); io.dispatch = undefined;
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network is forbidden in this regression'); }));
  vi.stubGlobal('localStorage', { getItem: (key: string) => io.stored.get(key) ?? null, setItem: (key: string, value: string) => io.stored.set(key, value), removeItem: (key: string) => io.stored.delete(key) });
  io.state = { projectInstanceId: 'A-session', savePath: 'A.Qiji', isProjectLoading: false, isDirty: false, pendingGens: [], visualStyle: '',
    addPendingGen: (p: unknown) => io.state.pendingGens.push(p),
    updatePendingGen: (id: string, patch: unknown) => { io.state.pendingGens = io.state.pendingGens.map((p: any) => p.id === id ? { ...p, ...patch as object } : p); },
    removePendingGen: (id: string) => { io.state.pendingGens = io.state.pendingGens.filter((p: any) => p.id !== id); },
    save: vi.fn(async () => { io.state.isDirty = false; }), registerAssetBlob: vi.fn(), addGenMeta: vi.fn(), addAssetImage: vi.fn(),
  };
  io.submit.mockReset().mockResolvedValue({ taskId: 'original-task' });
});
afterEach(() => vi.unstubAllGlobals());

async function setup() {
  const queue = await import('./generationQueue');
  const { hasClientActivity } = await import('./clientUpdateActivity');
  const { hasTrackedTasks } = await import('./taskCenter');
  return { queue, hasClientActivity, hasTrackedTasks };
}
const accepted = async (taskId = 'original-task') => { await vi.waitFor(() => expect(io.track).toHaveBeenCalledWith(expect.objectContaining({ taskId }))); };
const finish = (taskId: string, result = taskId) => io.dispatch!(taskId, 100, 'success', `https://fixture.invalid/${result}.png`);
const reopen = () => { io.state = { ...io.state, projectInstanceId: 'A-reopened', pendingGens: io.state.pendingGens.map((p: any) => ({ ...p })) }; };

describe('generation live request handoff retains the purpose runner terminal callback', () => {
  it('reopening an accepted request delivers once and releases the original activity', async () => {
    const { queue, hasClientActivity, hasTrackedTasks } = await setup();
    queue.startGeneration(spec); await accepted(); expect(hasClientActivity()).toBe(true);
    reopen(); queue.resumePendingGenerations(); finish('original-task');
    await vi.waitFor(() => expect(io.state.addAssetImage).toHaveBeenCalledOnce());
    expect(hasClientActivity()).toBe(false); expect(hasTrackedTasks()).toBe(false);
    expect(io.track).toHaveBeenCalledTimes(1);
    expect(io.state.pendingGens).toHaveLength(0);
  });

  it('reopening before acceptance retains the original request and its late receipt', async () => {
    const accept = deferred<{ taskId: string }>(); io.submit.mockReturnValueOnce(accept.promise);
    const { queue, hasClientActivity, hasTrackedTasks } = await setup();
    queue.startGeneration(spec); await vi.waitFor(() => expect(io.submit).toHaveBeenCalledOnce());
    reopen(); queue.resumePendingGenerations();
    expect(io.state.pendingGens[0].status).toBe('running');
    accept.resolve({ taskId: 'original-task' }); await accepted(); await flush();
    expect(io.state.pendingGens[0].taskId).toBe('original-task');
    finish('original-task'); await vi.waitFor(() => expect(io.state.addAssetImage).toHaveBeenCalledOnce());
    expect(io.track).toHaveBeenCalledTimes(1); expect(hasClientActivity()).toBe(false); expect(hasTrackedTasks()).toBe(false);
  });

  it('late acceptance in another project is adopted on return without replacing the live handler', async () => {
    const accept = deferred<{ taskId: string }>(); io.submit.mockReturnValueOnce(accept.promise);
    const { queue, hasClientActivity } = await setup();
    queue.startGeneration(spec); await vi.waitFor(() => expect(io.submit).toHaveBeenCalledOnce());
    const original = io.state.pendingGens.map((p: any) => ({ ...p }));
    io.state = { ...io.state, projectInstanceId: 'B-session', savePath: 'B.Qiji', pendingGens: [] };
    accept.resolve({ taskId: 'original-task' }); await accepted();
    expect(io.state.pendingGens).toHaveLength(0);
    io.state = { ...io.state, projectInstanceId: 'A-reopened', savePath: 'A.Qiji', pendingGens: original };
    queue.resumePendingGenerations(); finish('original-task');
    await vi.waitFor(() => expect(io.state.addAssetImage).toHaveBeenCalledOnce());
    expect(hasClientActivity()).toBe(false); expect(io.track).toHaveBeenCalledTimes(1);
  });

  it.each(['old-first', 'new-first'])('retry and superseded request both settle without old writes (%s)', async (order) => {
    const acceptOld = deferred<{ taskId: string }>(); io.submit.mockReturnValueOnce(acceptOld.promise).mockResolvedValueOnce({ taskId: 'retry-task' });
    const { queue, hasClientActivity, hasTrackedTasks } = await setup();
    queue.startGeneration(spec); await vi.waitFor(() => expect(io.submit).toHaveBeenCalledOnce());
    reopen(); queue.retryGeneration(io.state.pendingGens[0].id); await accepted('retry-task');
    acceptOld.resolve({ taskId: 'original-task' }); await accepted();
    expect(io.state.pendingGens[0].taskId).toBe('retry-task');
    finish(order === 'old-first' ? 'original-task' : 'retry-task'); await flush();
    expect(hasClientActivity()).toBe(true);
    if (order === 'old-first') expect(io.state.addAssetImage).not.toHaveBeenCalled();
    finish(order === 'old-first' ? 'retry-task' : 'original-task');
    await vi.waitFor(() => expect(hasClientActivity()).toBe(false));
    expect(hasTrackedTasks()).toBe(false); expect(io.track).toHaveBeenCalledTimes(2);
    expect(io.state.addAssetImage).toHaveBeenCalledOnce();
    expect(io.state.addAssetImage).toHaveBeenCalledWith('characters', 'character', null, 'https://fixture.invalid/retry-task.png', true);
  });

  it('manual reconnect while the original request is live does not replace its handler', async () => {
    const { queue, hasClientActivity } = await setup();
    queue.startGeneration(spec); await accepted();
    queue.recallPendingGeneration(io.state.pendingGens[0].id); finish('original-task');
    await vi.waitFor(() => expect(io.state.addAssetImage).toHaveBeenCalledOnce());
    expect(hasClientActivity()).toBe(false); expect(io.track).toHaveBeenCalledTimes(1);
  });
});
