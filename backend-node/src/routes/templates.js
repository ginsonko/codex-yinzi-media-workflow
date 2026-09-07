const response = require('../response');
const catalog = require('../services/templateCatalog');

module.exports = function templateRoutes(log = console) {
  return {
    list(req, res) {
      try { response.success(res, catalog.listTemplates(req.query || {})); }
      catch (error) { log.error?.('List templates failed', { error: error.message }); response.internalError(res, '获取模板目录失败'); }
    },
    get(req, res) {
      const item = catalog.getTemplate(req.params.id);
      if (!item) return response.notFound(res, '模板不存在');
      return response.success(res, item);
    },
  };
};
