'use strict';

const { spawn } = require('child_process');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const CLI_PATH = require.resolve('@webarkit/nft-marker-creator-app/src/NFTMarkerCreator.js');
const DEFAULT_THREADS = 8;
const TIMEOUT_MS = 20 * 60 * 1000;

function threadCount() {
  const requested = Number.parseInt(process.env.AR_MARKER_THREADS || '', 10);
  const available = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : os.cpus().length;

  if (Number.isFinite(requested) && requested > 0) {
    return Math.max(1, Math.min(requested, available));
  }
  return Math.max(1, Math.min(DEFAULT_THREADS, available));
}

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

/**
 * Run WebARKit's NFT marker creator on a normalised JPEG. It emits the
 * .iset/.fset/.fset3 triplet used by AR.js. Generation is CPU-heavy (tens of
 * seconds to a couple of minutes), so this is always called from the job queue.
 */
function generateMarker({ imagePath, outputDir, id, onLine }) {
  const threads = threadCount();
  const filename = `${id}.jpg`;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let tail = [];

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };

    const handleLine = (line) => {
      const clean = stripAnsi(line).trim();
      if (!clean) return;
      tail.push(clean);
      if (tail.length > 60) tail.shift();
      if (onLine) onLine(clean);
    };

    const env = { ...process.env };
    env.NODE_OPTIONS = [env.NODE_OPTIONS, '--max-old-space-size=4096']
      .filter(Boolean)
      .join(' ')
      .trim();

    fsp.mkdir(outputDir, { recursive: true })
      .then(() => {
        const child = spawn(
          process.execPath,
          [CLI_PATH, '-i', imagePath, '-o', outputDir, '--threaded', String(threads)],
          {
            cwd: path.dirname(CLI_PATH),
            env,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
          }
        );

        const started = Date.now();

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => chunk.split(/\r?\n/).forEach(handleLine));
        child.stderr.on('data', (chunk) => chunk.split(/\r?\n/).forEach(handleLine));

        child.on('error', (error) => {
          finish(new Error(`Could not start the marker generator: ${error.message}`));
        });

        child.on('close', async (code) => {
          if (settled) return;
          if (code !== 0) {
            finish(new Error(
              `Marker generation failed (exit ${code}).\n${tail.slice(-12).join('\n')}`
            ));
            return;
          }

          try {
            const names = ['fset', 'fset3', 'iset'];
            for (const extension of names) {
              const source = path.join(outputDir, `${id}.${extension}`);
              const destination = path.join(outputDir, `marker.${extension}`);
              const stats = await fsp.stat(source);
              if (!stats.size) throw new Error(`The generator produced an empty .${extension} file.`);
              await fsp.rm(destination, { force: true });
              await fsp.rename(source, destination);
            }

            finish(null, {
              ms: Date.now() - started,
              threads,
              bytes: await totalBytes(outputDir, names)
            });
          } catch (error) {
            finish(error);
          }
        });

        timer = setTimeout(() => {
          child.kill();
          finish(new Error('Marker generation timed out after 20 minutes.'));
        }, TIMEOUT_MS);
      })
      .catch((error) => finish(error));
  });
}

async function totalBytes(outputDir, names) {
  let total = 0;
  for (const extension of names) {
    try {
      total += (await fsp.stat(path.join(outputDir, `marker.${extension}`))).size;
    } catch (error) {
      /* reported by the caller's own checks */
    }
  }
  return total;
}

module.exports = {
  generateMarker,
  threadCount,
  CLI_PATH,
  filenameFor: (id) => `${id}.jpg`
};
