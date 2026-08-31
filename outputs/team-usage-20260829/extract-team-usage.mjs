import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ssh = "C:/Program Files/Git/usr/bin/ssh.exe";
const output = resolve(process.argv[2] || "outputs/team-usage-20260829/team-usage-data.json");

const remoteScript = String.raw`set -euo pipefail
docker exec -i qiji-server node <<'NODE'
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const dataDir = '/app/server/data';
const usersRaw = JSON.parse(fs.readFileSync(dataDir + '/users.json', 'utf8'));
const teamsRaw = JSON.parse(fs.readFileSync(dataDir + '/teams.json', 'utf8'));
const agentsRaw = JSON.parse(fs.readFileSync(dataDir + '/agents.json', 'utf8'));
const users = Array.isArray(usersRaw) ? usersRaw : (usersRaw.users || []);
const teams = Array.isArray(teamsRaw) ? teamsRaw : (teamsRaw.teams || []);
const agents = Array.isArray(agentsRaw) ? agentsRaw : (agentsRaw.agents || []);
const userById = new Map(users.map((u) => [u.id, u]));
const agentById = new Map(agents.map((a) => [a.id, a]));

const now = new Date();
const dates = [];
for (let i = 29; i >= 0; i--) dates.push(new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10));
const firstDay = dates[0];
const daySet = new Set(dates);

const currentTeams = [];
const teamUserIds = new Set();
const warnings = [];
for (const t of teams) {
  const ids = [t.leaderId, ...(Array.isArray(t.memberIds) ? t.memberIds : [])];
  const members = [];
  for (const [index, id] of ids.entries()) {
    const u = userById.get(id);
    if (!u) {
      warnings.push('团队 ' + t.name + ' 引用了不存在的用户 ' + id);
      continue;
    }
    teamUserIds.add(id);
    members.push({
      id,
      name: u.name || u.account || id,
      account: u.account || '',
      role: index === 0 ? '团长' : '成员',
      agentId: u.agentId || null,
    });
  }
  if (!members.length) continue;
  const leader = userById.get(t.leaderId);
  const companyAgent = leader?.agentId ? agentById.get(leader.agentId) : null;
  const companyId = companyAgent?.id || 'source';
  const companyName = companyAgent ? (companyAgent.name || companyAgent.account || companyAgent.id) : '源站';
  for (const member of members) {
    const memberCompanyId = member.agentId && agentById.has(member.agentId) ? member.agentId : 'source';
    if (memberCompanyId !== companyId) {
      warnings.push('团队 ' + (t.name || t.id) + ' 的成员 ' + member.id + ' 个人公司标记与团长公司不一致；公司报表按团长公司 ' + companyName + ' 整组归属');
    }
  }
  currentTeams.push({ id: t.id, name: t.name || t.id, creditMode: t.creditMode || '', companyId, companyName, members });
}

const currentUserIds = new Set(users.map((u) => u.id));
const ungroupedUsers = users
  .filter((u) => !teamUserIds.has(u.id))
  .map((u) => ({
    id: u.id,
    name: u.name || u.account || u.id,
    account: u.account || '',
    role: '个人',
    companyId: u.agentId && agentById.has(u.agentId) ? u.agentId : 'source',
    companyName: u.agentId && agentById.has(u.agentId)
      ? (agentById.get(u.agentId).name || agentById.get(u.agentId).account || u.agentId)
      : '源站',
  }));
const agentReports = agents.map((a) => ({
  id: a.id,
  name: a.name || a.account || a.id,
  users: users
    .filter((u) => u.agentId === a.id)
    .map((u) => ({ id: u.id, name: u.name || u.account || u.id, account: u.account || '', role: '用户' })),
}));
const companies = [
  { id: 'source', name: '源站' },
  ...agents.map((a) => ({ id: a.id, name: a.name || a.account || a.id })),
].map((company) => ({
  ...company,
  teams: currentTeams.filter((t) => t.companyId === company.id),
  ungroupedUsers: ungroupedUsers.filter((u) => u.companyId === company.id),
}));
const dailyByUser = Object.fromEntries([...currentUserIds].map((id) => [id, Object.fromEntries(dates.map((d) => [d, 0]))]));
const allCreditsByDay = Object.fromEntries(dates.map((d) => [d, 0]));
const db = new DatabaseSync(dataDir + '/qiji.db', { readOnly: true });
const rows = db.prepare('SELECT day, meta FROM logs WHERE day >= ? ORDER BY started_at').all(firstDay);
let includedLogs = 0;
let teamLogs = 0;
let currentUserLogs = 0;
let ungroupedLogs = 0;
for (const row of rows) {
  let m;
  try { m = JSON.parse(row.meta); } catch { continue; }
  const day = String(m.startedAt || row.day || '').slice(0, 10);
  if (!daySet.has(day) || m.status === 'failed') continue;
  const cost = Number(m.cost || 0);
  if (!Number.isFinite(cost)) continue;
  allCreditsByDay[day] += cost;
  includedLogs += 1;
  if (m.userId && dailyByUser[m.userId]) {
    dailyByUser[m.userId][day] += cost;
    currentUserLogs += 1;
    if (teamUserIds.has(m.userId)) teamLogs += 1;
    else ungroupedLogs += 1;
  }
}

const creditRows = db.prepare("SELECT status, COUNT(*) AS n FROM credit_ops WHERE created_at >= ? GROUP BY status ORDER BY status").all(Date.parse(firstDay + 'T00:00:00Z'));
console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  timezone: 'UTC',
  dates,
  teams: currentTeams,
  ungroupedUsers,
  agents: agentReports,
  companies,
  dailyByUser,
  allCreditsByDay,
  checks: { logRowsRead: rows.length, includedLogs, currentUserLogs, teamLogs, ungroupedLogs, creditOpStatusCounts: creditRows },
  warnings,
}));
NODE
`;

const raw = execFileSync(ssh, ["-o", "BatchMode=yes", "qiji", "bash", "-s"], {
  input: remoteScript,
  encoding: "utf8",
  maxBuffer: 128 << 20,
});
const parsed = JSON.parse(raw);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(parsed, null, 2), "utf8");
console.log(JSON.stringify({
  output,
  generatedAt: parsed.generatedAt,
  dates: [parsed.dates[0], parsed.dates.at(-1)],
  teams: parsed.teams.length,
  members: parsed.teams.reduce((n, t) => n + t.members.length, 0),
  ungroupedUsers: parsed.ungroupedUsers.length,
  agents: parsed.agents.length,
  agentUsers: parsed.agents.reduce((n, a) => n + a.users.length, 0),
  checks: parsed.checks,
  warnings: parsed.warnings,
}, null, 2));
