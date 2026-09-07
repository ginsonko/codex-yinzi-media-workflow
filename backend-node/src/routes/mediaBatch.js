const response = require('../response');

function routes(service, log = console) {
  function fail(res, error) {
    log.error?.('media batch', { error: error.message, code: error.code });
    const status = error.code === 'MEDIA_BATCH_NOT_FOUND' ? 404 : (String(error.code || '').endsWith('_INVALID') ? 400 : 422);
    return response.error(res, status, error.code || 'MEDIA_BATCH_ERROR', error.message || '批量任务失败');
  }
  return {
    list(req, res) {
      try { return response.success(res, service.list(req.query || {})); } catch (e) { return fail(res, e); }
    },
    create(req, res) {
      try { return response.created(res, service.create(req.body || {})); } catch (e) { return fail(res, e); }
    },
    get(req, res) {
      try {
        const item = service.get(req.params.id, req.query || {});
        if (!item) return response.error(res, 404, 'MEDIA_BATCH_NOT_FOUND', '批量任务不存在');
        return response.success(res, item);
      } catch (e) { return fail(res, e); }
    },
    pause(req, res) {
      try {
        const item = service.pause(req.params.id);
        if (!item) return response.error(res, 404, 'MEDIA_BATCH_NOT_FOUND', '批量任务不存在');
        return response.success(res, item);
      } catch (e) { return fail(res, e); }
    },
    resume(req, res) {
      try {
        const item = service.resume(req.params.id);
        if (!item) return response.error(res, 404, 'MEDIA_BATCH_NOT_FOUND', '批量任务不存在');
        return response.success(res, item);
      } catch (e) { return fail(res, e); }
    },
    retry(req, res) {
      try {
        const item = service.retryItem(req.params.id, req.params.itemId, req.body || {});
        if (!item) return response.error(res, 404, 'MEDIA_BATCH_ITEM_NOT_FOUND', '批量项目不存在');
        return response.success(res, item);
      } catch (e) { return fail(res, e); }
    },
  };
}
module.exports = routes;
