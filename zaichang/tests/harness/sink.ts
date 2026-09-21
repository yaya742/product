import { createServer, type Server } from 'node:http';
import { z } from 'zod';
import type { CapabilityProvider } from '../../src/main/capabilities/broker';

export class ExternalSink {
  readonly requests: { method: string; path: string; key: string }[] = [];
  readonly effects = new Map<string, string>();
  mode: 'success' | 'commit_then_disconnect' | 'fail_then_disconnect' | 'disconnect_unknown' = 'success';
  server: Server;
  origin = '';
  constructor() {
    this.server = createServer(async (req, res) => {
      const url = new URL(req.url || '/', this.origin || 'http://127.0.0.1'),
        key = String(req.headers['idempotency-key'] || url.searchParams.get('key') || '');
      this.requests.push({ method: req.method || '', path: url.pathname, key });
      if (req.method === 'POST') {
        let body = '';
        for await (const chunk of req) {
          body += String(chunk);
          if (body.length > 8000) {
            res.writeHead(413).end();
            return;
          }
        }
        JSON.parse(body || '{}');
        if (this.mode === 'fail_then_disconnect' || this.mode === 'disconnect_unknown') {
          res.destroy();
          return;
        }
        if (!this.effects.has(key)) this.effects.set(key, 'record-' + this.effects.size);
        if (this.mode === 'commit_then_disconnect') {
          res.destroy();
          return;
        }
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          receiptStatus: this.effects.has(key) ? 'confirmed_success' : 'confirmed_failure',
          ...(this.effects.has(key) ? { externalRecordId: this.effects.get(key) } : {}),
        }),
      );
    });
  }
  async start() {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('No sink address');
    this.origin = 'http://127.0.0.1:' + address.port;
    return this;
  }
  async close() {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
  provider(inspect = true): CapabilityProvider {
    const sourceId = 'test:external-sink';
    return {
      manifest: {
        id: 'controlled-external-sink',
        version: '1',
        trust: 'bundled_reviewed',
        sourceId,
        capabilities: [
          {
            name: inspect ? 'test.external.book' : 'test.external.no_inspect',
            version: '1',
            input: z.object({ title: z.string() }).strict(),
            output: z
              .object({
                receiptStatus: z.enum(['confirmed_success', 'confirmed_failure', 'unknown']),
                externalRecordId: z.string().optional(),
              })
              .strict(),
            effect: 'external_write',
            requiredScopes: ['external:book'],
            subjects: ['self'],
            worlds: ['real'],
            timeoutMs: 2000,
            maxBytes: 4000,
            supportsIdempotency: inspect,
            supportsInspect: inspect,
            supportsCancel: false,
          },
        ],
        egressHosts: [new URL(this.origin).host],
        platforms: ['*'],
        simulated: true,
        offline: 'unsupported',
        license: 'synthetic owned fixture',
      },
      invoke: async (_name, args, ctx) => {
        const response = await ctx.request(this.origin + '/execute', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': ctx.idempotencyKey! },
          body: JSON.stringify(args),
        });
        return { status: 'fresh', sourceId, data: await response.json(), simulated: true };
      },
      inspect: async (_name, key, ctx) => {
        const response = await ctx.request(this.origin + '/inspect?key=' + encodeURIComponent(key));
        return { status: 'fresh', sourceId, data: await response.json(), simulated: true };
      },
    };
  }
}
