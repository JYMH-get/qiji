import type { GenerateRequest, Purpose } from './contract.ts';

export const INFERENCE_PURPOSES = ['storyboard.toVideoPrompt', 'storyboard.singleShot', 'storyboard.unified', 'storyboard.unifiedShot'] as const;
export const isInferencePurpose = (purpose?: string): boolean => INFERENCE_PURPOSES.includes(purpose as typeof INFERENCE_PURPOSES[number]);
export const isInferenceRequestPurpose = (purpose?: string): boolean => purpose === 'storyboard.split' || isInferencePurpose(purpose);
export const inferenceTemplateMatches = (templatePurpose: string | undefined, requestPurpose: string): boolean => requestPurpose === 'storyboard.split' ? templatePurpose === 'storyboard.split' : isInferencePurpose(templatePurpose);

/** 仅拆分复用多卡格式；输出模式只来自本次请求，不从拆分模板或旧别名推断。 */
export function inferenceOutputPurpose(req: GenerateRequest): Purpose {
  if (req.purpose !== 'storyboard.split') return req.purpose;
  const mode = req.inference?.outputMode;
  if (mode !== undefined && mode !== 'storyboard' && mode !== 'unified') throw new Error('拆分输出模式无效');
  return mode === 'unified' ? 'storyboard.unified' : 'storyboard.toVideoPrompt';
}

interface OutputTemplate {
  id: string;
  purpose?: string;
  category?: string;
  outputDurationLimit?: 15 | 30;
  enabled?: boolean;
  agentId?: string;
  order?: number;
}

/** 输出路由只读取本次请求用途；时长作为变量，创作方案的 id、名称和旧用途不参与。 */
export function selectInferenceOutputTemplate<T extends OutputTemplate>(templates: readonly T[], purpose?: string): T | undefined {
  if (!isInferencePurpose(purpose)) return;
  const expectedId = `output.${purpose}`;
  const canonical = templates.find(t => !t.agentId && t.id === expectedId && t.category === '输出提示词' && t.purpose === purpose);
  // 缺失、停用或未开放的规范格式不能由另一模板代替，保证账号校验与实际拼接选择同一条目。
  return canonical && canonical.enabled !== false ? canonical : undefined;
}

/** 新范围优先；旧15/30档只用于旧项目兼容，不夹取、不限制自定义最大值。 */
export function resolveInferenceDurationRange(inference?: GenerateRequest['inference']): { min: number; max: number } {
  if (inference?.durationRange !== undefined) {
    const range = inference.durationRange;
    if (!range || typeof range.min !== 'number' || typeof range.max !== 'number'
      || !Number.isFinite(range.min) || !Number.isFinite(range.max) || range.min <= 0 || range.max <= 0 || range.min > range.max) {
      throw new Error('推理时长范围无效：最小值和最大值须为正数，且最小值不能大于最大值');
    }
    return { min: range.min, max: range.max };
  }
  const limit = inference?.durationLimit;
  if (limit !== undefined && limit !== 15 && limit !== 30) throw new Error('推理时长档位无效');
  return { min: 4, max: limit ?? 15 };
}

const inputVariables = ['视觉风格', '角色列表', '场景列表', '物品列表', '生物列表', '群像列表', '原文', '剧情引导', '提示词', '时长最小值', '时长最大值'];
const neighborVariables = ['上上一分镜', '上一分镜', '下一分镜'];

/** 新环境及补缺用；已存模板正文仍由管理端维护，不覆盖用户修改。 */
export const INFERENCE_FORMATS = INFERENCE_PURPOSES.map((purpose) => {
  const single = purpose === 'storyboard.singleShot' || purpose === 'storyboard.unifiedShot';
  const unified = purpose === 'storyboard.unified' || purpose === 'storyboard.unifiedShot';
  return {
    id: `output.${purpose}`,
    name: `${single ? '单卡' : '多卡'} · ${unified ? '图视同源' : '故事板与视频'}`,
    purpose: purpose as Purpose, capability: 'text' as const, category: '输出提示词',
    body: [
      `学习附件内的知识，根据视觉风格、资产库、剧本原文${single ? '、上下文资料' : ''}推理出结果，最终填入下面格式输出：`,
      '【最终输出格式与全局输出规范】',
      `${single ? '只输出一个标准 JSON 数组，且数组中只含 1 个对象（对应当前分镜），不再拆成多卡。' : '所有分镜卡必须以标准的 JSON 数组格式输出，数组中包含每个卡片的对象。'}每个对象**只能且必须**包含以下 ${unified ? 4 : 5} 个字段。所有内部描述文字需作为长字符串处理，并注意转义换行符（\\n）和双引号（"）：`,
      '1. `"card_number"`：分镜号',
      '2. `"duration"`:时长（纯数字），当前分镜演绎的时间长度，范围是{{时长最小值}}-{{时长最大值}}，纯数字，严禁出现非数字和违规数字。',
      '3. `"original_script"`： 原文（镜像无损保留剧本原句、△、台词、场景信息，一字不改）',
      ...(unified ? ['4. `"unified_prompt"`： 视频提示词（完整）'] : ['4. `"storyboard_prompts"`： 故事板提示词（完整）', '5. `"video_prompts"`： 视频提示词（完整）']),
      '警告：直接输出干净的 JSON 数组结构，前后禁止包裹任何 Markdown 代码块（如 ```json）或其他多余的解释性废话。',
      '', '【视觉风格】：', '{{视觉风格}}',
      '', '【已设计资产库（匹配角色用，注意分体）】：',
      '- 角色：{{角色列表}}', '- 场景：{{场景列表}}', '- 道具：{{物品列表}}', '- 生物：{{生物列表}}', '- 群像：{{群像列表}}',
      ...(single ? [
        '', '## 🔗 【上下文参考】（仅用于保持与相邻分镜的连贯，**绝不重复生成、不当作本卡内容输出**）',
        '- **上上一分镜**（更早的镜头，可能是已生成的提示词或原文，用于把握整体节奏走向）：', '{{上上一分镜}}',
        '- **上一分镜**（紧邻的上一镜，多为已生成的提示词——本卡的站位/光影/运镜/情绪/机位/资产状态须与其收尾**无缝衔接**，禁止跳变穿帮）：', '{{上一分镜}}',
        '- **下一分镜**（紧邻的下一镜原文，本卡结尾要为它做好转场铺垫，但**只产出本镜内容**、绝不提前生成下一镜）：', '{{下一分镜}}',
        '', '（以上上下文可能为空——为空时忽略即可，仍只依据下方【本分镜剧本原文】产出本镜结果。）',
      ] : []),
      '', '【剧本原文】：', '{{原文}}',
      '', '【剧情引导】：', '{{剧情引导}}',
      '', '【附件】：', '{{提示词}}',
    ].join('\n'),
    variables: single ? [...inputVariables, ...neighborVariables] : [...inputVariables],
    isDefault: false, order: 900,
  };
});

export function inferenceRequestError(req: GenerateRequest, available: (OutputTemplate & { aliases?: string[] })[]): string | undefined {
  if (!req.inference) return;
  const inference = req.inference;
  if (!isInferenceRequestPurpose(req.purpose) || !['template', 'skill'].includes(inference.source)) return '推理方案类型或用途无效';
  if (req.promptOverride) return '分离式推理不能同时覆盖完整请求';
  try { resolveInferenceDurationRange(inference); inferenceOutputPurpose(req); } catch (error) { return (error as Error).message; }
  if (inference.guidance !== undefined && (typeof inference.guidance !== 'string' || inference.guidance.length > 100000)) return '剧情引导无效或过长';
  if (inference.source === 'skill') {
    if (typeof inference.skillText !== 'string' || !inference.skillText.trim() || inference.skillText.length > 1000000) return '请提供有效的外部 Skills 文本（最多100万字符）';
  } else if (!available.some(t => t.enabled !== false && (t.id === req.templateId || !!req.templateId && t.aliases?.includes(req.templateId)) && inferenceTemplateMatches(t.purpose, req.purpose) && t.category !== '输出提示词')) return req.purpose === 'storyboard.split' ? '仅拆分方案不存在、用途不符、停用或未对当前账号开放' : '推理方案不存在、用途不符、停用或未对当前账号开放';
  if (!selectInferenceOutputTemplate(available, inferenceOutputPurpose(req))) return '当前输出格式未开放或已停用';
}

export function composeInference(req: GenerateRequest, creative: string, format: string): string {
  const duration = resolveInferenceDurationRange(req.inference);
  const vars: Record<string, string> = {
    ...req.variables,
    原文: req.variables?.原文 ?? req.variables?.prompt ?? '',
    时长最小值: String(duration.min), 时长最大值: String(duration.max),
  };
  if (req.inference?.guidance !== undefined) vars.剧情引导 = req.inference.guidance;
  const fill = (body: string, values: Record<string, string>) => body.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, key: string) => values[key.trim()] ?? '');
  // 用户 Skills 是完整附件；仅模板保留原有变量填充，均不裁剪或重写正文。
  const strategy = req.inference?.source === 'skill' ? req.inference.skillText ?? '' : fill(creative, vars);
  // 一次替换防止附件、原文或剧情引导中的 {{文字}} 被再次当成格式变量。
  const result = fill(format, { ...vars, 提示词: strategy });
  const composed = /\{\{\s*提示词\s*\}\}/.test(format) ? result : `${result}\n\n${strategy}`;
  if (req.purpose !== 'storyboard.split') return composed;
  const fields = inferenceOutputPurpose(req) === 'storyboard.unified' ? '`unified_prompt`' : '`storyboard_prompts` 与 `video_prompts`';
  return [
    '【本次任务：仅拆分】',
    '仅切分剧本原文、估算各分镜时长并匹配已设计资产，不生成详细故事板、视频或同源提示词，不新增或改写剧情。',
    `本次输出中的 ${fields} 必须输出空字符串 ""；只填写分镜号、原文和时长，不增加输出格式之外的字段。`,
    '外层字段、分镜数量和时长范围以本次输出格式为准；附件中的格式示例及固定时长说明只作为拆分方法参考，不覆盖本次任务与所填时长范围。',
    '', composed,
  ].join('\n');
}
