/* global AFRAME */
/*
 * STUDIÀ LIBERTÀ — AR mural
 * -------------------------
 * AR.js NFT image tracking + a custom holographic shader that brings the
 * printed photo to life exactly in place. Two extra layers (sparkles and
 * targeting rings) are built procedurally, so the app has no model assets.
 */
(function () {
    'use strict';

    var THREE = window.AFRAME && window.AFRAME.THREE;

    if (!THREE) {
        return;
    }

    /* ------------------------------------------------------------------
     * Target manifest
     * ------------------------------------------------------------------
     * Every scannable couple lives in assets/targets/<id>/ and is listed in
     * assets/targets.json. The backoffice writes both; the AR app only reads
     * them, so the experience keeps working on a plain static host.
     * ------------------------------------------------------------------ */
    var MANIFEST_URL = new URL('assets/targets.json', document.baseURI).href;

    /*
     * AR.js's NFT worker resolves a marker path against self.origin and only
     * recognises absolute URLs whose hostname looks like a real domain
     * (e.g. example.com). That means:
     *   - on a normal HTTPS domain, pass an absolute URL (works in a subfolder)
     *   - on localhost / 127.0.0.1 / a LAN IP, pass a root-relative path,
     *     because the worker would otherwise prefix the origin twice.
     * Serve local previews from the domain root (http://localhost:8080/).
     */
    var hostname = window.location.hostname;
    var looksLikeDomain = hostname.indexOf('.') !== -1 &&
        !/^[\d.]+$/.test(hostname);

    function absoluteUrl(path) {
        return path ? new URL(path, document.baseURI).href : '';
    }

    function markerUrl(path) {
        if (!path) return '';
        return looksLikeDomain ? absoluteUrl(path) : path;
    }

    var targetRoot = document.getElementById('targets-root');
    var targetEntries = [];
    var markerEls = [];
    var overlayEls = [];
    var activeTarget = null;
    var expectedTargets = 0;

    /* ------------------------------------------------------------------
     * Shaders
     * ------------------------------------------------------------------ */
    var MURAL_VERTEX = [
        'varying vec2 vUv;',
        'void main() {',
        '  vUv = uv;',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}'
    ].join('\n');

    var MURAL_FRAGMENT = [
        'precision highp float;',
        '',
        'uniform sampler2D uMap;',
        'uniform sampler2D uEdges;',
        'uniform float uTime;',
        'uniform float uOpacity;',
        'uniform float uIntensity;',
        'varying vec2 vUv;',
        '',
        'float luma(vec3 c) {',
        '  return dot(c, vec3(0.2126, 0.7152, 0.0722));',
        '}',
        '',
        'void main() {',
        '  vec2 uv = vUv;',
        '',
        '  // A barely-there breathing zoom; the print stays aligned.',
        '  float breathe = 1.0 + 0.0035 * sin(uTime * 1.15) * uIntensity;',
        '  vec2 cuv = (uv - 0.5) / breathe + 0.5;',
        '',
        '  // Chromatic shimmer, strongest away from the centre.',
        '  float edgeDist = distance(uv, vec2(0.5));',
        '  float split = (0.0008 + 0.0016 * (0.5 + 0.5 * sin(uTime * 2.3)))',
        '    * smoothstep(0.08, 0.82, edgeDist) * uIntensity;',
        '  vec3 col;',
        '  col.r = texture2D(uMap, cuv + vec2(split, 0.0)).r;',
        '  col.g = texture2D(uMap, cuv).g;',
        '  col.b = texture2D(uMap, cuv - vec2(split, 0.0)).b;',
        '',
        '  // Gentle cool grade and contrast lift.',
        '  float l = luma(col);',
        '  col = mix(col, vec3(l) * vec3(0.84, 1.01, 1.10), 0.14 * uIntensity);',
        '  col = mix(vec3(l), col, 1.0 + 0.05 * uIntensity);',
        '',
        '  // Neon contours baked from the artwork itself.',
        '  float edge = texture2D(uEdges, cuv).r;',
        '  float wave = 0.55 + 0.45 * sin(uTime * 1.9 - uv.y * 7.0 + uv.x * 2.0);',
        '  vec3 neon = mix(vec3(0.28, 0.95, 1.0), vec3(1.0, 0.36, 0.86),',
        '    0.35 + 0.35 * sin(uTime * 0.7 + uv.x * 2.5));',
        '  col += neon * edge * (0.28 + 0.55 * wave) * uIntensity;',
        '',
        '  // Soft travelling scan band.',
        '  float bandPos = fract(uTime * 0.085);',
        '  float band = smoothstep(0.055, 0.0, abs(bandPos - uv.y));',
        '  float halo = smoothstep(0.24, 0.0, abs(bandPos - uv.y));',
        '  col += vec3(0.34, 0.90, 1.0) * (band * 0.20 + halo * 0.045) * uIntensity;',
        '',
        '  // Fine CRT texture.',
        '  float scan = sin(uv.y * 760.0 - uTime * 3.4) * 0.5 + 0.5;',
        '  col *= 1.0 - 0.032 * scan * uIntensity;',
        '  col += vec3(0.10, 0.50, 0.65) * 0.018',
        '    * sin((uv.x + uv.y) * 6.0 - uTime * 1.2) * uIntensity;',
        '',
        '  // Inner rim light.',
        '  float rim = 1.0 - smoothstep(0.0, 0.052,',
        '    min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));',
        '  col += vec3(0.30, 0.90, 1.0) * rim * 0.16 * uIntensity;',
        '',
        '  col *= uOpacity;',
        '  gl_FragColor = vec4(col, uOpacity);',
        '}'
    ].join('\n');

    var SPARKLE_VERTEX = [
        'attribute float aSeed;',
        'attribute float aScale;',
        'uniform float uTime;',
        'uniform float uPixelRatio;',
        'varying float vTwinkle;',
        '',
        'void main() {',
        '  vec3 p = position;',
        '  float speed = 0.012 + aSeed * 0.030;',
        '  p.y = mod(p.y + 0.62 + uTime * speed, 1.24) - 0.62;',
        '  p.x += sin(uTime * 0.45 + aSeed * 19.0) * 0.012;',
        '',
        '  vec4 mv = modelViewMatrix * vec4(p, 1.0);',
        '  gl_Position = projectionMatrix * mv;',
        '  gl_PointSize = (1.4 + aScale * 2.8) * uPixelRatio * (520.0 / max(60.0, -mv.z));',
        '  vTwinkle = 0.30 + 0.70 * (0.5 + 0.5 * sin(uTime * 2.0 + aSeed * 41.0));',
        '}'
    ].join('\n');

    var SPARKLE_FRAGMENT = [
        'precision mediump float;',
        'varying float vTwinkle;',
        '',
        'void main() {',
        '  vec2 d = gl_PointCoord - 0.5;',
        '  float r = length(d);',
        '  if (r > 0.5) discard;',
        '  float core = smoothstep(0.5, 0.0, r);',
        '  core *= core;',
        '  vec3 col = mix(vec3(0.32, 0.94, 1.0), vec3(1.0, 0.72, 0.95), 0.28);',
        '  gl_FragColor = vec4(col * (0.70 + vTwinkle * 0.90) * core,',
        '    core * vTwinkle * 0.85);',
        '}'
    ].join('\n');

    /* ------------------------------------------------------------------
     * Minimal GIF decoder
     * ------------------------------------------------------------------
     * The browser paints an animated GIF on screen, but canvas drawImage()
     * only ever returns its first frame. Decoding the file ourselves gives
     * us the JPEG-sized frame list plus exact frame delays, which is what
     * lets the overlay pause, resume and restart in step with the marker.
     *
     * Supports what the mural animation needs and virtually every GIF in the
     * wild: global/local palettes, transparency, interlacing and all four
     * disposal modes. Frames are returned as top-down RGBA buffers.
     */
    function lzwDecode(minCodeSize, data, pixelCount) {
        var clearCode = 1 << minCodeSize;
        var endCode = clearCode + 1;
        var codeSize = minCodeSize + 1;
        var nextCode = endCode + 1;
        var maxCode = 4096;
        var table = [];
        var out = new Uint8Array(pixelCount);
        var outPos = 0;
        var prev = null;
        var bitBuf = 0;
        var bitCount = 0;
        var dataPos = 0;
        var i;

        for (i = 0; i < clearCode; i++) {
            table[i] = [i];
        }

        while (outPos < pixelCount) {
            while (bitCount < codeSize) {
                if (dataPos >= data.length) {
                    return out;
                }
                bitBuf |= data[dataPos++] << bitCount;
                bitCount += 8;
            }

            var code = bitBuf & ((1 << codeSize) - 1);
            bitBuf >>= codeSize;
            bitCount -= codeSize;

            if (code === clearCode) {
                codeSize = minCodeSize + 1;
                nextCode = endCode + 1;
                table.length = nextCode;
                prev = null;
                continue;
            }
            if (code === endCode) {
                break;
            }

            var entry;
            if (code < nextCode && table[code]) {
                entry = table[code];
            } else if (code === nextCode && prev) {
                entry = prev.concat(prev[0]);
            } else {
                break;
            }

            for (i = 0; i < entry.length && outPos < pixelCount; i++) {
                out[outPos++] = entry[i];
            }

            if (prev && nextCode < maxCode) {
                table[nextCode++] = prev.concat(entry[0]);
                if (nextCode === (1 << codeSize) && codeSize < 12) {
                    codeSize += 1;
                }
            }
            prev = entry;
        }

        return out;
    }

    function gifDrawFrame(dest, destWidth, palette, indices, left, top,
        width, height, transparentIndex, interlaced) {
        var passes = interlaced
            ? [[0, 8], [4, 8], [2, 4], [1, 2]]
            : [[0, 1]];
        var srcRow = 0;

        for (var pass = 0; pass < passes.length; pass++) {
            var start = passes[pass][0];
            var step = passes[pass][1];

            for (var y = start; y < height; y += step) {
                var rowBase = (top + y) * destWidth;

                for (var x = 0; x < width; x++) {
                    var index = indices[srcRow * width + x];
                    if (index === transparentIndex) {
                        continue;
                    }
                    var out = (rowBase + left + x) * 4;
                    var colour = index * 3;
                    dest[out] = palette[colour];
                    dest[out + 1] = palette[colour + 1];
                    dest[out + 2] = palette[colour + 2];
                    dest[out + 3] = 255;
                }
                srcRow += 1;
            }
        }
    }

    function gifClearRect(dest, destWidth, rect) {
        for (var y = rect.top; y < rect.top + rect.height; y++) {
            var start = (y * destWidth + rect.left) * 4;
            dest.fill(0, start, start + rect.width * 4);
        }
    }

    function gifFlipRows(data, width, height) {
        var stride = width * 4;
        var out = new Uint8Array(data.length);
        for (var y = 0; y < height; y++) {
            out.set(data.subarray(y * stride, (y + 1) * stride),
                (height - 1 - y) * stride);
        }
        return out;
    }

    function decodeGif(bytes) {
        var p = 0;

        function u8() {
            return bytes[p++];
        }

        function u16() {
            var value = bytes[p] | (bytes[p + 1] << 8);
            p += 2;
            return value;
        }

        function skipSubBlocks() {
            var size;
            while ((size = u8()) !== 0) {
                p += size;
            }
        }

        var signature = String.fromCharCode(bytes[0], bytes[1], bytes[2]);
        if (signature !== 'GIF') {
            throw new Error('Not a GIF');
        }

        p = 6;
        var width = u16();
        var height = u16();
        var packed = u8();
        u8(); // background colour index
        u8(); // pixel aspect ratio

        var globalPalette = null;
        if (packed & 0x80) {
            var globalSize = 2 << (packed & 7);
            globalPalette = bytes.subarray(p, p + globalSize * 3);
            p += globalSize * 3;
        }

        var canvas = new Uint8Array(width * height * 4);
        var frames = [];
        var disposal = 0;
        var transparentIndex = -1;
        var delay = 0;
        var previousDisposal = -1;
        var previousRect = null;
        var saved = null;

        while (p < bytes.length) {
            var block = u8();

            if (block === 0x3b) {
                break;
            }

            if (block === 0x21) {
                var label = u8();
                if (label === 0xf9) {
                    var size = u8();
                    var flags = bytes[p];
                    delay = bytes[p + 1] | (bytes[p + 2] << 8);
                    transparentIndex = (flags & 0x01) ? bytes[p + 3] : -1;
                    disposal = (flags >> 2) & 0x07;
                    p += size;
                    u8(); // terminator
                } else {
                    skipSubBlocks();
                }
                continue;
            }

            if (block !== 0x2c) {
                throw new Error('Unsupported GIF block 0x' + block.toString(16));
            }

            var left = u16();
            var top = u16();
            var frameWidth = u16();
            var frameHeight = u16();
            var frameFlags = u8();
            var palette = globalPalette;

            if (frameFlags & 0x80) {
                var localSize = 2 << (frameFlags & 7);
                palette = bytes.subarray(p, p + localSize * 3);
                p += localSize * 3;
            }
            if (!palette) {
                throw new Error('GIF frame has no colour table');
            }

            var interlaced = (frameFlags & 0x40) !== 0;
            var minCodeSize = u8();

            // Image data is stored as a chain of sub-blocks; flatten it.
            var total = 0;
            var chunks = [];
            var chunkSize;
            while ((chunkSize = u8()) !== 0) {
                chunks.push(bytes.subarray(p, p + chunkSize));
                total += chunkSize;
                p += chunkSize;
            }
            var compressed = new Uint8Array(total);
            var offset = 0;
            for (var c = 0; c < chunks.length; c++) {
                compressed.set(chunks[c], offset);
                offset += chunks[c].length;
            }

            var indices = lzwDecode(minCodeSize, compressed,
                frameWidth * frameHeight);

            // The previous frame's disposal is applied before this one.
            if (previousDisposal === 2 && previousRect) {
                gifClearRect(canvas, width, previousRect);
            } else if (previousDisposal === 3 && saved) {
                canvas.set(saved);
            }
            saved = disposal === 3 ? canvas.slice() : null;

            gifDrawFrame(canvas, width, palette, indices, left, top,
                frameWidth, frameHeight, transparentIndex, interlaced);

            frames.push({
                // Textures are sampled bottom-up; keep the data in that order.
                data: gifFlipRows(canvas, width, height),
                delay: delay > 0 ? delay * 10 : 100
            });

            previousDisposal = disposal;
            previousRect = {
                left: left, top: top, width: frameWidth, height: frameHeight
            };
            disposal = 0;
            transparentIndex = -1;
            delay = 0;
        }

        return { width: width, height: height, frames: frames };
    }

    /* ------------------------------------------------------------------
     * Hologram component
     * ------------------------------------------------------------------ */
    AFRAME.registerComponent('hologram-mural', {
        schema: {
            // 1 = exactly the marker size. HUD calibration multiplies this.
            fit: { type: 'number', default: 1 },
            intensity: { type: 'number', default: 1 },
            // Per-target assets, written by the backoffice and passed in from
            // targets.json. They are relative to index.html.
            photo: { type: 'string', default: '' },
            edges: { type: 'string', default: '' },
            gif: { type: 'string', default: '' },
            // Physical marker size in millimetres, from the target's .iset
            // metadata (pixels / 72 DPI). Keeping it per-component avoids the
            // global arjs-nft-init-data event mixing up multiple targets.
            markerWidth: { type: 'number', default: 0 },
            markerHeight: { type: 'number', default: 0 },
            label: { type: 'string', default: '' }
        },

        init: function () {
            var self = this;

            // The photo is 2048x1536 at 72 DPI. AR.js uses millimetres, so the
            // marker is ~722 x 542 mm in its coordinate space. targets.json
            // supplies the exact values for every couple.
            this.markerWidth = this.data.markerWidth > 0
                ? this.data.markerWidth
                : (2048 / 72) * 25.4;
            this.markerHeight = this.data.markerHeight > 0
                ? this.data.markerHeight
                : (1536 / 72) * 25.4;
            this.ready = false;
            this.wasVisible = false;

            var photoUrl = absoluteUrl(this.data.photo);
            var edgesUrl = absoluteUrl(this.data.edges);
            this.gifUrl = absoluteUrl(this.data.gif);

            var placeholder = new THREE.DataTexture(
                new Uint8Array([10, 16, 22, 255]), 1, 1, THREE.RGBAFormat
            );
            placeholder.needsUpdate = true;

            this.uniforms = {
                uMap: { value: placeholder },
                uEdges: { value: placeholder },
                uTime: { value: 0 },
                uOpacity: { value: 0 },
                uIntensity: { value: this.data.intensity }
            };

            var material = new THREE.ShaderMaterial({
                uniforms: this.uniforms,
                vertexShader: MURAL_VERTEX,
                fragmentShader: MURAL_FRAGMENT,
                transparent: true,
                depthWrite: false,
                side: THREE.DoubleSide,
                toneMapped: false
            });

            var mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
            mesh.renderOrder = 2;
            mesh.frustumCulled = false;

            this.mesh = mesh;
            this.shaderMaterial = material;
            this.el.setObject3D('hologram', mesh);

            // AR.js converts ARToolkit's Z-up frame into Y-up: inside a-nft
            // local space the marker lies on XZ, +Y is the marker normal and
            // -Z is the image's up direction. Lay the plane onto that frame.
            //
            // The NFT pose AR.js hands us is the marker's *bottom-left corner*
            // (its translation is exactly -width/2, -height/2), so the entity
            // itself is what moves to the marker centre. Keeping the offset on
            // the entity (and not on the plane) means the fit slider scales
            // the overlay around the print instead of around a corner.
            this.el.object3D.rotation.x = -Math.PI / 2;

            var loader = new THREE.TextureLoader();
            var pending = 2;

            function textureDone() {
                pending -= 1;
                if (pending === 0) {
                    self.ready = true;
                }
            }

            if (photoUrl) {
                loader.load(photoUrl, function (texture) {
                    texture.colorSpace = THREE.NoColorSpace;
                    texture.anisotropy = 4;
                    texture.minFilter = THREE.LinearMipmapLinearFilter;
                    texture.magFilter = THREE.LinearFilter;
                    texture.generateMipmaps = true;
                    self.uniforms.uMap.value = texture;
                    self.photoTexture = texture;
                    textureDone();
                }, undefined, function () {
                    // Keep the placeholder rather than throwing; tracking still works.
                    self.el.emit('hologram-texture-error', { src: photoUrl });
                    textureDone();
                });
            } else {
                textureDone();
            }

            if (edgesUrl) {
                loader.load(edgesUrl, function (texture) {
                    texture.colorSpace = THREE.NoColorSpace;
                    texture.minFilter = THREE.LinearMipmapLinearFilter;
                    texture.magFilter = THREE.LinearFilter;
                    texture.generateMipmaps = true;
                    self.uniforms.uEdges.value = texture;
                    self.edgeTexture = texture;
                    textureDone();
                }, undefined, function () {
                    self.el.emit('hologram-texture-error', { src: edgesUrl });
                    textureDone();
                });
            } else {
                textureDone();
            }

            this.applyScale();
            this.initGif(this.gifUrl);
        },

        /*
         * GIF overlay
         * -----------
         * The animation is decoded into RGBA frames and uploaded as a
         * DataTexture. The shader above stays in place as a fallback until the
         * GIF is ready (or if it cannot be decoded).
         */
        initGif: function (url) {
            var self = this;

            this.gifStarted = false;
            this.gifElapsed = 0;
            this.gifFrameIndex = -1;
            this.gifHiddenAt = 0;

            if (!url) {
                return;
            }

            fetch(url)
                .then(function (response) {
                    if (!response.ok) {
                        throw new Error('HTTP ' + response.status);
                    }
                    return response.arrayBuffer();
                })
                .then(function (buffer) {
                    return decodeGif(new Uint8Array(buffer));
                })
                .then(function (animation) {
                    if (animation.frames.length) {
                        self.setupGif(animation);
                    }
                })
                .catch(function (error) {
                    // Leave the hologram shader running.
                    self.el.emit('hologram-gif-error', {
                        src: url,
                        message: error && error.message
                    });
                });
        },

        setupGif: function (animation) {
            if (!this.mesh) {
                return;
            }

            var first = animation.frames[0];
            var texture = new THREE.DataTexture(
                first.data,
                animation.width,
                animation.height,
                THREE.RGBAFormat,
                THREE.UnsignedByteType
            );
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.minFilter = THREE.LinearFilter;
            texture.magFilter = THREE.LinearFilter;
            texture.generateMipmaps = false;
            texture.needsUpdate = true;

            var material = new THREE.MeshBasicMaterial({
                map: texture,
                transparent: true,
                opacity: 0,
                depthWrite: false,
                side: THREE.DoubleSide,
                toneMapped: false
            });

            this.gifFrames = animation.frames;
            this.gifDuration = animation.frames.reduce(function (sum, frame) {
                return sum + frame.delay;
            }, 0);
            this.gifTexture = texture;
            this.gifMaterial = material;
            this.gifStarted = false;
            this.gifElapsed = 0;
            this.gifFrameIndex = 0;
            this.mesh.material = material;
        },

        advanceGif: function (delta) {
            if (!this.gifStarted || !this.gifFrames || !this.gifDuration) {
                return;
            }

            this.gifElapsed = (this.gifElapsed + delta) % this.gifDuration;

            var rest = this.gifElapsed;
            var index = 0;
            for (var i = 0; i < this.gifFrames.length; i++) {
                rest -= this.gifFrames[i].delay;
                if (rest < 0) {
                    index = i;
                    break;
                }
            }

            if (index !== this.gifFrameIndex) {
                this.gifFrameIndex = index;
                this.gifTexture.image.data = this.gifFrames[index].data;
                this.gifTexture.needsUpdate = true;
            }
        },

        update: function (oldData) {
            if (!this.uniforms) {
                return;
            }
            if (!oldData || oldData.fit !== this.data.fit) {
                this.applyScale();
            }
            if (!oldData || oldData.intensity !== this.data.intensity) {
                this.uniforms.uIntensity.value = this.data.intensity;
            }
        },

        applyScale: function () {
            var fit = this.data && this.data.fit ? this.data.fit : 1;
            // Marker centre in a-nft space: +X is image-right, -Z is image-up.
            this.el.object3D.position.set(
                this.markerWidth / 2,
                0,
                -this.markerHeight / 2
            );
            this.el.object3D.scale.set(
                this.markerWidth * fit,
                this.markerHeight * fit,
                1
            );
        },

        tick: function (time, delta) {
            var parentVisible = !this.el.parentEl || this.el.parentEl.object3D.visible;
            var step = Math.min(1, (delta || 16) * 0.006);

            if (this.uniforms) {
                this.uniforms.uTime.value = time / 1000;
            }

            if (this.gifMaterial) {
                // The GIF can finish decoding after the marker is already on
                // screen; start it then, outside the visibility edge below.
                if (parentVisible && !this.gifStarted) {
                    this.gifStarted = true;
                    this.gifMaterial.opacity = 0;
                    this.gifElapsed = 0;
                    this.gifFrameIndex = -1;
                } else if (parentVisible && !this.wasVisible) {
                    // Re-detected: restart unless the marker only blinked out.
                    if (!this.gifHiddenAt || time - this.gifHiddenAt > 1500) {
                        this.gifElapsed = 0;
                    }
                    this.gifMaterial.opacity = 0;
                    this.gifFrameIndex = -1;
                } else if (!parentVisible && this.wasVisible) {
                    this.gifHiddenAt = time;
                }

                if (parentVisible) {
                    this.gifMaterial.opacity += (1 - this.gifMaterial.opacity) * step;
                    this.advanceGif(delta || 16);
                }

                this.wasVisible = parentVisible;
                return;
            }

            if (parentVisible && !this.wasVisible) {
                this.uniforms.uOpacity.value = 0;
            }
            this.wasVisible = parentVisible;

            if (parentVisible && this.ready) {
                this.uniforms.uOpacity.value += (1 - this.uniforms.uOpacity.value) * step;
            }
        },

        remove: function () {
            this.gifFrames = null;
            if (this.mesh) {
                this.mesh.geometry.dispose();
            }
            if (this.shaderMaterial) this.shaderMaterial.dispose();
            if (this.gifMaterial) this.gifMaterial.dispose();
            if (this.gifTexture) this.gifTexture.dispose();
            if (this.photoTexture) this.photoTexture.dispose();
            if (this.edgeTexture) this.edgeTexture.dispose();
        }
    });

    /* ------------------------------------------------------------------
     * Tracking stabiliser
     * ------------------------------------------------------------------
     * The NFT worker reports a new pose at camera frame rate, and that pose
     * carries a little noise every frame. Rendering it straight puts that
     * noise on screen, which is the classic AR.js "swimming"/jitter look.
     *
     * This filter runs from the renderer hook at the bottom of this file:
     * after A-Frame has ticked (so this frame's raw pose has been written)
     * and right before the draw, so the pose it produces is the one shown:
     *
     *   - tiny pose errors are deadbanded away (the overlay freezes),
     *   - at rest the filter is slow (very smooth),
     *   - as the marker actually moves the filter opens up, so fast pans do
     *     not feel laggy,
     *   - a fresh lock snaps straight to the raw pose instead of gliding in.
     *
     * It is frame-rate independent (time constant in seconds) and also
     * replaces AR.js's crude matrix-averaging `smooth` option.
     */
    function smoothstep(edge0, edge1, value) {
        var t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
        return t * t * (3 - 2 * t);
    }

    // Filled in by nft-pose-smoother instances; the renderer hook near the
    // bottom of this file runs them right before each draw.
    var poseFilters = [];

    AFRAME.registerComponent('nft-pose-smoother', {
        schema: {
            enabled: { type: 'boolean', default: true },
            // Pose error below which the overlay is considered at rest.
            // Translation is a fraction of the marker width; rotation is in
            // degrees.
            deadband: { type: 'number', default: 0.001 },
            rotationDeadband: { type: 'number', default: 0.1 },
            // Pose error at which the filter starts opening / is fully open.
            // The rest noise on a static camera peaks around 2% of the marker
            // width, so these sit just above it: noise stays smoothed, real
            // movement opens the filter.
            moveStart: { type: 'number', default: 0.004 },
            moveFull: { type: 'number', default: 0.032 },
            rotationMoveStart: { type: 'number', default: 0.35 },
            rotationMoveFull: { type: 'number', default: 4 },
            // Low-pass time constants, in seconds: held still vs moving.
            // Tuned on a static fake camera feed: 0.45 s at rest cuts
            // frame-to-frame z movement about 16x (6.9 mm -> 0.5 mm std)
            // while a fast pan still trails by only ~2% of the marker.
            restTau: { type: 'number', default: 0.45 },
            moveTau: { type: 'number', default: 0.02 },
            // Physical marker width in millimetres for this specific target.
            // When supplied, the global arjs-nft-init-data event is ignored so
            // one marker's metadata cannot affect another.
            markerWidth: { type: 'number', default: 0 }
        },

        init: function () {
            var self = this;

            // 2048 px at 72 DPI, the same default as hologram-mural.
            this.markerWidth = this.data.markerWidth > 0
                ? this.data.markerWidth
                : (2048 / 72) * 25.4;
            this.position = new THREE.Vector3();
            this.quaternion = new THREE.Quaternion();
            this.rawPosition = new THREE.Vector3();
            this.rawQuaternion = new THREE.Quaternion();
            this.initialised = false;
            this.lastVisible = false;
            this.lastPositionError = 0;
            this.lastAngleError = 0;

            this.onMarkerInfo = function (event) {
                if (self.data.markerWidth > 0) return;
                var info = event.detail || {};
                if (info.dpi > 0 && info.width > 0) {
                    self.markerWidth = (info.width / info.dpi) * 25.4;
                }
            };
            window.addEventListener('arjs-nft-init-data', this.onMarkerInfo);

            poseFilters.push(this);
        },

        filterPose: function (time, delta) {
            var object3D = this.el.object3D;
            var rawPosition = object3D.position;
            var rawQuaternion = object3D.quaternion;
            var visible = object3D.visible;

            if (!this.data.enabled) {
                this.initialised = false;
                return;
            }

            if (!visible) {
                this.lastVisible = false;
                return;
            }

            // Locked, or re-acquired after a loss: start from the raw pose so
            // the overlay never slides in from where it was last seen.
            if (!this.initialised || !this.lastVisible) {
                this.position.copy(rawPosition);
                this.quaternion.copy(rawQuaternion);
                this.rawPosition.copy(rawPosition);
                this.rawQuaternion.copy(rawQuaternion);
                this.initialised = true;
                this.lastVisible = true;
                this.lastPositionError = 0;
                this.lastAngleError = 0;
                return;
            }
            this.lastVisible = true;
            this.rawPosition.copy(rawPosition);
            this.rawQuaternion.copy(rawQuaternion);

            var positionError = this.position.distanceTo(rawPosition);
            var dot = Math.min(1, Math.abs(this.quaternion.dot(rawQuaternion)));
            var angleError = 2 * Math.acos(dot) * 180 / Math.PI;

            this.lastPositionError = positionError;
            this.lastAngleError = angleError;

            var positionNorm = positionError / this.markerWidth;
            var motion = Math.max(
                smoothstep(this.data.moveStart, this.data.moveFull, positionNorm),
                smoothstep(this.data.rotationMoveStart, this.data.rotationMoveFull,
                    angleError)
            );

            var atRest = positionError <= this.data.deadband * this.markerWidth &&
                angleError <= this.data.rotationDeadband;

            if (!atRest) {
                var tau = this.data.restTau +
                    (this.data.moveTau - this.data.restTau) * motion;
                var dt = Math.max(1, Math.min(delta || 16.7, 100)) / 1000;
                var alpha = 1 - Math.exp(-dt / tau);

                this.position.lerp(rawPosition, alpha);
                this.quaternion.slerp(rawQuaternion, alpha);
            }

            // arjs-anchor rewrites the raw pose next tick; this is what this
            // frame renders with.
            object3D.position.copy(this.position);
            object3D.quaternion.copy(this.quaternion);
        },

        remove: function () {
            window.removeEventListener('arjs-nft-init-data', this.onMarkerInfo);
            var index = poseFilters.indexOf(this);
            if (index !== -1) {
                poseFilters.splice(index, 1);
            }
        }
    });

    /* ------------------------------------------------------------------
     * Floating sparkles
     * ------------------------------------------------------------------ */
    AFRAME.registerComponent('ar-sparkles', {
        schema: {
            enabled: { type: 'boolean', default: true },
            count: { type: 'int', default: 130 }
        },

        init: function () {
            var count = this.data.count;
            var positions = new Float32Array(count * 3);
            var seeds = new Float32Array(count);
            var scales = new Float32Array(count);

            for (var i = 0; i < count; i++) {
                positions[i * 3] = (Math.random() - 0.5) * 1.16;
                positions[i * 3 + 1] = (Math.random() - 0.5) * 1.24;
                positions[i * 3 + 2] = 12 + Math.random() * 190;
                seeds[i] = Math.random();
                scales[i] = 0.35 + Math.random() * 1.3;
            }

            var geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
            geometry.setAttribute('aScale', new THREE.BufferAttribute(scales, 1));

            this.uniforms = {
                uTime: { value: 0 },
                uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) }
            };

            var material = new THREE.ShaderMaterial({
                uniforms: this.uniforms,
                vertexShader: SPARKLE_VERTEX,
                fragmentShader: SPARKLE_FRAGMENT,
                transparent: true,
                depthWrite: false,
                blending: THREE.AdditiveBlending,
                toneMapped: false
            });

            var points = new THREE.Points(geometry, material);
            points.renderOrder = 5;
            points.frustumCulled = false;
            points.visible = this.data.enabled;

            this.points = points;
            this.el.object3D.add(points);
        },

        update: function () {
            if (this.points) {
                this.points.visible = this.data.enabled;
            }
        },

        tick: function (time) {
            if (this.uniforms) {
                this.uniforms.uTime.value = time / 1000;
                this.uniforms.uPixelRatio.value = Math.min(window.devicePixelRatio || 1, 2);
            }
        },

        remove: function () {
            if (!this.points) return;
            this.el.object3D.remove(this.points);
            this.points.geometry.dispose();
            this.points.material.dispose();
        }
    });

    /* ------------------------------------------------------------------
     * Orbiting targeting arcs
     * ------------------------------------------------------------------ */
    AFRAME.registerComponent('ar-rings', {
        schema: {
            enabled: { type: 'boolean', default: true }
        },

        init: function () {
            this.group = new THREE.Group();
            this.group.visible = this.data.enabled;
            this.arcs = [];

            var specs = [
                { inner: 0.330, outer: 0.338, z: 24, color: 0x63f4ff, speed: 0.22, start: 0.1, length: Math.PI * 0.55, opacity: 0.55 },
                { inner: 0.425, outer: 0.431, z: 38, color: 0xff7ad9, speed: -0.16, start: Math.PI * 0.8, length: Math.PI * 0.32, opacity: 0.38 },
                { inner: 0.520, outer: 0.525, z: 52, color: 0xcfefff, speed: 0.10, start: Math.PI * 1.4, length: Math.PI * 0.26, opacity: 0.28 }
            ];

            for (var i = 0; i < specs.length; i++) {
                var spec = specs[i];
                var geometry = new THREE.RingGeometry(
                    spec.inner, spec.outer, 128, 1, spec.start, spec.length
                );
                var material = new THREE.MeshBasicMaterial({
                    color: spec.color,
                    transparent: true,
                    opacity: spec.opacity,
                    depthWrite: false,
                    side: THREE.DoubleSide,
                    blending: THREE.AdditiveBlending,
                    toneMapped: false
                });
                var mesh = new THREE.Mesh(geometry, material);
                mesh.position.z = spec.z;
                mesh.renderOrder = 4;
                mesh.frustumCulled = false;
                mesh.userData.speed = spec.speed;
                mesh.userData.baseOpacity = spec.opacity;
                this.group.add(mesh);
                this.arcs.push(mesh);
            }

            this.el.object3D.add(this.group);
        },

        update: function () {
            if (this.group) {
                this.group.visible = this.data.enabled;
            }
        },

        tick: function (time, delta) {
            if (!this.data.enabled || !this.arcs) {
                return;
            }
            var t = time / 1000;
            var dt = (delta || 16) / 1000;

            for (var i = 0; i < this.arcs.length; i++) {
                var arc = this.arcs[i];
                arc.rotation.z += arc.userData.speed * dt;
                arc.material.opacity = arc.userData.baseOpacity *
                    (0.7 + 0.3 * Math.sin(t * 1.6 + i * 2.1));
            }
        },

        remove: function () {
            if (!this.group) return;
            this.el.object3D.remove(this.group);
            for (var i = 0; i < this.arcs.length; i++) {
                this.arcs[i].geometry.dispose();
                this.arcs[i].material.dispose();
            }
        }
    });

    /* ------------------------------------------------------------------
     * Pulsing corner brackets
     * ------------------------------------------------------------------ */
    AFRAME.registerComponent('ar-brackets', {
        schema: {
            enabled: { type: 'boolean', default: true }
        },

        init: function () {
            var x = 0.532;
            var y = 0.545;
            var ax = 0.060; // ~43 mm on a 4:3 marker
            var ay = 0.080;

            var verts = [];
            var corners = [
                [-1, -1], [1, -1], [-1, 1], [1, 1]
            ];

            for (var i = 0; i < corners.length; i++) {
                var sx = corners[i][0];
                var sy = corners[i][1];
                // horizontal arm
                verts.push(sx * x, sy * y, 6, sx * (x - ax), sy * y, 6);
                // vertical arm
                verts.push(sx * x, sy * y, 6, sx * x, sy * (y - ay), 6);
            }

            var geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));

            var material = new THREE.LineBasicMaterial({
                color: 0x70f2ff,
                transparent: true,
                opacity: 0.5,
                depthWrite: false,
                blending: THREE.AdditiveBlending,
                toneMapped: false
            });

            this.lines = new THREE.LineSegments(geometry, material);
            this.lines.renderOrder = 4;
            this.lines.frustumCulled = false;
            this.lines.visible = this.data.enabled;
            this.el.object3D.add(this.lines);
        },

        update: function () {
            if (this.lines) {
                this.lines.visible = this.data.enabled;
            }
        },

        tick: function (time) {
            if (this.lines && this.data.enabled) {
                var t = time / 1000;
                this.lines.material.opacity = 0.32 + 0.26 * (0.5 + 0.5 * Math.sin(t * 1.8));
                this.lines.position.z = 1.5 + 1.5 * Math.sin(t * 1.2);
            }
        },

        remove: function () {
            if (!this.lines) return;
            this.el.object3D.remove(this.lines);
            this.lines.geometry.dispose();
            this.lines.material.dispose();
        }
    });

    /* ------------------------------------------------------------------
     * HUD wiring
     * ------------------------------------------------------------------ */
    var statusPill = document.getElementById('status-pill');
    var statusText = document.getElementById('status-text');
    var hint = document.getElementById('hint');
    var hintThumb = document.getElementById('hint-thumb');
    var hintTitle = document.getElementById('hint-title');
    var hintText = document.getElementById('hint-text');
    var targetTag = document.querySelector('.target-tag');
    var loader = document.getElementById('loader');
    var loaderText = document.getElementById('loader-text');
    var loaderNote = document.getElementById('loader-note');
    var errorOverlay = document.getElementById('error');
    var errorMessage = document.getElementById('error-message');
    var errorHint = document.getElementById('error-hint');

    var tuneBtn = document.getElementById('tune-btn');
    var tunePanel = document.getElementById('tune-panel');
    var tuneClose = document.getElementById('tune-close');
    var fitRange = document.getElementById('fit-range');
    var fitValue = document.getElementById('fit-value');
    var fxToggle = document.getElementById('fx-toggle');

    var cameraReady = false;
    var markersReady = false;
    var failed = false;
    var loaderHidden = false;
    var tracking = false;
    var lostAt = 0;

    var PREF_FIT = 'nftAr.fit';
    var PREF_FX = 'nftAr.fx';

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function readPref(key, fallback) {
        try {
            var raw = window.localStorage.getItem(key);
            if (raw === null) return fallback;
            var parsed = parseFloat(raw);
            return Number.isFinite(parsed) ? parsed : fallback;
        } catch (err) {
            return fallback;
        }
    }

    function writePref(key, value) {
        try {
            window.localStorage.setItem(key, String(value));
        } catch (err) {
            /* private mode — ignore */
        }
    }

    function setStatus(text, state) {
        if (!statusPill || !statusText) return;
        statusText.textContent = text;
        statusPill.className = 'status is-' + state;
    }

    function hideLoader() {
        if (!loader || loaderHidden) return;
        loaderHidden = true;
        loader.classList.add('is-gone');
        window.setTimeout(function () {
            loader.hidden = true;
        }, 800);
    }

    function showError(message, hintText) {
        if (failed) return;
        failed = true;

        if (errorMessage) {
            errorMessage.textContent = message ||
                'Please allow camera access, then reload the page.';
        }
        if (errorHint) {
            errorHint.textContent = hintText || '';
        }
        if (errorOverlay) {
            errorOverlay.hidden = false;
        }
        hideLoader();
        setStatus('Camera unavailable', 'error');
        if (hint) hint.classList.add('is-hidden');
        document.body.classList.remove('is-tracking');
    }

    function trackingHint() {
        var secure = window.isSecureContext ||
            window.location.hostname === 'localhost' ||
            window.location.hostname === '127.0.0.1';

        if (!secure) {
            return 'This page is running on plain HTTP. Mobile browsers only expose the camera over HTTPS (or localhost). Deploy to GitHub Pages, Netlify, or another HTTPS host.';
        }
        return 'Camera access was blocked. Open the browser\'s site settings, allow the camera for this page, then reload.';
    }

    function markCameraReady() {
        cameraReady = true;
        maybeStart();
    }

    function maybeStart() {
        if (failed) return;
        if (cameraReady && markersReady) {
            hideLoader();
            if (!tracking) {
                setStatus('Scanning for target', 'scanning');
            }
        } else if (markersReady) {
            if (loaderText) loaderText.textContent = 'Waiting for the camera…';
            if (loaderNote) loaderNote.textContent = 'Allow camera access when your browser asks.';
        }
    }

    /* ------------------------------------------------------------------
     * Camera-aspect alignment
     *
     * AR.js builds its projection from the camera intrinsics (the 640x480
     * frame), but renders into a canvas sized to the viewport. The webcam
     * feed fills the viewport with object-fit: cover, so the two only agree
     * when the viewport happens to be 4:3.
     *
     * We display the feed ourselves as a centred cover crop and pre-multiply
     * that same crop into the projection right before each render. AR.js
     * rewrites the projection every tick, hence the renderer hook.
     * ------------------------------------------------------------------ */
    var arSceneEl = document.getElementById('ar-scene');

    function coverProjection() {
        if (!arSceneEl || !document.body.classList.contains('ar-marker-ready')) {
            return;
        }
        var video = getVideoElement();
        var camera = arSceneEl.camera;
        var canvas = arSceneEl.canvas;
        if (!video || !camera || !canvas) return;

        var frameWidth = video.videoWidth;
        var frameHeight = video.videoHeight;
        var width = window.innerWidth;
        var height = window.innerHeight;
        if (!frameWidth || !frameHeight || !width || !height) return;

        var frameAspect = frameWidth / frameHeight;
        var coverWidth = Math.max(width, height * frameAspect);
        var coverHeight = coverWidth / frameAspect;
        var scaleX = coverWidth / width;
        var scaleY = coverHeight / height;

        // Scale the x/y rows of the projection. AR.js hands us a fresh matrix
        // each frame, so this never compounds.
        var elements = camera.projectionMatrix.elements;
        elements[0] *= scaleX;
        elements[4] *= scaleX;
        elements[8] *= scaleX;
        elements[12] *= scaleX;
        elements[1] *= scaleY;
        elements[5] *= scaleY;
        elements[9] *= scaleY;
        elements[13] *= scaleY;
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    }

    function installAspectFix() {
        var renderer = arSceneEl && arSceneEl.renderer;
        if (!renderer || renderer.__muralAspectFix) return;
        renderer.__muralAspectFix = true;

        var originalRender = renderer.render;
        renderer.render = function (scene, camera) {
            // Runs after A-Frame's tick (so the raw AR.js pose is in place)
            // and before the draw, which is exactly where the stabiliser
            // needs to be.
            for (var i = 0; i < poseFilters.length; i++) {
                poseFilters[i].filterPose(arSceneEl.time, arSceneEl.delta);
            }
            if (camera && camera === arSceneEl.camera) {
                coverProjection();
            }
            return originalRender.call(this, scene, camera);
        };
    }

    if (arSceneEl) {
        if (arSceneEl.renderer) {
            installAspectFix();
        } else {
            arSceneEl.addEventListener('renderstart', installAspectFix, { once: true });
        }
    }

    function updateTargetHud(target) {
        if (!target) return;
        activeTarget = target;

        if (targetTag) {
            targetTag.textContent = 'TARGET · ' + target.id;
        }
        if (hintThumb) {
            hintThumb.src = absoluteUrl(target.image);
            hintThumb.alt = target.title + ' image target';
        }
        if (hintTitle) {
            hintTitle.textContent = 'Point at ' + (target.title || 'the print');
        }
    }

    function trackFound(target) {
        if (target) updateTargetHud(target);
        lostAt = 0;
        if (tracking) return;
        tracking = true;
        document.body.classList.add('is-tracking');
        if (hint) hint.classList.add('is-hidden');
        setStatus('Target locked · layer live', 'locked');
        hideLoader();
    }

    function trackLost() {
        if (!tracking) return;
        tracking = false;
        lostAt = 0;
        document.body.classList.remove('is-tracking');
        if (failed) return;
        if (hint) hint.classList.remove('is-hidden');
        setStatus('Scanning for target', 'scanning');
    }

    function createTargetEntities(list) {
        targetEntries = list;
        expectedTargets = list.length;

        var root = targetRoot || arSceneEl;
        if (!root) return;

        for (var index = 0; index < list.length; index++) {
            var target = list[index];
            var first = index === 0;

            var nft = document.createElement('a-nft');
            nft.setAttribute('id', first ? 'mural-target' : 'target-' + target.id);
            nft.setAttribute('type', 'nft');
            nft.setAttribute('url', markerUrl(target.marker));
            nft.setAttribute('nft-pose-smoother', {
                enabled: true,
                markerWidth: target.widthMm || 0
            });
            nft.setAttribute('min-confidence', '0.5');
            nft.setAttribute('hit-testing-enabled', 'false');

            var overlay = document.createElement('a-entity');
            overlay.setAttribute('id', first ? 'mural-overlay' : 'overlay-' + target.id);
            overlay.setAttribute('hologram-mural', {
                fit: currentFit / 100,
                intensity: savedFx ? 1 : 0,
                photo: target.image,
                edges: target.edges || '',
                gif: target.animation || '',
                markerWidth: target.widthMm || 0,
                markerHeight: target.heightMm || 0,
                label: target.title || target.id
            });
            overlay.setAttribute('ar-sparkles', 'enabled', savedFx);
            overlay.setAttribute('ar-rings', 'enabled', savedFx);
            overlay.setAttribute('ar-brackets', 'enabled', savedFx);

            nft.appendChild(overlay);
            root.appendChild(nft);

            (function (entry, targetData) {
                entry.addEventListener('markerFound', function () {
                    trackFound(targetData);
                });
                entry.addEventListener('markerLost', function () {
                    if (activeTarget === targetData) lostAt = performance.now();
                });
            })(nft, target);

            markerEls.push({ el: nft, target: target, overlay: overlay });
            overlayEls.push(overlay);
        }

        // The camera may already be running; the loading kicker waits for
        // expectedTargets before replaying arjs-video-loaded, so every marker
        // gets its own NFT worker.
        var loaderBg = document.querySelector('.loader-bg');
        if (loaderBg && list[0] && list[0].image) {
            loaderBg.style.backgroundImage = 'url("' + absoluteUrl(list[0].image) + '")';
        }
        updateTargetHud(list[0]);
        maybeStart();
    }

    function showEmptyState() {
        hideLoader();
        setStatus('No image targets yet', 'scanning');
        if (hint) hint.classList.remove('is-hidden');
        if (hintThumb) hintThumb.style.display = 'none';
        if (hintTitle) hintTitle.textContent = 'No scannable prints yet';
        if (hintText) {
            hintText.textContent = 'Add an image and animation in the backoffice, then reload this page.';
        }
        if (targetTag) targetTag.textContent = 'TARGET · none';
    }

    function showSetupError(message, hintText) {
        var errorTitle = document.getElementById('error-title');
        var kicker = document.querySelector('.error-kicker');
        if (errorTitle) errorTitle.textContent = 'The target list could not load';
        if (kicker) kicker.textContent = 'Setup needed';
        showError(message, hintText);
        setStatus('Setup needed', 'error');
    }

    function loadTargets() {
        fetch(MANIFEST_URL, { cache: 'no-store' })
            .then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            })
            .then(function (manifest) {
                var list = manifest && Array.isArray(manifest.targets)
                    ? manifest.targets.filter(function (target) {
                        return target && target.id && target.image && target.marker;
                    })
                    : [];

                if (!list.length) {
                    showEmptyState();
                    return;
                }
                createTargetEntities(list);
            })
            .catch(function (error) {
                showSetupError(
                    'The target list could not be loaded.',
                    'Check that assets/targets.json is reachable and valid. ' +
                    (error && error.message ? error.message : '')
                );
            });
    }

    // AR.js emits markerFound/Lost, but polling object3D.visible is a reliable
    // fallback across AR.js versions and smoothing configurations.
    window.setInterval(function () {
        if (!markerEls.length) return;

        var found = null;
        for (var i = 0; i < markerEls.length; i++) {
            var entry = markerEls[i];
            if (entry.el.object3D && entry.el.object3D.visible) {
                found = entry;
                break;
            }
        }

        if (found) {
            trackFound(found.target);
        } else if (tracking && lostAt && performance.now() - lostAt > 900) {
            // A short grace period avoids flicker while the tracker blinks.
            trackLost();
        } else if (tracking && !lostAt) {
            lostAt = performance.now();
        }
    }, 200);

    /* --- AR.js lifecycle events --- */
    function getVideoElement() {
        return document.getElementById('arjs-video');
    }

    window.addEventListener('arjs-video-loaded', function () {
        markCameraReady();
    });
    window.addEventListener('arjs-nft-loaded', function () {
        markersReady = true;
        // The worker is initialised by now; from here on we own the webcam
        // layout so the feed is a centred cover crop (see coverProjection).
        document.body.classList.add('ar-marker-ready');
        maybeStart();
    });

    // If the camera became ready before our listener (and, more importantly,
    // before AR.js attached its own NFT worker listener), the video event is
    // lost and the marker worker never starts. Polling fixes our own state;
    // the kicker below repairs AR.js's race.
    window.setInterval(function () {
        if (cameraReady || failed) return;
        var video = getVideoElement();
        if (video && video.readyState >= 2 && video.videoWidth > 0) {
            markCameraReady();
        }
    }, 250);

    /*
     * AR.js attaches its NFT worker listener inside the marker controls, which
     * initialise a beat after the webcam starts. When the webcam is quick (or
     * the camera is already allowed), the real arjs-video-loaded event fires
     * first and is lost, so the worker never starts. This kicker re-sends the
     * event once the controller exists.
     *
     * A second copy of the event would start a second worker, so only kick
     * while AR.js's handler has clearly not run yet. The handler resizes the
     * controller canvas from the raw camera frame down to the 320px tracking
     * canvas as soon as it receives the event, which gives us a reliable
     * "already started" signal without touching AR.js internals.
     */
    function workerHasStarted(controller, video) {
        var canvas = controller && controller.canvas;
        if (!canvas || !video || !video.videoWidth) return false;
        return canvas.width !== video.videoWidth ||
            canvas.height !== video.videoHeight;
    }

    var readySince = 0;
    var lastKickAt = 0;

    window.setInterval(function () {
        if (markersReady || failed) return;

        // AR.js only starts an NFT worker for markers that are already in the
        // DOM when arjs-video-loaded fires. The manifest is fetched after the
        // scene boots, so wait until every expected <a-nft> exists before
        // replaying the event (one dispatch starts one worker per marker).
        if (!expectedTargets || document.querySelectorAll('a-nft').length < expectedTargets) {
            return;
        }

        var video = getVideoElement();
        var sceneEl = document.getElementById('ar-scene');
        var system = sceneEl && sceneEl.systems && sceneEl.systems.arjs;
        var session = system && system._arSession;
        var arContext = session && session.arContext;
        var controller = arContext && arContext.arController;

        if (!video || video.readyState < 2 || !video.videoWidth || !controller) {
            readySince = 0;
            return;
        }

        // Give the marker controls time to attach their listener before the
        // first kick.
        var now = performance.now();
        if (!readySince) readySince = now;
        if (workerHasStarted(controller, video)) return;

        // The handler resizes the canvas synchronously when it receives the
        // event, so a retry is only needed if the listener was not attached
        // yet. Two and a half seconds covers late init without risking a
        // duplicate worker (the canvas check above stops retries as soon as
        // any handler has run).
        if (lastKickAt && now - lastKickAt < 2500) return;

        var sinceReady = now - readySince;
        if (sinceReady < 900) return;

        lastKickAt = now;

        // AR.js samples the video element's clientWidth/clientHeight when the
        // event fires and keeps using that rect to feed its NFT worker. By the
        // time this repair runs, AR.js has already stretched the element to
        // cover the viewport, which would make the worker read a downscaled
        // frame and report a pose that scales with the window. Pin the element
        // to the camera's intrinsic size for the duration of the event.
        var intrinsicWidth = video.videoWidth || 640;
        var intrinsicHeight = video.videoHeight || 480;
        video.style.setProperty('width', intrinsicWidth + 'px', 'important');
        video.style.setProperty('height', intrinsicHeight + 'px', 'important');

        window.dispatchEvent(new CustomEvent('arjs-video-loaded', {
            detail: { component: video }
        }));

        // Drop our override; AR.js re-applies its display sizing next tick and
        // the marker-ready CSS takes over once the worker has loaded.
        video.style.removeProperty('width');
        video.style.removeProperty('height');
    }, 250);

    // AR.js shows its own unstyled popup shortly after a camera failure.
    // Take it over and present a useful message instead.
    var errorWatcher = new MutationObserver(function () {
        var popup = document.getElementById('error-popup');
        if (!popup) return;

        var raw = (popup.textContent || '').replace(/\s+/g, ' ').trim();
        popup.remove();

        var name = (raw.match(/Name:\s*([^\s]+)/i) || [])[1] || '';
        var message = raw
            .replace(/^Webcam Error\s*/i, '')
            .replace(/Name:\s*[^\s]+\s*/i, '')
            .replace(/Message:\s*/i, '')
            .trim();

        var friendly = message || 'The browser rejected the camera request.';
        if (/NotAllowedError|PermissionDenied/i.test(name)) {
            friendly = 'Camera permission was denied.';
        } else if (/NotFoundError|DevicesNotFound/i.test(name)) {
            friendly = 'No camera was found on this device.';
        } else if (/NotReadableError|TrackStartError/i.test(name)) {
            friendly = 'The camera is already in use by another app or tab.';
        } else if (/SecurityError/i.test(name)) {
            friendly = 'The browser blocked camera access on this page.';
        }

        showError(friendly, trackingHint());
    });
    errorWatcher.observe(document.body, { childList: true });

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showError(
            'This browser does not expose a camera API here.',
            trackingHint()
        );
    }

    // If nothing has happened after a while, explain the likely cause.
    window.setTimeout(function () {
        if (failed) return;
        if (!markersReady && cameraReady) {
            if (loaderText) loaderText.textContent = 'Still loading image descriptors…';
            if (loaderNote) {
                loaderNote.textContent = 'Check that assets/targets.json and the target marker files are reachable.';
            }
            return;
        }
        if (cameraReady) return;
        if (loaderText) loaderText.textContent = 'Still waiting for the camera…';
        if (loaderNote) {
            loaderNote.textContent = window.isSecureContext
                ? 'Check the camera permission for this site, then reload.'
                : 'A camera needs HTTPS. Deploy this page to an HTTPS host.';
        }
    }, 15000);

    /* --- Calibration panel --- */
    var currentFit = clamp(readPref(PREF_FIT, 100), 85, 115);
    var savedFx = readPref(PREF_FX, 1) !== 0;

    function renderFit(value) {
        if (fitRange) fitRange.value = String(value);
        if (fitValue) fitValue.textContent = Math.round(value) + '%';
    }

    function applyFit(value) {
        var fit = clamp(value, 85, 115);
        currentFit = fit;
        renderFit(fit);
        for (var i = 0; i < overlayEls.length; i++) {
            overlayEls[i].setAttribute('hologram-mural', 'fit', fit / 100);
        }
        writePref(PREF_FIT, fit);
    }

    function applyFx(enabled) {
        if (fxToggle) fxToggle.checked = enabled;
        for (var i = 0; i < overlayEls.length; i++) {
            var overlay = overlayEls[i];
            overlay.setAttribute('hologram-mural', 'intensity', enabled ? 1 : 0);
            overlay.setAttribute('ar-sparkles', 'enabled', enabled);
            overlay.setAttribute('ar-rings', 'enabled', enabled);
            overlay.setAttribute('ar-brackets', 'enabled', enabled);
        }
        writePref(PREF_FX, enabled ? 1 : 0);
    }

    renderFit(currentFit);
    applyFit(currentFit);
    applyFx(savedFx);

    function setPanel(open) {
        if (!tunePanel || !tuneBtn) return;
        tunePanel.hidden = !open;
        tuneBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    if (tuneBtn) {
        tuneBtn.addEventListener('click', function (event) {
            event.stopPropagation();
            setPanel(tunePanel.hidden);
        });
    }
    if (tuneClose) {
        tuneClose.addEventListener('click', function () {
            setPanel(false);
        });
    }
    if (fitRange) {
        fitRange.addEventListener('input', function () {
            applyFit(parseFloat(fitRange.value));
        });
    }
    if (fxToggle) {
        fxToggle.addEventListener('change', function () {
            applyFx(fxToggle.checked);
        });
    }

    document.addEventListener('click', function (event) {
        if (!tunePanel || tunePanel.hidden) return;
        if (tunePanel.contains(event.target) || (tuneBtn && tuneBtn.contains(event.target))) {
            return;
        }
        setPanel(false);
    });

    /* --- Tiny debug surface (useful in mobile remote consoles) --- */
    window.__AR_MURAL__ = {
        get tracking() {
            return tracking;
        },
        get status() {
            return statusText ? statusText.textContent : '';
        },
        get fit() {
            return currentFit;
        },
        get targets() {
            return targetEntries.map(function (target) {
                return { id: target.id, title: target.title };
            });
        },
        get active() {
            return activeTarget ? activeTarget.id : null;
        },
        get markerCount() {
            return markerEls.length;
        }
    };

    loadTargets();
})();
