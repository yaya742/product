import fs from 'node:fs';
import path from 'node:path';

// Official read-only status check. Never print the key, response body or balances.
// https://api-docs.deepseek.com/api/get-user-balance/
const key = process.env.ZAICHANG_PROJECT_DEEPSEEK_KEY || process.env.ZAICHANG_TEST_DEEPSEEK_KEY;
if (!key) throw new Error('Use the authorized project credential wrapper.');
const report = { checkedAt: new Date().toISOString(), endpoint: 'https://api.deepseek.com/user/balance', modelRequests: 0 };
try {
  const response = await fetch(report.endpoint, { method: 'GET', headers: { Authorization: 'Bearer ' + key }, redirect: 'error', signal: AbortSignal.timeout(15000) });
  report.httpStatus = response.status;
  if (!response.ok) { report.status = 'check_failed'; }
  else {
    const data = await response.json();
    if (typeof data.is_available !== 'boolean') report.status = 'unexpected_response';
    else { report.status = 'checked'; report.isAvailable = data.is_available; }
  }
} catch {
  report.status = 'check_failed';
  report.reason = 'No usable response from the official balance endpoint.';
}
const directory = path.resolve('artifacts/understanding-action');
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(directory, 'balance-status.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
if (report.status !== 'checked') process.exitCode = 1;
