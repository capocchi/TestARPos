'use strict';

const fsp = require('fs/promises');
const path = require('path');

const store = require('./store');
const media = require('./media');
const marker = require('./marker');

const TMP_ROOT = path.join(store.ROOT, '.tmp');
const UPLOAD_DIR = path.join(TMP_ROOT, 'uploads');
const JOB_DIR = path.join(TMP_ROOT, 'jobs');

async function prepareTemp() {
  await fsp.rm(TMP_ROOT, { recursive: true, force: true });
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  await fsp.mkdir(JOB_DIR, { recursive: true });
}

function assetPath(id, file) {
  return `assets/targets/${id}/${file}`;
}

function markerStage(line) {
  if (/Generating FeatureList/i.test(line)) return 'Extracting image features…';
  if (/Generating FeatureSet3/i.test(line)) return 'Building multi-scale features…';
  if (/Saving/i.test(line)) return 'Saving marker files…';
  if (/NFTMarkerGenerator took/i.test(line)) return 'Finalising marker…';
  return null;
}

/**
 * Turn one upload into a complete, scannable target folder:
 *
 *   image.jpg      normalised 72 DPI still
 *   animation.gif  uploaded GIF, or an auto-generated living-light loop
 *   edges.png      contour fallback for the shader
 *   marker.fset    AR.js NFT descriptor triplet
 *   marker.fset3
 *   marker.iset
 */
async function buildTarget({ job, id, title, imageFile, animationFile }) {
  const work = path.join(JOB_DIR, job.id);
  const imagePath = path.join(work, `${id}.jpg`);
  const animationPath = path.join(work, 'animation.gif');
  const edgesPath = path.join(work, 'edges.png');
  const markerPath = path.join(work, 'nft');

  let finalDir = null;
  let added = false;

  try {
    await fsp.mkdir(work, { recursive: true });

    job.step = 'Normalising image…';
    const sizes = await media.normaliseImage(imageFile, imagePath);

    let autoAnimation = false;
    let animationInfo;
    let notice = '';

    if (animationFile) {
      job.step = 'Checking animation…';
      animationInfo = await media.validateGif(animationFile);
      await fsp.copyFile(animationFile, animationPath);

      const imageAspect = sizes.width / sizes.height;
      const animationAspect = animationInfo.width / animationInfo.height;
      if (Math.abs(imageAspect - animationAspect) / imageAspect > 0.03) {
        notice = `The animation is ${animationInfo.width}×${animationInfo.height} but the image is ` +
          `${sizes.width}×${sizes.height}; it will be stretched to fill the print.`;
      }
    } else {
      job.step = 'Animating the print…';
      animationInfo = await media.makeAutoGif(imagePath, animationPath);
      autoAnimation = true;
    }

    job.step = 'Tracing contours…';
    await media.makeEdges(imagePath, edgesPath);

    job.step = 'Generating AR marker… (about a minute)';
    const markerResult = await marker.generateMarker({
      imagePath,
      outputDir: markerPath,
      id,
      onLine: (line) => {
        const stage = markerStage(line);
        if (stage) job.step = stage;
      }
    });

    finalDir = path.join(store.TARGETS_DIR, id);
    await fsp.mkdir(finalDir, { recursive: true });

    await fsp.copyFile(imagePath, path.join(finalDir, 'image.jpg'));
    await fsp.copyFile(animationPath, path.join(finalDir, 'animation.gif'));
    await fsp.copyFile(edgesPath, path.join(finalDir, 'edges.png'));
    for (const extension of ['fset', 'fset3', 'iset']) {
      await fsp.copyFile(
        path.join(markerPath, `marker.${extension}`),
        path.join(finalDir, `marker.${extension}`)
      );
    }

    const entry = {
      id,
      title,
      image: assetPath(id, 'image.jpg'),
      animation: assetPath(id, 'animation.gif'),
      edges: assetPath(id, 'edges.png'),
      marker: `assets/targets/${id}/marker`,
      width: sizes.width,
      height: sizes.height,
      dpi: sizes.dpi,
      widthMm: Number(sizes.widthMm.toFixed(3)),
      heightMm: Number(sizes.heightMm.toFixed(3)),
      autoAnimation,
      animationWidth: animationInfo.width,
      animationHeight: animationInfo.height,
      animationFrames: animationInfo.frames || null,
      createdAt: new Date().toISOString()
    };
    if (notice) entry.notice = notice;

    job.step = 'Saving target…';
    await store.addTarget(entry);
    added = true;

    return { entry, marker: markerResult };
  } catch (error) {
    if (finalDir && !added) {
      await fsp.rm(finalDir, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }
}

async function cleanupJob(job, files) {
  await fsp.rm(path.join(JOB_DIR, job.id), { recursive: true, force: true }).catch(() => {});
  for (const file of files) {
    if (file) await fsp.rm(file, { force: true }).catch(() => {});
  }
}

module.exports = {
  TMP_ROOT,
  UPLOAD_DIR,
  JOB_DIR,
  prepareTemp,
  buildTarget,
  cleanupJob
};
