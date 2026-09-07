const path = require('path');
const multer = require('multer');
const response = require('../response');
const uploadService = require('../services/uploadService');
const storageLayout = require('../services/storageLayout');

const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
const maxSize = 16 * 1024 * 1024; // 16MB，单张图片上限
const MAX_SIZE_MB = 16;

const memoryStorage = multer.memoryStorage();
const upload = multer({
  storage: memoryStorage,
  limits: { fileSize: maxSize },
  fileFilter: (req, file, cb) => {
    const ct = file.mimetype || 'application/octet-stream';
    if (!allowedTypes.includes(ct)) {
      return cb(new Error('只支持图片格式 (jpg, png, gif, webp)'));
    }
    cb(null, true);
  },
});

// Seedance 2.0 音色参考音频上传（支持常见音频格式）
const allowedAudioTypes = [
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/m4a',
  'audio/ogg',
  'audio/webm',
];
const audioMaxSize = 10 * 1024 * 1024; // 10MB
const audioUpload = multer({
  storage: memoryStorage,
  limits: { fileSize: audioMaxSize },
  fileFilter: (req, file, cb) => {
    const ct = file.mimetype || 'application/octet-stream';
    if (!allowedAudioTypes.includes(ct)) {
      return cb(new Error('只支持音频格式 (mp3, wav, m4a, ogg)'));
    }
    cb(null, true);
  },
});

const referenceMediaLimits = Object.freeze({
  image: 30 * 1024 * 1024,
  video: 50 * 1024 * 1024,
  audio: 15 * 1024 * 1024,
});
const referenceMediaUpload = multer({
  storage: memoryStorage,
  limits: { fileSize: referenceMediaLimits.video },
  fileFilter: (req, file, cb) => {
    const mediaType = String(file.mimetype || '').split('/')[0];
    if (!referenceMediaLimits[mediaType]) {
      return cb(new Error('参考媒体仅支持图片、视频或音频文件'));
    }
    cb(null, true);
  },
});

function routes(cfg, log, db) {
  const singleUpload = upload.single('file');
  return {
    multerSingle: singleUpload,
    uploadImage: (req, res) => {
      if (!req.file || !req.file.buffer) {
        return response.badRequest(res, '请选择文件');
      }
      try {
        const rawStorage = cfg?.storage?.local_path || './data/storage';
        const storagePath = path.isAbsolute(rawStorage)
          ? rawStorage
          : path.join(process.cwd(), rawStorage);
        const baseUrl = cfg?.storage?.base_url || '';
        let projectSubdir = null;
        if (db) {
          const raw = req.body?.drama_id;
          const did =
            raw !== undefined && raw !== null && String(raw).trim() !== ''
              ? Number(raw)
              : NaN;
          if (Number.isFinite(did) && did > 0) {
            projectSubdir = storageLayout.getProjectStorageSubdir(db, did);
          }
        }
        const result = uploadService.uploadFile(
          storagePath,
          baseUrl,
          log,
          req.file.buffer,
          req.file.originalname || 'image.png',
          req.file.mimetype,
          'uploads',
          projectSubdir
        );
        response.success(res, {
          url: result.url,
          path: result.local_path,
          local_path: result.local_path,
          sha256: result.sha256,
          deduplicated: result.deduplicated,
          filename: req.file.originalname,
          size: req.file.size,
        });
      } catch (err) {
        log.error('upload image', { error: err.message });
        response.internalError(res, err.message || '上传失败');
      }
    },
    uploadReferenceMedia: (req, res) => {
      if (!req.file || !req.file.buffer) {
        return response.badRequest(res, '请选择参考媒体文件');
      }
      try {
        const mediaType = String(req.file.mimetype || '').split('/')[0];
        const maxBytes = referenceMediaLimits[mediaType];
        if (!maxBytes || req.file.size > maxBytes) {
          return response.badRequest(res, `参考${mediaType || '媒体'}文件超出大小限制`);
        }
        const rawStorage = cfg?.storage?.local_path || './data/storage';
        const storagePath = path.isAbsolute(rawStorage) ? rawStorage : path.join(process.cwd(), rawStorage);
        const result = uploadService.uploadFile(
          storagePath,
          cfg?.storage?.base_url || '',
          log,
          req.file.buffer,
          req.file.originalname || 'reference.bin',
          req.file.mimetype,
          'references'
        );
        response.success(res, {
          url: result.url,
          local_path: result.local_path,
          sha256: result.sha256,
          deduplicated: result.deduplicated,
          filename: req.file.originalname,
          size: req.file.size,
          mime_type: req.file.mimetype,
          media_type: mediaType,
        });
      } catch (err) {
        log.error('upload reference media', { error: err.message });
        response.internalError(res, err.message || '参考媒体上传失败');
      }
    },
  };
}

module.exports = {
  routes,
  upload,
  multerSingle: upload.single('file'),
  multerAudioSingle: audioUpload.single('file'),
  multerReferenceMediaSingle: referenceMediaUpload.single('file'),
  MAX_IMAGE_SIZE_MB: MAX_SIZE_MB,
};
