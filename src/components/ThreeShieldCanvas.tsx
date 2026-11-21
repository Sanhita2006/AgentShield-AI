import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ChevronDown, ChevronUp, Layers, Orbit, Shield, Target, Volume2, VolumeX } from 'lucide-react';
import type { AppRoute } from './LandingPage.tsx';

export type CameraPreset = 'scroll' | 'overview' | 'explode' | 'intercept';

interface ThreeShieldCanvasProps {
  route: AppRoute;
  scrollProgressRef: React.MutableRefObject<number>;
  activeThreatPulse?: 'allow' | 'ask' | 'block' | null;
  auditBroken?: boolean;
  isDark: boolean;
  soundMuted: boolean;
  onToggleSound: () => void;
}

const _vec3A = new THREE.Vector3();
const _vec3B = new THREE.Vector3();
const _color = new THREE.Color();

function makeHexPoints(radius: number, z = 0): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    pts.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius, z));
  }
  return pts;
}

function makeCircleLoop(radius: number, segments: number, color: number, opacity = 0.65): THREE.LineLoop {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity });
  return new THREE.LineLoop(geo, mat);
}

function makeWireEdgeBox(
  w: number,
  h: number,
  d: number,
  lineColor: number,
  fillColor = 0x050811,
  fillOpacity = 0.35
): THREE.Group {
  const grp = new THREE.Group();
  const boxGeo = new THREE.BoxGeometry(w, h, d);
  const edges = new THREE.EdgesGeometry(boxGeo);
  const line = new THREE.LineSegments(
    edges,
    new THREE.LineBasicMaterial({ color: lineColor, transparent: true, opacity: 0.92 })
  );
  const core = new THREE.Mesh(
    boxGeo,
    new THREE.MeshBasicMaterial({ color: fillColor, transparent: true, opacity: fillOpacity, depthWrite: false })
  );
  grp.add(core, line);
  return grp;
}

function createRadialFloorLines(): THREE.Group {
  const floorGrp = new THREE.Group();

  // Subtle vector grid on pitch black
  const grid = new THREE.GridHelper(56, 44, 0x0284c7, 0x0c1b30);
  grid.position.y = 0;
  const gridMats = Array.isArray(grid.material) ? grid.material : [grid.material];
  gridMats.forEach((m) => {
    m.transparent = true;
    m.opacity = 0.65;
  });
  floorGrp.add(grid);

  // Concentric radar / perimeter rings
  for (const [rad, col, op] of [
    [3.2, 0xf97316, 0.36],
    [6.4, 0x38bdf8, 0.28],
    [10.0, 0x0ea5e9, 0.18],
    [14.5, 0x1e293b, 0.25],
  ] as const) {
    const ring = makeCircleLoop(rad, 96, col, op);
    ring.position.y = 0.02;
    floorGrp.add(ring);
  }

  // Diagonal axis laser ticks
  const axisPts: THREE.Vector3[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    axisPts.push(new THREE.Vector3(Math.cos(a) * 2.4, 0.02, Math.sin(a) * 2.4));
    axisPts.push(new THREE.Vector3(Math.cos(a) * 14.5, 0.02, Math.sin(a) * 14.5));
  }
  const axisGeo = new THREE.BufferGeometry().setFromPoints(axisPts);
  floorGrp.add(
    new THREE.LineSegments(
      axisGeo,
      new THREE.LineBasicMaterial({ color: 0x0ea5e9, transparent: true, opacity: 0.16 })
    )
  );

  return floorGrp;
}

export function ThreeShieldCanvas({
  route,
  scrollProgressRef,
  activeThreatPulse,
  auditBroken = false,
  soundMuted,
  onToggleSound,
}: ThreeShieldCanvasProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [preset, setPreset] = useState<CameraPreset>('scroll');
  const [autoOrbit, setAutoOrbit] = useState(true);
  const [dockCollapsed, setDockCollapsed] = useState(false);

  const routeRef = useRef<AppRoute>(route);
  const presetRef = useRef<CameraPreset>('scroll');
  const autoOrbitRef = useRef(true);
  const pulseRef = useRef<'allow' | 'ask' | 'block' | null>(null);
  const auditBrokenRef = useRef(auditBroken);

  useEffect(() => {
    routeRef.current = route;
  }, [route]);

  useEffect(() => {
    presetRef.current = preset;
  }, [preset]);

  useEffect(() => {
    autoOrbitRef.current = autoOrbit;
  }, [autoOrbit]);

  useEffect(() => {
    pulseRef.current = activeThreatPulse ?? null;
  }, [activeThreatPulse]);

  useEffect(() => {
    auditBrokenRef.current = auditBroken;
  }, [auditBroken]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (
        e.key.toLowerCase() === 'h' &&
        document.activeElement?.tagName !== 'INPUT' &&
        document.activeElement?.tagName !== 'TEXTAREA'
      ) {
        setDockCollapsed((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const isSoftwareGl = (() => {
      try {
        const probe = document.createElement('canvas').getContext('webgl2');
        if (!probe) return true;
        const ext = probe.getExtension('WEBGL_debug_renderer_info');
        const param = ext ? ext.UNMASKED_RENDERER_WEBGL : probe.RENDERER;
        const gpu = String(probe.getParameter(param));
        probe.getExtension('WEBGL_lose_context')?.loseContext();
        return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
      } catch {
        return true;
      }
    })();

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: !isSoftwareGl,
        powerPreference: 'high-performance',
        alpha: false,
      });
    } catch {
      return;
    }

    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.25;
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);

    container.innerHTML = '';
    container.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';

    // Pure pitch-black 3D canvas
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    scene.fog = new THREE.FogExp2(0x000000, 0.028);

    const camera = new THREE.PerspectiveCamera(
      45,
      (container.clientWidth || window.innerWidth) / (container.clientHeight || window.innerHeight),
      0.1,
      160
    );
    camera.position.set(0, 3.8, 12.2);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !isSoftwareGl;
    controls.dampingFactor = 0.06;
    controls.enableZoom = false;
    controls.enablePan = false;
    controls.minPolarAngle = 0.35;
    controls.maxPolarAngle = Math.PI / 2 - 0.05;
    controls.target.set(0, 1.85, 0);

    let userDragging = false;
    controls.addEventListener('start', () => {
      userDragging = true;
    });
    controls.addEventListener('end', () => {
      userDragging = false;
    });

    // Pure black radial vector floor
    const floorLines = createRadialFloorLines();
    scene.add(floorLines);

    // Expanding vector pulse ring on ground
    const pulseRing = makeCircleLoop(1.8, 96, 0xf97316, 0.5);
    pulseRing.position.y = 0.04;
    scene.add(pulseRing);

    // Ambient floating vertical data-lines across pure black space (3D line field)
    const verticalStreamCount = 46;
    const streamPositions = new Float32Array(verticalStreamCount * 6);
    const streamMeta = Array.from({ length: verticalStreamCount }, (_, i) => {
      const ang = (i / verticalStreamCount) * Math.PI * 2 + (i % 3) * 0.4;
      const rad = 5.5 + (i % 7) * 1.9;
      return {
        x: Math.cos(ang) * rad,
        z: Math.sin(ang) * rad,
        speed: 0.9 + (i % 5) * 0.35,
        len: 0.7 + (i % 4) * 0.45,
        offset: (i * 1.37) % 8,
      };
    });
    const streamGeo = new THREE.BufferGeometry();
    streamGeo.setAttribute('position', new THREE.BufferAttribute(streamPositions, 3));
    const streamLines = new THREE.LineSegments(
      streamGeo,
      new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.28 })
    );
    scene.add(streamLines);

    // =========================================================================
    // SCENE A: OVERVIEW & ATTACK-LAB (3D Vector Gateway Lines & Exploded Hex)
    // =========================================================================
    const gatewayWorldGroup = new THREE.Group();
    scene.add(gatewayWorldGroup);

    // Shield Base Pedestal (vector wireframe rings + vertical ribs)
    const shieldBaseRing1 = makeCircleLoop(1.65, 48, 0x38bdf8, 0.55);
    shieldBaseRing1.position.y = 0.06;
    const shieldBaseRing2 = makeCircleLoop(1.25, 48, 0xf97316, 0.45);
    shieldBaseRing2.position.y = 0.32;
    gatewayWorldGroup.add(shieldBaseRing1, shieldBaseRing2);

    const shieldHoverGroup = new THREE.Group();
    shieldHoverGroup.position.set(0, 2.15, 0);
    gatewayWorldGroup.add(shieldHoverGroup);

    // Outer hex chassis (line frame)
    const outerHexLoop = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(makeHexPoints(1.72)),
      new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.85 })
    );
    const innerHexLoop = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(makeHexPoints(1.42)),
      new THREE.LineBasicMaterial({ color: 0xf97316, transparent: true, opacity: 0.75 })
    );
    shieldHoverGroup.add(outerHexLoop, innerHexLoop);

    // 2 rotating 3D vector collars
    const collarRing = makeCircleLoop(2.05, 72, 0xf97316, 0.75);
    collarRing.rotation.x = Math.PI / 2.6;
    shieldHoverGroup.add(collarRing);

    const secondaryRing = makeCircleLoop(2.3, 72, 0x38bdf8, 0.45);
    secondaryRing.rotation.z = Math.PI / 3;
    shieldHoverGroup.add(secondaryRing);

    // 5 Exploding Stage Plates rendered as crisp glowing 3D Hex Line-Frames + thin translucent core
    const stageColors = [0x38bdf8, 0x60a5fa, 0xf97316, 0xfbbf24, 0x10b981];
    const stagePlates: THREE.Group[] = [];
    for (let i = 0; i < 5; i++) {
      const grp = new THREE.Group();
      const s = 1 - i * 0.06;
      const hexPts = makeHexPoints(1.22 * s, 0);
      const hexLine = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(hexPts),
        new THREE.LineBasicMaterial({ color: stageColors[i], transparent: true, opacity: 0.95 })
      );
      // Inner spoke lines to crystal core
      const spokePts: THREE.Vector3[] = [];
      for (let k = 0; k < 6; k++) {
        spokePts.push(hexPts[k], new THREE.Vector3(hexPts[k].x * 0.45, hexPts[k].y * 0.45, 0));
      }
      const spokes = new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(spokePts),
        new THREE.LineBasicMaterial({ color: stageColors[i], transparent: true, opacity: 0.45 })
      );
      grp.add(hexLine, spokes);
      grp.position.z = (i - 2) * 0.16;
      shieldHoverGroup.add(grp);
      stagePlates.push(grp);
    }

    // Z-axis laser guide rails connecting the 5 exploded plates
    const railPts: THREE.Vector3[] = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
      railPts.push(new THREE.Vector3(Math.cos(a) * 1.15, Math.sin(a) * 1.15, -1.7));
      railPts.push(new THREE.Vector3(Math.cos(a) * 1.15, Math.sin(a) * 1.15, 1.7));
    }
    const zRails = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(railPts),
      new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.25 })
    );
    shieldHoverGroup.add(zRails);

    // Wireframe Octahedron Core
    const crystalWire = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.OctahedronGeometry(0.48, 0)),
      new THREE.LineBasicMaterial({ color: 0x38bdf8 })
    );
    const crystalInner = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.38, 0),
      new THREE.MeshBasicMaterial({ color: 0x0ea5e9, wireframe: true, transparent: true, opacity: 0.55 })
    );
    shieldHoverGroup.add(crystalWire, crystalInner);

    // AI Agent Node (Left) — 3D Wireframe Brain + Gyro Lines
    const agentGroup = new THREE.Group();
    agentGroup.position.set(-4.7, 0, 0.4);
    gatewayWorldGroup.add(agentGroup);

    const agentFoot = makeCircleLoop(0.95, 32, 0x38bdf8, 0.55);
    agentFoot.position.y = 0.05;
    agentGroup.add(agentFoot);

    const agentColEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.CylinderGeometry(0.24, 0.48, 1.45, 8)),
      new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.45 })
    );
    agentColEdges.position.y = 0.78;
    agentGroup.add(agentColEdges);

    const agentBrain = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(0.62, 1)),
      new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.92 })
    );
    agentBrain.position.y = 2.05;
    agentGroup.add(agentBrain);

    const agentGyro1 = makeCircleLoop(0.92, 48, 0xf97316, 0.72);
    agentGyro1.position.y = 2.05;
    agentGroup.add(agentGyro1);

    const agentGyro2 = makeCircleLoop(0.78, 48, 0x10b981, 0.55);
    agentGyro2.position.y = 2.05;
    agentGyro2.rotation.x = Math.PI / 2;
    agentGroup.add(agentGyro2);

    // Bank Vault Node (Right) — 3D Wireframe Drum & Laser Lock
    const bankGroup = new THREE.Group();
    bankGroup.position.set(4.7, 0, -0.3);
    gatewayWorldGroup.add(bankGroup);

    const bankBox = makeWireEdgeBox(2.0, 2.3, 2.0, 0x10b981, 0x022c22, 0.16);
    bankBox.position.y = 1.2;
    bankGroup.add(bankBox);

    const vaultWheel = makeCircleLoop(0.55, 32, 0x10b981, 0.9);
    vaultWheel.position.set(0, 1.35, 1.04);
    vaultWheel.rotation.x = Math.PI / 2;
    bankGroup.add(vaultWheel);

    const vaultBeacon = makeCircleLoop(1.15, 48, 0x10b981, 0.65);
    vaultBeacon.position.y = 2.48;
    bankGroup.add(vaultBeacon);

    // Conduit Curves (Line trails connecting Agent -> Shield -> Bank)
    const leftCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-4.7, 2.05, 0.4),
      new THREE.Vector3(-2.4, 2.55, 0.25),
      new THREE.Vector3(0, 2.15, 0),
    ]);
    const rightCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 2.15, 0),
      new THREE.Vector3(2.35, 2.35, -0.15),
      new THREE.Vector3(4.7, 1.65, -0.3),
    ]);

    gatewayWorldGroup.add(
      new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(leftCurve.getPoints(48)),
        new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.72 })
      ),
      new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(rightCurve.getPoints(48)),
        new THREE.LineBasicMaterial({ color: 0x34d399, transparent: true, opacity: 0.72 })
      )
    );

    // Animated 3D Laser-Line Packet Streaks (28 flying vector segments along curves!)
    const streakCount = 28;
    const streakPositions = new Float32Array(streakCount * 6);
    const streakColors = new Float32Array(streakCount * 6);
    const streakGeo = new THREE.BufferGeometry();
    streakGeo.setAttribute('position', new THREE.BufferAttribute(streakPositions, 3));
    streakGeo.setAttribute('color', new THREE.BufferAttribute(streakColors, 3));
    const streakLines = new THREE.LineSegments(
      streakGeo,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.98 })
    );
    streakLines.frustumCulled = false;
    gatewayWorldGroup.add(streakLines);

    const streakMeta = Array.from({ length: streakCount }, (_, idx) => ({
      offset: idx / streakCount,
      speed: 0.22 + (idx % 5) * 0.035,
      isThreat: idx % 3 === 0,
    }));

    // =========================================================================
    // SCENE B: CUSTOMER VAULT & MANDATE VECTOR RINGS (Customer App)
    // =========================================================================
    const customerWorldGroup = new THREE.Group();
    customerWorldGroup.visible = false;
    scene.add(customerWorldGroup);

    const custVaultOuter = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.DodecahedronGeometry(1.1, 0)),
      new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.9 })
    );
    custVaultOuter.position.y = 2.15;
    customerWorldGroup.add(custVaultOuter);

    const custInnerCore = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.OctahedronGeometry(0.62, 0)),
      new THREE.LineBasicMaterial({ color: 0x10b981 })
    );
    custInnerCore.position.y = 2.15;
    customerWorldGroup.add(custInnerCore);

    const mandateRings: THREE.LineLoop[] = [];
    for (let i = 0; i < 3; i++) {
      const ring = makeCircleLoop(
        1.65 + i * 0.42,
        64,
        i === 0 ? 0xf97316 : i === 1 ? 0x38bdf8 : 0x10b981,
        0.78
      );
      ring.position.y = 2.15;
      ring.rotation.x = (i + 1) * 0.45;
      customerWorldGroup.add(ring);
      mandateRings.push(ring);
    }

    const custSatellites: THREE.Group[] = [];
    const tetherPositions = new Float32Array(3 * 6);
    const tetherGeo = new THREE.BufferGeometry();
    tetherGeo.setAttribute('position', new THREE.BufferAttribute(tetherPositions, 3));
    const tetherLines = new THREE.LineSegments(
      tetherGeo,
      new THREE.LineBasicMaterial({ color: 0xf97316, transparent: true, opacity: 0.58 })
    );
    customerWorldGroup.add(tetherLines);

    for (let i = 0; i < 3; i++) {
      const sat = new THREE.Group();
      const satWire = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.OctahedronGeometry(0.32, 0)),
        new THREE.LineBasicMaterial({ color: i === 2 ? 0xf97316 : 0x10b981 })
      );
      sat.add(satWire);
      customerWorldGroup.add(sat);
      custSatellites.push(sat);
    }

    // =========================================================================
    // SCENE C: BANK CONSOLE 3D RADAR & VECTOR RISK TOWERS
    // =========================================================================
    const consoleWorldGroup = new THREE.Group();
    consoleWorldGroup.visible = false;
    scene.add(consoleWorldGroup);

    for (const [r, c] of [
      [1.2, 0x10b981],
      [2.2, 0x38bdf8],
      [3.3, 0xf97316],
    ] as const) {
      const rl = makeCircleLoop(r, 72, c, 0.5);
      rl.position.y = 0.08;
      consoleWorldGroup.add(rl);
    }

    const radarSweepPts = [new THREE.Vector3(0, 0.14, 0), new THREE.Vector3(3.3, 0.14, 0)];
    const radarSweepLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(radarSweepPts),
      new THREE.LineBasicMaterial({ color: 0xf97316 })
    );
    const radarPivot = new THREE.Group();
    radarPivot.add(radarSweepLine);
    consoleWorldGroup.add(radarPivot);

    const riskTowers: THREE.Group[] = [];
    const towerCount = 14;
    for (let i = 0; i < towerCount; i++) {
      const ang = (i / towerCount) * Math.PI * 2;
      const rad = 2.45;
      const h = 1.0 + ((i * 5) % 4) * 0.45;
      const tower = makeWireEdgeBox(
        0.34,
        h,
        0.34,
        i % 4 === 0 ? 0xf97316 : i % 3 === 0 ? 0x10b981 : 0x38bdf8,
        0x000000,
        0.25
      );
      tower.position.set(Math.cos(ang) * rad, h / 2 + 0.1, Math.sin(ang) * rad);
      tower.lookAt(0, tower.position.y, 0);
      consoleWorldGroup.add(tower);
      riskTowers.push(tower);
    }

    const consoleDome = makeCircleLoop(1.25, 48, 0x38bdf8, 0.72);
    consoleDome.position.y = 1.85;
    consoleWorldGroup.add(consoleDome);

    // =========================================================================
    // SCENE D: AUDIT CHAIN 3D WIREFRAME CRYPTOGRAPHIC BLOCKS
    // =========================================================================
    const auditWorldGroup = new THREE.Group();
    auditWorldGroup.visible = false;
    scene.add(auditWorldGroup);

    const auditBlocks: THREE.Group[] = [];
    const blockCount = 7;
    const auditLinkLines: THREE.Line[] = [];

    for (let i = 0; i < blockCount; i++) {
      const grp = new THREE.Group();
      const x = (i - 3) * 1.75;
      grp.position.set(x, 1.55, Math.sin(i * 0.6) * 0.45);

      const cube = makeWireEdgeBox(0.95, 1.15, 0.95, 0x38bdf8, 0x020617, 0.3);
      const innerSeal = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.OctahedronGeometry(0.32, 0)),
        new THREE.LineBasicMaterial({ color: 0x10b981 })
      );
      const collar = makeCircleLoop(0.68, 32, 0x10b981, 0.75);
      collar.position.y = 0.65;
      grp.add(cube, innerSeal, collar);

      if (i < blockCount - 1) {
        const linkGeo = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(0.48, 0, 0),
          new THREE.Vector3(1.28, 0, Math.sin((i + 1) * 0.6) * 0.45 - grp.position.z),
        ]);
        const linkLine = new THREE.Line(linkGeo, new THREE.LineBasicMaterial({ color: 0x10b981 }));
        grp.add(linkLine);
        auditLinkLines.push(linkLine);
      }

      auditWorldGroup.add(grp);
      auditBlocks.push(grp);
    }

    // =========================================================================
    // SCENE E: SDK & DOCS ARCHITECTURAL VECTOR PRISM
    // =========================================================================
    const docsWorldGroup = new THREE.Group();
    docsWorldGroup.visible = false;
    scene.add(docsWorldGroup);

    const prismOuter = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.OctahedronGeometry(1.45, 1)),
      new THREE.LineBasicMaterial({ color: 0xf97316, transparent: true, opacity: 0.9 })
    );
    prismOuter.position.y = 2.05;
    docsWorldGroup.add(prismOuter);

    const prismInner = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(0.85, 0)),
      new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.85 })
    );
    prismInner.position.y = 2.05;
    docsWorldGroup.add(prismInner);

    const prismRing1 = makeCircleLoop(1.95, 64, 0x38bdf8, 0.65);
    prismRing1.position.y = 2.05;
    prismRing1.rotation.x = Math.PI / 3;
    const prismRing2 = makeCircleLoop(2.2, 64, 0x10b981, 0.5);
    prismRing2.position.y = 2.05;
    prismRing2.rotation.z = Math.PI / 4;
    docsWorldGroup.add(prismRing1, prismRing2);

    if (!isSoftwareGl) {
      renderer.compile(scene, camera);
    }

    const onResize = () => {
      if (!container) return;
      const w = container.clientWidth || window.innerWidth;
      const h = container.clientHeight || window.innerHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', onResize);

    const clock = new THREE.Clock();
    let frameId = 0;
    let disposed = false;
    let currentExplode = 0;
    let currentCamX = 0;
    let currentCamY = 3.8;
    let currentCamZ = 12.2;
    let currentTargetX = 0;
    let currentTargetY = 1.85;

    function afterDraw(cb: () => void) {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      const sync = gl.fenceSync ? gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0) : null;
      if (!sync) {
        frameId = window.setTimeout(cb, 80);
        return;
      }
      gl.flush();
      const poll = () => {
        if (disposed) return;
        const state = gl.getSyncParameter(sync, gl.SYNC_STATUS);
        if (state === gl.UNSIGNALED) {
          frameId = window.setTimeout(poll, 5);
        } else {
          gl.deleteSync(sync);
          frameId = window.setTimeout(cb, 80);
        }
      };
      frameId = window.setTimeout(poll, 5);
    }

    function tick() {
      if (disposed) return;
      const dt = Math.min(clock.getDelta(), 0.05);
      const t = clock.getElapsedTime();
      const scrollP = scrollProgressRef.current;
      const mode = presetRef.current;
      const activeRoute = routeRef.current;

      gatewayWorldGroup.visible = activeRoute === 'landing' || activeRoute === 'attack-lab';
      customerWorldGroup.visible = activeRoute === 'customer';
      consoleWorldGroup.visible = activeRoute === 'console';
      auditWorldGroup.visible = activeRoute === 'audit';
      docsWorldGroup.visible = activeRoute === 'docs';
      if (container) {
        container.style.opacity =
          activeRoute === 'landing' ? String(Math.min(1, Math.max(0, (scrollP - 0.04) / 0.14))) : '1';
      }

      // Animate expanding vector ground pulse ring
      const pulsePhase = (t * 0.45) % 1;
      pulseRing.scale.setScalar(0.6 + pulsePhase * 4.5);
      const pulseMat = pulseRing.material as THREE.LineBasicMaterial;
      pulseMat.opacity = (1 - pulsePhase) * 0.42;
      pulseMat.color.setHex(
        pulseRef.current === 'block' || auditBrokenRef.current
          ? 0xf43f5e
          : pulseRef.current === 'allow'
          ? 0x10b981
          : 0xf97316
      );

      // Animate rising vertical 3D data lines across black background
      const sPos = streamGeo.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < verticalStreamCount; i++) {
        const m = streamMeta[i];
        const yBase = ((t * m.speed + m.offset) % 8.5) - 0.5;
        sPos.setXYZ(i * 2, m.x, yBase, m.z);
        sPos.setXYZ(i * 2 + 1, m.x, yBase + m.len, m.z);
      }
      sPos.needsUpdate = true;

      // Camera target + explode
      let desiredExplode = 0.14;
      let desiredCamX = 0;
      let desiredCamY = 3.8;
      let desiredCamZ = 12.2;
      let desiredTargetX = 0;
      let desiredTargetY = 1.85;

      if (mode === 'explode') {
        desiredExplode = 1.0;
        desiredCamX = 3.4;
        desiredCamY = 2.6;
        desiredCamZ = 6.8;
      } else if (mode === 'intercept') {
        desiredExplode = 0.25;
        desiredCamX = -3.6;
        desiredCamY = 2.8;
        desiredCamZ = 8.4;
        desiredTargetX = -1.6;
      } else if (mode === 'overview') {
        desiredExplode = 0.12;
        desiredCamX = 0;
        desiredCamY = 4.2;
        desiredCamZ = 12.5;
      } else {
        if (activeRoute === 'landing') {
          if (scrollP < 0.25) {
            const k = scrollP / 0.25;
            desiredCamX = THREE.MathUtils.lerp(0.6, -2.8, k);
            desiredCamY = THREE.MathUtils.lerp(3.8, 3.0, k);
            desiredCamZ = THREE.MathUtils.lerp(12.2, 9.6, k);
            desiredTargetX = THREE.MathUtils.lerp(0, -1.2, k);
            desiredExplode = THREE.MathUtils.lerp(0.08, 0.3, k);
          } else if (scrollP < 0.62) {
            const k = (scrollP - 0.25) / 0.37;
            desiredCamX = THREE.MathUtils.lerp(-2.8, 3.6, k);
            desiredCamY = THREE.MathUtils.lerp(3.0, 2.7, k);
            desiredCamZ = THREE.MathUtils.lerp(9.6, 7.2, k);
            desiredTargetX = THREE.MathUtils.lerp(-1.2, 0.0, k);
            desiredTargetY = THREE.MathUtils.lerp(1.85, 2.15, k);
            desiredExplode = THREE.MathUtils.lerp(0.3, 1.0, k);
          } else {
            const k = (scrollP - 0.62) / 0.38;
            desiredCamX = THREE.MathUtils.lerp(3.6, 2.2, k);
            desiredCamY = THREE.MathUtils.lerp(2.7, 4.4, k);
            desiredCamZ = THREE.MathUtils.lerp(7.2, 11.4, k);
            desiredTargetX = THREE.MathUtils.lerp(0.0, 1.4, k);
            desiredExplode = THREE.MathUtils.lerp(1.0, 0.35, k);
          }
        } else if (activeRoute === 'attack-lab') {
          desiredCamX = THREE.MathUtils.lerp(-2.6, 1.8, scrollP);
          desiredCamY = THREE.MathUtils.lerp(3.1, 4.2, scrollP);
          desiredCamZ = THREE.MathUtils.lerp(9.5, 11.2, scrollP);
          desiredTargetX = THREE.MathUtils.lerp(-1.4, 0.2, scrollP);
          desiredExplode = 0.35 + scrollP * 0.6;
        } else if (activeRoute === 'customer') {
          desiredCamX = Math.sin(scrollP * Math.PI) * 3.2;
          desiredCamY = THREE.MathUtils.lerp(2.9, 4.6, scrollP);
          desiredCamZ = THREE.MathUtils.lerp(8.2, 9.8, scrollP);
          desiredTargetY = 2.05;
        } else if (activeRoute === 'console') {
          desiredCamX = THREE.MathUtils.lerp(-2.5, 2.8, scrollP);
          desiredCamY = THREE.MathUtils.lerp(4.8, 3.2, scrollP);
          desiredCamZ = THREE.MathUtils.lerp(9.6, 8.2, scrollP);
          desiredTargetY = 1.25;
        } else if (activeRoute === 'audit') {
          desiredCamX = THREE.MathUtils.lerp(-3.8, 3.8, scrollP);
          desiredCamY = 3.1;
          desiredCamZ = 8.8;
          desiredTargetX = THREE.MathUtils.lerp(-2.5, 2.5, scrollP);
          desiredTargetY = 1.55;
        } else if (activeRoute === 'docs') {
          desiredCamX = THREE.MathUtils.lerp(-2.2, 2.4, scrollP);
          desiredCamY = THREE.MathUtils.lerp(2.8, 4.1, scrollP);
          desiredCamZ = 7.8;
          desiredTargetY = 2.05;
        }
      }

      const lambda = 4.2;
      currentExplode = THREE.MathUtils.damp(currentExplode, desiredExplode, lambda, dt);
      currentCamX = THREE.MathUtils.damp(currentCamX, desiredCamX, lambda, dt);
      currentCamY = THREE.MathUtils.damp(currentCamY, desiredCamY, lambda, dt);
      currentCamZ = THREE.MathUtils.damp(currentCamZ, desiredCamZ, lambda, dt);
      currentTargetX = THREE.MathUtils.damp(currentTargetX, desiredTargetX, lambda, dt);
      currentTargetY = THREE.MathUtils.damp(currentTargetY, desiredTargetY, lambda, dt);

      if (!userDragging) {
        const orbitOffset = autoOrbitRef.current ? Math.sin(t * 0.25) * 0.75 : 0;
        camera.position.set(currentCamX + orbitOffset, currentCamY, currentCamZ);
        controls.target.set(currentTargetX, currentTargetY, 0);
      }
      controls.update();

      const activePulse = pulseRef.current;

      // Animate Scene A (3D Vector Gateway + Flying Line Streaks)
      if (gatewayWorldGroup.visible) {
        shieldHoverGroup.position.y = 2.15 + Math.sin(t * 1.4) * 0.08;
        collarRing.rotation.z = t * 0.42;
        secondaryRing.rotation.y = t * 0.3;
        crystalWire.rotation.y = t * 0.9;
        crystalInner.rotation.y = -t * 0.65;
        outerHexLoop.rotation.z = Math.sin(t * 0.3) * 0.1;

        const spread = 0.16 + currentExplode * 0.58;
        for (let i = 0; i < 5; i++) {
          stagePlates[i].position.z = (i - 2) * spread;
          stagePlates[i].rotation.z = Math.sin(t * 0.55 + i * 0.45) * 0.08;
        }

        agentBrain.rotation.y = t * 0.55;
        agentBrain.rotation.x = Math.sin(t * 0.4) * 0.2;
        agentGyro1.rotation.z = t * 0.85;
        agentGyro1.rotation.x = Math.sin(t * 0.45) * 0.4;
        agentGyro2.rotation.y = -t * 0.95;
        vaultWheel.rotation.z = Math.sin(t * 0.35) * 0.45;

        // Update animated 3D flying laser-line streaks along curves
        const posAttr = streakGeo.attributes.position as THREE.BufferAttribute;
        const colAttr = streakGeo.attributes.color as THREE.BufferAttribute;

        for (let i = 0; i < streakCount; i++) {
          const meta = streakMeta[i];
          const u1 = (meta.offset + t * meta.speed) % 1;
          const u0 = Math.max(0, u1 - 0.045);
          const threatFlag = activePulse === 'block' ? true : activePulse === 'allow' ? false : meta.isThreat;

          const samplePoint = (uVal: number, out: THREE.Vector3) => {
            if (threatFlag) {
              const clamped = Math.min(uVal, 0.78);
              leftCurve.getPointAt(clamped, out);
              if (uVal > 0.78) {
                const d = (uVal - 0.78) / 0.22;
                out.y += d * 2.4;
                out.x -= d * 1.25;
              }
            } else {
              if (uVal < 0.5) leftCurve.getPointAt(uVal * 2, out);
              else rightCurve.getPointAt((uVal - 0.5) * 2, out);
            }
          };

          samplePoint(u0, _vec3A);
          samplePoint(u1, _vec3B);

          posAttr.setXYZ(i * 2, _vec3A.x, _vec3A.y, _vec3A.z);
          posAttr.setXYZ(i * 2 + 1, _vec3B.x, _vec3B.y, _vec3B.z);

          _color.setHex(threatFlag ? 0xf97316 : 0x10b981);
          colAttr.setXYZ(i * 2, _color.r * 0.35, _color.g * 0.35, _color.b * 0.35);
          colAttr.setXYZ(i * 2 + 1, _color.r, _color.g, _color.b);
        }
        posAttr.needsUpdate = true;
        colAttr.needsUpdate = true;
      }

      // Animate Scene B (Customer Mandate Line Rings + Tethered Agents)
      if (customerWorldGroup.visible) {
        custVaultOuter.rotation.y = t * 0.45 + scrollP * 2.2;
        custInnerCore.rotation.y = -t * 0.85;
        mandateRings.forEach((ring, idx) => {
          ring.rotation.y = t * (0.4 + idx * 0.15) * (idx % 2 === 0 ? 1 : -1);
          ring.rotation.z = Math.sin(t * 0.5 + idx) * 0.35 + scrollP * 0.65;
        });

        const tPos = tetherGeo.attributes.position as THREE.BufferAttribute;
        custSatellites.forEach((sat, idx) => {
          const ang = t * 0.6 + (idx * Math.PI * 2) / 3 + scrollP * 2.5;
          const sx = Math.cos(ang) * 3.0;
          const sy = 1.85 + Math.sin(t * 1.4 + idx) * 0.28;
          const sz = Math.sin(ang) * 3.0;
          sat.position.set(sx, sy, sz);
          sat.rotation.y = -ang;
          tPos.setXYZ(idx * 2, 0, 2.15, 0);
          tPos.setXYZ(idx * 2 + 1, sx, sy, sz);
        });
        tPos.needsUpdate = true;
      }

      // Animate Scene C (Bank Console 3D Radar & Vector Towers)
      if (consoleWorldGroup.visible) {
        radarPivot.rotation.y = -t * 1.4;
        consoleDome.rotation.y = t * 0.45;
        consoleDome.rotation.x = Math.sin(t * 0.5) * 0.28 + scrollP * 0.45;
        riskTowers.forEach((tower, idx) => {
          const pulseScale = 0.8 + Math.sin(t * 2.2 + idx * 0.6 + scrollP * 4.0) * 0.28;
          tower.scale.y = activePulse === 'block' && idx % 3 === 0 ? 1.65 : pulseScale;
        });
      }

      // Animate Scene D (Audit Chain 3D Vector Ledger)
      if (auditWorldGroup.visible) {
        const broken = auditBrokenRef.current;
        auditBlocks.forEach((grp, idx) => {
          const isTampered = broken && idx === 3;
          grp.position.y = 1.55 + Math.sin(t * 1.3 + idx * 0.7) * 0.08 + (isTampered ? 0.65 : 0);
          grp.rotation.z = isTampered ? Math.sin(t * 6) * 0.16 : scrollP * 0.22;

          const innerSeal = grp.children[1] as THREE.LineSegments;
          const sealMat = innerSeal.material as THREE.LineBasicMaterial;
          sealMat.color.setHex(isTampered ? 0xf43f5e : 0x10b981);

          const collar = grp.children[2] as THREE.LineLoop;
          const collarMat = collar.material as THREE.LineBasicMaterial;
          collarMat.color.setHex(isTampered ? 0xf43f5e : 0x10b981);
        });

        auditLinkLines.forEach((line, idx) => {
          const mat = line.material as THREE.LineBasicMaterial;
          const severed = broken && (idx === 2 || idx === 3);
          mat.color.setHex(severed ? 0xf43f5e : 0x10b981);
          mat.opacity = severed ? 0.35 + Math.abs(Math.sin(t * 8)) * 0.5 : 0.9;
        });
      }

      // Animate Scene E (SDK Architectural Prism)
      if (docsWorldGroup.visible) {
        prismOuter.rotation.y = t * 0.45 + scrollP * 2.8;
        prismInner.rotation.y = -t * 0.6 + scrollP * 1.5;
        prismRing1.rotation.z = t * 0.45;
        prismRing2.rotation.x = t * 0.35;
      }

      renderer.render(scene, camera);

      if (isSoftwareGl) {
        afterDraw(tick);
      } else {
        frameId = requestAnimationFrame(tick);
      }
    }

    tick();

    return () => {
      disposed = true;
      cancelAnimationFrame(frameId);
      clearTimeout(frameId);
      window.removeEventListener('resize', onResize);
      controls.dispose();
      renderer.dispose();
    };
  }, [scrollProgressRef]);

  return (
    <>
      <div ref={mountRef} className="fixed inset-0 z-0 pointer-events-auto bg-black no-print" />

      {/* Collapsible Bottom 3D Control Dock */}
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-30 flex flex-col items-center pointer-events-auto no-print">
        <button
          type="button"
          onClick={() => setDockCollapsed((c) => !c)}
          className="px-3.5 py-1 text-xs font-medium text-slate-200 bg-black/90 border border-white/15 border-b-0 rounded-t-lg flex items-center gap-1.5 hover:text-white transition-colors whitespace-nowrap shrink-0"
        >
          {dockCollapsed ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          <span>{dockCollapsed ? '3D Controls (H)' : 'Hide 3D Controls (H)'}</span>
        </button>

        {!dockCollapsed && (
          <div
            style={{ backgroundColor: 'rgba(4, 6, 10, 0.92)' }}
            className="flex flex-wrap items-center justify-center gap-1.5 px-3 py-2 rounded-xl border border-white/15 shadow-2xl"
          >
            <button
              type="button"
              onClick={() => setPreset('scroll')}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 ${
                preset === 'scroll' ? 'bg-orange-500 text-white' : 'text-slate-300 hover:bg-white/10'
              }`}
            >
              <Shield className="w-3.5 h-3.5" />
              Scroll Sync
            </button>
            <button
              type="button"
              onClick={() => setPreset('explode')}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 ${
                preset === 'explode' ? 'bg-orange-500 text-white' : 'text-slate-300 hover:bg-white/10'
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              5-Layer Explode
            </button>
            <button
              type="button"
              onClick={() => setPreset('intercept')}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 ${
                preset === 'intercept' ? 'bg-orange-500 text-white' : 'text-slate-300 hover:bg-white/10'
              }`}
            >
              <Target className="w-3.5 h-3.5" />
              Threat Focus
            </button>
            <button
              type="button"
              onClick={() => setAutoOrbit((o) => !o)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 ${
                autoOrbit ? 'bg-white/10 text-sky-400 border border-sky-500/40' : 'text-slate-400 hover:bg-white/10'
              }`}
            >
              <Orbit className="w-3.5 h-3.5" />
              {autoOrbit ? 'Orbit On' : 'Orbit Off'}
            </button>
            <button
              type="button"
              onClick={onToggleSound}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 ${
                !soundMuted ? 'bg-white/10 text-emerald-400 border border-emerald-500/40' : 'text-slate-400 hover:bg-white/10'
              }`}
            >
              {soundMuted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
              {soundMuted ? 'Sound Muted' : 'Audio Alerts On'}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
