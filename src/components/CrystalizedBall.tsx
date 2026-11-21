import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';

export interface CrystalizedBallProps {
  preset?: 'plasma' | 'aurora' | 'ember' | 'ice';
  color?: string;
  size?: number;
  crackle?: number;
  fill?: number;
  interactive?: boolean;
  hoverStrength?: number;
  className?: string;
}

const RIM_VERTEX_SHADER = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const RIM_FRAGMENT_SHADER = `
  precision highp float;

  varying vec2 vUv;

  uniform float uTime;
  uniform vec2 uResolution;
  uniform vec3 uColor;
  uniform vec3 uSecondaryColor;
  uniform float uSize;
  uniform float uCrackle;
  uniform vec2 uPointer;
  uniform float uHover;
  uniform float uHoverStrength;

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  float noise2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash12(i);
    float b = hash12(i + vec2(1.0, 0.0));
    float c = hash12(i + vec2(0.0, 1.0));
    float d = hash12(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  float fbm2(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
      v += a * noise2(p);
      p = p * 2.07 + vec2(13.7, 29.3);
      a *= 0.5;
    }
    return v;
  }

  void main() {
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 p = (vUv - 0.5) * vec2(aspect, 1.0);
    float R = clamp(uSize, 0.25, 1.2) * 0.44;
    float dist = length(p);

    // Direction on circle for seamless periodic lightning/crackle noise
    vec2 dir = p / max(dist, 0.0001);

    // Multi-frequency jagged electric crackle displacement along the rim
    float n1 = fbm2(dir * 3.8 + vec2(uTime * 0.55, -uTime * 0.42)) - 0.5;
    float n2 = noise2(dir * 12.5 - vec2(uTime * 1.4, uTime * 1.1)) - 0.5;
    float n3 = noise2(dir * 26.0 + vec2(uTime * 2.4, -uTime * 1.9)) - 0.5;

    // Electric jitter boosts subtly near the cursor direction
    float ptrDist = length(p - uPointer);
    float ptrBoost = exp(-ptrDist * 4.5) * uHover * uHoverStrength;

    float crackleAmp = (0.005 + 0.015 * uCrackle) * (1.0 + ptrBoost * 0.65);
    float rimOffset = (n1 * 0.65 + n2 * 0.35 + n3 * 0.18) * crackleAmp;
    float d = dist - (R + rimOffset);

    // Secondary delicate branching arc close to the main electric ring
    float arcOffset = (fbm2(dir * 6.5 - vec2(uTime * 0.9, uTime * 0.7)) - 0.5) * crackleAmp * 1.65;
    float dArc = dist - (R + arcOffset);

    // Sharp white-hot plasma ring core + saturated outer/inner corona
    float coreLine = exp(-abs(d) * 340.0);
    float midGlow = exp(-abs(d) * 70.0);
    float outerHalo = exp(-abs(d) * 16.0);
    float secondaryArc = exp(-abs(dArc) * 210.0) * 0.55 * uCrackle;

    // Subtle localized lightning crackle surges around perimeter
    float surge = pow(max(0.0, noise2(dir * 5.0 + vec2(uTime * 1.6, 0.0))), 2.4);
    float ringEnergy = coreLine * 1.45 + midGlow * (0.78 + 0.32 * surge) + outerHalo * 0.32 + secondaryArc;

    // Subtle dark glass sphere rim reflection & very soft lower-bed ambient glow
    float inside = smoothstep(R + 0.004, R - 0.004, dist);
    float ndz = sqrt(max(0.0, 1.0 - clamp((dist * dist) / (R * R), 0.0, 1.0)));
    float fresnel = pow(1.0 - ndz, 3.6) * inside;

    // Soft glass tint inside edge + faint bottom dust bed aura
    float bottomAura = inside * smoothstep(0.15, -R, p.y) * 0.14;
    vec3 rimColor = mix(uColor, uSecondaryColor, 0.18);
    vec3 hotWhite = vec3(1.0, 0.95, 0.99);

    vec3 col = vec3(0.0);
    col += rimColor * (outerHalo * 0.55 + midGlow * 1.05 + secondaryArc * 0.9);
    col += hotWhite * (coreLine * 1.35 + secondaryArc * 0.45);
    col += rimColor * fresnel * 0.28;
    col += rimColor * bottomAura;

    // Cursor energy highlight where pointer sweeps across the glass edge
    col += rimColor * ptrBoost * outerHalo * 0.55;

    float alpha = clamp(ringEnergy * 0.92 + fresnel * 0.25 + bottomAura * 0.85, 0.0, 1.0);
    gl_FragColor = vec4(col, alpha);
  }
`;

const DUST_VERTEX_SHADER = `
  attribute float aSize;
  attribute float aSeed;
  attribute float aSpeed;

  uniform float uResolutionY;
  uniform float uAspect;
  uniform float uDpr;

  varying float vSeed;
  varying float vSpeed;

  void main() {
    vSeed = aSeed;
    vSpeed = aSpeed;

    // Position is stored in aspect-corrected [-0.5*aspect, 0.5*aspect] x [-0.5, 0.5]
    vec2 ndc = vec2(position.x / max(uAspect, 0.001) * 2.0, position.y * 2.0);
    gl_Position = vec4(ndc, 0.0, 1.0);

    float depthScale = 0.85 + 0.35 * (position.z + 0.35);
    float scale = (uResolutionY / 600.0) * uDpr;
    gl_PointSize = clamp(aSize * depthScale * scale * (1.0 + aSpeed * 0.45), 1.0, 14.0);
  }
`;

const DUST_FRAGMENT_SHADER = `
  precision highp float;

  uniform vec3 uColor;
  uniform vec3 uSecondaryColor;
  uniform float uTime;

  varying float vSeed;
  varying float vSpeed;

  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float r2 = dot(c, c);
    if (r2 > 0.25) discard;

    float glow = exp(-r2 * 18.0);
    float core = exp(-r2 * 48.0);

    float twinkle = 0.7 + 0.3 * sin(uTime * 3.5 + vSeed * 40.0);
    vec3 tint = mix(uSecondaryColor, uColor, clamp(0.45 + vSeed * 0.55, 0.0, 1.0));
    vec3 hotTint = mix(tint, vec3(1.0, 0.94, 0.99), clamp(core * 0.8 + vSpeed * 0.35, 0.0, 1.0));

    float alpha = glow * (0.45 + 0.55 * twinkle) + core * 0.45;
    gl_FragColor = vec4(hotTint * alpha, alpha);
  }
`;

const PRESET_SECONDARY: Record<NonNullable<CrystalizedBallProps['preset']>, string> = {
  plasma: '#9D4EDD',
  aurora: '#0EA5E9',
  ember: '#DC2626',
  ice: '#38BDF8',
};

const DUST_COUNT = 4000;

export function CrystalizedBall({
  preset = 'plasma',
  color = '#F25BD0',
  size = 0.7,
  crackle = 0.85,
  fill = 0.5,
  interactive = true,
  hoverStrength = 0.7,
  className = '',
}: CrystalizedBallProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);

  const propsRef = useRef({
    preset,
    color,
    size,
    crackle,
    fill,
    interactive,
    hoverStrength,
  });

  useEffect(() => {
    propsRef.current = {
      preset,
      color,
      size,
      crackle,
      fill,
      interactive,
      hoverStrength,
    };
  }, [preset, color, size, crackle, fill, interactive, hoverStrength]);

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
        alpha: true,
        powerPreference: 'high-performance',
      });
    } catch {
      return;
    }

    const dpr = isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.setPixelRatio(dpr);

    const initW = container.clientWidth || 600;
    const initH = container.clientHeight || 600;
    renderer.setSize(initW, initH);

    container.innerHTML = '';
    container.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const primaryColor = new THREE.Color(propsRef.current.color);
    const secondaryColor = new THREE.Color(PRESET_SECONDARY[propsRef.current.preset] ?? '#9D4EDD');
    const resolutionVec = new THREE.Vector2(initW, initH);
    const pointerVec = new THREE.Vector2(0, 0);

    // 1. Crackling Electric Rim + Glass Shell Quad
    const rimUniforms = {
      uTime: { value: 0 },
      uResolution: { value: resolutionVec },
      uColor: { value: primaryColor },
      uSecondaryColor: { value: secondaryColor },
      uSize: { value: propsRef.current.size },
      uCrackle: { value: propsRef.current.crackle },
      uPointer: { value: pointerVec },
      uHover: { value: 0 },
      uHoverStrength: { value: propsRef.current.hoverStrength },
    };

    const quadGeo = new THREE.PlaneGeometry(2, 2);
    const quadMat = new THREE.ShaderMaterial({
      uniforms: rimUniforms,
      vertexShader: RIM_VERTEX_SHADER,
      fragmentShader: RIM_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      depthTest: false,
    });
    const quadMesh = new THREE.Mesh(quadGeo, quadMat);
    quadMesh.renderOrder = 1;
    scene.add(quadMesh);

    // 2. Swirling Glowing Dust Particles inside the spherical cavity
    const positions = new Float32Array(DUST_COUNT * 3);
    const velocities = new Float32Array(DUST_COUNT * 3);
    const restNorm = new Float32Array(DUST_COUNT * 3); // normalized inside unit sphere
    const sizes = new Float32Array(DUST_COUNT);
    const seeds = new Float32Array(DUST_COUNT);
    const speeds = new Float32Array(DUST_COUNT);

    const initR = Math.max(0.25, Math.min(1.2, propsRef.current.size)) * 0.44 * 0.96;

    // Seed glowing dust pooled naturally in the lower hemisphere & drifting upward
    for (let i = 0; i < DUST_COUNT; i++) {
      // Spherical direction biased toward lower-right / lower bed just like settled plasma dust
      const u = Math.random();
      const v = Math.random();
      const theta = u * Math.PI * 2;
      // Bias phi toward bottom (pi/2 .. pi) with a sparser tail rising higher
      const isStray = Math.random() < 0.14;
      const yNorm = isStray
        ? -0.2 + Math.random() * 0.85
        : -1.0 + Math.pow(Math.random(), 1.85) * 1.12;
      const radial = Math.pow(Math.random(), 0.32) * 0.97;
      const ringR = Math.sqrt(Math.max(0, 1 - yNorm * yNorm));

      const nx = Math.cos(theta) * ringR * radial;
      const ny = yNorm * radial;
      const nz = Math.sin(theta) * ringR * radial;

      restNorm[i * 3] = nx;
      restNorm[i * 3 + 1] = ny;
      restNorm[i * 3 + 2] = nz;

      positions[i * 3] = nx * initR;
      positions[i * 3 + 1] = ny * initR;
      positions[i * 3 + 2] = nz * initR;

      sizes[i] = 1.35 + Math.pow(v, 2.2) * 3.1;
      seeds[i] = Math.random();
      speeds[i] = 0;
    }

    const dustGeo = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(positions, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    const speedAttr = new THREE.BufferAttribute(speeds, 1);
    speedAttr.setUsage(THREE.DynamicDrawUsage);

    dustGeo.setAttribute('position', posAttr);
    dustGeo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    dustGeo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    dustGeo.setAttribute('aSpeed', speedAttr);

    const dustUniforms = {
      uResolutionY: { value: initH },
      uAspect: { value: initW / Math.max(initH, 1) },
      uDpr: { value: dpr },
      uColor: { value: primaryColor },
      uSecondaryColor: { value: secondaryColor },
      uTime: { value: 0 },
    };

    const dustMat = new THREE.ShaderMaterial({
      uniforms: dustUniforms,
      vertexShader: DUST_VERTEX_SHADER,
      fragmentShader: DUST_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });

    const dustPoints = new THREE.Points(dustGeo, dustMat);
    dustPoints.frustumCulled = false;
    dustPoints.renderOrder = 2;
    scene.add(dustPoints);

    if (!isSoftwareGl) {
      renderer.compile(scene, camera);
    }

    const onResize = () => {
      if (!container) return;
      const w = container.clientWidth || 600;
      const h = container.clientHeight || 600;
      renderer.setSize(w, h);
      resolutionVec.set(w, h);
      dustUniforms.uResolutionY.value = h;
      dustUniforms.uAspect.value = w / Math.max(h, 1);
    };

    const ro = new ResizeObserver(onResize);
    ro.observe(container);

    // Interactive pointer tracking in the same aspect-corrected sphere space
    let targetPx = 0;
    let targetPy = 0;
    let targetHover = 0;
    let currentPx = 0;
    let currentPy = 0;
    let prevPx = 0;
    let prevPy = 0;
    let currentHover = 0;

    const handlePointerMove = (e: PointerEvent) => {
      if (!propsRef.current.interactive) {
        targetHover = 0;
        return;
      }
      const rect = container.getBoundingClientRect();
      if (
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom
      ) {
        const aspect = rect.width / Math.max(rect.height, 1);
        targetPx = ((e.clientX - rect.left) / Math.max(rect.width, 1) - 0.5) * aspect;
        targetPy = -((e.clientY - rect.top) / Math.max(rect.height, 1) - 0.5);
        targetHover = 1;
      } else {
        targetHover = 0;
      }
    };

    const handlePointerLeave = () => {
      targetHover = 0;
    };

    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    container.addEventListener('pointerleave', handlePointerLeave);

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
      const p = propsRef.current;

      prevPx = currentPx;
      prevPy = currentPy;
      currentPx = THREE.MathUtils.damp(currentPx, targetPx, 8.0, dt);
      currentPy = THREE.MathUtils.damp(currentPy, targetPy, 8.0, dt);
      currentHover = THREE.MathUtils.damp(currentHover, p.interactive ? targetHover : 0, 5.5, dt);

      const ptrVx = (currentPx - prevPx) / Math.max(dt, 0.008);
      const ptrVy = (currentPy - prevPy) / Math.max(dt, 0.008);

      // Update shader uniforms in place
      rimUniforms.uTime.value = elapsed;
      rimUniforms.uSize.value = p.size;
      rimUniforms.uCrackle.value = p.crackle;
      rimUniforms.uHoverStrength.value = p.hoverStrength;
      rimUniforms.uHover.value = currentHover;
      pointerVec.set(currentPx, currentPy);
      primaryColor.set(p.color);
      secondaryColor.set(PRESET_SECONDARY[p.preset] ?? '#9D4EDD');
      dustUniforms.uTime.value = elapsed;

      // Update glowing dust physics inside sphere radius R
      const R = THREE.MathUtils.clamp(p.size, 0.25, 1.2) * 0.44 * 0.965;
      const fillRatio = THREE.MathUtils.clamp(p.fill, 0.05, 1.0);
      const swirlRadius = R * 0.85;
      const strength = p.interactive ? p.hoverStrength * currentHover : 0;
      const drag = Math.exp(-3.4 * dt);

      for (let i = 0; i < DUST_COUNT; i++) {
        const i3 = i * 3;
        let x = positions[i3];
        let y = positions[i3 + 1];
        let z = positions[i3 + 2];

        let vx = velocities[i3];
        let vy = velocities[i3 + 1];
        let vz = velocities[i3 + 2];

        const seed = seeds[i];

        // Target rest coordinate scaled by fill height
        const rnx = restNorm[i3];
        const rny = (restNorm[i3 + 1] + 1.0) * (0.45 + fillRatio * 0.55) - 1.0;
        const rnz = restNorm[i3 + 2];

        const tx = rnx * R;
        const ty = THREE.MathUtils.clamp(rny, -0.97, 0.92) * R;
        const tz = rnz * R;

        // Gentle spring back toward resting stardust bed + ambient fluid drift
        const ambX = Math.sin(elapsed * 0.65 + y * 9.0 + seed * 12.0) * 0.025;
        const ambY = Math.cos(elapsed * 0.55 + x * 8.0 + seed * 9.0) * 0.02;
        const ambZ = Math.sin(elapsed * 0.5 + z * 7.0 + seed * 6.0) * 0.02;

        vx += ((tx - x) * 1.45 + ambX) * dt;
        vy += ((ty - y) * 1.15 + ambY) * dt;
        vz += ((tz - z) * 1.45 + ambZ) * dt;

        // Interactive cursor swirl + vortex wake inside the glass ball
        if (strength > 0.005) {
          const dx = x - currentPx;
          const dy = y - currentPy;
          const dist2 = dx * dx + dy * dy;
          const dist = Math.sqrt(dist2);
          if (dist < swirlRadius) {
            const falloff = 1.0 - dist / swirlRadius;
            const w = falloff * falloff * strength;

            // Tangential swirl around cursor + upward curl + cursor drag wake
            const invD = 1.0 / Math.max(dist, 0.018);
            const tangX = -dy * invD;
            const tangY = dx * invD;

            const swirlForce = (1.35 + seed * 0.7) * w;
            vx += (tangX * swirlForce + ptrVx * 0.38 * w) * dt;
            vy += (tangY * swirlForce + ptrVy * 0.38 * w + 0.35 * w) * dt;
            vz += Math.sin(seed * 25.0 + elapsed * 3.0) * 0.8 * w * dt;
          }
        }

        vx *= drag;
        vy *= drag;
        vz *= drag;

        x += vx * dt;
        y += vy * dt;
        z += vz * dt;

        // Hard spherical glass boundary containment
        const lenSq = x * x + y * y + z * z;
        const maxR = R * 0.985;
        if (lenSq > maxR * maxR) {
          const len = Math.sqrt(lenSq);
          const nx = x / len;
          const ny = y / len;
          const nz = z / len;
          x = nx * maxR;
          y = ny * maxR;
          z = nz * maxR;
          const dot = vx * nx + vy * ny + vz * nz;
          if (dot > 0) {
            vx -= 1.45 * dot * nx;
            vy -= 1.45 * dot * ny;
            vz -= 1.45 * dot * nz;
          }
        }

        positions[i3] = x;
        positions[i3 + 1] = y;
        positions[i3 + 2] = z;

        velocities[i3] = vx;
        velocities[i3 + 1] = vy;
        velocities[i3 + 2] = vz;

        speeds[i] = Math.min(1.5, Math.sqrt(vx * vx + vy * vy) * 2.5);
      }

      posAttr.needsUpdate = true;
      speedAttr.needsUpdate = true;

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
      ro.disconnect();
      window.removeEventListener('pointermove', handlePointerMove);
      container.removeEventListener('pointerleave', handlePointerLeave);
      quadGeo.dispose();
      quadMat.dispose();
      dustGeo.dispose();
      dustMat.dispose();
      renderer.dispose();
    };
  }, []);

  return (
    <div
      ref={mountRef}
      aria-hidden="true"
      className={className}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        overflow: 'hidden',
      }}
    />
  );
}

export default CrystalizedBall;
