import { describe, it, expect } from 'vitest';
import { routeParams, migratedRouteKey, normalizeIdentityInputs } from './routeParams';
describe('public route wire contract', () => {
  it('preserves explicit processing dimensions and extension parameters for every capability', () => {
    const params={multiple:2,target_width:2048,target_height:1152,erase_ratio_location:[{top_left_x:0,top_left_y:0.8,bottom_right_x:1,bottom_right_y:1}]};
    for (const capability of ['image-enhance', 'video-erase', 'video-enhance', 'image', 'video', 'text', 'audio']) {
      expect(routeParams(params,capability,[])).toEqual(params);
    }
  });
  it('normalizes legacy identity selection while retaining indexes and explicit usage', () => {
    const images = [{id:'a'}, {id:'b',usage:'reference' as const}, {id:'c',usage:'identity' as const}];
    const inputs = normalizeIdentityInputs({images},[0,1,-1,1.5,999]);
    expect(inputs?.images?.map(ref=>ref.usage)).toEqual(['identity','reference','identity']);
    expect(images[0]).toEqual({id:'a'});
    expect(routeParams({officialAssetIndexes:[0,1]})).toEqual({officialAssetIndexes:[0,1]});
  });
  it('keeps Fast and Mini selections in distinct families, including historic channel IDs', () => {
    const options = ['fast','mini'].map(v => ({id:`route:seedance20-${v}-promo`,familyId:`fam-seedance-2-0-${v}`}));
    const families = ['fam-seedance', ...options.map(m => m.familyId)];
    for (const id of ['seedance-2.0-fast','seedance-2.0-fast-s','os933-sd2.0-fast','cg933-sd2.0-fast','libtv-seedance-2-0-fast']) expect(migratedRouteKey(id,options,families)).toBe(options[0].id);
    for (const id of ['cg933-sd2.0-mini','bys900-sd2.0-mini']) expect(migratedRouteKey(id,options,families)).toBe(options[1].id);
    expect(migratedRouteKey('seedance-2.0-fast',options.slice(1),families)).toBe('');
    expect(migratedRouteKey('seedance-2.0',options,families)).toBe('');
  });
  it('retains provider-specific image settings even when they disagree with public fields', () => {
    const params = {aspect_ratio:'16:9',resolution:'2k',quality:'high',size:'2048x1152',imageSize:'4K',aspectRatio:'1:1',duration:5};
    expect(routeParams(params, 'image')).toEqual(params);
  });
  it('migrates image versions to their own family without falling back across versions', () => {
    const options = [{id:'route:image-nano-banana-pro-promo',familyId:'fam-nano-banana-pro'},{id:'route:image-nano-banana-2-promo',familyId:'fam-nano-banana-2'}];
    const families = options.map(m=>m.familyId);
    expect(migratedRouteKey('banana pro',options,families)).toBe(options[0].id);
    expect(migratedRouteKey('jmh-nano-banana-2',options,families)).toBe(options[1].id);
    expect(migratedRouteKey('banana pro',options.slice(1),families)).toBe('');
  });
  it('preserves all user parameters including provider and existing node state without mutating the source', () => {
    const input = { duration: 15, resolution: '720p', aspect_ratio: '9:16', method: 'omni', firstFrameUrl: 'https://assets.test/frame.png', model: 'old-provider', prompt: 'local text', watermark: false, generate_audio: false, selected: true };
    const routed = routeParams(Object.freeze(input));
    expect(routed).toEqual(input);
    expect(routed).not.toBe(input);
    routed.model = 'another-provider';
    expect(input.model).toBe('old-provider');
  });
  it('preserves reference controls, nested payloads, empty values and parameters absent from catalog', () => {
    const params = Object.freeze({ reference_strength: 0, seed: null, negative_prompt: '', watermark: false,
      custom: { weights: [0.2, 0.8], inputs: { images: [{ url: 'https://assets.test/reference.png' }] } }, omitted: undefined });
    const result = routeParams(params, 'image', [{ key: 'resolution' }]);
    expect(result).toStrictEqual(params);
    expect(result.custom).toBe(params.custom);
    expect(Object.prototype.hasOwnProperty.call(result, 'omitted')).toBe(true);
  });
  it('does not clamp invalid user values or manufacture defaults', () => {
    expect(routeParams({ duration: 31, resolution: 'invalid' })).toEqual({ duration: 31, resolution: 'invalid' });
  });
  it('keeps retired 2.5 selections in 2.5 and does not convert unrelated local models', () => {
    const options = [{ id: 'route:seedance-promo', familyId: 'fam-seedance' }, { id: 'route:seedance25-promo', familyId: 'fam-seedance-2-5' }];
    const families = ['fam-seedance', 'fam-seedance-2-5'];
    expect(migratedRouteKey('007-sd2.5', options, families)).toBe('route:seedance25-promo');
    expect(migratedRouteKey('libtv-seedance-2-5', options, families)).toBe('route:seedance25-promo');
    expect(migratedRouteKey('007-sd2.5', options.slice(0, 1), families)).toBe('');
    expect(migratedRouteKey('libtv-minimax-h3', options, families)).toBeUndefined();
  });
});
