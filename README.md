# STUDIÀ LIBERTÀ · AR image targets

A web-based augmented reality piece built with [AR.js](https://ar-js-org.github.io/AR.js-Docs/) **NFT image tracking**, plus a small backoffice for managing the scannable **image / animation couples**.

Point a phone (or a webcam) at any printed image in the library and an animated, holographic layer plays back exactly over the print, with drifting sparkles and orbiting targeting arcs around it.

The AR experience itself is still plain static HTML, CSS, and JavaScript. The backoffice runs on a small Node server that stores uploads, generates the GIF when needed, and produces the three AR.js NFT marker files automatically.

---

## What's here

```
index.html                     AR scene + HUD markup (targets are created at runtime)
assets/
  app.js                       A-Frame components, GIF decoder/overlay, shader fallback, HUD
  style.css                    HUD / loader / calibration panel styling
  targets.json                 Manifest of scannable couples (written by the backoffice)
  targets/
    photo-iut/                 One couple = one folder
      image.jpg                Normalised print image (72 DPI, max 2048 px)
      animation.gif            Uploaded animation, or the generated living-light loop
      edges.png                Generated contour map (shader fallback)
      marker.fset              Generated AR.js NFT marker
      marker.fset3
      marker.iset
backoffice/
  index.html                   Admin login + dashboard
  admin.js                     Uploads, job polling, delete
  admin.css                    Backoffice styling
server.js                      Express server: auth, upload API, job queue, static app
lib/
  store.js                     targets.json read/write, ids, delete
  media.js                     Image normalisation, auto-GIF, contour map, GIF validation
  marker.js                    Runs the WebARKit marker generator
  pipeline.js                  Normalise → animate → contours → marker → commit
package.json                   Server dependencies and `npm start`
```

The scene loads A-Frame 1.6.0 and AR.js 3.4.8 from a CDN.

---

## Quick start

```bash
npm install
npm start
```

- AR app: <http://127.0.0.1:8080/>
- Backoffice: <http://127.0.0.1:8080/backoffice/>
- Default login: **`iutmmi` / `iutmmi@corti`**

The credentials and port can be overridden with environment variables:

```bash
AR_ADMIN_USER=... AR_ADMIN_PASSWORD=... PORT=8080 npm start
```

> Use a different password before exposing the backoffice to a network.

The server only exposes `/`, `/assets`, and `/backoffice`. Server code, `package.json`, and `node_modules` are not served.

### On a phone

Mobile browsers only expose the camera over **HTTPS** (or `localhost`). Options:

- deploy the AR app to GitHub Pages / Netlify / Cloudflare Pages (all HTTPS), or
- tunnel the local server, e.g. `npx localtunnel --port 8080` or `ngrok http 8080`.

Opening the app on a phone over plain `http://192.168.x.x:8080` will load, but the camera request is blocked. The app detects this and explains it in the error panel.

---

## Backoffice

Sign in at `/backoffice/` and add a couple:

1. **Print image** (required) — JPEG, PNG or WebP, max 30 MB.
   The server rotates it, flattens transparency, resizes it to at most 2048 px on the long side, sets 72 DPI, and stores it as `image.jpg`.
2. **Animation** (optional) — a GIF. If omitted, a matching animation is generated automatically.
3. **Display name** (optional) — used in the app HUD and the admin list. The folder id is a lowercase slug; duplicates get `-2`, `-3`, …

Generation runs in a background queue:

```
normalise → auto-GIF (if needed) → contour map → NFT marker → commit
```

The couple only appears in `assets/targets.json` after every file is ready, so the AR app can never load a half-generated target. A card appears in the library when it is scannable. Typical marker time is **1–4 minutes** (about a minute for a 900 px image; ~3 minutes for 2048 px with 8 threads).

Delete a couple from its card. This removes its manifest entry and the whole `assets/targets/<id>/` folder. Deleting the last couple leaves the app in its "no targets yet" state until one is added again.

Uploads and unfinished jobs live in `.tmp/` and are cleaned at startup; failed jobs remove their partial target folder.

### Auto-generated animation

When no GIF is uploaded, the server keeps the print **pixel-aligned** (no zoom or pan, so AR registration is untouched) and adds:

- a soft cyan light sweep travelling across the image,
- deterministic sparkles that twinkle in place,
- one global palette so colours stay temporally stable.

Output: max 560 px on the long side, 20 frames at 90 ms (1.8 s loop), 200 colours + highlight entries. The base image, marker scale, and print alignment are unchanged. A GIF is still supplied and played by the app like any uploaded animation.

If an uploaded GIF's aspect ratio differs from the print by more than ~3%, the backoffice records a warning on the target; the GIF is stretched edge to edge across the print.

---

## Using the AR app

1. Allow the camera when prompted.
2. Point the camera at a printed target so the whole image is in view, then hold still.
3. When tracking locks, the animation fades in exactly over the artwork and plays from the start.

The first target in the manifest is also used for the hint thumbnail and the legacy `#mural-target` / `#mural-overlay` ids used by the automated tests. Any number of further targets become additional `<a-nft>` entities with their own overlay, GIF, and pose filter.

The **Tune overlay** button (bottom right) opens a small calibration panel:

- **Fit (85–115%)** — nudges the overlay size if it does not sit exactly on the print on your device. Applies to every target.
- **Layer effects** — turns the extra sparkles, rings, and brackets off for a clean alignment check.

Both preferences are stored in `localStorage`.

---

## Target store

`assets/targets.json` is the single source of truth for the app:

```json
{
  "version": 1,
  "updatedAt": "2026-11-10T00:00:00.000Z",
  "targets": [
    {
      "id": "photo-iut",
      "title": "STUDIÀ LIBERTÀ",
      "image": "assets/targets/photo-iut/image.jpg",
      "animation": "assets/targets/photo-iut/animation.gif",
      "edges": "assets/targets/photo-iut/edges.png",
      "marker": "assets/targets/photo-iut/marker",
      "width": 2048,
      "height": 1536,
      "dpi": 72,
      "widthMm": 722.488,
      "heightMm": 541.866,
      "autoAnimation": false,
      "createdAt": "2026-11-10T00:00:00.000Z"
    }
  ]
}
```

Paths are relative to the repository root. `marker` is a prefix: AR.js requests `marker.fset`, `marker.fset3`, and `marker.iset`. Physical sizes (`widthMm` / `heightMm`) are derived as `pixels / dpi × 25.4`.

The app fetches the manifest with `cache: 'no-store'`, so a reload picks up backoffice changes immediately.

---

## How it works

- `app.js` fetches `assets/targets.json` and creates one `<a-nft>` + overlay per couple. Each target carries its own photo, edges, GIF, and physical marker size.
- `<a-nft>` performs natural feature tracking and exposes a pose for its marker.
- `hologram-mural` owns the tracked plane. Its main layer is the supplied **animated GIF**, decoded once into RGBA frames and uploaded as a `DataTexture`:
  - `drawImage()` only ever returns an animated GIF's first frame, so `app.js` ships a small GIF decoder (palettes, transparency, interlacing, disposal modes) and plays the frames on its own clock;
  - the texture changes only when the animation advances a frame, not on every AR frame;
  - starts from frame 0 on detection; a short tracking blink (under 1.5 s) resumes where it left off, while a longer loss restarts it.
- Until the GIF has downloaded and decoded, or if it cannot be decoded, the component keeps its original `ShaderMaterial` (photo + contour map, scan bands, CRT texture) so tracking still shows something.
- `ar-sparkles`, `ar-rings`, and `ar-brackets` add procedural points, rotating arcs, and pulsing corner marks — all scaled to the marker.
- `nft-pose-smoother` (on each `<a-nft>`) filters the raw pose before each draw to remove AR.js tracking jitter — see below.
- A small renderer hook corrects AR.js's projection for non-4:3 viewports and runs the pose filters (see below).

### Tracking jitter

AR.js re-estimates the marker pose on every camera frame, and that raw pose carries
high-frequency noise. On a perfectly static camera feed the reported z translation
alone moves by up to ~20 mm between consecutive frames (a ~30 mm span while nothing
moves), which is what makes the overlay appear to swim or shake over the print.

`nft-pose-smoother` is attached to each `<a-nft>` and runs from the existing renderer
hook: after A-Frame has ticked (so the raw AR.js pose for this frame is in place)
and immediately before the draw. It low-passes the pose with a time constant that
adapts to the situation:

- **At rest** it is slow (`restTau`, 0.45 s) and a small deadband freezes motion
  below 0.1% of the marker width, so the overlay holds still instead of
  breathing with the tracker.
- **While the marker actually moves** the cutoff opens towards `moveTau` (0.02 s).
  The motion factor is derived from the pose error — translation as a fraction of
  the marker width (`moveStart`/`moveFull`), rotation in degrees — so a fast pan
  is followed with only a small, constant trail instead of feeling laggy.
- **On first lock, or after losing the marker**, the filter snaps straight to the
  raw pose, so a re-acquired layer never glides in from wherever it was last seen.
- The filter is frame-rate independent (time constants in seconds) and runs before
  the draw, so the frame that is displayed is already the filtered pose.

Measured on the static fake-camera fixture: frame-to-frame z movement drops from
~6.9 mm standard deviation (p99 ~19 mm) to ~0.46 mm (p99 ~1.6 mm), about a 16×
reduction, while a 480 mm/s pan trails by ~2% of the marker width.

AR.js's built-in `smooth`, `smooth-count`, `smooth-tolerance`, and
`smooth-threshold` options are **not** used. They average the raw matrix and
only switch to the averaged pose once enough elements deviate past a threshold,
which makes the motion either ignore small corrections or jump between the
averaged and raw poses. The adaptive filter above replaces them.

The component's thresholds and time constants are exposed as attributes on
each `<a-nft>` if you need to tune for a particular camera. The backoffice writes
`markerWidth` into the same attribute so each target uses its own physical size:

```html
<a-nft ... nft-pose-smoother="restTau: 0.45; moveTau: 0.02; markerWidth: 722.5"></a-nft>
```

---

## Marker generation

Marker generation is automatic: when an image is added, the pipeline runs
[`@webarkit/nft-marker-creator-app`](https://github.com/webarkit/Nft-Marker-Creator-App)
with the normalised JPEG and writes `marker.fset`, `marker.fset3`, and `marker.iset` into the target folder. It runs with 8 threads and a 4 GB heap by default; set `AR_MARKER_THREADS` to change the thread count.

To regenerate a marker by hand (e.g. a different tool version):

```bash
node node_modules/@webarkit/nft-marker-creator-app/src/NFTMarkerCreator.js \
  -i /absolute/path/to/assets/targets/<id>/image.jpg \
  -o /absolute/path/to/assets/targets/<id>/tmp \
  --threaded 8
```

Then rename the generated `<id>.fset` / `.fset3` / `.iset` to `marker.*` in the target folder. Keep the input at the same resolution and 72 DPI as the stored `image.jpg`: the marker's reported width in millimetres is used to size the overlay, and changing it changes the physical scale of the AR layer.

If you add a different photo manually, keep the artwork flat, high-contrast, and feature-rich; avoid large blank areas.

---

## AR.js 3.4.8 integration notes

These are the non-obvious parts of the integration, kept here so the next person does not rediscover them:

1. **The NFT pose is the marker's bottom-left corner.** AR.js reports the pose translation as `(-width/2, -height/2, z)` for a centred marker. Inside the `<a-nft>` frame, the image lies on XZ with `+Y` as the normal and image-up along `-Z`. The overlay entity is rotated `-90°` about X and moved to `(width/2, 0, -height/2)` so the plane is centred on the print.
2. **`arjs-video-loaded` race with runtime targets.** AR.js attaches its NFT worker listener after the video can already have fired the event, and it only starts a worker for markers already in the DOM at that moment. The manifest is fetched after the scene boots, so the kicker waits until every expected `<a-nft>` exists and then re-dispatches a synthetic event. Each `<a-nft>` gets its own worker; the handler's canvas resize is used as the "already started" signal so the event is not replayed twice.
3. **Global marker metadata.** AR.js broadcasts `arjs-nft-init-data` without identifying the marker, so with multiple targets `app.js` never relies on that event for scaling. Every overlay and pose filter receives its own `markerWidth` / `markerHeight` from `targets.json` instead.
4. **Worker URL handling.** AR.js's NFT worker builds URLs from `self.origin` and only treats hostnames containing a dot as absolute. On `localhost` or an IP the app passes a root-relative marker path (`assets/targets/<id>/marker`); on a real domain it passes an absolute URL, which also works when the site is hosted in a sub-folder.
5. **Viewport aspect.** AR.js renders with the camera intrinsics (4:3) into a viewport-sized canvas. The webcam feed is displayed as a centred `object-fit: cover` crop and the same crop is pre-multiplied into the projection immediately before each render, so the layer stays aligned on any screen shape (including portrait phones).

---

## Deployment

The **AR app** is still static: `index.html`, `assets/`, and `assets/targets.json` (plus the target folders) can be published to any static host. For GitHub Pages, publish the repository root (or put these files in `docs/`). For Netlify/Cloudflare Pages, set the publish directory to the repository root and leave the build command empty. HTTPS is required for the camera on phones.

The **backoffice** needs the Node server:

- run `npm start` on a host that can write to `assets/targets.json` and `assets/targets/`, or
- run it locally and publish/copy the regenerated `assets/targets.json` + `assets/targets/` afterwards.

The marker generator is CPU-heavy; avoid running several uploads at once. Jobs are queued and run one at a time.

---

## Credits

- Image tracking: [AR.js](https://github.com/AR-js-org/AR.js) by the AR.js organization, built on [ARToolKit](https://github.com/artoolkit/artoolkit5).
- Marker generation: [NFT-Marker-Creator-App](https://github.com/webarkit/Nft-Marker-Creator-App) by WebARKit.
- Auto-GIF encoding: [gifenc](https://github.com/mattdesl/gifenc) by Matt DesLauriers.
- Artwork: the STUDIÀ LIBERTÀ mural photograph (now `assets/targets/photo-iut/image.jpg`).
