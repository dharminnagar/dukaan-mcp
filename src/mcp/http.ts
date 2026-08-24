import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

const PORT = Number.parseInt(process.env.PORT ?? '8787', 10);

/**
 * The factory runs ONCE PER REQUEST with { era, authInfo, requestInfo }.
 *
 * ctx.authInfo is strictly pass-through — createMcpHandler never populates it
 * from headers and performs no token verification. So multi-tenancy reads the
 * header off ctx.requestInfo here, which is the point of the per-request factory.
 */
const handler = createMcpHandler(
  ({ requestInfo }) => {
    const authorization = requestInfo?.headers.get('authorization') ?? null;

    const server = new McpServer({ name: 'dukaan-mcp', version: '0.1.0' });

    server.registerTool(
      'whoami',
      {
        title: 'Who am I',
        description: 'Echoes back the Authorization header the caller sent. Spike only.',
        inputSchema: z.object({}),
      },
      async () => ({
        content: [{ type: 'text' as const, text: authorization ?? '<no authorization header>' }],
      }),
    );

    return server;
  },
  { onerror: (err) => console.error('[mcp]', err.message) },
);

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return new Response('ok\n');
    if (url.pathname !== '/mcp') return new Response('not found\n', { status: 404 });
    return handler.fetch(req);
  },
});

console.log(`mcp listening on http://127.0.0.1:${PORT}/mcp`);
