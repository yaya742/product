import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
if (!args.length) throw new Error('A local Node entry point is required.');
const env = { ...process.env, ZAICHANG_MODEL_TRANSPORT: 'luna-app-server-test', ZAICHANG_ALLOW_LIVE_EVAL: '1' };
for (const name of Object.keys(env)) if (/DEEPSEEK.*KEY|KEY.*DEEPSEEK/i.test(name)) delete env[name];
console.log('Temporary test substitute: GPT-5.6-Luna via App Server. DeepSeek production default is unchanged.');
const child = spawn(process.execPath, args, { env, stdio: 'inherit', windowsHide: true });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
