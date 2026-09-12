import type { GenerateRequest } from './contract.ts';
import { inferenceRequestError, isInferenceRequestPurpose } from './inferenceComposition.ts';
import { getDefaultTemplate, getInferenceTemplate, listEnabledTemplatesForAgent } from './store/templates.ts';

interface InferenceCaller {
  agentNode?: { id: string };
  user?: { agentId?: string };
}

/** 生成与批量入口共用；旧客户端的分离式正文也必须检查创作方案及输出格式的开放范围。 */
export function inferenceRequestErrorForCaller(request: GenerateRequest, caller: InferenceCaller): string | undefined {
  const split = request.purpose === 'storyboard.split';
  const template = request.templateId ? getInferenceTemplate(request.templateId) : split ? getDefaultTemplate('storyboard.split') : undefined;
  if (request.inference?.source !== 'skill' && template?.purpose === 'storyboard.split' && !split) return '仅拆分模板只能用于仅拆分请求';
  let validated = !request.templateId && split && request.inference?.source !== 'skill' ? { ...request, templateId: template?.id } : request;
  if (!request.inference) {
    if ((!template?.outputSeparated && !split) || !isInferenceRequestPurpose(request.purpose) || request.promptOverride?.trim()) return;
    // 不修改原始请求；旧客户端缺省15秒，空白完整覆盖与 buildPrompt 一样视为未提供。
    validated = { ...validated, promptOverride: undefined, inference: { source: 'template' } };
  }
  const agentId = caller.agentNode?.id ?? caller.user?.agentId;
  return inferenceRequestError(validated, listEnabledTemplatesForAgent(agentId));
}
