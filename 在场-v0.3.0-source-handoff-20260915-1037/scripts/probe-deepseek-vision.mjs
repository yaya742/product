import fs from 'node:fs';
import path from 'node:path';

const key = process.env.DEEPSEEK_API_KEY;
if (!key) throw new Error('Project DeepSeek credential was not injected.');

const imagePath = path.resolve(process.argv[2] || 'build/icon.png');
const imageUrl = 'data:image/png;base64,' + fs.readFileSync(imagePath).toString('base64');

async function ask(text) {
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-flash',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        },
      ],
      thinking: { type: 'disabled' },
      max_tokens: 100,
      stream: false,
    }),
  });
  const body = await response.json().catch(() => ({}));
  return {
    ok: response.ok,
    status: response.status,
    model: body.model || null,
    answer: body.choices?.[0]?.message?.content || null,
    error: body.error
      ? { type: body.error.type || null, code: body.error.code || null }
      : null,
  };
}

const results = await Promise.all([
  ask(
    '规则：若图中小圆点位于拱门主体的右半边，只回复“右侧通行”；若在左半边，只回复“左侧通行”。不要描述图片。',
  ),
  ask(
    '把图形当作一扇宿舍门。根据小圆点所在的左右位置，写一句20字以内、自然的晚归拿钥匙提醒；句子必须写明“左边”或“右边”，不要描述颜色或图形。',
  ),
]);

const passed =
  results.every((result) => result.ok && result.model === 'deepseek-flash' && result.answer) &&
  results[0].answer.trim() === '右侧通行' &&
  /右/.test(results[1].answer) &&
  /钥匙/.test(results[1].answer);
console.log(JSON.stringify({ image: path.basename(imagePath), passed, results }, null, 2));
if (!passed) process.exitCode = 1;
