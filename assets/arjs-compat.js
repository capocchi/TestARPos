// AR.js 3.4.x calls THREE.MathUtils, which does not exist in the three.js
// version bundled with A-Frame 1.0.4 (there it is THREE.Math). Without this
// alias, gps-camera throws on every GPS update and never sets its origin,
// leaving all gps-entity-place markers unanchored.
if (window.AFRAME && AFRAME.THREE && !AFRAME.THREE.MathUtils) {
    AFRAME.THREE.MathUtils = AFRAME.THREE.Math || {};
}
