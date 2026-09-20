import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { Fixture } from './support';
const distribution = (samples: number[]) => {
  const ordered = [...samples].sort((a, b) => a - b);
  return {
    samples: ordered.length,
    p50Ms: ordered[Math.floor(ordered.length * 0.5)],
    p95Ms: ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * 0.95))],
  };
};
test('bounded local latency measurements keep kernel, retrieval, loopback and unavailable model evidence separate', async () => {
  const f = new Fixture(),
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"fixture_only"}');
    });
  try {
    for (let i = 0; i < 24; i++)
      f.ingest('主图学习记录 ' + i + '；需要安静的地方，保留晚上休息时间。', 'benchmark-' + i);
    const kernel: number[] = [],
      retrieval: number[] = [],
      network: number[] = [];
    for (let i = 0; i < 30; i++) {
      const start = performance.now(),
        run = f.store.runtime.begin(
          '主图附近哪里适合安静学习？',
          'bench-turn-' + i,
          'bench-session',
          new AbortController().signal,
        );
      await f.store.runtime.compile(run);
      kernel.push(performance.now() - start);
      f.store.runtime.finish(run);
    }
    for (let i = 0; i < 50; i++) {
      const start = performance.now();
      assert.ok(f.repo.searchEvidence(f.scope(), '主图', 6).length);
      retrieval.push(performance.now() - start);
    }
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    for (let i = 0; i < 12; i++) {
      const start = performance.now();
      const response = await fetch(`http://127.0.0.1:${address.port}/fixture`, {
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(((await response.json()) as any).status, 'fixture_only');
      network.push(performance.now() - start);
    }
    const report = {
      kind: 'deterministic_local_microbenchmark',
      node: process.version,
      platform: process.platform,
      cpu: os.cpus()[0]?.model,
      kernel: distribution(kernel),
      lexicalRetrieval: distribution(retrieval),
      loopbackHttp: distribution(network),
      model: { status: 'not_run', samples: 0 },
      externalNetwork: { status: 'not_run', samples: 0 },
      limits:
        'Synthetic SQLite data, no model or external provider. Includes host policy and context work; no production SLA. Loopback timings do not estimate campus/DeepSeek latency.',
    };
    fs.writeFileSync(
      path.join(path.dirname(process.env.ZAICHANG_CASE_REPORT!), 'performance.json'),
      JSON.stringify(report, null, 2),
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.close();
  }
});
