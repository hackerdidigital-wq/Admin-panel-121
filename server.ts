import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { getLocalD1Database } from './src/db/local-d1.ts';
import { handleApiRequest } from './src/worker/app.ts';
import type { WorkerEnv } from './src/worker/types.ts';

const PORT = 3000;

function getLocalWorkerEnv(): WorkerEnv {
  return {
    DB: getLocalD1Database(),
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GITHUB_DEFAULT_REPO: process.env.GITHUB_DEFAULT_REPO,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    EMAIL_PROVIDER_URL: process.env.EMAIL_PROVIDER_URL,
    PUSH_PROVIDER_URL: process.env.PUSH_PROVIDER_URL,
    APP_URL: process.env.APP_URL,
    APP_ENV: process.env.NODE_ENV || 'development',
  };
}

async function startServer() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // Forward all /api/* requests through the exact Cloudflare Worker Web Request handler
  app.use('/api', express.raw({ type: '*/*', limit: '4mb' }), async (req, res) => {
    try {
      const host = req.headers.host || `localhost:${PORT}`;
      const forwardedProto = req.headers['x-forwarded-proto'];
      const protocol =
        (typeof forwardedProto === 'string' ? forwardedProto.split(',')[0].trim() : '') ||
        req.protocol ||
        'http';
      const targetUrl = `${protocol}://${host}${req.originalUrl}`;

      const headers = new Headers();
      for (const [key, val] of Object.entries(req.headers)) {
        if (val === undefined) continue;
        if (Array.isArray(val)) {
          for (const item of val) headers.append(key, item);
        } else {
          headers.set(key, val);
        }
      }

      const method = req.method.toUpperCase();
      const hasBody = method !== 'GET' && method !== 'HEAD';
      const bodyBuffer =
        hasBody && Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : undefined;

      const webReq = new Request(targetUrl, {
        method,
        headers,
        body: bodyBuffer ? new Uint8Array(bodyBuffer) : undefined,
      });

      const webRes = await handleApiRequest(webReq, getLocalWorkerEnv());
      res.status(webRes.status);

      const setCookies =
        typeof webRes.headers.getSetCookie === 'function' ? webRes.headers.getSetCookie() : [];
      for (const cookieVal of setCookies) {
        res.append('Set-Cookie', cookieVal);
      }
      webRes.headers.forEach((value, key) => {
        if (key.toLowerCase() !== 'set-cookie') {
          res.setHeader(key, value);
        }
      });

      const arrayBuf = await webRes.arrayBuffer();
      res.send(Buffer.from(arrayBuf));
    } catch (err) {
      console.error('Local Worker bridge error:', err);
      res.status(500).json({ error: 'Local API adapter failure.' });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Aegis Enterprise Console (D1 SQLite / Worker runtime) listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
