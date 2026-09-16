const { inventorySummary } = require('../src/services/orchestrationModuleCatalog');
console.log(JSON.stringify(inventorySummary(), null, 2));
