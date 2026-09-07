'use strict';

const fs = require('fs');
const path = require('path');
const { assertNoSecrets, resolveMacVariant } = require('./mac-build-utils');

const desktopDir = path.join(__dirname, '..');
const variant = resolveMacVariant();
const required = [
  'main.js',
  'runtime.js',
  'package.json',
  variant.config,
  'backend-app/src/app.js',
  'frontweb-dist/index.html',
  'build/icon.png',
  'LICENSE.txt',
  'THIRD_PARTY_NOTICES.txt',
  'release-docs/Mac小白测试说明.md',
  'release-docs/Mac发布说明.md',
];

for (const relative of required) {
  if (!fs.existsSync(path.join(desktopDir, relative))) throw new Error(`Mac 发布输入缺失：desktop/${relative}`);
}
const config = JSON.parse(fs.readFileSync(path.join(desktopDir, variant.config), 'utf8'));
if (config.appId !== variant.appId) throw new Error(`${variant.id} Mac appId 与当前产品不一致`);
if (config.productName !== variant.productName) throw new Error(`${variant.id} Mac 产品名与当前产品不一致`);
if (config.executableName !== variant.productName) throw new Error(`${variant.id} Mac 可执行文件名与产品不一致`);
if (config.directories?.output !== variant.output) throw new Error(`${variant.id} Mac 构建输出目录错误`);
if (Object.hasOwn(config.mac || {}, 'identity')) throw new Error('Mac 配置不得永久关闭证书发现');
const targets = Array.isArray(config.mac?.target) ? config.mac.target : [];
if (!targets.includes('dmg') || !targets.includes('zip')) throw new Error('Mac 原生构建必须同时输出 DMG 和 ZIP');
assertNoSecrets([
  path.join(desktopDir, 'backend-app'),
  path.join(desktopDir, 'frontweb-dist'),
  path.join(desktopDir, 'release-docs'),
  path.join(desktopDir, 'main.js'),
  path.join(desktopDir, 'runtime.js'),
], new Set(['.js', '.json', '.yaml', '.yml', '.html', '.css', '.md', '.txt', '.svg']));
console.log(`[mac-input] ${variant.id} 品牌、输出边界、发布输入与凭据扫描通过。`);
