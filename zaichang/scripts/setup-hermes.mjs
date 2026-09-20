import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const lock = JSON.parse(fs.readFileSync('runtime/hermes/lock.json', 'utf8'));
const root = path.resolve('.runtime/hermes-agent');
const run = (command, args, cwd = process.cwd()) => execFileSync(command, args, { cwd, stdio: 'inherit', windowsHide: true });
function resolveUv() {
  try {
    const located = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['uv'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
      .split(/\r?\n/)
      .map(value => value.trim())
      .find(Boolean);
    if (located) return located;
  } catch {
    // Fall through to the user-level Python installation locations.
  }
  const candidates = [];
  const appData = process.env.APPDATA || '';
  const localAppData = process.env.LOCALAPPDATA || '';
  for (const pythonRoot of [path.join(appData, 'Python'), path.join(localAppData, 'Programs', 'Python')]) {
    if (!pythonRoot || !fs.existsSync(pythonRoot)) continue;
    for (const entry of fs.readdirSync(pythonRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && /^Python\d+$/i.test(entry.name))
        candidates.push(path.join(pythonRoot, entry.name, 'Scripts', process.platform === 'win32' ? 'uv.exe' : 'uv'));
    }
  }
  const resolved = candidates.find(file => fs.existsSync(file));
  if (!resolved) throw new Error('找不到 uv，请先安装 uv 后再准备 Hermes 运行环境。');
  return resolved;
}
const uv = resolveUv();
if (!fs.existsSync(path.join(root, '.git'))) {
  fs.mkdirSync(path.dirname(root), { recursive: true });
  run('git', ['clone', '--no-checkout', lock.repository, root]);
  run('git', ['checkout', '--detach', lock.commit], root);
}
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
if (head !== lock.commit) throw new Error('Hermes checkout differs from the pinned commit; refusing to overwrite it.');
const changes = [
  ['agent/agent_init.py', 'def _setup_logging(agent):\n', 'def _setup_logging(agent):\n    if getattr(agent, "_host_adapter", None) is not None:\n        return  # Host owns state and logging, including ephemeral mode.\n'],
  ['agent/agent_init.py', 'def _load_tools(agent, enabled_toolsets, disabled_toolsets):\n', 'def _load_tools(agent, enabled_toolsets, disabled_toolsets):\n    if getattr(agent, "_host_adapter", None) is not None:\n        agent.tools = agent._host_adapter.tools\n        agent.valid_tool_names = {t["function"]["name"] for t in agent.tools}\n        agent._tool_snapshot_generation = 0\n        agent._kanban_worker_guidance = ""\n        return\n'],
  ['model_tools.py', 'discover_builtin_tools()\n', 'if os.environ.get("ZAICHANG_HERMES_HOST") != "1":\n    discover_builtin_tools()\n'],
  ['model_tools.py', '    discover_plugins()\n', '    if os.environ.get("ZAICHANG_HERMES_HOST") != "1":\n        discover_plugins()\n'],
  ['agent/tool_executor.py', '    if function_name != "delegate_task" and function_name in INLINE_TOOL_EXECUTORS:\n', '    if getattr(agent, "_host_adapter", None) is not None:\n        return _SequentialDispatch(lambda args: agent._host_adapter.tool(function_name, args, tool_call_id), finish_in_finally=False)\n    if function_name != "delegate_task" and function_name in INLINE_TOOL_EXECUTORS:\n'],
  ['tools/delegate_tool.py', '            child = AIAgent(\n', '            child_factory = getattr(getattr(parent_agent, "_host_adapter", None), "create_child", AIAgent)\n            child = child_factory(\n'],
  ['agent/context_compressor.py', '        # call_llm writes the route it actually selected; never pre-resolve a second, stale pair.\n', '        if getattr(self, "_host_summary_call", None) is not None:\n            return self._host_summary_call(prompt)\n        # call_llm writes the route it actually selected; never pre-resolve a second, stale pair.\n'],
  ['agent/context_compressor.py', '        content_to_summarize = bound(self._serialize_for_summary(turns_to_summarize))\n', '        content_to_summarize = (self._host_serialize(turns_to_summarize) if getattr(self, "_host_serialize", None) is not None else bound(self._serialize_for_summary(turns_to_summarize)))\n'],
];
const evidence = [];
for (const [file, before, after] of changes) {
  const target = path.join(root, file);
  const original = fs.readFileSync(target, 'utf8').replaceAll('\r\n', '\n');
  if (!original.includes(after)) {
    if (original.split(before).length !== 2) throw new Error('Upstream adaptation point changed: ' + file);
    fs.writeFileSync(target, original.replace(before, after));
  }
  evidence.push({ file, sha256: createHash('sha256').update(fs.readFileSync(target)).digest('hex') });
}
// Configuration contains only static product policy, never messages, keys, or user facts.
const home = path.resolve('.runtime/hermes-home');
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(path.join(home, 'config.yaml'), 'model:\n  context_length: 131072\ncompression:\n  enabled: false\nagent:\n  max_iterations: 16\n  reasoning_effort: high\n  reasoning_content: true\n  auto_memory: false\n  auto_skills: false\ndelegation:\n  max_concurrent_children: 2\n  max_spawn_depth: 1\n  max_iterations: 6\n  max_summary_chars: 24000\n  child_timeout_seconds: 120\nrelay:\n  enabled: false\nobservability:\n  shared_metrics:\n    enabled: false\n');
run(uv, ['sync', '--frozen', '--no-dev', '--python', lock.python], root);
fs.mkdirSync('artifacts/understanding-action/runtime', { recursive: true });
const finalPatches = [...new Set(evidence.map(item => item.file))].map(file => ({ file, sha256: createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') }));
fs.writeFileSync('artifacts/understanding-action/runtime/install.json', JSON.stringify({ ...lock, installedAt: new Date().toISOString(), uvLockSha256: createHash('sha256').update(fs.readFileSync(path.join(root, 'uv.lock'))).digest('hex'), patches: finalPatches }, null, 2));
console.log('Pinned Hermes source and host adaptation ready.');
