import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ upload: vi.fn(), resolve: vi.fn(), verify: vi.fn(), publicUrl: vi.fn() }));
vi.mock('@/lib/publicUrl', async (importOriginal) => ({
	...await importOriginal<typeof import('@/lib/publicUrl')>(), ensurePublicUrl: mocks.publicUrl,
}));
vi.mock('./managedClient', () => ({ managedClient: { resolveAssetUrl: mocks.resolve } }));
vi.mock('./nyxenAcceleration', () => ({ uploadToNyxenAccelerationBucket: mocks.upload, verifyNyxenAccelerationUrl: mocks.verify }));
import { nyxenMaterialController as controller, nyxenMaterialKey, prepareNyxenMaterial, cachedNyxenMaterial } from './nyxenMaterialPreparation';
import { useConnectionStore } from '@/store/connectionStore';

describe('background acceleration for every material kind', () => {
	beforeEach(() => {
		vi.useFakeTimers(); controller.clear(); mocks.verify.mockReset().mockResolvedValue(true);
		vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (_algorithm, data) => Uint8Array.from(new TextEncoder().encode(String(data))).buffer);
		useConnectionStore.setState({ accessKey: crypto.randomUUID() });
		mocks.resolve.mockReset().mockImplementation(async id => `https://source.test/${id}`);
		mocks.publicUrl.mockReset().mockResolvedValue('https://source.test/local.mp3');
		mocks.upload.mockReset().mockImplementation(async (url, kind) => `https://bucket.test/${kind}/${url.split('/').at(-1)}`);
	});
	afterEach(() => { controller.clear(); vi.useRealTimers(); vi.restoreAllMocks(); });
	it.each(['image', 'video', 'audio'] as const)('converts a local %s display URL before native upload', async (kind) => {
		const asset = { id: `LC-${kind}`, url: `http://asset.localhost/D%3A%5Cprojects%5C素材%5CLC-${kind}.mp3` };
		const original = { ...asset };
		await prepareNyxenMaterial(asset, kind);
		expect(mocks.publicUrl).toHaveBeenCalledWith(asset.url, { name: undefined });
		expect(mocks.upload).toHaveBeenCalledWith('https://source.test/local.mp3', kind);
		expect(mocks.resolve).not.toHaveBeenCalled();
		expect(asset).toEqual(original);
	});
	it('converts a local URL returned by asset resolution', async () => {
		const local = 'http://asset.localhost/D%3A%5Cassets%5Cref.mp3';
		mocks.resolve.mockResolvedValue(local);
		await prepareNyxenMaterial({ id: 'audio1' }, 'audio');
		expect(mocks.publicUrl).toHaveBeenCalledWith(local, { name: undefined });
		expect(mocks.upload).toHaveBeenCalledWith('https://source.test/local.mp3', 'audio');
	});
	it.each(['', 'http://asset.localhost/D%3A%5Cmissing.mp3'])('never uploads when local conversion returns %j', async (result) => {
		mocks.publicUrl.mockResolvedValue(result);
		const asset = { id: 'LC-missing', url: 'http://asset.localhost/D%3A%5Cmissing.mp3' };
		const key = nyxenMaterialKey(asset, 'audio');
		controller.subscribe(key, 'audio', asset, 'nyxen', vi.fn());
		await vi.advanceTimersByTimeAsync(5000);
		expect(controller.peek(key)).toMatchObject({ status: 'Failed', error: '素材尚无可用公网地址' });
		expect(mocks.upload).not.toHaveBeenCalled();
	});
	it('keeps public source URLs on the direct upload path', async () => {
		await prepareNyxenMaterial({ url: 'https://source.test/ref.mp3' }, 'audio');
		expect(mocks.publicUrl).not.toHaveBeenCalled();
		expect(mocks.upload).toHaveBeenCalledWith('https://source.test/ref.mp3', 'audio');
	});
	it('uses the local copy when resolving a registered asset fails', async () => {
		mocks.resolve.mockRejectedValue(new Error('asset unavailable'));
		const url = 'asset://localhost/D:/assets/ref.mp3';
		await prepareNyxenMaterial({ id: 'audio1', url }, 'audio');
		expect(mocks.publicUrl).toHaveBeenCalledWith(url, { name: undefined });
		expect(mocks.upload).toHaveBeenCalledWith('https://source.test/local.mp3', 'audio');
	});
	it('images, video and audio prewarm after three seconds, submit reuses links without uploading again', async () => {
		for (const kind of ['image', 'video', 'audio'] as const) {
			const asset = { id: `file-${kind}` };
			controller.subscribe(nyxenMaterialKey(asset, kind), kind, asset, 'nyxen', vi.fn());
		}
		await vi.advanceTimersByTimeAsync(2999); expect(mocks.upload).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1); expect(mocks.upload).toHaveBeenCalledTimes(3);
		for (const kind of ['image', 'video', 'audio'] as const) {
			const asset = { id: `file-${kind}` };
			expect(await prepareNyxenMaterial(asset, kind)).toBe(`https://bucket.test/${kind}/file-${kind}`);
			expect(cachedNyxenMaterial(asset, kind)).toBeDefined();
		}
		expect(mocks.upload).toHaveBeenCalledTimes(3); expect(mocks.resolve).toHaveBeenCalledTimes(3);
	});
	it('deleting before three seconds cancels preparation', async () => {
		const asset = { id: 'removed' };
		controller.subscribe(nyxenMaterialKey(asset, 'audio'), 'audio', asset, 'nyxen', vi.fn())();
		await vi.advanceTimersByTimeAsync(4000); expect(mocks.upload).not.toHaveBeenCalled();
	});
	it('placing cached material again checks the link in gray, replaces an expired link, and submit skips checking', async () => {
		const asset = { id: 'repeat' }, key = nyxenMaterialKey(asset, 'image');
		const state = vi.fn();
		const off = controller.subscribe(key, 'image', asset, 'nyxen', state);
		await vi.advanceTimersByTimeAsync(3000); off();
		controller.subscribe(key, 'image', asset, 'nyxen', state);
		expect(state).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'checking' }));
		await vi.advanceTimersByTimeAsync(3000);
		expect(mocks.verify).toHaveBeenCalledTimes(1);
		expect(mocks.upload).toHaveBeenCalledTimes(1);
		await prepareNyxenMaterial(asset, 'image');
		expect(mocks.verify).toHaveBeenCalledTimes(1);
		controller.clear(); mocks.verify.mockResolvedValue(false);
		controller.subscribe(key, 'image', asset, 'nyxen', state);
		await vi.advanceTimersByTimeAsync(3000);
		expect(mocks.upload).toHaveBeenCalledTimes(2);
		expect(state.mock.calls.some(([s]) => s.phase === 'uploading')).toBe(true);
		expect(controller.peek(key)?.status).toBe('Active');
	});
	it('submit joins background work already in flight', async () => {
		let finish!: (url: string) => void;
		mocks.upload.mockImplementation(() => new Promise<string>(resolve => { finish = resolve; }));
		const asset = { id: 'pending' };
		controller.subscribe(nyxenMaterialKey(asset, 'video'), 'video', asset, 'nyxen', vi.fn());
		await vi.advanceTimersByTimeAsync(3000);
		const submit = prepareNyxenMaterial(asset, 'video');
		finish('https://bucket.test/ready.mp4');
		expect(await submit).toBe('https://bucket.test/ready.mp4');
		expect(mocks.upload).toHaveBeenCalledTimes(1);
	});
	it('failed upload turns red and explicit retry refreshes it', async () => {
		mocks.upload.mockRejectedValue(new Error('network'));
		const asset = { id: 'retry' }, key = nyxenMaterialKey(asset, 'image');
		controller.subscribe(key, 'image', asset, 'nyxen', vi.fn());
		await vi.advanceTimersByTimeAsync(5000);
		expect(mocks.upload).toHaveBeenCalledTimes(4);
		expect(controller.peek(key)?.status).toBe('Failed');
		mocks.upload.mockResolvedValue('https://bucket.test/retry');
		controller.retry(key); await vi.advanceTimersByTimeAsync(0);
		expect(controller.peek(key)?.status).toBe('Active');
		expect(mocks.upload).toHaveBeenCalledTimes(5);
	});
});

