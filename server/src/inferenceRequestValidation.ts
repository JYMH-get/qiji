import { applyAgentFeatureGate, type AgentFeatures } from './store/agents.ts';
import type { GenerateRequest } from './contract.ts';
import { inferenceRequestError, isInferenceRequestPurpose } from './inferenceComposition.ts';
import { getDefaultTemplate, getInferenceTemplate, listEnabledTemplatesForAgent } from './store/templates.ts';

interface InferenceCaller {
  agentNode?: { id: string };
  user?: { agentId?: string; features?: AgentFeatures };
}

/** 源站及 relay 的生成、批量入口均在转发和扣费前检查双模权限。 */
export function dualModeRequestErrorForCaller(request: GenerateRequest, caller: InferenceCaller): string | undefined {
  const features = applyAgentFeatureGate(caller.agentNode?.id ?? caller.user?.agentId, caller.user?.features);
  if (features?.dualMode === false && (
    request.purpose === 'storyboard.toVideoPrompt' || request.purpose === 'storyboard.singleShot'
    || request.purpose === 'storyboard.toImagePrompt'
    || request.purpose === 'storyboard.split' && request.inference?.outputMode !== 'unified'
    || isInferenceRequestPurpose(request.purpose) && request.inference?.outputMode === 'storyboard'
  )) return '双模已关闭，请选用同源';
}

export function inferenceRequestErrorForCaller(request: GenerateRequest, caller: InferenceCaller): string | undefined {
  const permissionError = dualModeRequestErrorForCaller(request, caller);
  if (permissionError) return permissionError;
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
