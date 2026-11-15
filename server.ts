import 'dotenv/config';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import { createAuthApp } from './server/app.ts';
import {
  bootstrapOwnerFromEnv,
  createRuntimeStore,
} from './server/runtime-store.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveListenTarget(isProd: boolean): { port: number; host: string } {
  const args = process.argv.slice(2);
  let cliPort: string | undefined;
  let cliHost: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--port' || arg === '-p') {
      cliPort = args[i + 1];
      i += 1;
    } else if (arg.startsWith('--port=')) {
      cliPort = arg.slice('--port='.length);
    } else if (arg === '--host' || arg === '-H') {
      cliHost = args[i + 1];
      i += 1;
    } else if (arg.startsWith('--host=')) {
      cliHost = arg.slice('--host='.length);
    }
  }

  let portSource = cliPort;
  if (!portSource) {
    const envPort = (process.env.PORT || '').trim();
    const nginxPort = (process.env.NGINX_PORT || '').trim();
    const defaultAppPort = (process.env.DEFAULT_APP_PORT || '3000').trim();
    // In AI Studio dev containers, nginx occupies NGINX_PORT (e.g. 8080) and proxies to DEFAULT_APP_PORT (3000).
    if (!isProd && envPort && nginxPort && envPort === nginxPort) {
      portSource = defaultAppPort;
    } else {
      portSource = envPort || defaultAppPort;
    }
  }

  const parsedPort = Number.parseInt(portSource || '3000', 10);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : 3000;
  const host = (cliHost || '0.0.0.0').trim() || '0.0.0.0';
  return { port, host };
}

async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';
  const { port, host } = resolveListenTarget(isProd);

  const rootApp = express();
  const httpServer = http.createServer(rootApp);

  let readyApp: Express | null = null;
  let startupError: unknown = null;

  const readyPromise = (async () => {
    const { store, config, diagnostics } = await createRuntimeStore();
    console.log(
      `[sahithi] targetEnv=${config.targetEnv} (${config.targetEnvSource}) backend=${store.backend} authMode=${diagnostics.authMode} persistent=${store.isPersistent} store=${store.locationLabel}`
    );
    if (store.backend === 'sqlite' && !store.isPersistent) {
      console.warn(
        `[sahithi] Notice: Using local SQLite (${config.sqliteDbPath}). Firestore project "${diagnostics.firebaseProjectId || 'unknown'}" was not reachable (${diagnostics.firestoreErrorCode || 'UNAVAILABLE'}).`
      );
    }

    const bootstrapResult = await bootstrapOwnerFromEnv(store, config.ownerEmail, process.env);
    if (bootstrapResult.mode === 'firebase_managed') {
      console.log(
        `[sahithi] Managed Firebase Auth + Persistent Firestore active for authorized owner ${bootstrapResult.email}. Open ${config.canonicalAppUrl || 'http://localhost:3000'}/admin/login to activate or sign in.`
      );
    } else if (bootstrapResult.mode === 'already_configured') {
      console.log(
        `[sahithi] Owner access active for ${bootstrapResult.binding.bound_email} (userId=${bootstrapResult.binding.owner_user_id}).`
      );
    } else if (bootstrapResult.mode === 'invalid_password') {
      console.warn(
        `[sahithi] Ignored ADMIN_OWNER_PASSWORD for ${bootstrapResult.email}: ${bootstrapResult.reason}`
      );
    } else if (bootstrapResult.mode === 'provisioned') {
      const res = bootstrapResult.result;
      if (res.status === 'conflict') {
        console.warn(
          `[sahithi] Owner binding conflict: existing binding belongs to userId=${res.existingUserId} (${res.existingEmail}); refused to reassign to ${res.email}.`
        );
      } else {
        console.log(
          `[sahithi] Owner account ${res.status === 'created' ? 'created & bound' : 'password updated & sessions rotated'} via server secret for ${res.binding.bound_email} (userId=${res.userId}).`
        );
      }
    } else {
      const ownerResult = bootstrapResult.result;
      if (ownerResult.status === 'bound' || ownerResult.status === 'already_bound') {
        console.log(
          `[sahithi] Owner access ${ownerResult.status === 'bound' ? 'automatically bound' : 'verified'} for ${ownerResult.binding.bound_email} (userId=${ownerResult.binding.owner_user_id}).`
        );
      } else if (ownerResult.status === 'conflict') {
        console.warn(
          `[sahithi] Owner binding conflict: existing binding belongs to userId=${ownerResult.existingUserId} (${ownerResult.existingEmail}); refused to reassign to ${ownerResult.email}.`
        );
      } else {
        console.log(
          `[sahithi] Owner account (${ownerResult.email}) not yet configured (${ownerResult.status}). Run \`npm run admin:setup\` or set ADMIN_OWNER_PASSWORD in server secrets to sign in at ${config.canonicalAppUrl || 'http://localhost:3000'}/admin/login.`
        );
      }
    }

    const { app } = createAuthApp({
      store,
      appBaseUrl: config.canonicalAppUrl || undefined,
    });

    if (!isProd) {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: {
          middlewareMode: true,
          hmr: process.env.DISABLE_HMR === 'true' ? false : { server: httpServer },
        },
        appType: 'spa',
      });
      app.use(vite.middlewares);
    } else {
      const distDir = path.resolve(__dirname, 'dist');
      app.use(express.static(distDir, { index: false }));
      app.get('*', (req, res) => {
        const indexHtml = path.join(distDir, 'index.html');
        if (fs.existsSync(indexHtml)) {
          const cleanPath = req.path.replace(/\/+$/, '') || '/';
          if (cleanPath === '/account' || cleanPath === '/admin' || cleanPath.startsWith('/admin/')) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            res.setHeader('X-Robots-Tag', 'noindex, nofollow');
            res.sendFile(indexHtml, { cacheControl: false });
          } else {
            res.sendFile(indexHtml);
          }
        } else {
          res.status(404).send('Production build not found. Run npm run build first.');
        }
      });
    }

    readyApp = app;
  })().catch((err) => {
    startupError = err;
    console.error('Failed to initialize Sahithi Collections server:', err);
    throw err;
  });

  rootApp.use(async (req, res, next) => {
    try {
      if (!readyApp) {
        await readyPromise;
      }
      if (!readyApp) {
        res.status(503).send('Server is initializing.');
        return;
      }
      return readyApp(req, res, next);
    } catch (err) {
      if (res.headersSent) return next(err);
      const message =
        startupError instanceof Error
          ? startupError.message
          : 'Server failed to initialize.';
      res.status(503).json({ code: 'SERVER_UNAVAILABLE', error: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.off('error', reject);
      console.log(`Sahithi Collections server listening on http://${host}:${port}`);
      resolve();
    });
  });

  await readyPromise;
}

startServer().catch((err) => {
  console.error('Failed to start Sahithi Collections server:', err);
  process.exit(1);
});
