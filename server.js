'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const express = require('express');
const multer = require('multer');

const store = require('./lib/store');
const pipeline = require('./lib/pipeline');

const PORT = Number.parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '127.0.0.1';
const ADMIN_USER = process.env.AR_ADMIN_USER || 'iutmmi';
const ADMIN_PASSWORD = process.env.AR_ADMIN_PASSWORD || 'iutmmi@corti';
const COOKIE_NAME = 'ar_admin';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

const ROOT = store.ROOT;
const BACKOFFICE_DIR = path.join(ROOT, 'backoffice');
const INDEX_PATH = path.join(ROOT, 'index.html');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

const sessions = new Map();
const loginAttempts = new Map();
const jobs = new Map();
let jobChain = Promise.resolve();

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function safeEqual(a, b) {
  return crypto.timingSafeEqual(hash(a), hash(b));
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const chunk of header.split(';')) {
    const index = chunk.indexOf('=');
    if (index === -1) continue;
    const key = chunk.slice(0, index).trim();
    const value = chunk.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { createdAt: Date.now() });
  return token;
}

function sessionFor(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function requireAuth(req, res, next) {
  if (!sessionFor(req)) {
    res.status(401).json({ error: 'Please sign in to use the backoffice.' });
    return;
  }
  next();
}

function cookieSecure(req) {
  if (process.env.AR_COOKIE_SECURE === '1') return true;
  return req.secure;
}

/* ------------------------------------------------------------------ */
/* Upload handling                                                     */
/* ------------------------------------------------------------------ */

const upload = multer({
  dest: pipeline.UPLOAD_DIR,
  limits: {
    fileSize: 30 * 1024 * 1024,
    files: 2,
    fields: 6,
    fieldSize: 1024 * 1024
  },
  fileFilter(req, file, callback) {
    if (file.fieldname === 'image') {
      if (!/^image\/(jpeg|png|webp)$/i.test(file.mimetype || '')) {
        callback(new HttpError(400, 'The image must be a JPEG, PNG or WebP file.'));
        return;
      }
      callback(null, true);
      return;
    }

    if (file.fieldname === 'animation') {
      if (file.mimetype === 'image/gif' || /\.gif$/i.test(file.originalname || '')) {
        callback(null, true);
        return;
      }
      callback(new HttpError(400, 'The animation must be a GIF file.'));
      return;
    }

    callback(new HttpError(400, `Unexpected upload field "${file.fieldname}".`));
  }
});

function uploadedPaths(req) {
  const paths = [];
  for (const list of Object.values(req.files || {})) {
    for (const file of list) {
      if (file && file.path) paths.push(file.path);
    }
  }
  return paths;
}

async function discard(paths) {
  await Promise.all(paths.map((file) => fsp.rm(file, { force: true }).catch(() => {})));
}

/* ------------------------------------------------------------------ */
/* Job queue                                                           */
/* ------------------------------------------------------------------ */

function publicJob(job) {
  return {
    id: job.id,
    state: job.state,
    title: job.title,
    targetId: job.targetId,
    step: job.step,
    error: job.error || null,
    createdAt: job.createdAt,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    elapsedMs: job.startedAt ? (job.finishedAt || Date.now()) - job.startedAt : 0,
    result: job.result || null
  };
}

function pruneJobs() {
  const finished = [...jobs.values()]
    .filter((job) => job.state === 'done' || job.state === 'error')
    .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));

  for (const job of finished.slice(20)) {
    jobs.delete(job.id);
  }
}

function enqueueJob({ id, title, base, imageFile, animationFile }) {
  const job = {
    id,
    state: 'queued',
    title,
    targetId: null,
    step: 'Waiting for the marker generator…',
    error: null,
    createdAt: Date.now(),
    uploads: [imageFile, animationFile].filter(Boolean)
  };

  jobs.set(job.id, job);
  pruneJobs();

  jobChain = jobChain.then(async () => {
    job.state = 'running';
    job.startedAt = Date.now();
    try {
      // Resolve the id inside the queue: two uploads with the same title then
      // can never claim the same folder before either one has committed.
      const targetId = await store.uniqueId(base);
      job.targetId = targetId;

      const result = await pipeline.buildTarget({
        job,
        id: targetId,
        title,
        imageFile,
        animationFile
      });
      job.state = 'done';
      job.step = 'Ready to scan';
      job.result = {
        ...result.entry,
        markerMs: result.marker.ms,
        markerThreads: result.marker.threads,
        markerBytes: result.marker.bytes
      };
    } catch (error) {
      job.state = 'error';
      job.step = 'Generation failed';
      job.error = String(error && error.message ? error.message : error).slice(0, 4000);
      console.error(`[job ${job.id}]`, job.error);
    } finally {
      job.finishedAt = Date.now();
      await pipeline.cleanupJob(job, job.uploads);
      delete job.uploads;
    }
  });

  jobChain = jobChain.catch((error) => {
    console.error('[queue]', error);
  });

  return job;
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', false);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use('/api', express.json({ limit: '64kb' }));

app.post('/api/login', (req, res) => {
  const ip = req.ip || 'local';
  const now = Date.now();
  const attempt = loginAttempts.get(ip);

  if (attempt && attempt.resetAt > now && attempt.count >= LOGIN_MAX_ATTEMPTS) {
    res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
    return;
  }

  const username = String((req.body && req.body.username) || '');
  const password = String((req.body && req.body.password) || '');

  if (!safeEqual(username, ADMIN_USER) || !safeEqual(password, ADMIN_PASSWORD)) {
    const current = attempt && attempt.resetAt > now ? attempt : { count: 0, resetAt: now + LOGIN_WINDOW_MS };
    current.count += 1;
    loginAttempts.set(ip, current);
    res.status(401).json({ error: 'Invalid username or password.' });
    return;
  }

  loginAttempts.delete(ip);
  const token = createSession();
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: cookieSecure(req),
    maxAge: SESSION_TTL_MS,
    path: '/'
  });
  res.json({ ok: true, user: ADMIN_USER });
});

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (token) sessions.delete(token);
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/session', (req, res) => {
  res.json({ authenticated: Boolean(sessionFor(req)), user: ADMIN_USER });
});

app.get('/api/targets', requireAuth, async (req, res, next) => {
  try {
    const manifest = await store.readManifest();
    const pending = [...jobs.values()]
      .filter((job) => job.state === 'queued' || job.state === 'running')
      .map(publicJob);
    res.json({
      targets: manifest.targets,
      updatedAt: manifest.updatedAt,
      pending
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/jobs', requireAuth, (req, res) => {
  const list = [...jobs.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(publicJob);
  res.json({ jobs: list });
});

app.get('/api/jobs/:id', requireAuth, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'Job not found.' });
    return;
  }
  res.json({ job: publicJob(job) });
});

app.post('/api/targets', requireAuth, upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'animation', maxCount: 1 }
]), async (req, res, next) => {
  const files = uploadedPaths(req);

  try {
    const imageFile = req.files && req.files.image && req.files.image[0];
    let animationFile = req.files && req.files.animation && req.files.animation[0];

    if (!imageFile) {
      await discard(files);
      res.status(400).json({ error: 'A still image is required.' });
      return;
    }

    if (animationFile) {
      const stats = await fsp.stat(animationFile.path);
      if (!stats.size) {
        await fsp.rm(animationFile.path, { force: true });
        animationFile = null;
      }
    }

    const rawTitle = String((req.body && req.body.title) || '').trim();
    const fallbackTitle = path.parse(imageFile.originalname || 'target').name.replace(/[_-]+/g, ' ');
    const title = (rawTitle || fallbackTitle || 'Untitled target')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .slice(0, 80)
      .trim() || 'Untitled target';

    const base = store.slugify(rawTitle || fallbackTitle, 'target');
    const jobId = crypto.randomUUID();

    const job = enqueueJob({
      id: jobId,
      title,
      base,
      imageFile: imageFile.path,
      animationFile: animationFile ? animationFile.path : null
    });

    res.status(202).json({
      job: publicJob(job),
      target: { title, slug: base }
    });
  } catch (error) {
    await discard(files);
    next(error);
  }
});

app.delete('/api/targets/:id', requireAuth, async (req, res, next) => {
  try {
    const removed = await store.removeTarget(req.params.id);
    res.json({ ok: true, removed: removed.id });
  } catch (error) {
    next(error);
  }
});

/* ------------------------------------------------------------------ */
/* Static app                                                          */
/* ------------------------------------------------------------------ */

app.get('/', (req, res) => res.sendFile(INDEX_PATH));
app.get('/index.html', (req, res) => res.sendFile(INDEX_PATH));
app.get('/favicon.ico', (req, res) => res.status(204).end());

app.use('/assets', express.static(store.ASSETS_DIR, {
  dotfiles: 'deny',
  fallthrough: true,
  maxAge: 0
}));
// express.static redirects /backoffice to /backoffice/ and serves index.html
// from the directory, so no explicit redirect route is needed (Express 5's
// non-strict routing would otherwise make /backoffice/ redirect to itself).
app.use('/backoffice', express.static(BACKOFFICE_DIR, {
  dotfiles: 'deny',
  index: 'index.html',
  maxAge: 0
}));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ error: 'Not found.' });
    return;
  }
  res.status(404).type('text/plain').send('Not found');
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  let status = error.status || error.statusCode || 500;
  let message = error.message || 'Unexpected server error.';

  if (error instanceof multer.MulterError) {
    status = 400;
    if (error.code === 'LIMIT_FILE_SIZE') {
      message = 'The file is too large (maximum 30 MB).';
    } else if (error.code === 'LIMIT_FILE_COUNT') {
      message = 'Too many files. Add one image and, optionally, one GIF.';
    } else if (error.code === 'LIMIT_UNEXPECTED_FILE') {
      message = `Unexpected upload field "${error.field}".`;
    }
  }

  if (status >= 500) {
    console.error('[server]', error);
  }

  if (req.path.startsWith('/api/')) {
    res.status(status).json({ error: message });
    return;
  }
  res.status(status).type('text/plain').send(message);
});

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) sessions.delete(token);
  }
  for (const [ip, attempt] of loginAttempts) {
    if (attempt.resetAt <= now) loginAttempts.delete(ip);
  }
}, 10 * 60 * 1000);
cleanupTimer.unref();

(async () => {
  await store.ensureStore();
  await pipeline.prepareTemp();

  app.listen(PORT, HOST, () => {
    console.log('');
    console.log('  STUDIÀ LIBERTÀ · AR');
    console.log(`  App        http://${HOST}:${PORT}/`);
    console.log(`  Backoffice http://${HOST}:${PORT}/backoffice/`);
    if (ADMIN_USER === 'iutmmi' && ADMIN_PASSWORD === 'iutmmi@corti') {
      console.log('  Login      iutmmi / iutmmi@corti');
      console.log('             (set AR_ADMIN_USER / AR_ADMIN_PASSWORD to override)');
    }
    console.log('');
  });
})().catch((error) => {
  console.error('Could not start the server:', error);
  process.exit(1);
});
