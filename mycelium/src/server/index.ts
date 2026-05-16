import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { logger } from 'hono/logger';
import { nip05Route } from './routes/nip05';
import { healthRoute } from './routes/health';
import { relaysRoute } from './routes/relays';
import { cacheRoute } from './routes/cache';
import { getDb, getEventCount } from './db';
import { startMonitor } from './monitor/probe';

const app = new Hono();

// Initialize database on startup
const db = getDb();
console.log(`📦 SQLite database initialized (${getEventCount()} cached events)`);

// Start relay monitor (background probe engine)
startMonitor();

app.use('*', logger());

// Block sensitive file probes
app.use('*', async (c, next) => {
  const path = c.req.path;
  if (
    path.startsWith('/.env') ||
    path.startsWith('/.git') ||
    path.startsWith('/.svn') ||
    path.startsWith('/.htaccess') ||
    path.startsWith('/wp-') ||
    path.endsWith('.php') ||
    path.includes('..')
  ) {
    return c.text('Not Found', 404);
  }
  return next();
});

// API routes
app.route('/api', healthRoute);
app.route('/api/cache', cacheRoute);
app.route('/.well-known', nip05Route);

// Relay discovery API (NIP-66 rstate proxy)
// HAProxy sends /api/* to relaycreator, not ribbit — so relay endpoints
// live at /relays/* which HAProxy routes to ribbit's Hono server.
app.route('/', relaysRoute);

// Serve static assets from dist/public
app.use('/assets/*', serveStatic({ root: './dist/public' }));
app.use('/favicon.ico', serveStatic({ root: './dist/public' }));
app.use('/blazecn.png', serveStatic({ root: './dist/public' }));

// SPA fallback: serve index.html for all non-API routes
app.get('*', serveStatic({ root: './dist/public', path: '/index.html' }));

const port = Number(process.env.PORT) || 3000;

console.log(`🐸 ribbit.network starting on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};
