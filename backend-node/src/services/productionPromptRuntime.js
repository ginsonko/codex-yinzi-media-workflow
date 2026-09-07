const repo = require('./productionRepository');
const registry = require('./productionPromptRegistry');

function resolvePair(db, promptId, prompts, options = {}) {
  if (!promptId) throw new Error('生产文本调用缺少 prompt_id');
  const receipt = registry.resolveRuntime(db, promptId, {
    default_content: String(prompts?.system || ''),
    variables: options.variables || {},
    additional_locked_suffix: options.additional_locked_suffix || '',
  });
  const resolvedPrompts = {
    system: receipt.content,
    user: String(prompts?.user || ''),
  };
  return {
    prompts: resolvedPrompts,
    receipt: {
      prompt_id: receipt.id,
      prompt_version: receipt.version,
      customized: receipt.customized,
      system_hash: receipt.content_hash,
      combined_hash: repo.hashJson(resolvedPrompts),
      system: resolvedPrompts.system,
      user: resolvedPrompts.user,
    },
  };
}

module.exports = { resolvePair };
