const response = require('../response');
const service = require('../services/assetImportService');
const multer = require('multer');
const path = require('node:path');
const fs = require('node:fs');
function routes(db, cfg, log, injected = {}) {
  const adapters = injected.assetImport || {};
  // Write multipart bytes directly into the controlled session staging root.
  // The previous process-temp handoff relied on rename/copy across drives and
  // could leave a missing source before the route had a chance to scan it.
  const storageRoot = path.resolve(cfg?.storage?.local_path || './data/storage');
  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, _file, callback) => {
        try {
          const sessionId = String(req.params.id || '').trim();
          if (!sessionId || !/^[a-zA-Z0-9-]{8,128}$/.test(sessionId)) return callback(new Error('导入会话标识无效'));
          const stagingRoot = path.resolve(storageRoot, 'imports', '.staging', sessionId);
          const relative = path.relative(storageRoot, stagingRoot).replace(/\\/g, '/');
          if (relative.startsWith('..') || path.isAbsolute(relative) || !relative.startsWith('imports/.staging/')) return callback(new Error('导入暂存目录无效'));
          fs.mkdirSync(stagingRoot, { recursive: true });
          callback(null, stagingRoot);
        } catch (error) { callback(error); }
      },
      filename: (_req, file, callback) => callback(null, `${require('node:crypto').randomUUID()}${path.extname(file.originalname || '').toLowerCase()}`),
    }),
    limits: { files: service.MAX_FILES, fileSize: 500 * 1024 * 1024 },
  });
  const uploadFiles = (req, res, next) => upload.array('files', service.MAX_FILES)(req, res, (error) => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') return response.error(res, 413, 'ASSET_IMPORT_FILE_TOO_LARGE', '单个导入文件不能超过 500MB，请压缩或拆分后重试');
    if (error.code === 'LIMIT_FILE_COUNT') return response.error(res, 413, 'ASSET_IMPORT_TOO_MANY_FILES', `导入文件不能超过 ${service.MAX_FILES} 个`);
    return response.badRequest(res, error.message || '导入文件上传失败');
  });
  function fail(res, error) { log.error('asset import', { error: error.message, code: error.code }); return response.badRequest(res, error.message); }
  return {
    list: (req, res) => { try { response.success(res, service.listSessions(db, req.query || {})); } catch (e) { fail(res, e); } },
    create: (req, res) => { try { response.created(res, service.getPublicSession(db, service.createSession(db, req.body || {}).id)); } catch (e) { fail(res, e); } },
    get: (req, res) => { try { const item = service.getSession(db, req.params.id); if (!item) return response.notFound(res, '导入会话不存在'); response.success(res, { session: service.getPublicSession(db, item.id), items: service.listItems(db, item.id).map(service.publicItem) }); } catch (e) { fail(res, e); } },
    upload: [uploadFiles, (req, res) => {
      try {
        const rawPaths = req.body?.relative_paths;
        let relativePaths = [];
        if (rawPaths) { try { relativePaths = Array.isArray(rawPaths) ? rawPaths : JSON.parse(rawPaths); } catch (_) { relativePaths = []; } }
        const result = service.stageUploadedFiles(db, cfg, req.params.id, req.files || [], relativePaths);
        if (!result) return response.notFound(res, '导入会话不存在');
        response.success(res, result);
      } catch (e) { fail(res, e); }
      finally {
        // Files successfully staged have been atomically renamed; failed or
        // rejected uploads must not accumulate in the process temp directory.
        for (const file of req.files || []) { try { if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path); } catch (_) {} }
      }
    }],
    scan: async (req, res) => { try { const result = await service.scanSession(db, req.params.id, req.body || {}, adapters, log); if (!result) return response.notFound(res, '导入会话不存在'); response.success(res, result); } catch (e) { fail(res, e); } },
    reorganize: async (req, res) => { try { const result = await service.reorganizeSession(db, req.params.id, req.body || {}, adapters, log); if (!result) return response.notFound(res, '导入会话不存在'); response.success(res, result); } catch (e) { fail(res, e); } },
    updatePlan: (req, res) => { try { const result = service.updatePlan(db, req.params.id, req.body || {}); if (!result) return response.notFound(res, '导入会话不存在'); response.success(res, result); } catch (e) { fail(res, e); } },
    plan: (req, res) => { try { const item = service.getSession(db, req.params.id); if (!item) return response.notFound(res, '导入会话不存在'); response.success(res, { plan: service.publicPlan(item.plan), items: service.listItems(db, item.id).map(service.publicItem) }); } catch (e) { fail(res, e); } },
    apply: (req, res) => { try { const result = service.applySession(db, cfg, req.params.id, req.body || {}); if (!result) return response.notFound(res, '导入会话不存在'); response.success(res, { ...result, session: service.getPublicSession(db, req.params.id) }); } catch (e) { fail(res, e); } },
    rollback: (req, res) => { try { const result = service.rollbackSession(db, cfg, req.params.id); if (!result) return response.notFound(res, '导入会话不存在'); response.success(res, { ...result, session: service.getPublicSession(db, req.params.id) }); } catch (e) { fail(res, e); } },
  };
}
module.exports = routes;
