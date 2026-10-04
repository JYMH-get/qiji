import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root = path.resolve(import.meta.dirname, '..'), sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qiji-four-routes-'));
fs.mkdirSync(path.join(sandbox, 'src')); fs.mkdirSync(path.join(sandbox, 'server/scripts'), { recursive: true });
fs.copyFileSync(path.join(root, 'src/contract.ts'), path.join(sandbox, 'src/contract.ts'));
for (const dir of ['src', 'skills']) fs.cpSync(path.join(root, 'server', dir), path.join(sandbox, 'server', dir), { recursive: true });
fs.copyFileSync(path.join(root, 'server/package.json'), path.join(sandbox, 'server/package.json'));
fs.symlinkSync(path.join(root, 'server/node_modules'), path.join(sandbox, 'server/node_modules'), 'junction');
for (const file of ['smoke-text-audio-routing.mjs', 'smoke-agent-lines.mjs']) {
  fs.copyFileSync(path.join(root, 'server/scripts', file), path.join(sandbox, 'server/scripts', file));
  execFileSync(process.execPath, ['--import', 'tsx', `scripts/${file}`], { cwd: path.join(sandbox, 'server'), stdio: 'inherit', env: { ...process.env, QIJI_TEST_SNAPSHOT: '1' } });
}
fs.writeFileSync(path.join(sandbox, 'server/restart-prices.mjs'), `import assert from 'node:assert/strict';import fs from 'node:fs';globalThis.fetch=async()=>{throw Error('No network')};const p=await import('./src/store/agentLinePrices.ts');const before=JSON.parse(fs.readFileSync('data/agent-price-restart-proof.json'));for(const row of before)assert.deepEqual(p.agentLineSetting(row.agentId,row.lineId),row.setting);const proof=JSON.parse(fs.readFileSync('data/agent-billing-restart-proof.json'));const users=await import('./src/store/users.ts'),agents=await import('./src/store/agents.ts');await (await import('./src/store/textBilling.ts')).recoverTextBillingResults();assert.deepEqual([users.getUser(proof.userId).credits,agents.getAgent(proof.agentId).credits],proof.balances);const gp=await import('./src/store/agentGroupPrices.ts');const gproof=JSON.parse(fs.readFileSync('data/group-price-restart-proof.json'));assert.equal(gp.groupPriceVersion(gproof.agentId),gproof.version);for(const r of gproof.rows)assert.deepEqual(gp.groupLineSetting(gproof.groupId,r.lineId),r.setting);console.log('Group price restart: '+gproof.rows.length+' settings retained');console.log('Agent prices restart: '+before.length+' scopes retained; token settlement remains idempotent');`);
execFileSync(process.execPath, ['--import', 'tsx', 'restart-prices.mjs'], { cwd: path.join(sandbox, 'server'), stdio: 'inherit' });
fs.writeFileSync(path.join(sandbox, 'server/preview.mjs'), `globalThis.fetch=async()=>{throw Error('Preview has no external network')};const {default:Fastify}=await import('fastify');const app=Fastify();app.get('/health',async()=>({ok:true,status:'ok',role:'source'}));await app.register((await import('./src/routes.ts')).registerRoutes);await app.register((await import('./src/routes/admin.ts')).registerAdminRoutes);await app.register((await import('./src/routes/agent.ts')).registerAgentRoutes);await app.listen({port:8798,host:'127.0.0.1'});console.log('Preview http://127.0.0.1:8798');`);
console.log('Sandbox:', sandbox);
fs.mkdirSync(path.join(root, 'outputs/agent-lines-20260915'), { recursive: true });
fs.writeFileSync(path.join(root, 'outputs/agent-lines-20260915/sandbox.txt'), sandbox);
