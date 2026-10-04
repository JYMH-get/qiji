import type { ParamField } from './contract.ts';

/** OpenAI-compatible wire contracts. Unknown models keep administrator-defined fields. */
export function textReasoningFields(model: string): ParamField[] {
  const id = model.toLowerCase();
  let modes: string[] = ['enabled', 'disabled'];
  let efforts: string[];
  if (/deepseek-(?:v4|flash)/.test(id)) efforts = ['low', 'high', 'max'];
  else if (/deepseek-(?:v3\.2|chat|reasoner)/.test(id)) {
    return [{ key: 'thinkingMode', label: '思考模式', type: 'enum', options: modes, default: modes.includes('disabled') ? 'disabled' : 'enabled' }];
  } else if (/gpt-5\.6/.test(id)) efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
  else if (/gpt-5\.[245]/.test(id)) efforts = ['low', 'medium', 'high', 'xhigh'];
  else if (/gpt-5\.1/.test(id)) efforts = ['low', 'medium', 'high'];
  else if (/gpt-5(?:-|$)|o[134](?:-|$)/.test(id)) {
    modes = ['enabled']; efforts = /gpt-5/.test(id) ? ['minimal', 'low', 'medium', 'high'] : ['low', 'medium', 'high'];
  } else if (/gemini-(?:3|2\.5)/.test(id)) {
    modes = /gemini-2\.5-flash/.test(id) ? modes : ['enabled'];
    efforts = /gemini-3-pro/.test(id) ? ['low', 'high'] : ['low', 'medium', 'high'];
  } else return [];
  return [
    { key: 'thinkingMode', label: '思考模式', type: 'enum', options: modes, default: modes.includes('disabled') ? 'disabled' : 'enabled' },
    { key: 'reasoning_effort', label: '思考强度', type: 'enum', options: efforts, default: efforts.includes('high') ? 'high' : efforts[0] },
  ];
}

export function addTextReasoningFields<T extends { capability: string; protocol: string; id: string; upstreamModel?: string; params: ParamField[] }>(model: T): void {
  if (model.capability !== 'text' || model.protocol !== 'openai-chat') return;
  const fields = textReasoningFields(model.upstreamModel || model.id);
  model.params = [...model.params, ...fields.filter(field => !model.params.some(existing => existing.key === field.key))];
}

/** Apply only thinking defaults, at dispatch time; never rewrite the accepted request. */
export function textReasoningBody(model: string, params: Record<string, unknown> = {}, defaults: Record<string, unknown> = {}): Record<string, unknown> {
  const mode = params.thinkingMode ?? defaults.thinkingMode;
  const effort = params.reasoning_effort ?? defaults.reasoning_effort;
  const body: Record<string, unknown> = {};
  // Native values take precedence over the convenience switch.
  if (params.thinking !== undefined) body.thinking = params.thinking;
  if (effort !== undefined && effort !== 'default') body.reasoning_effort = effort;
  if (/deepseek/i.test(model)) {
    if (body.thinking === undefined && (mode === 'enabled' || mode === 'disabled')) body.thinking = { type: mode };
    if (mode === 'disabled' && params.thinking === undefined) delete body.reasoning_effort;
  } else if (mode === 'disabled') {
    body.reasoning_effort = 'none';
  } else if (mode === 'enabled' && body.reasoning_effort === undefined) {
    body.reasoning_effort = /gemini/i.test(model) ? 'high' : 'medium';
  }
  return body;
}
