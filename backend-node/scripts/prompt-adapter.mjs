#!/usr/bin/env node
import fs from 'node:fs/promises';
import { executePromptRequest } from '../src/services/promptAdapter/index.mjs';
const args = process.argv.slice(2);
try {
  const inputIndex = args.indexOf('--input');
  if (args[0] === 'profiles') console.log(JSON.stringify(executePromptRequest({action:'profiles'}), null, 2));
  else if (inputIndex >= 0 && args[inputIndex + 1]) {
    const result = executePromptRequest(JSON.parse((await fs.readFile(args[inputIndex + 1], 'utf8')).replace(/^\uFEFF/, '')));
    console.log(JSON.stringify(result, null, 2));
    if (!result.success) process.exitCode = 1;
  } else { console.error('Usage: node backend-node/scripts/prompt-adapter.mjs profiles | --input request.json'); process.exitCode = 1; }
} catch (error) { console.error(JSON.stringify({success:false, code:'PROMPT_INPUT_ERROR', message:error.message})); process.exitCode = 1; }