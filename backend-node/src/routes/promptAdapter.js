const express = require('express');
const response = require('../response');
module.exports = function promptAdapterRoutes() {
  const router = express.Router();
  router.get('/profiles', async (req, res, next) => {
    try { const {listProfiles} = await import('../services/promptAdapter/index.mjs'); response.success(res, {profiles:listProfiles()}); }
    catch (error) { next(error); }
  });
  router.post('/', async (req, res, next) => {
    try {
      const {executePromptRequest} = await import('../services/promptAdapter/index.mjs');
      const result = executePromptRequest(req.body);
      if (result.success === false) return response.error(res, 400, result.code || 'PROMPT_ADAPT_FAILED', (result.errors || []).join('; '), result);
      response.success(res, result);
    } catch (error) { next(error); }
  });
  return router;
};