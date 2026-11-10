'use strict';

const fsp = require('fs/promises');
const sharp = require('sharp');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');

const MAX_IMAGE_SIDE = 2048;
const MAX_EDGE_SIDE = 1024;
const MAX_GIF_SIDE = 560;
const GIF_FRAMES = 20;
const GIF_DELAY_MS = 90;
const GIF_COLORS = 200;

const IMAGE_FORMATS = new Set(['jpeg', 'png', 'webp']);

function smoothstep(edge0, edge1, value) {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Validate an uploaded still, then normalise it to a max-2048px sRGB JPEG at
 * 72 DPI. The DPI is what AR.js stores in the .iset marker, so fixing it keeps
 * the world scale of every target consistent.
 */
async function normaliseImage(inputPath, outputPath) {
  const source = sharp(inputPath, { failOn: 'error' });
  const metadata = await source.metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error('The uploaded image has no readable dimensions.');
  }
  if (!IMAGE_FORMATS.has(metadata.format)) {
    throw new Error('The image must be a JPEG, PNG or WebP file.');
  }

  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(metadata.width, metadata.height));
  const width = Math.max(1, Math.round(metadata.width * scale));
  const height = Math.max(1, Math.round(metadata.height * scale));
  const density = 72;

  await source
    .rotate()
    .resize({ width, height, fit: 'fill' })
    .flatten({ background: '#ffffff' })
    .withMetadata({ density })
    .jpeg({ quality: 92, mozjpeg: true, chromaSubsampling: '4:4:4' })
    .toFile(outputPath);

  const output = await sharp(outputPath).metadata();
  const finalWidth = output.width || width;
  const finalHeight = output.height || height;
  const finalDpi = output.density || density;

  return {
    width: finalWidth,
    height: finalHeight,
    dpi: finalDpi,
    widthMm: (finalWidth / finalDpi) * 25.4,
    heightMm: (finalHeight / finalDpi) * 25.4,
    bytes: (await fsp.stat(outputPath)).size
  };
}

/**
 * Build the neon contour fallback used before the GIF is decoded. White lines
 * on black at <=1024px, matching the baked map that shipped with the mural.
 */
async function makeEdges(imagePath, outputPath) {
  const metadata = await sharp(imagePath).metadata();
  const scale = Math.min(1, MAX_EDGE_SIDE / Math.max(metadata.width, metadata.height));
  const width = Math.max(3, Math.round(metadata.width * scale));
  const height = Math.max(3, Math.round(metadata.height * scale));

  const { data } = await sharp(imagePath)
    .resize({ width, height, fit: 'fill' })
    .greyscale()
    .blur(1.1)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const magnitude = new Float32Array(width * height);
  let max = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const tl = data[i - width - 1];
      const tc = data[i - width];
      const tr = data[i - width + 1];
      const ml = data[i - 1];
      const mr = data[i + 1];
      const bl = data[i + width - 1];
      const bc = data[i + width];
      const br = data[i + width + 1];

      const gx = -tl - 2 * ml - bl + tr + 2 * mr + br;
      const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
      const m = Math.hypot(gx, gy) / 1020;
      magnitude[i] = m;
      if (m > max) max = m;
    }
  }

  const output = Buffer.alloc(width * height * 3);
  if (max <= 1e-5) {
    await sharp(output, { raw: { width, height, channels: 3 } }).png().toFile(outputPath);
    return { width, height };
  }

  const threshold = 0.055;
  for (let i = 0; i < width * height; i++) {
    const value = magnitude[i] / max;
    const edge = smoothstep(threshold, threshold * 2.8, value);
    const byte = Math.round(255 * edge);
    output[i * 3] = byte;
    output[i * 3 + 1] = byte;
    output[i * 3 + 2] = byte;
  }

  await sharp(output, { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 9 })
    .toFile(outputPath);

  return { width, height };
}

/**
 * Create the fallback animation when no GIF is supplied: the still image stays
 * pixel-aligned with the print (so AR alignment is untouched) while a soft
 * light sweep and deterministic sparkles travel across it.
 */
async function makeAutoGif(imagePath, outputPath) {
  const metadata = await sharp(imagePath).metadata();
  const scale = Math.min(1, MAX_GIF_SIDE / Math.max(metadata.width, metadata.height));
  const width = Math.max(1, Math.round(metadata.width * scale));
  const height = Math.max(1, Math.round(metadata.height * scale));

  const { data } = await sharp(imagePath)
    .resize({ width, height, fit: 'fill' })
    .flatten({ background: '#ffffff' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
    rgba[j] = data[i];
    rgba[j + 1] = data[i + 1];
    rgba[j + 2] = data[i + 2];
    rgba[j + 3] = 255;
  }

  // One global palette keeps colours temporally stable. A few highlight
  // entries make sure the cyan/pink glints survive quantisation.
  const palette = quantize(rgba, GIF_COLORS, { format: 'rgb565' });
  for (const color of [[255, 255, 255], [150, 242, 255], [255, 186, 232]]) {
    if (!palette.some((entry) => entry[0] === color[0] && entry[1] === color[1] && entry[2] === color[2])) {
      palette.push(color);
    }
  }

  const stars = [];
  const random = mulberry32(0x51b3a7);
  for (let i = 0; i < 48; i++) {
    stars.push({
      x: Math.floor(random() * width),
      y: Math.floor(random() * height),
      phase: random(),
      speed: 0.6 + random() * 1.6,
      radius: 1.2 + random() * 3.2,
      tint: random() < 0.6 ? [150, 240, 255] : [255, 190, 235]
    });
  }

  const encoder = GIFEncoder();
  const frame = new Uint8Array(width * height * 4);

  for (let f = 0; f < GIF_FRAMES; f++) {
    const t = f / GIF_FRAMES;
    frame.set(rgba);

    const brightness = 1 + 0.018 * Math.sin(t * Math.PI * 2);
    const sweep = -0.22 + 1.44 * t;
    const sweepSoft = -0.55 + 1.44 * t;

    for (let y = 0; y < height; y++) {
      const v = y / height;
      for (let x = 0; x < width; x++) {
        const u = (x / width) * 0.66 + v * 0.34;
        const band = Math.exp(-Math.pow((u - sweep) / 0.085, 2));
        const halo = Math.exp(-Math.pow((u - sweepSoft) / 0.16, 2)) * 0.45;
        const lift = band * 34 + halo * 16;
        const i = (y * width + x) * 4;

        frame[i] = Math.min(255, frame[i] * brightness + lift * 0.62);
        frame[i + 1] = Math.min(255, frame[i + 1] * brightness + lift * 0.95);
        frame[i + 2] = Math.min(255, frame[i + 2] * brightness + lift);
      }
    }

    for (const star of stars) {
      const twinkle = Math.pow(Math.max(0, Math.sin((t * star.speed + star.phase) * Math.PI * 2)), 4);
      if (twinkle <= 0.01) continue;

      const reach = Math.ceil(star.radius * 2.6);
      const power = 120 * twinkle;
      for (let dy = -reach; dy <= reach; dy++) {
        const y = star.y + dy;
        if (y < 0 || y >= height) continue;
        for (let dx = -reach; dx <= reach; dx++) {
          const x = star.x + dx;
          if (x < 0 || x >= width) continue;
          const distance = (dx * dx + dy * dy) / (star.radius * star.radius);
          if (distance > 6.5) continue;

          const amount = Math.exp(-distance) * power;
          const i = (y * width + x) * 4;
          frame[i] = Math.min(255, frame[i] + (amount * star.tint[0]) / 255);
          frame[i + 1] = Math.min(255, frame[i + 1] + (amount * star.tint[1]) / 255);
          frame[i + 2] = Math.min(255, frame[i + 2] + (amount * star.tint[2]) / 255);
        }
      }
    }

    const index = applyPalette(frame, palette, 'rgb565');
    encoder.writeFrame(index, width, height, {
      palette: f === 0 ? palette : undefined,
      delay: GIF_DELAY_MS,
      repeat: 0
    });
  }

  encoder.finish();
  const bytes = Buffer.from(encoder.bytes());
  await fsp.writeFile(outputPath, bytes);

  return {
    width,
    height,
    frames: GIF_FRAMES,
    delay: GIF_DELAY_MS,
    duration: GIF_FRAMES * GIF_DELAY_MS,
    bytes: bytes.length
  };
}

/**
 * Read a GIF header so we can reject non-GIF uploads and report its size.
 */
async function validateGif(filePath) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const header = Buffer.alloc(13);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 13) throw new Error('The animation is not a valid GIF.');

    const signature = header.toString('ascii', 0, 6);
    if (signature !== 'GIF87a' && signature !== 'GIF89a') {
      throw new Error('The animation must be a GIF file.');
    }

    const width = header.readUInt16LE(6);
    const height = header.readUInt16LE(8);
    if (!width || !height) throw new Error('The GIF has no readable dimensions.');
    if (width > 4096 || height > 4096) {
      throw new Error('The GIF is too large (maximum 4096 × 4096).');
    }

    return { width, height };
  } finally {
    await handle.close();
  }
}

module.exports = {
  normaliseImage,
  makeEdges,
  makeAutoGif,
  validateGif
};
