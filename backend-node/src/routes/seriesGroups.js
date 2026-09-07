const response = require('../response');
const service = require('../services/seriesGroupService');
function routes(db, log) {
  function fail(res, error) { log.error('series groups', { error: error.message, code: error.code }); return response.badRequest(res, error.message); }
  return {
    list: (req, res) => { try { response.success(res, service.listGroups(db, req.query || {})); } catch (e) { fail(res, e); } },
    create: (req, res) => { try { response.created(res, service.createGroup(db, req.body || {})); } catch (e) { fail(res, e); } },
    get: (req, res) => { try { const group = service.getGroup(db, req.params.id); if (!group) return response.notFound(res, '剧集组不存在'); response.success(res, group); } catch (e) { fail(res, e); } },
    addEpisode: (req, res) => { try { response.success(res, service.addEpisode(db, req.params.id, req.body || {})); } catch (e) { fail(res, e); } },
    assets: (req, res) => { try { const result = service.listReusableAssets(db, req.params.id, req.query || {}); if (!result) return response.notFound(res, '剧集组不存在'); response.success(res, result); } catch (e) { fail(res, e); } },
    upsertAsset: (req, res) => { try { response.success(res, service.upsertAsset(db, req.params.id, req.body || {})); } catch (e) { fail(res, e); } },
    reuse: (req, res) => { try { response.success(res, service.reuseAsset(db, req.params.id, req.body || {})); } catch (e) { fail(res, e); } },
    fork: (req, res) => { try { response.success(res, service.forkAsset(db, req.params.id, req.body || {})); } catch (e) { fail(res, e); } },
  };
}
module.exports = routes;
