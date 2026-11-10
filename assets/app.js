(function () {
    var TARGET = {
        latitude: 42.297470,
        longitude: 9.154552,
        accuracy: 6,
        altitude: 496
    };

    // The JPEG is anchored at the target and only appears once you are
    // within this radius. It never moves with the camera.
    var SHOW_RADIUS_M = 5;

    var latEl = document.getElementById('gps-lat');
    var lonEl = document.getElementById('gps-lon');
    var accEl = document.getElementById('gps-acc');
    var altEl = document.getElementById('gps-alt');
    var statusEl = document.getElementById('gps-status');

    var markerEl = document.getElementById('ar-marker');
    var coordsEl = document.getElementById('marker-coords');
    var specEl = document.getElementById('marker-spec');
    var assetEl = document.getElementById('marker-asset');
    var distanceEl = document.getElementById('marker-distance');
    var markerStatusEl = document.getElementById('marker-status');

    var textureLoaded = false;
    var anchored = false;
    var lastDistance = null;

    function haversine(aLat, aLon, bLat, bLon) {
        var R = 6371000;
        var toRad = Math.PI / 180;
        var dLat = (bLat - aLat) * toRad;
        var dLon = (bLon - aLon) * toRad;
        var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(aLat * toRad) * Math.cos(bLat * toRad) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)) * R;
    }

    function formatDistance(meters) {
        if (!Number.isFinite(meters)) return '--';
        return meters >= 1000
            ? (meters / 1000).toFixed(2) + ' km'
            : meters.toFixed(1) + ' m';
    }

    function formatCoord(value, positive, negative) {
        return value.toFixed(6) + '° ' + (value >= 0 ? positive : negative);
    }

    function setStatus(text, isError) {
        statusEl.textContent = text;
        statusEl.classList.toggle('gps-error', !!isError);
    }

    function setMarkerStatus(text, cls) {
        markerStatusEl.textContent = text;
        markerStatusEl.classList.remove('gps-error', 'gps-ok');
        if (cls) markerStatusEl.classList.add(cls);
    }

    function setAssetState(text, cls) {
        assetEl.textContent = text;
        assetEl.classList.remove('gps-error', 'gps-ok');
        if (cls) assetEl.classList.add(cls);
    }

    function textureInfo() {
        // Prefer the preloaded <a-assets> image: it is the source of truth
        // that the JPEG actually downloaded.
        var img = document.getElementById('marker-texture');
        var image = img && img.complete && (img.naturalWidth || img.width) ? img : null;

        if (!image) {
            var mesh = markerEl.getObject3D('mesh');
            var map = mesh && mesh.material && mesh.material.map;
            image = map && (map.image || (map.source && map.source.data));
        }
        if (!image) return null;

        var width = image.naturalWidth || image.videoWidth || image.width || 0;
        var height = image.naturalHeight || image.videoHeight || image.height || 0;
        if (!width || !height) return null;
        return { width: width, height: height };
    }

    function markTextureLoaded() {
        if (textureLoaded) return;
        var info = textureInfo();
        textureLoaded = true;
        setAssetState(
            info && info.width
                ? 'loaded ✓ (' + info.width + '×' + info.height + ')'
                : 'loaded ✓',
            'gps-ok'
        );
        verifyPlacement();
    }

    function onMarkerAnchored() {
        anchored = true;
        verifyPlacement();
    }

    function cameraHasOrigin() {
        var camEl = document.querySelector('[gps-camera]');
        var comp = camEl && camEl.components && camEl.components['gps-camera'];
        return !!(comp && comp.originCoords);
    }

    function verifyPlacement() {
        var comp = markerEl.components && markerEl.components['gps-entity-place'];
        var info = textureInfo();

        if (info) markTextureLoaded();

        if (!comp || !comp.data) {
            setMarkerStatus('initializing marker…');
            return;
        }

        // Read the values actually applied by AR.js, not just the HTML.
        var lat = Number(comp.data.latitude);
        var lon = Number(comp.data.longitude);
        var coordsMatch =
            Math.abs(lat - TARGET.latitude) < 1e-7 &&
            Math.abs(lon - TARGET.longitude) < 1e-7;

        coordsEl.textContent = lat.toFixed(6) + ', ' + lon.toFixed(6);
        specEl.textContent = '±' + TARGET.accuracy + ' m · alt ' + TARGET.altitude +
            ' m · show < ' + SHOW_RADIUS_M + ' m';

        if (!coordsMatch) {
            setMarkerStatus('coordinate mismatch', 'gps-error');
            return;
        }
        if (!textureLoaded) {
            setMarkerStatus('loading JPEG…');
            return;
        }

        // AR.js only anchors entities once the camera has a GPS origin.
        if (!anchored && cameraHasOrigin()) {
            anchored = true;
        }
        if (!anchored) {
            setMarkerStatus('JPEG loaded, waiting for GPS fix…');
            return;
        }

        if (lastDistance === null) {
            setMarkerStatus('JPEG ready, waiting for your GPS fix…');
            return;
        }
        if (lastDistance > SHOW_RADIUS_M) {
            setMarkerStatus(
                'hidden — ' + formatDistance(lastDistance) + ' away, move closer'
            );
            return;
        }

        setMarkerStatus(
            'visible ✓ (' + formatDistance(lastDistance) + ' away)',
            'gps-ok'
        );
    }

    // AR.js dispatches this once the marker has a world position.
    markerEl.addEventListener('gps-entity-place-update-position', onMarkerAnchored);

    if (markerEl.hasLoaded) {
        verifyPlacement();
    } else {
        markerEl.addEventListener('loaded', verifyPlacement);
    }
    markerEl.addEventListener('materialtextureloaded', markTextureLoaded);

    var textureImg = document.getElementById('marker-texture');
    if (textureImg) {
        if (textureImg.complete && (textureImg.naturalWidth || textureImg.width)) {
            markTextureLoaded();
        } else {
            textureImg.addEventListener('load', markTextureLoaded);
            textureImg.addEventListener('error', function () {
                setAssetState('failed ✗', 'gps-error');
                setMarkerStatus('JPEG could not be loaded', 'gps-error');
            });
        }
    }

    // Fallback polling: covers cached textures that load before listeners attach.
    var polls = 0;
    var pollTimer = setInterval(function () {
        polls += 1;
        if (!textureLoaded) {
            if (textureInfo()) {
                markTextureLoaded();
            } else if (polls >= 40) {
                setAssetState('not loaded ✗', 'gps-error');
                setMarkerStatus('JPEG failed to load after 20 s', 'gps-error');
            }
        }
        verifyPlacement();
        if (textureLoaded && anchored) clearInterval(pollTimer);
    }, 500);

    if (!navigator.geolocation) {
        setStatus('geolocation not supported', true);
        return;
    }

    function onPosition(position) {
        var coords = position.coords;

        latEl.textContent = formatCoord(coords.latitude, 'N', 'S');
        lonEl.textContent = formatCoord(coords.longitude, 'E', 'W');
        accEl.textContent = Number.isFinite(coords.accuracy)
            ? '±' + Math.round(coords.accuracy) + ' m'
            : '--';
        altEl.textContent = Number.isFinite(coords.altitude)
            ? Math.round(coords.altitude) + ' m'
            : '--';

        var distance = haversine(
            coords.latitude,
            coords.longitude,
            TARGET.latitude,
            TARGET.longitude
        );
        lastDistance = distance;
        distanceEl.textContent = formatDistance(distance);

        // Single anchored JPEG: only shown while you are inside the radius.
        markerEl.setAttribute('visible', distance <= SHOW_RADIUS_M);

        var time = new Date(position.timestamp).toLocaleTimeString();
        setStatus('updated ' + time);
        verifyPlacement();
    }

    function onError(error) {
        var messages = {
            1: 'permission denied',
            2: 'position unavailable',
            3: 'timed out'
        };
        setStatus('GPS error: ' + (messages[error.code] || error.message), true);
    }

    statusEl.textContent = 'locating…';

    navigator.geolocation.watchPosition(onPosition, onError, {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 15000
    });
})();
