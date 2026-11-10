'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ASSETS_DIR = path.join(ROOT, 'assets');
const TARGETS_DIR = path.join(ASSETS_DIR, 'targets');
const MANIFEST_PATH = path.join(ASSETS_DIR, 'targets.json');

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Manifest writes are serialized so a delete cannot race a finished upload.
let writeChain = Promise.resolve();

function serialize(task) {
  const run = writeChain.then(task, task);
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}

async function ensureStore() {
  await fsp.mkdir(TARGETS_DIR, { recursive: true });
  try {
    await fsp.access(MANIFEST_PATH);
  } catch (error) {
    await writeManifest({ version: 1, updatedAt: new Date().toISOString(), targets: [] });
  }
}

function emptyManifest() {
  return { version: 1, updatedAt: new Date().toISOString(), targets: [] };
}

async function readManifest() {
  let raw;
  try {
    raw = await fsp.readFile(MANIFEST_PATH, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return emptyManifest();
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`targets.json is not valid JSON: ${error.message}`);
  }

  if (!parsed || !Array.isArray(parsed.targets)) {
    throw new Error('targets.json must contain a "targets" array.');
  }

  return {
    version: parsed.version || 1,
    updatedAt: parsed.updatedAt || new Date().toISOString(),
    targets: parsed.targets.filter(isValidTarget)
  };
}

function isValidTarget(target) {
  return Boolean(
    target &&
    typeof target.id === 'string' &&
    ID_PATTERN.test(target.id) &&
    typeof target.image === 'string' &&
    typeof target.marker === 'string'
  );
}

async function writeManifest(manifest) {
  const data = JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    targets: manifest.targets
  }, null, 2) + '\n';

  const temp = `${MANIFEST_PATH}.${process.pid}.${Date.now()}.tmp`;
  await fsp.mkdir(path.dirname(MANIFEST_PATH), { recursive: true });
  await fsp.writeFile(temp, data, 'utf8');

  // copyFile overwrites, which is portable across Windows rename semantics.
  await fsp.copyFile(temp, MANIFEST_PATH);
  await fsp.unlink(temp).catch(() => {});
}

function slugify(value, fallback) {
  const slug = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 48)
    .replace(/-+$/g, '');

  if (slug && ID_PATTERN.test(slug)) return slug;
  return fallback || 'target';
}

async function uniqueId(base) {
  const manifest = await readManifest();
  const taken = new Set(manifest.targets.map((target) => target.id));

  let candidate = base;
  let index = 2;
  while (taken.has(candidate) || fs.existsSync(path.join(TARGETS_DIR, candidate))) {
    candidate = `${base}-${index}`;
    index += 1;
  }
  return candidate;
}

async function addTarget(entry) {
  return serialize(async () => {
    const manifest = await readManifest();
    if (manifest.targets.some((target) => target.id === entry.id)) {
      throw new Error(`A target with id "${entry.id}" already exists.`);
    }
    manifest.targets.push(entry);
    await writeManifest(manifest);
    return entry;
  });
}

async function removeTarget(id) {
  if (!ID_PATTERN.test(String(id || ''))) {
    const error = new Error('Invalid target id.');
    error.status = 400;
    throw error;
  }

  return serialize(async () => {
    const manifest = await readManifest();
    const index = manifest.targets.findIndex((target) => target.id === id);
    if (index === -1) {
      const error = new Error('Target not found.');
      error.status = 404;
      throw error;
    }

    manifest.targets.splice(index, 1);
    await writeManifest(manifest);

    const targetDir = path.join(TARGETS_DIR, id);
    if (path.dirname(targetDir) === TARGETS_DIR) {
      await fsp.rm(targetDir, { recursive: true, force: true });
    }

    return { id };
  });
}

module.exports = {
  ROOT,
  ASSETS_DIR,
  TARGETS_DIR,
  MANIFEST_PATH,
  ID_PATTERN,
  ensureStore,
  readManifest,
  writeManifest,
  slugify,
  uniqueId,
  addTarget,
  removeTarget
};
