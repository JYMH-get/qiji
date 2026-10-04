import { listUsers, getUser, type User } from '../store/users.ts';
import { listTeams, type Team } from '../store/teams.ts';
import { listAgents, getAgent } from '../store/agents.ts';
import { filterLogs, setUsageReportObserver, backfillUsageProducts, type LogMeta } from '../store/logs.ts';
import { queueUsage, flushUsage, usageRows, productRows, archivedUsageCompanies, USAGE_REPORT_START } from '../store/usageReports.ts';
import type { UsageReportScope } from '../usageReportTypes.ts';
import type { ProductKind } from '../usageProducts.ts';

const SOURCE = 'source', UNGROUPED = 'ungrouped';
let started = false;
let timer: ReturnType<typeof setInterval> | undefined;

function ownerAt(user: User, at: string): string {
  let owner = user.agentId || SOURCE;
  for (const transfer of [...(user.transferHistory ?? [])].sort((a,b) => b.at.localeCompare(a.at))) {
    if (transfer.at > at) owner = transfer.sourceAgentId || SOURCE;
  }
  return owner;
}

function makeScope(user: User, team: Team | undefined, at: string): UsageReportScope {
  const leader = team && getUser(team.leaderId);
  const companyId = ownerAt(leader || user, at);
  return {
    companyId, companyName: companyId === SOURCE ? '源站' : getAgent(companyId)?.name || '已删除公司',
    groupId: team?.id || UNGROUPED, groupName: team?.name || '未分组个人', mode: team?.creditMode || 'personal',
    userId: user.id, name: user.name || user.account || user.id, account: user.account || '',
    role: team ? team.leaderId === user.id ? '团长' : '成员' : '个人',
  };
}

function resolveScope(log: LogMeta): UsageReportScope | undefined {
  if (!log.userId) return;
  const user = getUser(log.userId);
  // Existing logs use their explicit team if available. A newly created team must
  // not pull requests from before its creation into its company during backfill.
  const teams = listTeams();
  const team = teams.find(t => t.createdAt <= log.startedAt && (log.teamId ? t.id === log.teamId : t.leaderId === log.userId || t.memberIds.includes(log.userId!)));
  if (user) return makeScope(user, team, log.startedAt);
  const companyId = log.pricingAgentId || log.ownerId || SOURCE;
  return {
    companyId: companyId === 'platform' ? SOURCE : companyId,
    companyName: companyId === SOURCE || companyId === 'platform' ? '源站' : getAgent(companyId)?.name || '已删除公司',
    groupId: 'historical', groupName: '历史人员（团队待核对）', mode: 'unknown',
    userId: log.userId, name: log.userName || log.userId, account: '', role: '历史人员',
  };
}

export function startUsageReports(background = true): void {
  if (!started) {
    // Subscriber registration precedes backfill. Only lightweight metadata is read.
    setUsageReportObserver(logs => queueUsage(logs, resolveScope), resolveScope);
    backfillUsageProducts(USAGE_REPORT_START);
    queueUsage(filterLogs({ from: Date.parse(USAGE_REPORT_START) }), resolveScope);
    flushUsage();
    started = true;
  }
  if (background && !timer) {
    timer = setInterval(() => {
      try { flushUsage(); } catch (e) { console.warn('[usage-report] daily update failed', (e as Error).message); }
    }, 60_000);
    timer.unref();
  }
}

export function stopUsageReports(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  if (started) flushUsage();
}

export function usageCompanies() {
  const choices = new Map([[SOURCE, { id: SOURCE, name: '源站' }]]);
  for (const company of archivedUsageCompanies()) choices.set(company.id, company);
  for (const agent of listAgents()) choices.set(agent.id, { id: agent.id, name: agent.name });
  return [...choices.values()];
}

interface ProductMetric { quantity:number; cost:number; knownCost:number; requests:number; missing:number; estimated:number; average:number|null }
type Products = Record<ProductKind,ProductMetric>;
interface ProductTotals { products:Products; dailyProducts:Products[] }
const productZero = (): Products => Object.fromEntries(['video','image','text','audio','other'].map(k => [k,{quantity:0,cost:0,knownCost:0,requests:0,missing:0,estimated:0,average:null}])) as Products;
interface Member extends UsageReportScope, ProductTotals { daily: number[]; total: number }
interface Group extends ProductTotals { id: string; name: string; mode: UsageReportScope['mode']; members: Member[]; daily: number[]; total: number }
interface Company extends ProductTotals { id: string; name: string; groups: Group[]; daily: number[]; total: number; userCount: number; teamCount: number }

export function getUsageReport(companyId: string, days: number, now = Date.now(), range?: {from:string;to:string}, team?: Team) {
  startUsageReports(false);
  flushUsage(now);
  const today = new Date(now).toISOString().slice(0,10);
  const end = range?.to ?? today;
  const length = range ? Math.round((Date.parse(range.to)-Date.parse(range.from))/86400000)+1 : days;
  const dates = Array.from({ length }, (_, i) => new Date(Date.parse(end + 'T00:00:00Z') - i * 86400000).toISOString().slice(0,10))
    .filter(day => day >= USAGE_REPORT_START.slice(0,10));
  const available = team ? [{id:team.id,name:team.name}] : usageCompanies();
  const selected = companyId === 'all' ? available : available.filter(c => c.id === companyId);
  const zero = () => dates.map(() => 0);
  const products = (): ProductTotals => ({products:productZero(),dailyProducts:dates.map(productZero)});
  const companies: Company[] = selected.map(c => ({ ...c, ...products(), groups: [], daily: zero(), total: 0, userCount: 0, teamCount: 0 }));
  const byCompany = new Map(companies.map(c => [c.id, c]));
  const members = new Map<string, Member>();
  function add(scope: UsageReportScope) {
    if (team) {
      if (scope.groupId !== team.id) return;
      scope = {...scope,companyId:team.id,companyName:team.name};
    }
    const company = byCompany.get(scope.companyId); if (!company) return;
    let group = company.groups.find(g => g.id === scope.groupId);
    if (!group) { group = { id: scope.groupId, name: scope.groupName, mode: scope.mode, members: [], daily: zero(), total: 0, ...products() }; company.groups.push(group); }
    const key = JSON.stringify([scope.companyId, scope.groupId, scope.userId]);
    let member = members.get(key);
    if (!member) { member = { ...scope, daily: zero(), total: 0, ...products() }; members.set(key, member); group.members.push(member); }
    return { company, group, member };
  }
  // Include zero-use current users; membership and company identity remain server-side.
  const teamByUser = new Map<string, Team>();
  for (const team of listTeams()) for (const id of [team.leaderId, ...team.memberIds]) teamByUser.set(id, team);
  for (const user of listUsers()) if (!team || user.id === team.leaderId || team.memberIds.includes(user.id)) add(makeScope(user, teamByUser.get(user.id), new Date(now).toISOString()));
  for (const company of companies) if (!team && !company.groups.some(g => g.id === UNGROUPED)) company.groups.push({ id: UNGROUPED, name: '未分组个人', mode: 'personal', members: [], daily: zero(), total: 0, ...products() });
  if (dates.length) for (const row of usageRows(companyId, dates.at(-1)!, dates[0], team?.id)) {
    const target = add(row.scope); if (!target) continue;
    const index = dates.indexOf(row.day); if (index < 0) continue;
    for (const item of [target.company, target.group, target.member]) { item.daily[index] += row.cost; item.total += row.cost; }
  }
  if (dates.length) for (const row of productRows(companyId,dates.at(-1)!,dates[0],team?.id)) {
    const target = add(row.scope); if (!target) continue;
    const index = dates.indexOf(row.day); if (index < 0) continue;
    for (const item of [target.company,target.group,target.member]) for (const metrics of [item.products,item.dailyProducts[index]]) {
      const metric = metrics[row.kind];
      metric.quantity += row.quantity; metric.cost += row.cost; metric.knownCost += row.known_cost;
      metric.requests += row.requests; metric.missing += row.missing; metric.estimated += row.estimated;
      metric.average = metric.quantity > 0 ? metric.knownCost / metric.quantity : null;
    }
  }
  for (const company of companies) {
    company.userCount = new Set(company.groups.flatMap(g => g.members.map(m => m.userId))).size;
    company.teamCount = company.groups.filter(g => ![UNGROUPED, 'historical'].includes(g.id)).length;
    company.groups.sort((a,b) => a.id === UNGROUPED ? -1 : b.id === UNGROUPED ? 1 : b.total - a.total || a.name.localeCompare(b.name, 'zh-CN'));
    for (const group of company.groups) group.members.sort((a,b) => (a.role === '团长' ? 0 : 1) - (b.role === '团长' ? 0 : 1) || b.total-a.total || a.name.localeCompare(b.name, 'zh-CN'));
  }
  return { generatedAt: new Date(now).toISOString(), startAt: USAGE_REPORT_START, timezone: 'UTC', today, days: dates.length, from:dates.at(-1), to:dates[0], dates, companies };
}

/** Expose retail usage only, with request-time team membership preserved across transfers. */
export function getTeamUsageReport(team: Team, days: number, range?: {from:string;to:string}) {
  const {companies,...period} = getUsageReport('all',days,Date.now(),range,team);
  const company = companies[0];
  return {...period,team:{id:team.id,name:team.name,total:company.total,daily:company.daily,products:company.products,
    members:company.groups.flatMap(g => g.members).map(m => ({
      userId:m.userId,name:m.name,role:m.userId === team.leaderId ? '团长' : '成员',
      active:m.userId === team.leaderId || team.memberIds.includes(m.userId),
      total:m.total,daily:m.daily,products:m.products,
    })),
  }};
}

/** Personal outputs follow the initiator across company transfers and team changes. */
export function getPersonalProductReport(user: User, days: number, range?: {from:string;to:string}) {
  startUsageReports(false); flushUsage();
  const today = new Date().toISOString().slice(0,10), end = range?.to ?? today;
  const length = range ? Math.round((Date.parse(range.to)-Date.parse(range.from))/86400000)+1 : days;
  const dates = Array.from({length},(_,i)=>new Date(Date.parse(end)-i*86400000).toISOString().slice(0,10)).filter(d=>d>=USAGE_REPORT_START.slice(0,10));
  const products=productZero(), daily=dates.map(()=>0);
  if(dates.length)for(const row of productRows('all',dates.at(-1)!,dates[0],undefined,user.id)){
    const metric=products[row.kind];
    metric.quantity+=row.quantity;metric.cost+=row.cost;metric.knownCost+=row.known_cost;
    metric.requests+=row.requests;metric.missing+=row.missing;metric.estimated+=row.estimated;
    metric.average=metric.quantity>0?metric.knownCost/metric.quantity:null;
    daily[dates.indexOf(row.day)]+=row.cost;
  }
  const total=daily.reduce((a,b)=>a+b,0);
  return {generatedAt:new Date().toISOString(),startAt:USAGE_REPORT_START,timezone:'UTC',today,dates,
    person:{id:user.id,name:'个人成品',total,daily,products,members:[{userId:user.id,name:user.name||'我',role:'本人',active:true,total,daily,products}]}};
}
