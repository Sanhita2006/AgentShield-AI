import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';

const VERTEX_SHADER = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const FRAGMENT_SHADER = `
  precision highp float;

  varying vec2 vUv;

  uniform float uTime;
  uniform vec2 uResolution;
  uniform vec2 uPointer;
  uniform float uHover;

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  vec2 hash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
  }

  float noise2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x),
      mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x),
      f.y
    );
  }

  float fbm2(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 3; i++) {
      v += a * noise2(p);
      p = p * 2.05 + vec2(11.3, 27.1);
      a *= 0.5;
    }
    return v;
  }

  mat2 rot2(float a) {
    float c = cos(a);
    float s = sin(a);
    return mat2(c, -s, s, c);
  }

  float smin(float a, float b, float k) {
    float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
    return mix(b, a, h) - k * h * (1.0 - h);
  }

  float smax(float a, float b, float k) {
    return -smin(-a, -b, k);
  }

  float sdSphere(vec3 p, float r) {
    return length(p) - r;
  }

  float sdEllipsoid(vec3 p, vec3 r) {
    float k0 = length(p / r);
    float k1 = length(p / (r * r));
    return k0 * (k0 - 1.0) / max(k1, 0.0001);
  }

  float sdCapsule(vec3 p, vec3 a, vec3 b, float r) {
    vec3 pa = p - a;
    vec3 ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 0.0001), 0.0, 1.0);
    return length(pa - ba * h) - r;
  }

  // Sculpted classical 3D bust head & neck SDF
  float mapBust(vec3 pos) {
    // Gentle 3/4 upward-right classical pose + subtle breathing motion
    vec3 p = pos;
    p.y -= 0.04;
    p.xz = rot2(-0.38 + sin(uTime * 0.35) * 0.05) * p.xz;
    p.yz = rot2(0.28 + cos(uTime * 0.28) * 0.025) * p.yz;

    // Symmetric coordinate for mirrored facial anatomy
    vec3 q = vec3(abs(p.x), p.y, p.z);

    // 1. Cranium & facial block
    float cranium = sdEllipsoid(p - vec3(0.0, 0.24, -0.05), vec3(0.32, 0.39, 0.37));
    float jaw = sdEllipsoid(p - vec3(0.0, -0.02, 0.09), vec3(0.22, 0.27, 0.26));
    float d = smin(cranium, jaw, 0.14);

    // 2. Sculpted cheekbones & brow ridge
    float cheek = sdEllipsoid(q - vec3(0.15, 0.04, 0.21), vec3(0.11, 0.08, 0.11));
    d = smin(d, cheek, 0.09);

    float brow = sdCapsule(q, vec3(0.0, 0.18, 0.31), vec3(0.17, 0.18, 0.24), 0.048);
    d = smin(d, brow, 0.06);

    // 3. Eye sockets + closed sculpted eyelids
    float socket = sdEllipsoid(q - vec3(0.115, 0.115, 0.295), vec3(0.072, 0.048, 0.07));
    d = smax(d, -socket, 0.045);
    float eyelid = sdEllipsoid(q - vec3(0.115, 0.112, 0.275), vec3(0.052, 0.036, 0.052));
    d = smin(d, eyelid, 0.015);

    // 4. Nose bridge, tip & nostrils
    float noseBridge = sdCapsule(p, vec3(0.0, 0.175, 0.32), vec3(0.0, 0.005, 0.415), 0.032);
    float noseTip = sdSphere(p - vec3(0.0, 0.0, 0.415), 0.038);
    float nostril = sdEllipsoid(q - vec3(0.034, -0.015, 0.365), vec3(0.026, 0.024, 0.032));
    float nose = smin(noseBridge, noseTip, 0.03);
    nose = smin(nose, nostril, 0.025);
    d = smin(d, nose, 0.045);

    // 5. Upper lip, lower lip & chin
    float upperLip = sdCapsule(q, vec3(0.0, -0.095, 0.35), vec3(0.068, -0.105, 0.30), 0.022);
    float lowerLip = sdCapsule(q, vec3(0.0, -0.138, 0.335), vec3(0.058, -0.142, 0.29), 0.024);
    float chin = sdSphere(p - vec3(0.0, -0.225, 0.255), 0.082);
    d = smin(d, upperLip, 0.025);
    d = smin(d, lowerLip, 0.025);
    d = smin(d, chin, 0.06);

    // 6. Ears
    float ear = sdEllipsoid(q - vec3(0.315, 0.05, -0.04), vec3(0.042, 0.105, 0.068));
    d = smin(d, ear, 0.035);

    // 7. Neck & sternocleidomastoid ridges + clean bust base cut
    float neck = sdCapsule(p, vec3(0.0, -0.12, -0.02), vec3(0.0, -0.82, -0.12), 0.205);
    float sterno = sdCapsule(q, vec3(0.14, -0.16, 0.02), vec3(0.05, -0.78, 0.11), 0.062);
    float shoulders = sdEllipsoid(p - vec3(0.0, -0.78, -0.04), vec3(0.42, 0.18, 0.25));
    float neckGroup = smin(neck, sterno, 0.08);
    neckGroup = smin(neckGroup, shoulders, 0.14);
    d = smin(d, neckGroup, 0.1);

    // Clean angled bust base slice
    float baseCut = -(pos.y + 0.68 - pos.z * 0.15);
    d = smax(d, baseCut, 0.03);

    return d;
  }

  vec3 calcNormal(vec3 p) {
    vec2 e = vec2(0.0025, -0.0025);
    return normalize(
      e.xyy * mapBust(p + e.xyy) +
      e.yyx * mapBust(p + e.yyx) +
      e.yxy * mapBust(p + e.yxy) +
      e.xxx * mapBust(p + e.xxx)
    );
  }

  // Thin-film iridescent liquid-chrome color palette
  vec3 iridescence(float phase) {
    vec3 a = vec3(0.55, 0.55, 0.58);
    vec3 b = vec3(0.45, 0.45, 0.45);
    vec3 c = vec3(1.0, 1.0, 1.0);
    vec3 d = vec3(0.0, 0.33, 0.67);
    return a + b * cos(6.28318 * (c * phase + d));
  }

  // Stippled dither lattice returning (dotDistance, cellSeed)
  vec3 stippleCell(vec2 fragCoord, float spacing) {
    vec2 g = fragCoord / spacing;
    vec2 cell = floor(g);
    vec2 local = fract(g);

    float minDist = 10.0;
    float bestSeed = 0.0;

    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 neighbor = vec2(float(i), float(j));
        vec2 cid = cell + neighbor;
        vec2 rnd = hash22(cid);
        vec2 pt = neighbor + 0.18 + 0.64 * rnd;
        float d = length(pt - local);
        if (d < minDist) {
          minDist = d;
          bestSeed = rnd.x;
        }
      }
    }
    return vec3(minDist, bestSeed, 0.0);
  }

  void main() {
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 uv = (vUv - 0.5) * vec2(aspect, 1.0);

    // Raymarch camera aimed at sculpted bust
    vec3 ro = vec3(0.0, -0.04, 2.05);
    vec3 rd = normalize(vec3(uv, -1.55));

    float t = 0.6;
    float hit = -1.0;
    for (int i = 0; i < 64; i++) {
      vec3 p = ro + rd * t;
      float d = mapBust(p);
      if (d < 0.0025) {
        hit = t;
        break;
      }
      if (t > 3.6) break;
      t += d * 0.92;
    }

    vec3 bgCol = vec3(0.022, 0.025, 0.035);

    if (hit < 0.0) {
      gl_FragColor = vec4(bgCol, 1.0);
      return;
    }

    vec3 pos = ro + rd * hit;
    vec3 N = calcNormal(pos);
    vec3 V = -rd;

    // Studio key + rim lighting for dramatic high-contrast monochrome dither & chrome
    vec3 keyDir = normalize(vec3(-0.45, 0.72, 0.65));
    vec3 rimDir = normalize(vec3(0.65, 0.45, -0.45));
    vec3 fillDir = normalize(vec3(0.4, -0.25, 0.7));

    float keyDiff = max(dot(N, keyDir), 0.0);
    float fillDiff = max(dot(N, fillDir), 0.0);
    float ndv = clamp(dot(N, V), 0.0, 1.0);
    float fresnel = pow(1.0 - ndv, 3.0);

    vec3 Hkey = normalize(keyDir + V);
    vec3 Hrim = normalize(rimDir + V);
    float specKey = pow(max(dot(N, Hkey), 0.0), 42.0);
    float specRim = pow(max(dot(N, Hrim), 0.0), 20.0);

    // Luminance for stippled dither halftone
    float lum = keyDiff * 0.68 + fillDiff * 0.2 + fresnel * 0.42 + specKey * 0.85 + specRim * 0.35;
    lum = smoothstep(0.06, 0.98, lum);

    // Iridescent liquid-chrome surface shading
    vec3 refl = reflect(-V, N);
    float filmPhase = refl.y * 0.65 + refl.x * 0.45 + fresnel * 0.9 + uTime * 0.12;
    vec3 irid = iridescence(filmPhase);

    // Metallic dark contrast bands + vivid chrome reflection
    float envBands = smoothstep(-0.3, 0.65, sin(refl.y * 5.2 + refl.x * 3.1));
    vec3 chromeCol = mix(vec3(0.04, 0.05, 0.07), irid * 1.15, 0.35 + 0.65 * envBands);
    chromeCol = mix(chromeCol, vec3(0.96, 0.98, 1.0), clamp(specKey * 1.1 + fresnel * 0.55, 0.0, 1.0));
    chromeCol += irid * specRim * 0.65;

    // Cursor-driven organic Dither Veil mask
    vec2 ptrAspect = (uPointer - 0.5) * vec2(aspect, 1.0);
    float ptrDist = length(uv - ptrAspect);
    float veilNoise = (fbm2(uv * 5.5 + vec2(uTime * 0.35, -uTime * 0.28)) - 0.5) * 0.14;
    float revealMask = smoothstep(0.38, 0.08, ptrDist + veilNoise) * uHover;

    // Stippled dither pattern
    float spacing = max(3.4, uResolution.y / 175.0);
    vec3 stipple = stippleCell(gl_FragCoord.xy, spacing);
    float dotDist = stipple.x;
    float dotSeed = stipple.y;

    // Outside veil: crisp white stippled dots driven by 3D luminance
    float dotRadius = mix(0.02, 0.44, pow(lum, 0.82));
    float dotMask = smoothstep(dotRadius + 0.08, dotRadius - 0.08, dotDist);

    // Suppress tiny stray dots in very deep shadow regions
    dotMask *= step(0.05, lum);

    // Transition edge band: colorful iridescent scattered micro-dots!
    float edgeBand = smoothstep(0.05, 0.35, revealMask) * (1.0 - smoothstep(0.45, 0.82, revealMask));
    float scatterThresh = step(dotSeed, 0.35 + 0.65 * lum);
    vec3 ditherWhite = vec3(0.93, 0.95, 0.98) * dotMask;
    vec3 ditherIrid = iridescence(filmPhase + dotSeed * 0.55) * 1.25 * dotMask * scatterThresh;

    vec3 ditherCol = mix(ditherWhite, ditherIrid, clamp(edgeBand * 1.35, 0.0, 1.0));

    // Blend smoothly between crisp monochrome dither veil and liquid-chrome iridescent bust
    float solidMix = smoothstep(0.42, 0.85, revealMask);
    vec3 finalCol = mix(max(bgCol, ditherCol), chromeCol, solidMix);

    gl_FragColor = vec4(finalCol, 1.0);
  }
`;

export function DitherVeilBackground() {
  const mountRef = useRef<HTMLDivElement | null>(null);

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
        alpha: false,
        powerPreference: 'high-performance',
      });
    } catch {
      return;
    }

    const dpr = isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.setPixelRatio(dpr);

    const initW = window.innerWidth;
    const initH = window.innerHeight;
    renderer.setSize(initW, initH);

    container.innerHTML = '';
    container.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const resolutionVec = new THREE.Vector2(initW * dpr, initH * dpr);
    const pointerVec = new THREE.Vector2(0.5, 0.5);

    const uniforms = {
      uTime: { value: 0 },
      uResolution: { value: resolutionVec },
      uPointer: { value: pointerVec },
      uHover: { value: 0 },
    };

    const geometry = new THREE.PlaneGeometry(2, 2);
    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      depthWrite: false,
      depthTest: false,
    });

    const quad = new THREE.Mesh(geometry, material);
    scene.add(quad);

    if (!isSoftwareGl) {
      renderer.compile(scene, camera);
    }

    const onResize = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      renderer.setSize(w, h);
      resolutionVec.set(w * dpr, h * dpr);
    };
    window.addEventListener('resize', onResize);

    // Track pointer anywhere across viewport; fades smoothly into pure dither veil when idle/away
    let targetPx = 0.5;
    let targetPy = 0.55;
    let currentPx = 0.5;
    let currentPy = 0.55;
    let lastMoveAt = performance.now();
    let pointerActive = true;
    let currentHover = 0.9;

    const handlePointerMove = (e: PointerEvent) => {
      targetPx = e.clientX / Math.max(window.innerWidth, 1);
      targetPy = 1.0 - e.clientY / Math.max(window.innerHeight, 1);
      pointerActive = true;
      lastMoveAt = performance.now();
    };

    const handlePointerLeave = () => {
      pointerActive = false;
    };

    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    document.addEventListener('mouseleave', handlePointerLeave);

    const clock = new THREE.Clock();
    let frameId = 0;
    let disposed = false;

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
      const elapsed = clock.getElapsedTime();

      const idleMs = performance.now() - lastMoveAt;
      const shouldShowVeil = pointerActive && idleMs < 2400;

      currentPx = THREE.MathUtils.damp(currentPx, targetPx, 6.5, dt);
      currentPy = THREE.MathUtils.damp(currentPy, targetPy, 6.5, dt);
      currentHover = THREE.MathUtils.damp(currentHover, shouldShowVeil ? 1.0 : 0.0, shouldShowVeil ? 5.0 : 2.8, dt);

      uniforms.uTime.value = elapsed;
      uniforms.uHover.value = currentHover;
      pointerVec.set(currentPx, currentPy);

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
      window.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('mouseleave', handlePointerLeave);
      geometry.dispose();
      material.dispose();
      renderer.dispose();
    };
  }, []);

  return (
    <div
      ref={mountRef}
      aria-hidden="true"
      className="fixed inset-0 z-0 pointer-events-none bg-[#06070a] no-print"
    />
  );
}

export default DitherVeilBackground;
