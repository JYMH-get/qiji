import type { FastifyInstance } from 'fastify';
import { filterLogs, startLog, getLog, finishLog } from '../store/logs.ts';
import { startUsageReports } from '../services/usageReports.ts';
import type { GenerateRequest } from '../contract.ts';
import type { User } from '../store/users.ts';
import { getModelDef, updateModel } from '../store/models.ts';
import { settle } from '../store/credits.ts';
import type { PaymentContext } from '../billingContext.ts';
import { paymentFeaturesFor } from '../billingContext.ts';
import { db } from '../store/sqlite.ts';

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

export function registerLocalGenerationReports(api: FastifyInstance, planBilling:(user:User,model:ReturnType<typeof getModelDef>)=>PaymentContext & {cost:number;agents:{id:string;cost:number}[];reject?:string}) {
  api.post('/v1/local-generation-reports', { bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    if (!req.user) return reply.code(403).send({error:{message:'仅用户凭证可用'}});
    const b = req.body;
    if (!object(b) || !text(b.clientTaskId, 200) || !text(b.model, 160) || !/^(libtv-|dreamina-)[a-zA-Z0-9-]+$/.test(b.model)
      || !object(b.params) || !object(b.variables) || typeof b.variables.prompt !== 'string') {
      return reply.code(400).send({error:{message:'本地生成报备参数无效'}});
    }
    const feature=b.model.startsWith('libtv-')?'libtv':'dreamina';
    if(paymentFeaturesFor(req.user)?.[feature]===false) return reply.code(403).send({error:{message:'该本地渠道未开放'}});
    const old = filterLogs({userIds:[req.user.id]}).find(l => l.localExecution && l.clientTaskId === b.clientTaskId);
    if(old?.status==='failed') return reply.code(409).send({error:{message:'该报备任务已失败，请重新提交'}});
    const fee=getModelDef('fee-thirdparty');
    if(!fee) return reply.code(503).send({error:{message:'本地渠道手续费未配置'}});
    const plan=old ? undefined : planBilling(req.user,fee);
    if(plan?.reject) return reply.code(402).send({error:{message:plan.reject}});
    startUsageReports(false);
    const log = old ?? startLog({req:{purpose:'video.generate',model:b.model,clientTaskId:b.clientTaskId,
      variables:{prompt:b.variables.prompt},params:b.params,inputs:object(b.inputs) ? b.inputs as GenerateRequest['inputs'] : undefined,
      projectId:typeof b.projectId === 'string' ? b.projectId : '',output:{format:'asset'}},
      userId:req.user.id,userName:req.user.name,ownerId:req.user.agentId,cost:plan!.cost,agentCosts:plan!.agents,
      payerId:plan!.payer.id,userWallet:plan!.wallet,creditSource:plan!.source,pricingAgentId:plan!.priceOwner.agentId,teamId:plan!.team?.id,
      localExecution:true,localRefundOnFailure:fee.localFailureRefund!==false});
    const charged=settle({reason:'local-generate',idempotencyKey:'local-charge:'+log.id,ref:log.id,payerId:log.payerId??req.user.id,
      statsUserId:req.user.id,userAmount:log.cost??0,userWallet:log.userWallet,creditSource:log.creditSource,agents:log.agentCosts??[]});
    if(!charged.ok) {
      // No dispatch took place and no money moved; failed admission is never a retained fee.
      log.cost=0;log.agentCosts=[];
      finishLog(log.id,{status:'failed',error:charged.error});
      return reply.code(402).send({error:{message:charged.error}});
    }
    return {id:log.id,status:log.status};
  });
  api.put('/v1/local-generation-reports/:id', async (req, reply) => {
    if (!req.user) return reply.code(403).send({error:{message:'仅用户凭证可用'}});
    const log = getLog((req.params as {id:string}).id);
    if (!log?.localExecution || log.userId !== req.user.id) return reply.code(404).send({error:{message:'报备记录不存在'}});
    const b = req.body;
    if (!object(b) || !['success','failed'].includes(String(b.status))
      || (b.taskId !== undefined && !text(b.taskId, 1000))
      || (b.error !== undefined && !text(b.error, 8000))) {
      return reply.code(400).send({error:{message:'本地生成结果无效'}});
    }
    // A retry must not rewrite the first terminal result or count the output twice.
    if (log.status !== 'running') {
      if (log.status !== b.status) return reply.code(409).send({error:{message:'任务已结束，不能覆盖结果'}});
      return {ok:true,status:log.status};
    }
    const debit=db.prepare('SELECT status FROM credit_ops WHERE op_id=?').get('local-charge:'+log.id) as {status:string}|undefined;
    // A fully free admission has no credit_ops row. Use its frozen amounts,
    // including merchant costs, rather than the current fee configuration.
    const hasCharge=(log.cost??0)!==0 || (log.agentCosts??[]).some(a=>a.cost!==0);
    if(debit ? !['done','healed'].includes(debit.status) : hasCharge) return reply.code(409).send({error:{message:'预扣尚未完成，请重试原报备请求'}});
    if(b.status==='failed' && log.localRefundOnFailure!==false && hasCharge) {
      const refunded=settle({reason:'local-refund',idempotencyKey:'local-refund:'+log.id,ref:log.id,payerId:log.payerId??req.user.id,
        statsUserId:req.user.id,userAmount:-(log.cost??0),userWallet:log.userWallet,agents:(log.agentCosts??[]).map(a=>({id:a.id,cost:-a.cost}))});
      if(!refunded.ok) return reply.code(503).send({error:{message:refunded.error}});
    }
    finishLog(log.id,{status:b.status as 'success'|'failed',taskId:b.taskId as string|undefined,error:b.error as string|undefined,
      response:{source:'local-client',status:b.status,...(b.status==='failed'?{error:b.error}:{})}});
    return {ok:true,status:b.status};
  });
}

export function registerLocalGenerationSettings(api:FastifyInstance) {
  const view=()=>{const m=getModelDef('fee-thirdparty');return {cost:m?.cost??5,refundOnFailure:m?.localFailureRefund!==false};};
  api.get('/admin-api/settings/local-generation',async()=>view());
  api.put('/admin-api/settings/local-generation',async(req,reply)=>{
    const b=req.body;
    if(!object(b)||typeof b.cost!=='number'||!Number.isFinite(b.cost)||b.cost<0||typeof b.refundOnFailure!=='boolean')
      return reply.code(400).send({error:{message:'请填写非负积分及失败退款开关'}});
    if(!updateModel('fee-thirdparty',{cost:b.cost,localFailureRefund:b.refundOnFailure})) return reply.code(404).send({error:{message:'手续费模型不存在'}});
    return view();
  });
}
