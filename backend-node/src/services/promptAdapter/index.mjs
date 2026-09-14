import { validateShotIR, validateProfile } from './schema.mjs';
import { parseTextToShotIR } from './parser.mjs';
import { compileShotIR } from './compiler.mjs';
import { getProfile, listProfiles } from './profiles.mjs';
export * from './schema.mjs';
export * from './profiles.mjs';
export { parseTextToShotIR, compileShotIR };

const invalid = (code, validation) => ({ success: false, code, errors: validation.errors });
export function compileIR(ir, profileOrId, options = {}) {
  const validation = validateShotIR(ir);
  if (!validation.valid) return invalid('INVALID_SHOT_IR', validation);
  const profile = typeof profileOrId === 'string' ? getProfile(profileOrId) : profileOrId;
  const checked = validateProfile(profile);
  if (!checked.valid) return invalid('INVALID_PROMPT_PROFILE', checked);
  return compileShotIR(ir, profile, options);
}
export function adaptPrompt(text, profileOrId, options = {}) {
  const ir = parseTextToShotIR(text, options);
  return { ir, compiled: compileIR(ir, profileOrId, options) };
}
// One deterministic request surface shared by HTTP, the local CLI and MCP.
// Profiles supplied in a request never mutate another user's profile registry.
export function executePromptRequest(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid('INVALID_REQUEST', {errors:['Request must be an object']});
  const action = body.action || 'compile';
  if (action === 'profiles') return {success:true, profiles:listProfiles()};
  if (action === 'validate') return {success:true, validation:validateShotIR(body.ir)};
  if (!['parse', 'compile'].includes(action)) return invalid('INVALID_ACTION', {errors:['Use profiles, parse, validate or compile']});
  if (!body.ir && (typeof body.text !== 'string' || !body.text.trim())) return invalid('EMPTY_PROMPT', {errors:['Provide text or an editable ir']});
  const ir = body.ir ?? parseTextToShotIR(body.text);
  const validation = validateShotIR(ir);
  if (!validation.valid) return {...invalid('INVALID_SHOT_IR', validation), ir};
  if (action === 'parse') return {success:true, ir, guidance:'自动拆分仅为草稿；Agent应按真实剧情编辑IR，再编译。原文保留为来源，不覆盖编辑结果。'};
  const compiled = compileIR(ir, body.profile, body.options || {});
  return {success:compiled.success, ir, compiled, ...(compiled.code ? {code:compiled.code, errors:compiled.errors} : {})};
}