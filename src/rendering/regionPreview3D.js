import * as THREE from 'three';
import { MaterialRegistry } from './materials.js';
import { buildTerrainMesh } from './terrainMesh.js';
import { buildWaterMesh } from './waterMesh.js';

/**
 * Create a 3D preview renderer for the region selection screen.
 * Shows terrain, water, rivers, and settlement markers with an auto-rotating camera.
 *
 * @param {HTMLElement} container - DOM element to mount the canvas into
 * @returns {{ update: (region: object) => void, highlight: (settlement: object|null) => void, dispose: () => void }}
 */
export function createRegionPreview3D(container) {
  const materials = new MaterialRegistry();

  // --- Renderer ---
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  // --- Scene ---
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87CEEB);
  // Fog scaled for regional terrain (~51k world units)
  scene.fog = new THREE.Fog(0x87CEEB, 40000, 120000);

  // --- Camera ---
  // Near plane as large as possible for depth precision; far plane for orbit distance
  const camera = new THREE.PerspectiveCamera(50, 1, 500, 200000);

  // --- Lighting (matches game.js pattern, scaled for region) ---
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const sun = new THREE.DirectionalLight(0xffeedd, 0.8);
  sun.position.set(20000, 30000, 15000);
  scene.add(sun);

  // --- State ---
  let animFrameId = null;
  let orbitAngle = 0;
  let orbitCenter = new THREE.Vector3();
  let orbitRadius = 100;
  let disposed = false;

  // Track meshes for cleanup
  let currentMeshes = [];
  let settlementMarkers = [];
  let highlightRing = null;

  function clearScene() {
    for (const mesh of currentMeshes) {
      scene.remove(mesh);
      if (mesh.geometry) mesh.geometry.dispose();
      // Dispose materials owned by this mesh (not shared registry materials)
      if (mesh._ownsMaterial && mesh.material) mesh.material.dispose();
    }
    currentMeshes = [];
    settlementMarkers = [];
    if (highlightRing) {
      scene.remove(highlightRing);
      if (highlightRing.geometry) highlightRing.geometry.dispose();
      if (highlightRing.material) highlightRing.material.dispose();
      highlightRing = null;
    }
  }

  /**
   * Update the 3D preview with new region data.
   * @param {object} region - RegionData from generateRegion
   */
  function update(region) {
    clearScene();

    const { heightmap, seaLevel, drainage, settlements } = region;
    const worldW = heightmap.worldWidth;
    const worldH = heightmap.worldHeight;

    // Terrain mesh
    const terrain = buildTerrainMesh(heightmap, seaLevel, materials);
    scene.add(terrain);
    currentMeshes.push(terrain);

    // Water mesh — offset slightly below sea level to avoid z-fighting with terrain
    const water = buildWaterMesh(heightmap, seaLevel - 3, materials);
    scene.add(water);
    currentMeshes.push(water);

    // River dots on terrain
    if (drainage && drainage.accumulation) {
      const riverMesh = buildRiverMesh(heightmap, seaLevel, drainage, region.params);
      if (riverMesh) {
        scene.add(riverMesh);
        currentMeshes.push(riverMesh);
      }
    }

    // Settlement markers
    if (settlements && settlements.length > 0) {
      for (const s of settlements) {
        const marker = buildSettlementMarker(s, heightmap);
        scene.add(marker);
        currentMeshes.push(marker);
        settlementMarkers.push({ settlement: s, mesh: marker });
      }
    }

    // Configure orbit camera
    orbitCenter.set(worldW / 2, seaLevel, worldH / 2);
    orbitRadius = Math.max(worldW, worldH) * 0.9;
  }

  /**
   * Highlight a selected settlement with a cyan ring.
   * @param {object|null} settlement
   */
  function highlight(settlement) {
    // Remove old highlight
    if (highlightRing) {
      scene.remove(highlightRing);
      if (highlightRing.geometry) highlightRing.geometry.dispose();
      if (highlightRing.material) highlightRing.material.dispose();
      highlightRing = null;
    }

    // Reset all marker emissive
    for (const { mesh } of settlementMarkers) {
      if (mesh.material && mesh.material.emissive) {
        mesh.material.emissive.setHex(0x000000);
      }
    }

    if (!settlement) return;

    // Find matching marker and set emissive
    for (const { settlement: s, mesh } of settlementMarkers) {
      if (s === settlement && mesh.material && mesh.material.emissive) {
        mesh.material.emissive.setHex(0x226666);
      }
    }

    // Add a ring above the settlement
    const ringGeo = new THREE.RingGeometry(500, 600, 32);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x00ffff,
      transparent: true,
      opacity: 0.6,
      side: THREE.DoubleSide,
    });
    highlightRing = new THREE.Mesh(ringGeo, ringMat);
    highlightRing.position.set(settlement.x, (settlement.elevation || 0) + 100, settlement.z);
    scene.add(highlightRing);
  }

  // --- Animation loop ---
  function animate() {
    if (disposed) return;
    animFrameId = requestAnimationFrame(animate);

    orbitAngle += 0.003; // ~0.1 rad/s at 60fps

    const elevAngle = Math.PI / 4; // 45 degrees
    camera.position.set(
      orbitCenter.x + orbitRadius * Math.cos(orbitAngle) * Math.cos(elevAngle),
      orbitCenter.y + orbitRadius * Math.sin(elevAngle),
      orbitCenter.z + orbitRadius * Math.sin(orbitAngle) * Math.cos(elevAngle),
    );
    camera.lookAt(orbitCenter);

    // Animate highlight ring
    if (highlightRing) {
      highlightRing.rotation.y += 0.01;
    }

    // Resize renderer to match container
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (renderer.domElement.width !== w || renderer.domElement.height !== h) {
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }

    renderer.render(scene, camera);
  }

  animate();

  function dispose() {
    disposed = true;
    if (animFrameId) cancelAnimationFrame(animFrameId);
    clearScene();
    renderer.dispose();
    materials.dispose();
    if (renderer.domElement.parentNode) {
      renderer.domElement.parentNode.removeChild(renderer.domElement);
    }
  }

  return { update, highlight, dispose };
}

/**
 * Build river geometry as blue points/dots on terrain surface.
 */
function buildRiverMesh(heightmap, seaLevel, drainage, params) {
  const { accumulation } = drainage;
  const W = heightmap.width;
  const H = heightmap.height;
  const cellSize = heightmap.cellSize;
  const riverThreshold = (params && params.riverThreshold) || 1000;

  // Collect river positions
  const positions = [];
  for (let gz = 0; gz < H; gz++) {
    for (let gx = 0; gx < W; gx++) {
      const acc = accumulation[gz * W + gx];
      if (acc < riverThreshold) continue;
      const elev = heightmap.get(gx, gz);
      if (elev < seaLevel) continue;

      positions.push(gx * cellSize, elev + 2, gz * cellSize);
    }
  }

  if (positions.length === 0) return null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

  const mat = new THREE.PointsMaterial({
    color: 0x3388cc,
    size: cellSize * 1.5,
    sizeAttenuation: true,
  });

  const points = new THREE.Points(geo, mat);
  points._ownsMaterial = true;
  return points;
}

/**
 * Build a colored cylinder marker for a settlement.
 */
function buildSettlementMarker(settlement, heightmap) {
  let radius, height, color;

  switch (settlement.rank) {
    case 'city':
      radius = 400;
      height = 800;
      color = 0xdd3333;
      break;
    case 'town':
      radius = 250;
      height = 500;
      color = 0xee8833;
      break;
    case 'village':
    default:
      radius = 150;
      height = 300;
      color = 0xddcc33;
      break;
  }

  const geo = new THREE.CylinderGeometry(radius, radius, height, 12);
  const mat = new THREE.MeshLambertMaterial({ color });
  const mesh = new THREE.Mesh(geo, mat);
  mesh._ownsMaterial = true;

  const elev = settlement.elevation || heightmap.sample(settlement.x, settlement.z);
  mesh.position.set(settlement.x, elev + height / 2, settlement.z);

  return mesh;
}
