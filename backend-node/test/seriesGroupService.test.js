const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const service = require('../src/services/seriesGroupService');
let db;
beforeEach(() => { db = new Database(':memory:'); const old = console.log; const oldWarn = console.warn; console.log = () => {}; console.warn = () => {}; try { runMigrationsAndEnsure(db); } finally { console.log = old; console.warn = oldWarn; } });
afterEach(() => db.close());
describe('series group immutable assets', () => {
  it('creates versions, reuses explicit versions, and forks edits without mutating the source', () => {
    const group = service.createGroup(db, { name: '星尘系列' }); service.addEpisode(db, group.id, { drama_id: 1, episode_id: 1 });
    const first = service.upsertAsset(db, group.id, { asset_key: 'hero-lin', asset_type: 'character', title: '林夏', content: { hair: 'silver' } });
    const asset = first.assets[0]; assert.equal(asset.current_version, 1);
    const second = service.upsertAsset(db, group.id, { asset_key: 'hero-lin', asset_type: 'character', content: { hair: 'silver', coat: 'blue' } });
    assert.equal(second.assets[0].current_version, 2); assert.equal(second.assets[0].versions.length, 2);
    const ref = service.reuseAsset(db, group.id, { series_asset_id: asset.id, series_asset_version_id: 1, drama_id: 2, episode_id: 3 });
    assert.equal(ref.reference.mode, 'reuse'); assert.equal(ref.asset.version.version, 1);
    const forked = service.forkAsset(db, group.id, { series_asset_id: asset.id, series_asset_version_id: 1, new_asset_key: 'hero-lin-ep2', content: { hair: 'silver', coat: 'red' } });
    assert.ok(forked.assets.some((item) => item.asset_key === 'hero-lin-ep2')); assert.equal(service.getGroup(db, group.id).assets.find((item) => item.asset_key === 'hero-lin').current_version, 2);
  });
  it('is idempotent for episode membership and reuse refs', () => {
    const group = service.createGroup(db, { name: '系列二' }); service.addEpisode(db, group.id, { drama_id: 1, episode_id: 1 }); service.addEpisode(db, group.id, { drama_id: 1, episode_id: 1 });
    service.upsertAsset(db, group.id, { asset_key: 'scene', asset_type: 'scene', content: { place: 'garden' } });
    const asset = service.getGroup(db, group.id).assets[0]; service.reuseAsset(db, group.id, { series_asset_id: asset.id, drama_id: 1, episode_id: 1 }); service.reuseAsset(db, group.id, { series_asset_id: asset.id, drama_id: 1, episode_id: 1 });
    assert.equal(service.getGroup(db, group.id).episodes.length, 1); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM episode_asset_refs').get().n, 1);
  });

  it('builds path-free generation context with selected and advisory candidates', () => {
    const group = service.createGroup(db, { name: '系列上下文' });
    service.addEpisode(db, group.id, { drama_id: 10, episode_id: 1 });
    const asset = service.upsertAsset(db, group.id, { asset_key: 'hero', asset_type: 'character', title: '主角', content: { identity: 'silver hair' } }).assets[0];
    service.upsertAsset(db, group.id, { asset_key: 'scene', asset_type: 'scene', title: '场景', content: { location: 'city' } });
    service.reuseAsset(db, group.id, { series_asset_id: asset.id, drama_id: 10, episode_id: 1 });
    const context = service.buildGenerationContext(db, { drama_id: 10, episode_id: 1 });
    assert.equal(context.group.name, '系列上下文');
    assert.equal(context.selected[0].asset_key, 'hero');
    assert.equal(context.candidates.find((item) => item.asset_key === 'scene').selected, false);
    assert.equal(JSON.stringify(context).includes('source_path'), false);
  });
});
