# STUDIÀ LIBERTÀ · AR mural

A web-based augmented reality piece built with [AR.js](https://ar-js-org.github.io/AR.js-Docs/) **NFT image tracking**. Point a phone (or a webcam) at the printed **STUDIÀ LIBERTÀ** mural and an animated version of the artwork plays back exactly over the print, with drifting sparkles and orbiting targeting arcs around it.

No build step, no 3D models — just static HTML, CSS, and JavaScript.

---

## What's here

```
index.html                     AR scene + HUD markup
assets/
  app.js                       A-Frame components, GIF overlay, shader fallback, HUD logic
  style.css                    HUD / loader / calibration panel styling
  photo-iut.jpg                The mural image used as the NFT target
  photo-iut-edges.png          Baked edge map (neon contour glow, shader fallback)
  Mural_STUDIA_LIBERTA_en_animation.gif
                               Animated AR layer (438 × 389, 9 frames, 1.62 s loop)
  nft/
    photo-iut.fset             NFT marker feature set
    photo-iut.fset3            NFT marker feature set (multi-scale)
    photo-iut.iset             NFT marker image set
```

The scene loads A-Frame 1.6.0 and AR.js 3.4.8 from a CDN.

---

## Run it locally

The app must be served over HTTP; opening `index.html` from the file system will not work. Serve **from the repository root** so the marker files resolve:

```bash
python -m http.server 8080 --bind 127.0.0.1
```

Then open <http://localhost:8080/> (or <http://127.0.0.1:8080/>) and allow camera access.

> **Why the domain root?** AR.js 3.4.8's NFT worker builds marker URLs from `self.origin` and only treats hostnames containing a dot as absolute. On `localhost` or an IP, the app therefore passes a root-relative marker path (`assets/nft/photo-iut`). Hosting the page in a sub-folder on `localhost` will not find the marker; on a real domain it will.

### On a phone

Mobile browsers only expose the camera over **HTTPS** (or `localhost`). Options:

- deploy to GitHub Pages / Netlify / Cloudflare Pages (all HTTPS), or
- tunnel the local server, e.g. `npx localtunnel --port 8080` or `ngrok http 8080`.

Opening the app on a phone over plain `http://192.168.x.x:8080` will load, but the camera request is blocked. The app detects this and explains it in the error panel.

---

## Using it

1. Allow the camera when prompted.
2. Point the camera at the mural so the whole print is in view, then hold still.
3. When tracking locks, the animation fades in exactly over the artwork and plays from the start.

The **Tune overlay** button (bottom right) opens a small calibration panel:

- **Fit (85–115%)** — nudges the overlay size if it does not sit exactly on the print on your device.
- **Layer effects** — turns the extra sparkles, rings, and brackets off for a clean alignment check.

Both preferences are stored in `localStorage`.

---

## Regenerating the NFT marker

The marker files were produced from `assets/photo-iut.jpg` with
[`@webarkit/nft-marker-creator-app`](https://github.com/webarkit/Nft-Marker-Creator-App).

```bash
npm install @webarkit/nft-marker-creator-app
cd node_modules/@webarkit/nft-marker-creator-app/src

node NFTMarkerCreator.js -i /absolute/path/to/photo-iut.jpg -o /absolute/path/to/assets/nft --threaded 4
```

The tool writes `<name>.fset`, `<name>.fset3`, and `<name>.iset` and prints a confidence score. Our run reported **1.67 / 5** — modest, but tracking is reliable with the full print in frame. If you swap in a different photo:

1. Keep the artwork flat, high-contrast, and feature-rich; avoid large blank areas.
2. Regenerate all three files with the same base name.
3. Update the `url` on `<a-nft>` in `index.html` if the base name changes (`assets/nft/<name>`).
4. If the print size changes, the overlay scale follows the image DPI reported by AR.js; use the Fit slider for fine tuning.

---

## How it works

- `<a-nft>` performs natural feature tracking and exposes a pose for the marker.
- `hologram-mural` owns the tracked plane. Its main layer is the supplied **animated GIF**, decoded once into RGBA frames and uploaded as a `DataTexture`:
  - `drawImage()` only ever returns an animated GIF's first frame, so `app.js` ships a small GIF decoder (palettes, transparency, interlacing, disposal modes) and plays the frames on its own clock;
  - 9 frames at 180 ms each, looped every 1.62 s, stretched to the 4:3 marker plane (the GIF's artwork was authored slightly taller than 4:3, so this is what lines up with the print);
  - the texture changes only when the animation advances a frame (about 5.5 uploads/s), not on every AR frame;
  - starts from frame 0 on detection; a short tracking blink (under 1.5 s) resumes where it left off, while a longer loss restarts it.
- Until the GIF has downloaded and decoded, or if it cannot be decoded, the component keeps its original `ShaderMaterial` (photo + neon edge map, scan bands, CRT texture) so tracking still shows something.
- `ar-sparkles`, `ar-rings`, and `ar-brackets` add procedural points, rotating arcs, and pulsing corner marks — all scaled to the marker.
- A small renderer hook corrects AR.js's projection for non-4:3 viewports (see below).

### Replacing the animation

The animation is `assets/Mural_STUDIA_LIBERTA_en_animation.gif` (438 × 389, 9 frames, 180 ms per frame). Anything that decodes as a GIF works:

1. Drop a new GIF in `assets/` and point `GIF_URL` in `assets/app.js` at it.
2. Keep the artwork registered with the print — the GIF is mapped edge to edge across the tracked plane, so its framing must match `photo-iut.jpg` (a slightly different aspect ratio is fine and is stretched to 4:3).
3. The `Fit` slider in the overlay panel absorbs any remaining offset.

There is no player library and no build step; the decoder is part of `app.js` and works in every browser that supports WebGL/canvas.

### AR.js 3.4.8 integration notes

These are the non-obvious parts of the integration, kept here so the next person does not rediscover them:

1. **The NFT pose is the marker's bottom-left corner.** AR.js reports the pose translation as `(-width/2, -height/2, z)` for a centred marker. Inside the `<a-nft>` frame, the image lies on XZ with `+Y` as the normal and image-up along `-Z`. The overlay entity is rotated `-90°` about X and moved to `(width/2, 0, -height/2)` so the plane is centred on the print.
2. **`arjs-video-loaded` race.** AR.js attaches its NFT worker listener after the video can already have fired the event, so the worker never starts. Once the AR controller exists, `app.js` re-dispatches a synthetic event — but only while AR.js clearly has not handled one yet. The handler resizes the controller canvas from the raw camera frame to its 320 px tracking canvas synchronously, so that size change is the "already started" signal; this prevents a second worker. The video element is temporarily pinned to the camera's intrinsic size for the dispatch, because AR.js samples `clientWidth/clientHeight` once and uses that rect to feed every frame.
3. **Worker URL handling.** See the localhost note above (`MARKER_URL` in `app.js`).
4. **Viewport aspect.** AR.js renders with the camera intrinsics (4:3) into a viewport-sized canvas. The webcam feed is displayed as a centred `object-fit: cover` crop and the same crop is pre-multiplied into the projection immediately before each render, so the layer stays aligned on any screen shape (including portrait phones).

---

## Deployment

Any static host works. For GitHub Pages, publish the repository root (or put these files in `docs/`). For Netlify/Cloudflare Pages, set the publish directory to the repository root and leave the build command empty. HTTPS is required for the camera on phones.

---

## Credits

- Image tracking: [AR.js](https://github.com/AR-js-org/AR.js) by the AR.js organization, built on [ARToolKit](https://github.com/artoolkit/artoolkit5).
- Marker generation: [NFT-Marker-Creator-App](https://github.com/webarkit/Nft-Marker-Creator-App) by WebARKit.
- Artwork: the STUDIÀ LIBERTÀ mural photograph (`assets/photo-iut.jpg`).
