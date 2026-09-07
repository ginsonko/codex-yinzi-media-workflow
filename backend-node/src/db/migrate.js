const fs = require('fs');
const path = require('path');
const { getDb } = require('./index.js');
const { loadConfig } = require('../config/index.js');

function stripLeadingComments(sql) {
  return sql
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return t.length > 0 && !t.startsWith('--');
    })
    .join('\n')
    .trim();
}

function runOne(database, sql, file, index) {
  const s = stripLeadingComments(sql);
  if (!s) return;
  try {
    database.exec(s);
    console.log('Ran migration:', file + (index >= 0 ? ' #' + (index + 1) : ''));
  } catch (err) {
    const msg = (err.message || '').toLowerCase();
    if (err.code === 'SQLITE_ERROR' && (msg.includes('duplicate column') || msg.includes('already exists'))) {
      console.log('Skip (already exists):', file + (index >= 0 ? ' #' + (index + 1) : ''));
    } else if (err.code === 'SQLITE_ERROR' && msg.includes('no such table')) {
      // ALTER TABLE 遇到表不存在时，记录警告并跳过（启动后 ensureAllColumns 会兜底建表补列）
      console.warn('Skip migration (table not found, will be ensured later):', file, '-', err.message);
    } else {
      throw err;
    }
  }
}

function runMigrations(database) {
  const migrationsDir = path.join(__dirname, '..', '..', 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    console.log('Migrations dir missing, skipping:', migrationsDir);
    return;
  }
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const fullPath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(fullPath, 'utf8');
    const statements = sql
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (statements.length <= 1) {
      runOne(database, sql, file, -1);
    } else {
      statements.forEach((stmt, i) => runOne(database, stmt + ';', file, i));
    }
  }
}

/**
 * 通用：确保某张表存在指定列，不存在则 ALTER TABLE ADD COLUMN。
 * @param {object} database - better-sqlite3 实例
 * @param {string} table - 表名
 * @param {Array<{name:string, type:string}>} columns - 要确保存在的列
 */
function ensureColumns(database, table, columns) {
  let existing;
  try {
    existing = database.prepare(`PRAGMA table_info(${table})`).all();
  } catch (err) {
    if ((err.message || '').toLowerCase().includes('no such table')) {
      console.log(`ensureColumns: table ${table} not found, skip`);
      return;
    }
    throw err;
  }
  const names = new Set(existing.map((r) => r.name));
  for (const col of columns) {
    if (names.has(col.name)) continue;
    try {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${col.name} ${col.type}`);
      console.log(`ensureColumns: added ${table}.${col.name} (${col.type})`);
    } catch (e) {
      if ((e.message || '').toLowerCase().includes('duplicate column')) {
        // already exists (race / concurrent)
      } else {
        console.warn(`ensureColumns: failed to add ${table}.${col.name}:`, e.message);
      }
    }
  }
}

/**
 * 全量兜底补列：覆盖所有表的所有业务列。
 * 对于旧数据库（用更早版本的 init 脚本创建、缺少部分列），
 * 在每次启动时自动补齐，避免 "no such column" 运行时错误。
 *
 * SQLite 不支持 ALTER TABLE ADD COLUMN ... NOT NULL（无默认值），
 * 所以原 schema 中 NOT NULL 的列在这里用 DEFAULT 兜底。
 */
function ensureAllColumns(database) {
  // --- dramas ---
  ensureColumns(database, 'dramas', [
    { name: 'title',          type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'description',    type: 'TEXT' },
    { name: 'genre',          type: 'TEXT' },
    { name: 'style',          type: 'TEXT DEFAULT \'realistic\'' },
    { name: 'tags',           type: 'TEXT' },
    { name: 'thumbnail',      type: 'TEXT' },
    { name: 'total_episodes', type: 'INTEGER DEFAULT 1' },
    { name: 'total_duration', type: 'INTEGER DEFAULT 0' },
    { name: 'status',         type: 'TEXT DEFAULT \'draft\'' },
    { name: 'metadata',       type: 'TEXT' },
    { name: 'created_at',     type: 'TEXT' },
    { name: 'updated_at',     type: 'TEXT' },
    { name: 'archived_at',    type: 'TEXT' },
    { name: 'deleted_at',     type: 'TEXT' },
  ]);
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_dramas_archive_list
      ON dramas (deleted_at, archived_at, updated_at DESC);
  `);

  // --- episodes ---
  ensureColumns(database, 'episodes', [
    { name: 'drama_id',       type: 'INTEGER DEFAULT 0' },
    { name: 'episode_number', type: 'INTEGER DEFAULT 0' },
    { name: 'title',          type: 'TEXT DEFAULT \'\'' },
    { name: 'script_content', type: 'TEXT' },
    { name: 'description',    type: 'TEXT' },
    { name: 'duration',       type: 'INTEGER DEFAULT 0' },
    { name: 'video_url',      type: 'TEXT' },
    { name: 'thumbnail',      type: 'TEXT' },
    { name: 'status',         type: 'TEXT DEFAULT \'draft\'' },
    { name: 'created_at',     type: 'TEXT' },
    { name: 'updated_at',     type: 'TEXT' },
    { name: 'deleted_at',     type: 'TEXT' },
  ]);

  // --- storyboards ---
  ensureColumns(database, 'storyboards', [
    { name: 'episode_id',        type: 'INTEGER DEFAULT 0' },
    { name: 'scene_id',          type: 'INTEGER' },
    { name: 'storyboard_number', type: 'INTEGER DEFAULT 0' },
    { name: 'title',             type: 'TEXT' },
    { name: 'description',       type: 'TEXT' },
    { name: 'layout_description', type: 'TEXT' },   // 画面布局与人物站位（首尾帧模式空间合同）
    { name: 'location',          type: 'TEXT' },
    { name: 'time',              type: 'TEXT' },
    { name: 'duration',          type: 'REAL' },
    { name: 'dialogue',          type: 'TEXT' },
    { name: 'narration',         type: 'TEXT' },
    { name: 'action',            type: 'TEXT' },
    { name: 'atmosphere',        type: 'TEXT' },
    { name: 'image_prompt',      type: 'TEXT' },
    { name: 'video_prompt',      type: 'TEXT' },
    { name: 'characters',        type: 'TEXT' },
    { name: 'shot_type',         type: 'TEXT' },
    { name: 'angle',             type: 'TEXT' },
    { name: 'movement',          type: 'TEXT' },
    { name: 'image_url',         type: 'TEXT' },
    { name: 'local_path',        type: 'TEXT' },
    { name: 'main_panel_idx',    type: 'INTEGER' },
    { name: 'video_url',         type: 'TEXT' },
    { name: 'composed_image',    type: 'TEXT' },
    { name: 'result',            type: 'TEXT' },
    { name: 'emotion',           type: 'TEXT' },               // 当前情绪（兴奋/悲伤/紧张等）
    { name: 'emotion_intensity', type: 'INTEGER' },            // 情绪强度 3/2/1/0/-1
    { name: 'error_msg',         type: 'TEXT' },
    { name: 'segment_index',     type: 'INTEGER DEFAULT 0' },  // 剧情段落索引（0-based）
    { name: 'segment_title',     type: 'TEXT' },               // 剧情段落名称
    { name: 'angle_h',           type: 'TEXT' },               // 水平方向（front/left/back/right...）
    { name: 'angle_v',           type: 'TEXT' },               // 俯仰角度（worm/low/eye_level/high）
    { name: 'angle_s',           type: 'TEXT' },               // 景别（close_up/medium/wide）
    { name: 'lighting_style',    type: 'TEXT' },               // 灯光风格（natural/side/dramatic/golden_hour 等）
    { name: 'depth_of_field',    type: 'TEXT' },               // 景深（shallow/medium/deep/extreme_shallow）
    { name: 'polished_prompt',        type: 'TEXT' },               // 文字AI润色后的图片生成提示词（可编辑，生图时优先使用）
    { name: 'continuity_snapshot',   type: 'TEXT' },               // JSON: 连戏状态快照 {characters:{name:{position,clothing,expression,props}},lighting}
    { name: 'audio_local_path',      type: 'TEXT' },               // 对白 TTS 本地路径
    { name: 'narration_audio_local_path', type: 'TEXT' },         // 解说旁白 TTS 本地路径
    { name: 'creation_mode',     type: 'TEXT DEFAULT \'classic\'' }, // classic | universal
    { name: 'universal_segment_text', type: 'TEXT' },              // 全能模式片段描述（@ 引用等）
    { name: 'first_frame_image_id', type: 'INTEGER' },
    { name: 'last_frame_image_id',  type: 'INTEGER' },
    { name: 'last_frame_image_url', type: 'TEXT' },
    { name: 'last_frame_local_path', type: 'TEXT' },
    { name: 'workflow_selected', type: 'INTEGER DEFAULT 1' },
    { name: 'workflow_references', type: 'TEXT' },
    { name: 'workflow_approved_at', type: 'TEXT' },
    { name: 'director_scene_json', type: 'TEXT' },
    { name: 'director_frame_path', type: 'TEXT' },
    { name: 'director_preview_path', type: 'TEXT' },
    { name: 'status',            type: 'TEXT DEFAULT \'draft\'' },
    { name: 'created_at',        type: 'TEXT' },
    { name: 'updated_at',        type: 'TEXT' },
    { name: 'deleted_at',        type: 'TEXT' },
  ]);

  // --- characters ---
  ensureColumns(database, 'characters', [
    { name: 'drama_id',          type: 'INTEGER DEFAULT 0' },
    { name: 'name',              type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'role',              type: 'TEXT' },
    { name: 'description',       type: 'TEXT' },
    { name: 'personality',       type: 'TEXT' },
    { name: 'appearance',        type: 'TEXT' },
    { name: 'image_url',         type: 'TEXT' },
    { name: 'local_path',        type: 'TEXT' },
    { name: 'extra_images',      type: 'TEXT' },
    { name: 'voice_style',       type: 'TEXT' },
    { name: 'sort_order',        type: 'INTEGER DEFAULT 0' },
    { name: 'error_msg',         type: 'TEXT' },
    { name: 'identity_anchors',  type: 'TEXT' },   // JSON: 6层视觉锚点（骨相/五官/辨识标记/色值/皮肤/发型）
    { name: 'style_tokens',      type: 'TEXT' },   // 风格词 token 列表
    { name: 'color_palette',     type: 'TEXT' },   // JSON: Hex 色值数组
    { name: 'four_view_image_url', type: 'TEXT' }, // 四视图参考图 URL
    { name: 'polished_prompt',   type: 'TEXT' },   // 文字AI润色后的完整图片生成提示词（可编辑，生图时直接使用）
    { name: 'ref_image',         type: 'TEXT' },   // 用户上传的参考图（本地相对路径或 URL），独立于 AI 生成的主图
    { name: 'stages',            type: 'TEXT' },   // JSON: 多阶段造型 [{episode_range:[1,3], appearance:"..."}]
    { name: 'seedance2_asset', type: 'TEXT' },   // JSON: 即梦/Seedance2 素材库认证 hub_asset_id / asset_url 等
    { name: 'seedance2_voice_asset', type: 'TEXT' }, // JSON: Seedance 2.0 音色参考音频（仅 SD2 模型有效）
    { name: 'negative_prompt', type: 'TEXT' },
    { name: 'created_at',        type: 'TEXT' },
    { name: 'updated_at',        type: 'TEXT' },
    { name: 'deleted_at',        type: 'TEXT' },
  ]);

  // --- scenes ---
  ensureColumns(database, 'scenes', [
    { name: 'drama_id',         type: 'INTEGER DEFAULT 0' },
    { name: 'episode_id',       type: 'INTEGER' },
    { name: 'location',         type: 'TEXT' },
    { name: 'time',             type: 'TEXT' },
    { name: 'prompt',           type: 'TEXT' },
    { name: 'polished_prompt',  type: 'TEXT' },  // 文字AI润色后的完整四视图图片提示词，生图时直接使用
    { name: 'image_url',        type: 'TEXT' },
    { name: 'local_path',       type: 'TEXT' },
    { name: 'extra_images',     type: 'TEXT' },
    { name: 'ref_image',        type: 'TEXT' },  // 用户上传的参考图（本地相对路径或 URL）
    { name: 'negative_prompt',  type: 'TEXT' },
    { name: 'storyboard_count', type: 'INTEGER DEFAULT 0' },
    { name: 'error_msg',        type: 'TEXT' },
    { name: 'status',           type: 'TEXT DEFAULT \'draft\'' },
    { name: 'created_at',       type: 'TEXT' },
    { name: 'updated_at',       type: 'TEXT' },
    { name: 'deleted_at',       type: 'TEXT' },
  ]);

  // --- props ---
  ensureColumns(database, 'props', [
    { name: 'drama_id',    type: 'INTEGER DEFAULT 0' },
    { name: 'episode_id',  type: 'INTEGER' },
    { name: 'name',        type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'type',        type: 'TEXT' },
    { name: 'description', type: 'TEXT' },
    { name: 'prompt',      type: 'TEXT' },
    { name: 'image_url',    type: 'TEXT' },
    { name: 'local_path',   type: 'TEXT' },
    { name: 'extra_images', type: 'TEXT' },
    { name: 'ref_image',    type: 'TEXT' },  // 用户上传的参考图（本地相对路径或 URL）
    { name: 'negative_prompt', type: 'TEXT' },
    { name: 'error_msg',    type: 'TEXT' },
    { name: 'created_at',   type: 'TEXT' },
    { name: 'updated_at',   type: 'TEXT' },
    { name: 'deleted_at',   type: 'TEXT' },
  ]);

  // --- ai_service_configs ---（兜底建表：旧版 01_init.sql 可能未包含此表）
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS ai_service_configs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      service_type  TEXT NOT NULL DEFAULT 'text',
      provider      TEXT DEFAULT '',
      name          TEXT DEFAULT '',
      base_url      TEXT DEFAULT '',
      api_key       TEXT,
      model         TEXT,
      default_model TEXT,
      endpoint      TEXT,
      query_endpoint TEXT,
      priority      INTEGER DEFAULT 0,
      is_default    INTEGER DEFAULT 0,
      is_active     INTEGER DEFAULT 1,
      settings      TEXT,
      metadata_json TEXT,
      created_at    TEXT,
      updated_at    TEXT,
      deleted_at    TEXT
    )`);
  } catch (_) {}
  ensureColumns(database, 'ai_service_configs', [
    { name: 'service_type',   type: 'TEXT NOT NULL DEFAULT \'text\'' },
    { name: 'provider',       type: 'TEXT DEFAULT \'\'' },
    { name: 'name',           type: 'TEXT DEFAULT \'\'' },
    { name: 'base_url',       type: 'TEXT DEFAULT \'\'' },
    { name: 'api_key',        type: 'TEXT' },
    { name: 'model',          type: 'TEXT' },
    { name: 'default_model',  type: 'TEXT' },
    { name: 'endpoint',       type: 'TEXT' },
    { name: 'query_endpoint', type: 'TEXT' },
    { name: 'priority',       type: 'INTEGER DEFAULT 0' },
    { name: 'is_default',     type: 'INTEGER DEFAULT 0' },
    { name: 'is_active',      type: 'INTEGER DEFAULT 1' },
    { name: 'settings',       type: 'TEXT' },
    { name: 'metadata_json',  type: 'TEXT' },
    { name: 'created_at',     type: 'TEXT' },
    { name: 'updated_at',     type: 'TEXT' },
    { name: 'deleted_at',     type: 'TEXT' },
  ]);

  // --- async_tasks ---
  ensureColumns(database, 'async_tasks', [
    { name: 'type',         type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'status',       type: 'TEXT NOT NULL DEFAULT \'pending\'' },
    { name: 'progress',     type: 'INTEGER DEFAULT 0' },
    { name: 'message',      type: 'TEXT' },
    { name: 'resource_id',  type: 'TEXT' },
    { name: 'completed_at', type: 'TEXT' },
    { name: 'error',        type: 'TEXT' },
    { name: 'result',       type: 'TEXT' },
    { name: 'created_at',   type: 'TEXT' },
    { name: 'updated_at',   type: 'TEXT' },
    { name: 'deleted_at',   type: 'TEXT' },
  ]);

  // --- image_generations ---
  ensureColumns(database, 'image_generations', [
    { name: 'storyboard_id',    type: 'INTEGER' },
    { name: 'drama_id',         type: 'INTEGER' },
    { name: 'episode_id',       type: 'INTEGER' },
    { name: 'scene_id',         type: 'INTEGER' },
    { name: 'character_id',     type: 'INTEGER' },
    { name: 'provider',         type: 'TEXT' },
    { name: 'prompt',           type: 'TEXT' },
    { name: 'negative_prompt',  type: 'TEXT' },
    { name: 'model',            type: 'TEXT' },
    { name: 'image_service_type', type: 'TEXT' },
    { name: 'image_config_id',  type: 'INTEGER' },
    { name: 'frame_type',       type: 'TEXT' },
    { name: 'reference_images', type: 'TEXT' },
    { name: 'use_first_frame_layout_lock', type: 'INTEGER' },
    { name: 'size',             type: 'TEXT' },
    { name: 'quality',          type: 'TEXT' },
    { name: 'image_url',        type: 'TEXT' },
    { name: 'local_path',       type: 'TEXT' },
    { name: 'width',            type: 'INTEGER' },
    { name: 'height',           type: 'INTEGER' },
    { name: 'status',           type: 'TEXT' },
    { name: 'task_id',          type: 'TEXT' },
    { name: 'client_request_key', type: 'TEXT' },
    { name: 'completed_at',     type: 'TEXT' },
    { name: 'error_msg',        type: 'TEXT' },
    { name: 'created_at',       type: 'TEXT' },
    { name: 'updated_at',       type: 'TEXT' },
    { name: 'deleted_at',       type: 'TEXT' },
  ]);

  // --- video_generations ---
  ensureColumns(database, 'video_generations', [
    { name: 'drama_id',             type: 'INTEGER' },
    { name: 'storyboard_id',        type: 'INTEGER' },
    { name: 'provider',             type: 'TEXT' },
    { name: 'prompt',               type: 'TEXT' },
    { name: 'model',                type: 'TEXT' },
    { name: 'duration',             type: 'REAL' },
    { name: 'aspect_ratio',         type: 'TEXT' },
    { name: 'resolution',           type: 'TEXT' },
    { name: 'seed',                 type: 'INTEGER' },
    { name: 'camera_fixed',         type: 'INTEGER' },
    { name: 'watermark',            type: 'INTEGER' },
    { name: 'image_url',            type: 'TEXT' },
    { name: 'first_frame_url',      type: 'TEXT' },
    { name: 'last_frame_url',       type: 'TEXT' },
    { name: 'reference_image_urls', type: 'TEXT' },
    { name: 'reference_video_urls', type: 'TEXT' },
    { name: 'reference_audio_urls', type: 'TEXT' },
    { name: 'video_url',            type: 'TEXT' },
    { name: 'local_path',           type: 'TEXT' },
    { name: 'status',               type: 'TEXT' },
    { name: 'generation_status',    type: 'TEXT' },
    { name: 'download_status',      type: 'TEXT' },
    { name: 'remote_video_url',     type: 'TEXT' },
    { name: 'download_source_url',  type: 'TEXT' },
    { name: 'download_requires_auth', type: 'INTEGER NOT NULL DEFAULT 0' },
    { name: 'download_error',       type: 'TEXT' },
    { name: 'download_attempts',    type: 'INTEGER NOT NULL DEFAULT 0' },
    { name: 'download_lease_owner', type: 'TEXT' },
    { name: 'download_lease_expires_at', type: 'TEXT' },
    { name: 'download_started_at',  type: 'TEXT' },
    { name: 'download_completed_at', type: 'TEXT' },
    { name: 'provider_completed_at', type: 'TEXT' },
    { name: 'video_config_id',      type: 'INTEGER' },
    { name: 'provider_protocol',    type: 'TEXT' },
    { name: 'provider_config_snapshot_json', type: 'TEXT' },
    { name: 'submission_status', type: 'TEXT' },
    { name: 'submission_http_status', type: 'INTEGER' },
    { name: 'submission_receipt_json', type: 'TEXT' },
    { name: 'contract_validation_mode', type: "TEXT NOT NULL DEFAULT 'strict'" },
    { name: 'contract_validation_receipt_json', type: 'TEXT' },
    { name: 'task_id',              type: 'TEXT' },
    { name: 'client_request_key',    type: 'TEXT' },
    { name: 'provider_task_id',     type: 'TEXT' },
    { name: 'prompt_contract_json', type: 'TEXT' },
    { name: 'provider_prompt_receipt_json', type: 'TEXT' },
    { name: 'scene_id',             type: 'INTEGER' },
    { name: 'completed_at',         type: 'TEXT' },
    { name: 'error_msg',            type: 'TEXT' },
    { name: 'created_at',           type: 'TEXT' },
    { name: 'updated_at',           type: 'TEXT' },
    { name: 'deleted_at',           type: 'TEXT' },
  ]);

  // --- video_merges ---
  ensureColumns(database, 'video_merges', [
    { name: 'episode_id',   type: 'INTEGER' },
    { name: 'drama_id',     type: 'INTEGER' },
    { name: 'title',        type: 'TEXT' },
    { name: 'provider',     type: 'TEXT' },
    { name: 'model',        type: 'TEXT' },
    { name: 'status',       type: 'TEXT' },
    { name: 'scenes',       type: 'TEXT' },
    { name: 'merge_options', type: 'TEXT' },
    { name: 'task_id',      type: 'TEXT' },
    { name: 'merged_url',   type: 'TEXT' },
    { name: 'duration',     type: 'INTEGER' },
    { name: 'completed_at', type: 'TEXT' },
    { name: 'error_msg',    type: 'TEXT' },
    { name: 'created_at',   type: 'TEXT' },
    { name: 'updated_at',   type: 'TEXT' },
    { name: 'deleted_at',   type: 'TEXT' },
  ]);

  // --- assets ---
  ensureColumns(database, 'assets', [
    { name: 'drama_id',     type: 'INTEGER' },
    { name: 'name',         type: 'TEXT' },
    { name: 'type',         type: 'TEXT' },
    { name: 'category',     type: 'TEXT' },
    { name: 'url',          type: 'TEXT' },
    { name: 'local_path',   type: 'TEXT' },
    { name: 'file_size',    type: 'INTEGER' },
    { name: 'mime_type',    type: 'TEXT' },
    { name: 'width',        type: 'INTEGER' },
    { name: 'height',       type: 'INTEGER' },
    { name: 'duration',     type: 'REAL' },
    { name: 'image_gen_id', type: 'INTEGER' },
    { name: 'video_gen_id', type: 'INTEGER' },
    { name: 'created_at',   type: 'TEXT' },
    { name: 'updated_at',   type: 'TEXT' },
    { name: 'deleted_at',   type: 'TEXT' },
  ]);

  // --- character_libraries ---
  ensureColumns(database, 'character_libraries', [
    { name: 'drama_id',          type: 'INTEGER' },   // NULL = 全局素材库；有值 = 本剧专属
    { name: 'name',              type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'category',          type: 'TEXT' },
    { name: 'image_url',         type: 'TEXT' },
    { name: 'local_path',        type: 'TEXT' },
    { name: 'description',       type: 'TEXT' },
    { name: 'appearance',        type: 'TEXT' },
    { name: 'tags',              type: 'TEXT' },
    { name: 'source_type',       type: 'TEXT' },
    { name: 'source_id',         type: 'TEXT' },
    { name: 'identity_anchors',  type: 'TEXT' },   // JSON: 6层视觉锚点（骨相/五官/辨识标记/色值/皮肤/发型）
    { name: 'style_tokens',      type: 'TEXT' },   // 风格词 token 列表
    { name: 'color_palette',     type: 'TEXT' },   // JSON: Hex 色值数组
    { name: 'four_view_image_url', type: 'TEXT' }, // 四视图参考图 URL（分镜图生图参考用）
    { name: 'created_at',        type: 'TEXT' },
    { name: 'updated_at',        type: 'TEXT' },
    { name: 'deleted_at',        type: 'TEXT' },
  ]);

  // --- scene_libraries ---
  ensureColumns(database, 'scene_libraries', [
    { name: 'drama_id',    type: 'INTEGER' },   // NULL = 全局素材库
    { name: 'location',    type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'time',        type: 'TEXT' },
    { name: 'prompt',      type: 'TEXT' },
    { name: 'description', type: 'TEXT' },
    { name: 'image_url',   type: 'TEXT' },
    { name: 'local_path',  type: 'TEXT' },
    { name: 'category',    type: 'TEXT' },
    { name: 'tags',        type: 'TEXT' },
    { name: 'source_type', type: 'TEXT' },
    { name: 'source_id',   type: 'TEXT' },
    { name: 'created_at',  type: 'TEXT' },
    { name: 'updated_at',  type: 'TEXT' },
    { name: 'deleted_at',  type: 'TEXT' },
  ]);

  // --- prop_libraries ---
  ensureColumns(database, 'prop_libraries', [
    { name: 'drama_id',    type: 'INTEGER' },   // NULL = 全局素材库
    { name: 'name',        type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'description', type: 'TEXT' },
    { name: 'prompt',      type: 'TEXT' },
    { name: 'image_url',   type: 'TEXT' },
    { name: 'local_path',  type: 'TEXT' },
    { name: 'category',    type: 'TEXT' },
    { name: 'tags',        type: 'TEXT' },
    { name: 'source_type', type: 'TEXT' },
    { name: 'source_id',   type: 'TEXT' },
    { name: 'created_at',  type: 'TEXT' },
    { name: 'updated_at',  type: 'TEXT' },
    { name: 'deleted_at',  type: 'TEXT' },
  ]);

  // --- image_proxy_cache ---
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS image_proxy_cache (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      cache_key  TEXT NOT NULL UNIQUE,
      proxy_url  TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
  } catch (_) {}
  ensureColumns(database, 'image_proxy_cache', [
    { name: 'cache_key',  type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'proxy_url',  type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'created_at', type: 'TEXT NOT NULL DEFAULT \'\'' },
  ]);

  // --- ai_model_map（业务场景→模型路由映射表） ---
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS ai_model_map (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      key            TEXT NOT NULL UNIQUE,
      service_type   TEXT NOT NULL DEFAULT 'text',
      config_id      INTEGER,
      model_override TEXT,
      description    TEXT,
      created_at     TEXT NOT NULL DEFAULT '',
      updated_at     TEXT NOT NULL DEFAULT ''
    )`);
  } catch (_) {}
  ensureColumns(database, 'ai_model_map', [
    { name: 'key',            type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'service_type',   type: 'TEXT NOT NULL DEFAULT \'text\'' },
    { name: 'config_id',      type: 'INTEGER' },
    { name: 'model_override', type: 'TEXT' },
    { name: 'description',    type: 'TEXT' },
    { name: 'created_at',     type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'updated_at',     type: 'TEXT NOT NULL DEFAULT \'\'' },
  ]);

  // --- storyboard_characters（分镜与角色库的关联表） ---
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS storyboard_characters (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      storyboard_id  INTEGER NOT NULL,
      character_id   INTEGER NOT NULL,
      created_at     TEXT NOT NULL DEFAULT ''
    )`);
  } catch (_) {}

  // --- global_settings（全局键值设置表） ---
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS global_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    )`);
  } catch (_) {}

  // --- production workflow v1 ---
  database.exec(`
    CREATE TABLE IF NOT EXISTS production_runs (
      id TEXT PRIMARY KEY,
      drama_id INTEGER NOT NULL,
      episode_id INTEGER,
      idempotency_key TEXT,
      graph_version INTEGER NOT NULL DEFAULT 1,
      handler_version INTEGER NOT NULL DEFAULT 1,
      review_owner TEXT NOT NULL DEFAULT 'human',
      next_stage_strategy TEXT NOT NULL DEFAULT 'auto_generate',
      manual_next_default INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft',
      current_stage TEXT NOT NULL DEFAULT 'story_input',
      current_scope_type TEXT,
      current_scope_id TEXT,
      input_json TEXT NOT NULL DEFAULT '{}',
      policy_json TEXT NOT NULL DEFAULT '{}',
      budget_json TEXT NOT NULL DEFAULT '{}',
      usage_json TEXT NOT NULL DEFAULT '{}',
      review_profile_json TEXT NOT NULL DEFAULT '{}',
      runtime_json TEXT NOT NULL DEFAULT '{}',
      waiting_reason TEXT,
      error_code TEXT,
      error_message TEXT,
      lease_owner TEXT,
      lease_expires_at TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_production_runs_project
      ON production_runs (drama_id, episode_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_production_runs_status
      ON production_runs (status, updated_at DESC);
    CREATE TABLE IF NOT EXISTS production_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      action_key TEXT NOT NULL,
      stage TEXT NOT NULL,
      scope_type TEXT,
      scope_id TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'reserved',
      attempt INTEGER NOT NULL DEFAULT 1,
      handler_version INTEGER NOT NULL DEFAULT 1,
      request_json TEXT NOT NULL DEFAULT '{}',
      request_hash TEXT,
      task_id TEXT,
      generation_id INTEGER,
      merge_id INTEGER,
      provider_id TEXT,
      result_json TEXT,
      error_code TEXT,
      error_message TEXT,
      reserved_video_seconds REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE (run_id, action_key)
    );
    CREATE INDEX IF NOT EXISTS idx_production_actions_run
      ON production_actions (run_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_production_actions_status
      ON production_actions (run_id, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS production_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      title TEXT,
      content_json TEXT NOT NULL DEFAULT '{}',
      media_path TEXT,
      mime_type TEXT,
      content_hash TEXT,
      parent_artifact_id INTEGER,
      source_action_id INTEGER,
      source_task_id TEXT,
      source_generation_id INTEGER,
      source_merge_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      approved_at TEXT,
      rejected_at TEXT,
      deleted_at TEXT,
      UNIQUE (run_id, stage, scope_type, scope_id, revision)
    );
    CREATE INDEX IF NOT EXISTS idx_production_artifacts_current
      ON production_artifacts (run_id, stage, scope_type, scope_id, revision DESC);
    CREATE INDEX IF NOT EXISTS idx_production_artifacts_status
      ON production_artifacts (run_id, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS production_artifact_dependencies (
      artifact_id INTEGER NOT NULL,
      depends_on_artifact_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (artifact_id, depends_on_artifact_id)
    );
    CREATE INDEX IF NOT EXISTS idx_production_dependencies_upstream
      ON production_artifact_dependencies (depends_on_artifact_id, artifact_id);

    CREATE TABLE IF NOT EXISTS production_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      artifact_id INTEGER NOT NULL,
      reviewer_type TEXT NOT NULL,
      decision TEXT NOT NULL,
      reason TEXT,
      criteria_version TEXT,
      confidence REAL,
      scores_json TEXT NOT NULL DEFAULT '{}',
      evidence_json TEXT NOT NULL DEFAULT '{}',
      prompt_snapshot TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_production_reviews_artifact
      ON production_reviews (artifact_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_production_reviews_run
      ON production_reviews (run_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS production_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      stage TEXT,
      scope_type TEXT,
      scope_id TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_production_events_run
      ON production_events (run_id, id DESC);
  `);

  // Keep local databases created by an earlier workflow draft forward-compatible.
  ensureColumns(database, 'production_runs', [
    { name: 'idempotency_key', type: 'TEXT' },
  ]);
  // V0.4 parent/child media actions.  These columns are deliberately
  // additive so databases created by older releases remain readable and the
  // migration can be run repeatedly during desktop startup.
  ensureColumns(database, 'production_actions', [
    { name: 'parent_action_id', type: 'INTEGER' },
    { name: 'parent_action_key', type: 'TEXT' },
    { name: 'segment_index', type: 'INTEGER' },
    { name: 'cancel_mode', type: 'TEXT' },
    { name: 'external_outcome', type: 'TEXT' },
  ]);
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_production_actions_parent
      ON production_actions (parent_action_id, segment_index, id);
  `);
  database.exec(`
    CREATE TABLE IF NOT EXISTS model_prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      service_type TEXT NOT NULL,
      model TEXT NOT NULL,
      group_name TEXT NOT NULL DEFAULT '',
      billing_unit TEXT NOT NULL,
      unit_price_microusd INTEGER,
      input_price_microusd INTEGER,
      output_price_microusd INTEGER,
      currency TEXT NOT NULL DEFAULT 'USD',
      source TEXT NOT NULL DEFAULT 'manual',
      source_version TEXT,
      source_fetched_at TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (provider, service_type, model, group_name, billing_unit)
    );
    CREATE INDEX IF NOT EXISTS idx_model_prices_lookup
      ON model_prices (provider, service_type, model, enabled, updated_at DESC);
    CREATE TABLE IF NOT EXISTS cost_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT,
      action_id INTEGER,
      idempotency_key TEXT NOT NULL UNIQUE,
      provider TEXT NOT NULL DEFAULT '',
      service_type TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      billing_unit TEXT NOT NULL DEFAULT 'unknown',
      units REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'reserved',
      estimated_microusd INTEGER,
      reserved_microusd INTEGER NOT NULL DEFAULT 0,
      actual_microusd INTEGER,
      price_snapshot_json TEXT NOT NULL DEFAULT '{}',
      usage_snapshot_json TEXT NOT NULL DEFAULT '{}',
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      settled_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cost_ledger_run
      ON cost_ledger (run_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_cost_ledger_action
      ON cost_ledger (action_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS config_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_type TEXT NOT NULL DEFAULT 'automatic',
      reason TEXT NOT NULL DEFAULT '',
      schema_version INTEGER NOT NULL,
      sections_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_config_snapshots_created
      ON config_snapshots (created_at DESC, id DESC);
    CREATE TABLE IF NOT EXISTS config_import_previews (
      token TEXT PRIMARY KEY,
      bundle_json TEXT NOT NULL,
      bundle_hash TEXT NOT NULL,
      base_fingerprint TEXT NOT NULL,
      diff_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      applied_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_config_import_previews_expiry
      ON config_import_previews (expires_at, applied_at);
  `);
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_production_runs_idempotency
      ON production_runs (drama_id, IFNULL(episode_id, 0), idempotency_key)
      WHERE idempotency_key IS NOT NULL AND deleted_at IS NULL;
  `);

  // V0.4 P3: resumable asset-import plans and immutable series-group refs.
  // These tables are additive and deliberately keep the pre-apply phase
  // separate from production_artifacts so a preview can be discarded safely.
  database.exec(`
    CREATE TABLE IF NOT EXISTS asset_import_sessions (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'draft',
      source_label TEXT NOT NULL DEFAULT '',
      target_run_id TEXT,
      options_json TEXT NOT NULL DEFAULT '{}',
      plan_json TEXT NOT NULL DEFAULT '{}',
      snapshot_json TEXT NOT NULL DEFAULT '{}',
      error_code TEXT,
      error_message TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      applied_at TEXT,
      rolled_back_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_asset_import_sessions_status
      ON asset_import_sessions(status, updated_at DESC);
    CREATE TABLE IF NOT EXISTS asset_import_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      source_path TEXT,
      file_name TEXT NOT NULL DEFAULT '',
      extension TEXT NOT NULL DEFAULT '',
      mime_type TEXT,
      bytes INTEGER NOT NULL DEFAULT 0,
      mtime TEXT,
      sha256 TEXT,
      detected_type TEXT NOT NULL DEFAULT 'unknown',
      candidate_stage TEXT,
      candidate_scope_type TEXT,
      candidate_scope_id TEXT,
      confidence REAL,
      evidence_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      error_code TEXT,
      error_message TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(session_id, relative_path)
    );
    CREATE INDEX IF NOT EXISTS idx_asset_import_items_session
      ON asset_import_items(session_id, status, id);
    CREATE INDEX IF NOT EXISTS idx_asset_import_items_hash
      ON asset_import_items(sha256, session_id);
    CREATE TABLE IF NOT EXISTS series_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      UNIQUE(name)
    );
    CREATE TABLE IF NOT EXISTS series_group_episodes (
      series_group_id INTEGER NOT NULL,
      drama_id INTEGER NOT NULL,
      episode_id INTEGER,
      created_at TEXT NOT NULL,
      PRIMARY KEY(series_group_id, drama_id, episode_id)
    );
    CREATE INDEX IF NOT EXISTS idx_series_group_episodes_lookup
      ON series_group_episodes(series_group_id, drama_id, episode_id);
    CREATE TABLE IF NOT EXISTS series_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      series_group_id INTEGER NOT NULL,
      asset_key TEXT NOT NULL,
      asset_type TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      current_version_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(series_group_id, asset_key)
    );
    CREATE TABLE IF NOT EXISTS series_asset_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      series_asset_id INTEGER NOT NULL,
      version INTEGER NOT NULL,
      content_json TEXT NOT NULL DEFAULT '{}',
      source_artifact_id INTEGER,
      content_hash TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(series_asset_id, version)
    );
    CREATE TABLE IF NOT EXISTS episode_asset_refs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      series_asset_id INTEGER NOT NULL,
      series_asset_version_id INTEGER NOT NULL,
      drama_id INTEGER NOT NULL,
      episode_id INTEGER,
      mode TEXT NOT NULL DEFAULT 'reuse',
      created_at TEXT NOT NULL,
      UNIQUE(series_asset_version_id, drama_id, episode_id)
    );
    CREATE INDEX IF NOT EXISTS idx_episode_asset_refs_episode
      ON episode_asset_refs(drama_id, episode_id, created_at DESC);
  `);

  // Durable local batch queue. Provider work is still submitted through the
  // existing image/video services; these tables only persist scheduling state
  // so refreshes and restarts never submit an already-created item twice.
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_image_generations_client_request
      ON image_generations(client_request_key)
      WHERE client_request_key IS NOT NULL AND TRIM(client_request_key) != '';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_video_generations_client_request
      ON video_generations(client_request_key)
      WHERE client_request_key IS NOT NULL AND TRIM(client_request_key) != '';
    CREATE TABLE IF NOT EXISTS media_batches (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT,
      request_hash TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      title TEXT NOT NULL DEFAULT '',
      prompt TEXT NOT NULL DEFAULT '',
      model TEXT,
      settings_json TEXT NOT NULL DEFAULT '{}',
      concurrency INTEGER NOT NULL DEFAULT 8,
      total INTEGER NOT NULL DEFAULT 0,
      queued INTEGER NOT NULL DEFAULT 0,
      running INTEGER NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      needs_review INTEGER NOT NULL DEFAULT 0,
      paused_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_media_batches_status
      ON media_batches(status, updated_at DESC);
    CREATE TABLE IF NOT EXISTS media_batch_items (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      request_key TEXT,
      ordinal INTEGER NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      request_json TEXT NOT NULL DEFAULT '{}',
      attempt INTEGER NOT NULL DEFAULT 0,
      image_id INTEGER,
      video_id INTEGER,
      task_id TEXT,
      media_url TEXT,
      error_code TEXT,
      error_message TEXT,
      retryable INTEGER NOT NULL DEFAULT 0,
      submitted_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(batch_id, ordinal)
    );
    CREATE INDEX IF NOT EXISTS idx_media_batch_items_queue
      ON media_batch_items(batch_id, status, ordinal);
  `);
  ensureColumns(database, 'media_batches', [
    { name: 'exploration_json', type: "TEXT NOT NULL DEFAULT '{}'" },
    { name: 'idempotency_key', type: 'TEXT' },
    { name: 'request_hash', type: 'TEXT' },
    { name: 'needs_review', type: 'INTEGER NOT NULL DEFAULT 0' },
  ]);
  ensureColumns(database, 'media_batch_items', [
    { name: 'request_key', type: 'TEXT' },
  ]);
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_media_batches_idempotency
      ON media_batches(idempotency_key)
      WHERE idempotency_key IS NOT NULL AND TRIM(idempotency_key) != '';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_media_batch_items_request_key
      ON media_batch_items(request_key)
      WHERE request_key IS NOT NULL AND TRIM(request_key) != '';
  `);
}

/** 对已打开的 database 执行迁移与兜底补列（供 app 启动时调用） */
function runMigrationsAndEnsure(database) {
  runMigrations(database);
  ensureAllColumns(database);
}

function main() {
  const config = loadConfig();
  const database = getDb(config.database);
  runMigrationsAndEnsure(database);
  console.log('Migrations complete.');
}

if (require.main === module) {
  main();
}

module.exports = { runMigrationsAndEnsure, ensureColumns };
