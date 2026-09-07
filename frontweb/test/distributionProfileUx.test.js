import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

describe('发行版入口隔离', () => {
  it('只在智能路由 profile 下渲染首页银子入口，并把通用缺口导向老李配置', () => {
    const source = read('views/FilmList.vue');
    assert.match(source, /v-if="distributionProfile\?\.smart_routing_entry" class="yinzi-link"/);
    assert.match(source, /openConfigDialog\(distributionProfile\?\.smart_routing_entry \? 'yinzi' : 'laoli'\)/);
    assert.match(source, /configInitialAction\.value = action === 'yinzi' \? 'yinzi' : action === 'laoli' \? 'laoli'/);
    assert.match(source, /v-if="distributionProfile\?\.smart_routing_entry" href="https:\/\/www\.yinziapi\.top"/);
  });

  it('通用帮助与模拟入口根据 profile 选择老李，不固定跳转银子', () => {
    const help = read('views/HelpCenter.vue');
    const demo = read('views/GuidedDemo.vue');
    assert.match(help, /distributionProfile(?:\.value)?\.smart_routing_entry \? 'yinzi' : 'laoli'/);
    assert.match(help, /<ol v-else>[\s\S]*老李站点没有文本模型/);
    assert.match(demo, /distributionProfile\.value\.smart_routing_entry \? 'yinzi' : 'laoli'/);
    assert.doesNotMatch(demo, /query: \{ config: 'yinzi' \}/);
  });

  it('老李弹窗使用三组独立 URL 字段，不再绑定单一 base_url', () => {
    const source = read('components/AIConfigContent.vue');
    for (const field of ['text_base_url', 'image_base_url', 'video_base_url']) assert.match(source, new RegExp(`oneKeyLaoliForm\\.${field}`));
    assert.doesNotMatch(source, /oneKeyLaoliForm\.base_url/);
  });
});
