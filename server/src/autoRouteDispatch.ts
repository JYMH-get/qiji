import type { GenerateRequest } from './contract.ts';
import { selectRoute, recordRouteResult, isChannelFailure, routingConfig, routeFamilyName } from './autoRouting.ts';
import { getModelDef } from './store/models.ts';
import { beginRouteObservation, finishRouteObservation } from './routeObservations.ts';
import { randomUUID } from 'node:crypto';
import { scrubChannelInfo } from './errorScrub.ts';
import { dispatchGenerate, type DispatchResult } from './translators/index.ts';
import { setTaskRouting } from './store/tasks.ts';
import { attachRouting, finishLog } from './store/logs.ts';

export async function dispatchRouted(req: GenerateRequest, logId?: string, agentId?: string, modes?: Record<string, boolean>): Promise<DispatchResult> {
  if (!req.model.startsWith('route:')) return dispatchGenerate(req, logId);
  let observationId: string | undefined;
  try {
    const { request, ticket } = selectRoute(req, agentId, modes);
    observationId = logId ?? randomUUID(); ticket.observationId = observationId;
    const line = routingConfig().lines.find(l => l.id === ticket.lineId)!;
    beginRouteObservation(observationId, { ...ticket, familyName:routeFamilyName(line), lineName:line.name, modelName:getModelDef(ticket.modelId)?.label ?? ticket.modelId }, 900);
    if (logId) attachRouting(logId, ticket);
    const result = await dispatchGenerate(request, logId);
    if (result.kind === 'async') setTaskRouting(result.taskId, ticket);
    else {
      if (result.status === 'success' || isChannelFailure(result.error, observationId)) recordRouteResult(ticket, result.status === 'success');
      finishRouteObservation(observationId, result.status === 'success', result.error);
    }
    return result.kind === 'sync' && result.error ? { ...result, error: scrubChannelInfo(result.error, false) } : result;
  } catch (e) {
    const error = (e as Error).message;
    finishRouteObservation(observationId, false, error);
    if (logId) finishLog(logId, { status: 'failed', error });
    return { kind: 'sync', status: 'failed', error: scrubChannelInfo(error, false) };
  }
}
