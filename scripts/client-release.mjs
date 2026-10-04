import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appTomlVersion = /(^\[package\]\r?\n[\s\S]*?^version\s*=\s*")([^"]+)(")/m;
const appLockVersion = /(^\[\[package\]\]\r?\nname = "app"\r?\nversion = ")([^"]+)(")/m;
const jsonText = (data, original) => JSON.stringify(data, null, original.includes('\n\t') ? '\t' : 2).replace(/\n/g, original.includes('\r\n') ? '\r\n' : '\n') + (original.includes('\r\n') ? '\r\n' : '\n');

export function bumpClientVersion(root, increment = 'patch') {
  if (!['patch', 'minor', 'major'].includes(increment)) throw new Error('版本递增规则须为 patch/minor/major');
  const names = ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock'];
  const original = names.map(name => readFileSync(resolve(root, name), 'utf8'));
  const [pkg, lock, tauri] = original.slice(0, 3).map(text => JSON.parse(text.replace(/^\uFEFF/, '')));
  const versions = [pkg.version, lock.version, lock.packages?.['']?.version, tauri.version,
    original[3].match(appTomlVersion)?.[2], original[4].match(appLockVersion)?.[2]];
  const previous = pkg.version;
  if (typeof previous !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(previous)
    || versions.some(v => v !== previous)) throw new Error('客户端版本配置不一致或不是 x.y.z，已停止且未修改文件');
  const parts = previous.split('.').map(Number);
  const index = { major: 0, minor: 1, patch: 2 }[increment];
  parts[index]++;
  for (let i = index + 1; i < 3; i++) parts[i] = 0;
  if (!parts.every(Number.isSafeInteger)) throw new Error('版本号超出安全整数范围');
  const version = parts.join('.');
  pkg.version = lock.version = lock.packages[''].version = tauri.version = version;
  const updated = [jsonText(pkg, original[0]), jsonText(lock, original[1]), jsonText(tauri, original[2]),
    original[3].replace(appTomlVersion, (_all, a, _old, b) => a + version + b),
    original[4].replace(appLockVersion, (_all, a, _old, b) => a + version + b)];
  let written = 0;
  try {
    for (let i = 0; i < names.length; i++) { written = i + 1; writeFileSync(resolve(root, names[i]), updated[i]); }
  } catch (error) {
    for (let i = 0; i < written; i++) writeFileSync(resolve(root, names[i]), original[i]);
    throw error;
  }
  return { previous, version, increment };
}

export function writeReleaseInstructions(directory) {
  const release = JSON.parse(readFileSync(resolve(directory, 'update-release.json'), 'utf8').replace(/^\uFEFF/, ''));
  const notes = `Qiji v${release.version} 更新\n请在推送前将此行替换为本次实际更新内容，再粘贴到后台「本次更新说明」。\n`;
  const steps = `Qiji v${release.version} 推送更新步骤

1. 确认服务端已部署自动更新发布功能，登录后台 → 网页管理 → 客户端自动更新。
2. 更新发布文件选择本目录的 update-release.json。
3. Windows安装包选择本目录的 ${release.filename}。
   JSON已包含签名，不需要另选.sig；两个文件必须来自同一次打包。
4. 编辑本目录「更新说明.txt」，补充实际更新内容并粘贴到后台。
5. 点击「上传、验签并发布更新」，等待显示「v${release.version} 已发布」。
6. 在低于v${release.version}且支持更新的客户端中点击「检查更新」；下载后点击「保存并重启安装」。
7. 重启后确认版本为v${release.version}，并检查项目、素材和登录状态。

旧v2.0.0需先手动安装一次支持自动更新的版本（v2.0.1及以上）。
此入口面向使用同一更新地址的旧客户端发布。打包本身不会上传或推送。
官网普通安装包下载链接与客户端自动更新入口分别管理。
更新地址：${release.feedUrl}

版本规则：双击打包BAT默认补丁号+1，例如2.0.9→2.0.10；失败后已递增的版本号保留，下次继续+1。
每次自动生成EXE/MSI、.sig、update-release.json、哈希及本推送说明。
大版本变更时再调整BAT的QIJI_VERSION_INCREMENT，平时保持patch。
`;
  writeFileSync(resolve(directory, '更新说明.txt'), '\uFEFF' + notes.replace(/\n/g, '\r\n'));
  writeFileSync(resolve(directory, '推送更新步骤.txt'), '\uFEFF' + steps.replace(/\n/g, '\r\n'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, path, increment] = process.argv.slice(2);
  if (!path) throw new Error('请提供项目或产物目录');
  if (command === 'bump') {
    const result = bumpClientVersion(path, increment);
    console.log(`客户端版本：${result.previous} → ${result.version} (${result.increment})`);
  } else if (command === 'instructions') {
    writeReleaseInstructions(path);
    console.log('已生成更新说明.txt、推送更新步骤.txt');
  } else throw new Error('未知命令');
}
