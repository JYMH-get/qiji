import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerateRequest } from '../contract';
import { composeInference, inferenceRequestError, INFERENCE_FORMATS, INFERENCE_PURPOSES, resolveInferenceDurationRange, selectInferenceOutputTemplate } from '../../server/src/inferenceComposition';

const store = vi.hoisted(() => ({
  getTemplateDef: vi.fn(),
  getDefaultTemplate: vi.fn(),
  getInferenceTemplate: vi.fn(),
  getInferenceOutputTemplate: vi.fn(),
  listEnabledTemplatesForAgent: vi.fn(),
}));
vi.mock('../../server/src/store/templates.ts', () => store);
vi.mock('../../server/src/catalog.ts', () => ({ getVariantPrefix: vi.fn() }));
vi.mock('../../server/src/translators/viewAnglePrompt.ts', () => ({ renderViewAnglePrompt: vi.fn() }));
vi.mock('../../server/src/translators/panoramaPrompt.ts', () => ({ renderPanoramaPrompt: vi.fn() }));
vi.mock('../../server/src/translators/jianyiSummaryPrompt.ts', () => ({ renderJianyiSummaryPrompt: vi.fn() }));
import { buildPrompt } from '../../server/src/translators/prompt';
import { inferenceRequestErrorForCaller } from '../../server/src/inferenceRequestValidation';

const formats = INFERENCE_FORMATS.map(t => ({ ...t, enabled: true }));
const creativeBody = '\n# 导演\n保留原有动作、声音与所有示例。\n';
const creative = { id: 'official-6-single', name: '官方6', aliases: ['old-multi'], purpose: 'storyboard.unifiedShot', enabled: true, outputSeparated: true, body: creativeBody };
const splitTemplate = { id: 'jianyi', name: '智能仅拆分', aliases: ['支inengchaifen0', 'zhinengchaifen5', 'storyboard.split.smart'], purpose: 'storyboard.split', enabled: true, outputSeparated: true, body: '\n完整拆分正文。\n# Output Format\n最高15秒、保留原文、匹配资产。\n' };
const request = (patch: Partial<GenerateRequest> = {}): GenerateRequest => ({
  clientTaskId: 'qa-inference-composition',
  projectId: 'qa-project',
  purpose: 'storyboard.toVideoPrompt', model: 'mock-model', templateId: creative.id,
  inference: { source: 'template' }, variables: { 原文: '原文哨兵', 剧情引导: '变量引导哨兵' }, ...patch,
});

beforeEach(() => {
  vi.clearAllMocks();
  store.getInferenceTemplate.mockImplementation((id: string) => [creative, splitTemplate].find(t => t.id === id || t.aliases.includes(id)));
  store.getDefaultTemplate.mockImplementation((purpose: string) => purpose === 'storyboard.split' ? splitTemplate : undefined);
  store.getInferenceOutputTemplate.mockImplementation((purpose: string) => selectInferenceOutputTemplate(formats, purpose));
  store.listEnabledTemplatesForAgent.mockReturnValue([...formats, creative, splitTemplate]);
});

describe('生成与批量入口共用的身份和旧客户端校验', () => {
  it('ank节点按agentNode校验，普通用户按user.agentId校验，直属用户按平台校验', () => {
    for (const caller of [{ agentNode: { id: 'channel-node' } }, { user: { agentId: 'channel-user' } }, { user: {} }]) {
      const audience = 'agentNode' in caller ? caller.agentNode?.id : caller.user?.agentId;
      store.listEnabledTemplatesForAgent.mockImplementation(id => id === audience ? [...formats, creative] : []);
      expect(inferenceRequestErrorForCaller(request(), caller)).toBeUndefined();
      expect(store.listEnabledTemplatesForAgent).toHaveBeenLastCalledWith(audience);
    }
  });

  it('节点身份不会因为同时存在用户字段而退回其他受众', () => {
    const caller = { agentNode: { id: 'actual-node' }, user: { agentId: 'different-user' } };
    store.listEnabledTemplatesForAgent.mockImplementation(id => id === 'actual-node' ? [] : [...formats, creative]);
    expect(inferenceRequestErrorForCaller(request(), caller)).toContain('未对');
  });

  it('旧outputSeparated及合并别名仍检查未开放创作模板', () => {
    store.listEnabledTemplatesForAgent.mockReturnValue(formats);
    for (const templateId of [creative.id, 'old-multi']) {
      const req = request({ inference: undefined, templateId });
      expect(inferenceRequestErrorForCaller(req, { user: { agentId: 'not-shared' } })).toContain('未对');
      expect(req.inference).toBeUndefined();
    }
  });

  it('旧outputSeparated请求也拒绝未开放格式，合法旧请求保持15秒且不改变原入参', () => {
    const req = request({ purpose: 'storyboard.unified', inference: undefined });
    store.listEnabledTemplatesForAgent.mockReturnValue([creative]);
    expect(inferenceRequestErrorForCaller(req, { user: {} })).toContain('输出格式');
    store.listEnabledTemplatesForAgent.mockReturnValue([...formats, creative]);
    expect(inferenceRequestErrorForCaller(req, { user: {} })).toBeUndefined();
    expect(req.inference).toBeUndefined();
    expect(buildPrompt(req)).toContain('范围是4-15');
  });

  it('旧客户端空白完整覆盖按未提供处理，非推理和真正完整覆盖保留原路径', () => {
    expect(inferenceRequestErrorForCaller(request({ inference: undefined, promptOverride: ' \n' }), {})).toBeUndefined();
    store.listEnabledTemplatesForAgent.mockClear();
    for (const req of [request({ purpose: 'script.analyze', inference: undefined }), request({ inference: undefined, promptOverride: '用户完整请求' })]) {
      expect(inferenceRequestErrorForCaller(req, {})).toBeUndefined();
    }
    expect(store.listEnabledTemplatesForAgent).not.toHaveBeenCalled();
  });
});

describe('仅拆分复用输出格式，创作模板用途隔离', () => {
  it.each((['storyboard', 'unified'] as const).flatMap(outputMode => [{ min: 4, max: 15 }, { min: 2.5, max: 35.75 }].map(durationRange => ({ outputMode, durationRange }))))('$outputMode范围$durationRange仅拆分、保留附件、提示词字段为空', ({ outputMode, durationRange }) => {
    const req = request({ purpose: 'storyboard.split', templateId: splitTemplate.id, inference: { source: 'template', outputMode, durationRange, guidance: '保留对白停顿' } });
    const available = [...formats, creative, splitTemplate];
    const result = buildPrompt(req);
    expect(inferenceRequestError(req, available)).toBeUndefined();
    expect(inferenceRequestErrorForCaller(req, { user: {} })).toBeUndefined();
    expect(store.getInferenceOutputTemplate).toHaveBeenCalledWith(outputMode === 'unified' ? 'storyboard.unified' : 'storyboard.toVideoPrompt');
    expect(result.startsWith('【本次任务：仅拆分】')).toBe(true);
    expect(result).toContain('仅切分剧本原文、估算各分镜时长并匹配已设计资产');
    expect(result).toContain(outputMode === 'unified' ? '`unified_prompt` 必须输出空字符串 ""' : '`storyboard_prompts` 与 `video_prompts` 必须输出空字符串 ""');
    expect(result).toContain(`范围是${durationRange.min}-${durationRange.max}`);
    expect(result).toContain('【剧情引导】：\n保留对白停顿');
    expect(result.split('原文哨兵')).toHaveLength(2);
    expect(result.endsWith(`【附件】：\n${splitTemplate.body}`)).toBe(true);
    expect(req.purpose).toBe('storyboard.split');
    expect(INFERENCE_FORMATS).toHaveLength(4);
  });

  it.each([undefined, splitTemplate.id, ...splitTemplate.aliases])('旧拆分引用%s及缺省模板均使用完整默认正文，不按旧id推断30秒', templateId => {
    const req = request({ purpose: 'storyboard.split', templateId, inference: undefined });
    expect(inferenceRequestErrorForCaller(req, {})).toBeUndefined();
    const result = buildPrompt(req);
    expect(result.startsWith('【本次任务：仅拆分】')).toBe(true);
    expect(result).toContain('`storyboard_prompts` 与 `video_prompts` 必须输出空字符串 ""');
    expect(result).toContain('范围是4-15');
    expect(result.endsWith(splitTemplate.body)).toBe(true);
    expect(req.inference).toBeUndefined();
    expect(req.templateId).toBe(templateId);
  });

  it('新拆分请求无templateId也使用默认，仅拆分Skills全文及占位符保持原样', () => {
    const req = request({ purpose: 'storyboard.split', templateId: undefined, inference: { source: 'template', durationLimit: 30 } });
    expect(inferenceRequestErrorForCaller(req, {})).toBeUndefined();
    expect(buildPrompt(req)).toContain('范围是4-30');
    const skill = '\n{{时长最大值}} + {{原文}} + 外部正文\n';
    const skillsRequest = request({ purpose: 'storyboard.split', templateId: undefined, inference: { source: 'skill', skillText: skill, outputMode: 'unified', durationRange: { min: 1, max: 90 }, guidance: '安静' } });
    const result = buildPrompt(skillsRequest);
    expect(inferenceRequestErrorForCaller(skillsRequest, {})).toBeUndefined();
    expect(result).toContain('范围是1-90');
    expect(result.endsWith(`【附件】：\n${skill}`)).toBe(true);
    expect(result).not.toContain(splitTemplate.body);
  });

  it('仅拆分和普通推理模板双向隔离，迁移别名不可通过普通推理调用', () => {
    const available = [...formats, creative, splitTemplate];
    for (const templateId of [splitTemplate.id, ...splitTemplate.aliases]) {
      const req = request({ templateId });
      expect(inferenceRequestError(req, available)).toContain('用途不符');
      expect(inferenceRequestErrorForCaller(req, {})).toContain('仅拆分模板');
      expect(() => buildPrompt(req)).toThrow('仅拆分模板');
    }
    const wrong = request({ purpose: 'storyboard.split' });
    expect(inferenceRequestError(wrong, available)).toContain('用途不符');
    expect(() => buildPrompt(wrong)).toThrow('仅拆分方案');
    expect(buildPrompt(request())).not.toContain('【本次任务：仅拆分】');
  });

  it('旧拆分默认、别名仍校验当前受众的模板及输出格式开放范围', () => {
    store.listEnabledTemplatesForAgent.mockReturnValue(formats);
    for (const templateId of [undefined, 'storyboard.split.smart']) {
      expect(inferenceRequestErrorForCaller(request({ purpose: 'storyboard.split', templateId, inference: undefined }), { agentNode: { id: 'hidden' } })).toContain('未对');
    }
    store.listEnabledTemplatesForAgent.mockReturnValue([splitTemplate]);
    expect(inferenceRequestErrorForCaller(request({ purpose: 'storyboard.split', templateId: splitTemplate.id, inference: undefined }), {})).toContain('输出格式');
    store.getDefaultTemplate.mockReturnValue(undefined);
    expect(() => buildPrompt(request({ purpose: 'storyboard.split', templateId: undefined, inference: undefined }))).toThrow('仅拆分方案');
  });

  it('拆分模式非法值被拒绝，普通推理按请求purpose不受split输出字段影响', () => {
    const req = request({ purpose: 'storyboard.split', templateId: splitTemplate.id, inference: { source: 'template', outputMode: 'invalid' as 'storyboard' } });
    expect(inferenceRequestError(req, [...formats, splitTemplate])).toContain('输出模式');
    expect(() => buildPrompt(req)).toThrow('输出模式');
    const normal = buildPrompt(request({ inference: { source: 'template', outputMode: 'unified' } }));
    expect(normal).toContain('`"storyboard_prompts"`');
    expect(normal).not.toContain('【本次任务：仅拆分】');
  });
});

describe('请求位置决定推理输出格式', () => {
  it.each(INFERENCE_PURPOSES.flatMap(purpose => [{ min: 4, max: 15 }, { min: 4, max: 30 }, { min: 2.5, max: 12.75 }, { min: 30, max: 60 }].map(durationRange => ({ purpose, durationRange }))))('$purpose范围$durationRange使用相应输出、原文、引导及完整附件', ({ purpose, durationRange }) => {
    const req = request({ purpose, inference: { source: 'template', durationRange, guidance: '请求引导哨兵' }, variables: { 原文: '原文哨兵', 上上一分镜: '上上镜哨兵', 上一分镜: '上镜哨兵', 下一分镜: '下镜哨兵' } });
    const output = buildPrompt(req);
    const format = selectInferenceOutputTemplate(formats, purpose)!;
    const unified = purpose === 'storyboard.unified' || purpose === 'storyboard.unifiedShot';
    const single = purpose === 'storyboard.singleShot' || purpose === 'storyboard.unifiedShot';
    expect(store.getInferenceOutputTemplate).toHaveBeenCalledWith(purpose);
    expect(output.startsWith('学习附件内的知识')).toBe(true);
    expect(output).toContain(`范围是${durationRange.min}-${durationRange.max}`);
    expect(output).toContain(`以下 ${unified ? 4 : 5} 个字段`);
    expect(output.includes('`"unified_prompt"`')).toBe(unified);
    expect(output.includes('`"storyboard_prompts"`')).toBe(!unified);
    expect(output.includes('`"video_prompts"`')).toBe(!unified);
    expect(output.includes('数组中只含 1 个对象（对应当前分镜）')).toBe(single);
    for (const marker of ['上上镜哨兵', '上镜哨兵', '下镜哨兵']) expect(output.includes(marker)).toBe(single);
    for (const marker of ['原文哨兵', '请求引导哨兵']) expect(output.split(marker)).toHaveLength(2);
    expect(output.endsWith(`【附件】：\n${creativeBody}`)).toBe(true);
    expect(output).not.toContain('{{');
    expect(format.variables).toEqual(expect.arrayContaining(['原文', '剧情引导', '提示词', '时长最小值', '时长最大值']));
    expect(inferenceRequestError(req, [...formats, creative])).toBeUndefined();
  });

  it('旧单卡或多卡模板引用不会改写本次请求的模式', () => {
    const old = request({ templateId: 'old-multi', purpose: 'storyboard.singleShot', inference: undefined });
    const output = buildPrompt(old);
    expect(store.getInferenceOutputTemplate).toHaveBeenCalledWith('storyboard.singleShot');
    expect(output).toContain('`"storyboard_prompts"`');
    expect(output).not.toContain('`"unified_prompt"`');
    expect(output.endsWith(creativeBody)).toBe(true);
  });

  it('规范格式不可用时明确失败，不选择旧30秒或其他模板', () => {
    const limited = formats.filter(t => t.id !== 'output.storyboard.unified');
    const previous30 = { ...formats.find(t => t.id === 'output.storyboard.unified')!, id: 'output.storyboard.unified-30s' };
    const req = request({ purpose: 'storyboard.unified', inference: { source: 'template', durationLimit: 30 } });
    expect(selectInferenceOutputTemplate([...limited, previous30], req.purpose)).toBeUndefined();
    expect(inferenceRequestError(req, [...limited, creative])).toContain('输出格式');
    store.getInferenceOutputTemplate.mockReturnValue(undefined);
    expect(() => buildPrompt(req)).toThrow('输出格式模板');
  });

  it('格式停用或仅渠道自建时不能替代平台规范格式，旧档位metadata不参与选择', () => {
    const canonical = formats.find(t => t.id === 'output.storyboard.unified')!;
    const alternate = { ...canonical, id: 'another-format' };
    expect(selectInferenceOutputTemplate([alternate], canonical.purpose)).toBeUndefined();
    expect(selectInferenceOutputTemplate([{ ...canonical, enabled: false }, alternate], canonical.purpose)).toBeUndefined();
    expect(selectInferenceOutputTemplate([{ ...canonical, outputDurationLimit: 30 as const }, alternate], canonical.purpose)?.id).toBe(canonical.id);
    expect(selectInferenceOutputTemplate([{ ...canonical, agentId: 'channel' }], canonical.purpose)).toBeUndefined();
    // 鉴权可见列表缺少平台规范项时，即使同用途替代项可见，也不能放行后读取隐藏正文。
    expect(inferenceRequestError(request({ purpose: canonical.purpose, inference: { source: 'template', durationLimit: 30 } }), [creative, alternate])).toContain('输出格式');
  });

  it('只保留四种变量化种子，不补种已删除的30秒格式', () => {
    expect(INFERENCE_FORMATS.map(t => t.id)).toEqual(INFERENCE_PURPOSES.map(purpose => `output.${purpose}`));
    for (const existing of INFERENCE_FORMATS) {
      expect(existing.body).toContain('{{时长最小值}}-{{时长最大值}}');
      expect(selectInferenceOutputTemplate([{ ...existing, outputDurationLimit: undefined }], existing.purpose)?.id).toBe(existing.id);
      expect(selectInferenceOutputTemplate([{ ...existing, id: `${existing.id}-30s` }], existing.purpose)).toBeUndefined();
    }
  });

  it('非法请求时长在校验与拼接中均明确拒绝', () => {
    const invalid = request({ inference: { source: 'template', durationLimit: 20 as 15 } });
    expect(inferenceRequestError(invalid, [...formats, creative])).toContain('档位');
    expect(() => buildPrompt(invalid)).toThrow('档位');
  });
});

describe('时长范围变量与旧档位兼容', () => {
  it.each([15, 30] as const)('旧durationLimit=%s填入同一规范模板，默认下限4', durationLimit => {
    const req = request({ inference: { source: 'template', durationLimit } });
    expect(inferenceRequestError(req, [...formats, creative])).toBeUndefined();
    expect(buildPrompt(req)).toContain(`范围是4-${durationLimit}`);
    expect(store.getInferenceOutputTemplate).toHaveBeenCalledWith(req.purpose);
  });

  it('默认4-15，显式小数范围优先于旧档位及同名变量，不增加上限', () => {
    expect(resolveInferenceDurationRange()).toEqual({ min: 4, max: 15 });
    const req = request({ inference: { source: 'template', durationRange: { min: 0.25, max: 123456.75 }, durationLimit: 30 }, variables: { 时长最小值: '4', 时长最大值: '15' } });
    expect(inferenceRequestError(req, [...formats, creative])).toBeUndefined();
    expect(buildPrompt(req)).toContain('范围是0.25-123456.75');
  });

  it('相同最小最大值合法，显式范围使旧档位不再参与请求', () => {
    const req = request({ inference: { source: 'template', durationRange: { min: 9.5, max: 9.5 }, durationLimit: 20 as 15 } });
    expect(inferenceRequestError(req, [...formats, creative])).toBeUndefined();
    expect(buildPrompt(req)).toContain('范围是9.5-9.5');
  });

  it.each([
    null, { min: 0, max: 15 }, { min: -1, max: 15 }, { min: 4, max: 0 },
    { min: 30, max: 15 }, { min: Number.NaN, max: 15 }, { min: 4, max: Number.POSITIVE_INFINITY },
    { min: Number.NEGATIVE_INFINITY, max: 15 }, { min: '4', max: 15 }, { min: 4, max: '15' },
    { min: 4 }, {},
  ])('非法范围%j不能通过校验或拼接，也不退回旧档位', durationRange => {
    const req = request({ inference: { source: 'template', durationRange: durationRange as { min: number; max: number }, durationLimit: 30 } });
    expect(inferenceRequestError(req, [...formats, creative])).toContain('范围无效');
    expect(() => buildPrompt(req)).toThrow('范围无效');
  });
});

describe('输出格式承载全部输入，附件保持完整', () => {
  it('Skills、原文、引导中的占位符不递归替换，正文空白完整保留', () => {
    const skill = '\n  # 外部 Skills\n{{原文}} / {{剧情引导}} / {{自有变量}} / {{时长最小值}} / {{时长最大值}}\n';
    const req = request({ templateId: undefined, inference: { source: 'skill', skillText: skill, guidance: '保留 {{提示词}} 原样' }, variables: { 原文: '原文包含 {{自有变量}}', 自有变量: '不可递归替换' } });
    const output = buildPrompt(req);
    expect(output.endsWith(`【附件】：\n${skill}`)).toBe(true);
    expect(output).toContain('【剧本原文】：\n原文包含 {{自有变量}}');
    expect(output).toContain('【剧情引导】：\n保留 {{提示词}} 原样');
    expect(output).not.toContain('不可递归替换');
    expect(output).not.toContain(creativeBody);
  });

  it('没有单独传guidance时保留变量值，显式空串可清空引导', () => {
    const format = '【原文】{{原文}}【引导】{{剧情引导}}【附件】{{提示词}}';
    expect(composeInference(request(), '正文', format)).toBe('【原文】原文哨兵【引导】变量引导哨兵【附件】正文');
    expect(composeInference(request({ inference: { source: 'template', guidance: '' } }), '正文', format)).toBe('【原文】原文哨兵【引导】【附件】正文');
    expect(composeInference(request({ inference: { source: 'template', guidance: '\n 引导 \n' } }), '正文', format)).toContain('【引导】\n 引导 \n【附件】');
  });

  it('兼容原文变量回退及创作模板原有变量，保留所有格式示例', () => {
    const body = '\n# 创作\n{{视觉风格}}\n## 输出示例\n```json\n[{"duration":15}]\n```\n';
    const req = request({ variables: { prompt: '旧入口原文', 视觉风格: '水墨' } });
    const result = composeInference(req, body, '{{原文}}\n{{提示词}}');
    expect(result).toBe('旧入口原文\n' + body.replace('{{视觉风格}}', '水墨'));
  });

  it('旧格式没有附件变量时仅在其后追加正文，不重复原文或引导', () => {
    const result = composeInference(request(), creativeBody, '格式\n{{原文}}\n{{剧情引导}}');
    expect(result).toBe(`格式\n原文哨兵\n变量引导哨兵\n\n${creativeBody}`);
  });
});
