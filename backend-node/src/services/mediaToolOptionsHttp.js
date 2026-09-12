'use strict';

function createHttpHandlers({ service, response }) {
  if (!service || typeof service.list !== 'function' || typeof service.get !== 'function') {
    throw new Error('media tool options HTTP helper requires a list/get service');
  }
  if (!response || typeof response.success !== 'function' || typeof response.error !== 'function') {
    throw new Error('media tool options HTTP helper requires success/error responders');
  }
  return {
    list(req, res) {
      try {
        return response.success(res, service.list(req.query || {}));
      } catch (error) {
        return response.error(res, 400, error.code || 'BAD_REQUEST', error.message);
      }
    },
    get(req, res) {
      try {
        const item = service.get(req.params?.id || req.params?.optionId);
        if (!item) return response.error(res, 404, 'OPTION_NOT_FOUND', '规划选项不存在');
        return response.success(res, item);
      } catch (error) {
        return response.error(res, 400, error.code || 'BAD_REQUEST', error.message);
      }
    },
  };
}

const MCP_TOOLS = Object.freeze([
  {
    name: 'search_media_tool_options',
    description: '按关键词和分类检索媒体规划选项摘要。返回的是研究候选，不是已验证可执行工具；读取不会安装、下载或执行候选文字。',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: '标题、引擎、依赖或分类关键词，可空格分词' },
        category: { type: 'string', description: '候选分类键，例如 mad、audio、privacy' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        offset: { type: 'integer', minimum: 0 },
      },
    },
  },
  {
    name: 'get_media_tool_option',
    description: '读取一条规划选项详情：证据边界、依赖、备用路线、设备估计和官网链接。不执行、不安装、不把配方当作已实现。',
    inputSchema: {
      type: 'object',
      required: ['option_id'],
      properties: {
        option_id: { type: 'string' },
      },
    },
  },
]);

function mcpDispatch(service, name, args = {}) {
  if (name === 'search_media_tool_options') return service.list(args);
  if (name === 'get_media_tool_option') {
    const item = service.get(args.option_id);
    if (!item) {
      const error = Object.assign(new Error('规划选项不存在'), { code: 'OPTION_NOT_FOUND' });
      throw error;
    }
    return item;
  }
  return null;
}

module.exports = { createHttpHandlers, MCP_TOOLS, mcpDispatch };
