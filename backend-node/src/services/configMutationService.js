const bundles = require('./configBundleService');

function withAutomaticSnapshot(db, reason, mutate) {
  const tx = db.transaction(() => {
    const snapshot = bundles.createSnapshot(db, {
      snapshot_type: 'automatic',
      reason: String(reason || '配置变更前自动快照'),
    });
    return { snapshot, result: mutate() };
  });
  return tx.immediate();
}

module.exports = { withAutomaticSnapshot };
