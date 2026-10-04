import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { bumpClientVersion, writeReleaseInstructions } from './client-release.mjs';

function fixture(version, run) {
  const root = mkdtempSync(join(tmpdir(), 'qiji-release-test-'));
  mkdirSync(join(root, 'src-tauri'));
  const write = (path, text) => writeFileSync(join(root, path), text);
  write('package.json', JSON.stringify({ name: 'Qiji', version, dependencies: { other: '2.0.2' } }));
  write('package-lock.json', JSON.stringify({ version, packages: { '': { version }, 'node_modules/other': { version: '2.0.2' } } }));
  write('src-tauri/tauri.conf.json', JSON.stringify({ version, identifier: 'com.qiji.canvas' }));
  write('src-tauri/Cargo.toml', `[package]\r\nname = "app"\r\nversion = "${version}"\r\n[dependencies]\r\nother = "2.0.2"\r\n`);
  write('src-tauri/Cargo.lock', `version = 3\n\n[[package]]\nname = "other"\nversion = "2.0.2"\n\n[[package]]\nname = "app"\nversion = "${version}"\n`);
  try { run(root, write); } finally {
    const target = realpathSync(root);
    assert.equal(dirname(target), realpathSync(tmpdir()));
    assert.ok(basename(target).startsWith('qiji-release-test-'));
    rmSync(target, { recursive: true, force: true });
  }
}
test('连续打包每次只递增补丁号，并同步所有版本位置', () => fixture('2.0.9', root => {
  assert.equal(bumpClientVersion(root).version, '2.0.10');
  assert.equal(bumpClientVersion(root).version, '2.0.11');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json')));
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json')));
  const tauri = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json')));
  assert.deepEqual([pkg.version, lock.version, lock.packages[''].version, tauri.version], Array(4).fill('2.0.11'));
  assert.equal(pkg.dependencies.other, '2.0.2'); assert.equal(lock.packages['node_modules/other'].version, '2.0.2');
  assert.equal(tauri.identifier, 'com.qiji.canvas');
  assert.match(readFileSync(join(root, 'src-tauri/Cargo.lock'), 'utf8'), /name = "app"\nversion = "2.0.11"/);
  assert.match(readFileSync(join(root, 'src-tauri/Cargo.toml'), 'utf8'), /version = "2.0.11"\r\n/);
}));
test('配置不一致时拒绝且不修改其他文件', () => fixture('2.0.2', (root, write) => {
  const previous = readFileSync(join(root, 'package.json'), 'utf8');
  write('src-tauri/tauri.conf.json', '{"version":"2.0.1"}');
  assert.throws(() => bumpClientVersion(root), /不一致/);
  assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), previous);
}));
test('只在显式选择时递增大/小版本', () => fixture('2.7.9', root => {
  assert.equal(bumpClientVersion(root, 'minor').version, '2.8.0');
  assert.equal(bumpClientVersion(root, 'major').version, '3.0.0');
}));
test('生成说明使用本次产物版本和文件名，不沿用演练描述', () => fixture('2.0.3', (root, write) => {
  write('update-release.json', JSON.stringify({ version: '2.0.3', filename: 'Qiji_2.0.3_x64-setup.exe', feedUrl: 'https://example.test/stable.json' }));
  writeReleaseInstructions(root);
  const steps = readFileSync(join(root, '推送更新步骤.txt'), 'utf8');
  const notes = readFileSync(join(root, '更新说明.txt'), 'utf8');
  assert.match(steps, /Qiji_2.0.3_x64-setup.exe/); assert.match(steps, /update-release.json/);
  assert.match(notes, /v2.0.3/); assert.doesNotMatch(notes, /演练/);
}));
