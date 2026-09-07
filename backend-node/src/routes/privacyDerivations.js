const response = require('../response');
const service = require('../services/privacyDerivationService');

module.exports = function privacyRoutes(db, cfg, log = console) {
  const fail = (res, error) => { log.error?.('privacy derivation', { error: error.message, code: error.code }); response.badRequest(res, error.message); };
  return {
    list(req, res) { try { response.success(res, { items: service.list(db, req.query || {}) }); } catch (error) { fail(res, error); } },
    derive: async (req, res) => { try { response.created(res, await service.derive(db, cfg, req.body || {})); } catch (error) { fail(res, error); } },
    remove(req, res) { try { response.success(res, service.remove(db, cfg, req.params.id)); } catch (error) { fail(res, error); } },
  };
};
