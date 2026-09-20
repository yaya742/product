// Synthetic App Server wire peer. Never connects to a model or reads account data.
import { createInterface } from 'node:readline';
let config;
createInterface({ input: process.stdin }).on('line', async line => {
  const request = JSON.parse(line);
  if (!request.id) return;
  const answer = result => process.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
  if (request.method === 'initialize') return answer({});
  if (request.method === 'config/read') return answer({ config: { mcp_servers: { unrelated: { command: 'must-not-run' } } } });
  if (request.method === 'thread/start') {
    config = request.params.config;
    if (config.mcp_servers.unrelated.enabled !== false) process.exit(3);
    if (!request.params.ephemeral || request.params.allowProviderModelFallback || config.features.multi_agent !== false || config.features.shell_tool !== false) process.exit(2);
    return answer({ model: request.params.model, thread: { id: 'synthetic-thread', ephemeral: true } });
  }
  if (request.method === 'turn/start') {
    answer({ turn: { id: 'synthetic-turn' } });
    await fetch(config.model_providers.zaichang_luna_test.base_url + '/responses', {
      method: 'POST', headers: { authorization: 'Bearer synthetic-auth', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'wrong-model', input: [{ role: 'user', content: 'unwanted Codex prompt' }], tools: [{ type: 'function', name: 'exec_command' }] }),
    });
  }
});
