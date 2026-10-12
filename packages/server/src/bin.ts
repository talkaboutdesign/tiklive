#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { LiveServer } from './server/server.js';

const { values } = parseArgs({
  options: {
    port: { type: 'string', short: 'p' },
    host: { type: 'string' },
    token: { type: 'string' },
    watch: { type: 'string', short: 'w', multiple: true },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  console.log(`tiklive — self-hosted TikTok LIVE event server

Usage: tiklive [options]

  -p, --port <n>       Port to listen on (env PORT, default 8080)
      --host <addr>    Interface to bind (env HOST, default 127.0.0.1)
      --token <secret> Require this token for API and WebSocket access (env TIKLIVE_TOKEN)
  -w, --watch <user>   Stay connected to a streamer, reconnecting whenever they go live.
                       Repeatable (env TIKLIVE_WATCH, comma-separated)
  -h, --help           Show this help

Open http://localhost:8080 for the dashboard. Use the username "demo" to test overlays with fake events.`);
  process.exit(0);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const watch = [...(values.watch ?? []), ...(process.env.TIKLIVE_WATCH?.split(',').filter(Boolean) ?? [])];
const token = values.token ?? process.env.TIKLIVE_TOKEN;
const host = values.host ?? process.env.HOST ?? '127.0.0.1';

const server = new LiveServer({
  port: Number(values.port ?? process.env.PORT ?? 8080),
  host,
  ...(token ? { token } : {}),
  publicDir: join(root, 'public'),
  watch,
});

const { port } = await server.listen();
const shown = host === '0.0.0.0' ? 'localhost' : host;
console.log(`tiklive listening on http://${shown}:${port}`);
if (watch.length) console.log(`watching: ${watch.map((w) => '@' + w).join(', ')}`);
if (host !== '127.0.0.1' && host !== 'localhost' && !token) {
  console.warn('warning: listening on a public interface without --token; anyone who can reach it can use this server');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
