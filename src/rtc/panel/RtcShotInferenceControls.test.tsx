import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ state: {} as any, templates: [] as any[] }));
vi.mock('@/store/projectStore', () => ({ useProjectStore: Object.assign((selector: any) => selector(h.state), { getState: () => h.state }) }));
vi.mock('@/store/catalogStore', () => {
	const state = () => ({ catalog: { templates: h.templates, models: [{ id: 'text', capability: 'text', pricingHidden: true }] } });
	return { useCatalogStore: Object.assign((selector: any) => selector(state()), { getState: state }) };
});
vi.mock('@/store/connectionStore', async importOriginal => ({ ...await importOriginal<typeof import('@/store/connectionStore')>(), getDualModeFeature: () => true }));
vi.mock('./shotGenActions', () => ({ inferShotPrompts: vi.fn() }));
import { RtcShotInferenceControls } from './RtcShotInferenceControls';
beforeEach(() => {
	h.state = { projectInstanceId: 'owner', mediaSettings: { inferenceStrategy: { templateId: 'multi' } }, episodes: [{ id: 'ep', shots: [{ id: 'shot' }] }] };
	h.templates = [
		{ id: 'multi', name: '多卡方案', purpose: 'storyboard.toVideoPrompt' },
		{ id: 'single', name: '单卡方案', purpose: 'storyboard.unifiedShot' },
		{ id: 'split', name: '仅拆分方案', purpose: 'storyboard.split' },
		{ id: 'output', name: '输出契约', purpose: 'storyboard.singleShot', category: '输出提示词' },
	];
});
describe('RTC inference controls', () => {
	it('shows the existing creation strategies and selected template beside the run button', () => {
		const html = renderToStaticMarkup(<RtcShotInferenceControls episodeId="ep" shotId="shot" busy={false} />);
		expect(html).toContain('推理提示词'); expect(html).toContain('aria-label="推理方案"');
		expect(html).toContain('按用量计费');
		expect(html).toContain('value="multi" selected=""'); expect(html).toContain('单卡方案');
		expect(html).not.toContain('仅拆分方案'); expect(html).not.toContain('输出契约'); expect(html).toContain('外部 Skills');
		expect(html.indexOf('推理提示词')).toBeLessThan(html.indexOf('aria-label="推理方案"'));
	});
	it('locks both submission and strategy selection while inference is running', () => {
		const html = renderToStaticMarkup(<RtcShotInferenceControls episodeId="ep" shotId="shot" busy />);
		expect(html).toContain('推理中…'); expect(html.match(/disabled=""/g)).toHaveLength(3);
	});
});
