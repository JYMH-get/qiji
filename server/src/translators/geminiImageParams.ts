/** Gemini 原生配置原样保留；公共别名只补齐缺失字段，不把 UI 参数塞进协议。 */
export function geminiGenerationConfig(
  params: Record<string, unknown> | undefined,
  imageDefaults: Record<string, unknown> = {},
  responseModalities?: string[],
): Record<string, unknown> {
  const p = params ?? {};
  const native = p.generationConfig;
  if (native !== undefined && (!native || typeof native !== 'object' || Array.isArray(native))) {
    throw new Error('generationConfig 必须为对象');
  }
  const config: Record<string, unknown> = { ...(native as Record<string, unknown> | undefined) };
  // https://ai.google.dev/api/generate-content#generationconfig
  for (const key of ['temperature', 'topP', 'topK', 'seed', 'maxOutputTokens', 'candidateCount', 'stopSequences', 'responseModalities']) {
    if (config[key] === undefined && p[key] !== undefined) config[key] = p[key];
  }
  if (config.responseModalities === undefined && responseModalities) config.responseModalities = responseModalities;
  if (config.imageConfig !== undefined && (!config.imageConfig || typeof config.imageConfig !== 'object' || Array.isArray(config.imageConfig))) {
    throw new Error('generationConfig.imageConfig 必须为对象');
  }
  const imageConfig: Record<string, unknown> = { ...(config.imageConfig as Record<string, unknown> | undefined) };
  for (const [key, value] of Object.entries(imageDefaults)) {
    if (imageConfig[key] === undefined && value !== undefined) imageConfig[key] = value;
  }
  if (config.imageConfig !== undefined || Object.keys(imageConfig).length) config.imageConfig = imageConfig;
  return config;
}

/** 原生请求层字段不属于 generationConfig，保持原来的嵌套层级。 */
export function geminiRequestOptions(params: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ['systemInstruction', 'safetySettings']) {
    if (params?.[key] !== undefined) out[key] = params[key];
  }
  return out;
}
