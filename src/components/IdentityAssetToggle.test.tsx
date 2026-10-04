import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogModel } from "@/contract";

const mocks = vi.hoisted(() => ({ preparation: vi.fn(), retry: vi.fn(), models: [] as CatalogModel[] }));
vi.mock('@/hooks/useOfficialMaterialPreparation', () => ({ useOfficialMaterialPreparation: mocks.preparation }));
vi.mock('@/store/catalogStore', () => ({ useCatalogStore: (selector: (state: unknown) => unknown) => selector({ catalog: { models: mocks.models } }) }));
import { IdentityAssetToggle } from "./IdentityAssetToggle";

describe("IdentityAssetToggle", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.models = [];
		mocks.preparation.mockReturnValue({ state: { status: 'Processing', checkedAt: 0 }, retry: mocks.retry });
	});
	it("固定在人像素材卡右下角，不占用右上角删除位", () => {
		const html = renderToStaticMarkup(<IdentityAssetToggle active onToggle={vi.fn()} />);

		expect(html).toContain("right:1px");
		expect(html).toContain("bottom:1px");
		expect(html).not.toContain("top:");
		expect(html).not.toContain("left:");
		expect(html).toContain("aria-pressed=\"true\"");
		expect(html).toContain('data-material-status="Processing"');
		expect(html).not.toContain("人✓");
	});
	it('automatically prepares old unchecked images on official routes and cannot switch them off', () => {
		mocks.models = [{ id: 'official', materialPolicy: { kind: 'official-assets', library: 'sd' } } as CatalogModel];
		const onToggle = vi.fn();
		const material = { id: 'old-reference', usage: 'reference' as const };
		const button = IdentityAssetToggle({ active: false, onToggle, modelId: 'official', material });
		expect(mocks.preparation).toHaveBeenCalledWith('official', material, true);
		const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
		button.props.onClick(event);
		button.props.onContextMenu(event);
		expect(onToggle).not.toHaveBeenCalled();
		const html = renderToStaticMarkup(button);
		expect(html).toContain('data-material-status="Processing"');
		expect(html).toContain('官方图片素材');
		expect(html).not.toContain('改为普通参考');
		expect(html).not.toContain('aria-pressed');
	});
	it('retries failed official images without changing persisted usage', () => {
		mocks.models = [{ id: 'official', officialAssets: true } as CatalogModel];
		mocks.preparation.mockReturnValue({ state: { status: 'Failed', checkedAt: 1, error: 'expired' }, retry: mocks.retry });
		const onToggle = vi.fn();
		const button = IdentityAssetToggle({ active: false, onToggle, modelId: 'official', material: { id: 'image' } });
		button.props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
		expect(mocks.retry).toHaveBeenCalledOnce();
		expect(onToggle).not.toHaveBeenCalled();
		expect(renderToStaticMarkup(button)).toContain('重试官方图片素材');
	});
	it('preserves existing toggle behavior outside official routes', () => {
		mocks.models = [{ id: 'url', materialPolicy: { kind: 'url' } } as CatalogModel];
		const onToggle = vi.fn();
		const button = IdentityAssetToggle({ active: false, onToggle, modelId: 'url', material: { id: 'image' } });
		expect(mocks.preparation).toHaveBeenCalledWith('url', { id: 'image' }, false);
		button.props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
		expect(onToggle).toHaveBeenCalledOnce();
		expect(renderToStaticMarkup(button)).toContain('data-material-status="Ignored"');
	});
	it.each([['video', 'Video', '视频'], ['audio', 'Audio', '音频']] as const)('automatically prepares %s and allows failed-state retry', (kind, type, label) => {
		mocks.models = [{ id: 'official', officialAssets: true } as CatalogModel];
		mocks.preparation.mockReturnValue({ state: { status: 'Failed', checkedAt: 1 }, retry: mocks.retry });
		const button = IdentityAssetToggle({ kind, active: false, onToggle: vi.fn(), modelId: 'official', material: { id: 'media' } });
		expect(mocks.preparation).toHaveBeenCalledWith('official', { id: 'media', officialAssetType: type }, true);
		expect(renderToStaticMarkup(button)).toContain(`重试官方${label}素材`);
		button.props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
		expect(mocks.retry).toHaveBeenCalledOnce();
	});
});
