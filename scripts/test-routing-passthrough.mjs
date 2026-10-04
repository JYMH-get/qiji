import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qiji-routing-passthrough-'));
fs.mkdirSync(path.join(sandbox, 'src'));
fs.mkdirSync(path.join(sandbox, 'server/scripts'), { recursive: true });
fs.copyFileSync(path.join(root, 'src/contract.ts'), path.join(sandbox, 'src/contract.ts'));
for (const directory of ['src', 'skills']) {
  fs.cpSync(path.join(root, 'server', directory), path.join(sandbox, 'server', directory), { recursive: true });
}
fs.copyFileSync(path.join(root, 'server/package.json'), path.join(sandbox, 'server/package.json'));
fs.symlinkSync(path.join(root, 'server/node_modules'), path.join(sandbox, 'server/node_modules'), 'junction');
fs.copyFileSync(path.join(root, 'server/scripts/smoke-routing-passthrough.mjs'), path.join(sandbox, 'server/scripts/smoke-routing-passthrough.mjs'));
console.log('Sandbox:', sandbox);
execFileSync(process.execPath, ['--import', 'tsx', 'scripts/smoke-routing-passthrough.mjs'], {
  cwd: path.join(sandbox, 'server'), stdio: 'inherit',
  env: { ...process.env, QIJI_TEST_SNAPSHOT: '1', ADMIN_TOKEN: 'routing-passthrough-admin', NODE_ROLE: 'origin' },
});
