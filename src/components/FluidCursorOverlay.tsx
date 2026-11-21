import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';

const BASE_VERTEX = `
  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;
  uniform vec2 uTexelSize;

  void main() {
    vUv = uv;
    vL = vUv - vec2(uTexelSize.x, 0.0);
    vR = vUv + vec2(uTexelSize.x, 0.0);
    vT = vUv + vec2(0.0, uTexelSize.y);
    vB = vUv - vec2(0.0, uTexelSize.y);
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const SPLAT_FRAGMENT = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTarget;
  uniform float uAspectRatio;
  uniform vec3 uColor;
  uniform vec2 uPoint;
  uniform float uRadius;

  void main() {
    vec2 p = vUv - uPoint;
    p.x *= uAspectRatio;
    vec3 splat = exp(-dot(p, p) / max(uRadius, 0.00001)) * uColor;
    vec3 base = texture2D(uTarget, vUv).xyz;
    gl_FragColor = vec4(base + splat, 1.0);
  }
`;

const CURL_FRAGMENT = `
  precision highp float;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;
  uniform sampler2D uVelocity;

  void main() {
    float L = texture2D(uVelocity, vL).y;
    float R = texture2D(uVelocity, vR).y;
    float T = texture2D(uVelocity, vT).x;
    float B = texture2D(uVelocity, vB).x;
    float vorticity = R - L - T + B;
    gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
  }
`;

const VORTICITY_FRAGMENT = `
  precision highp float;
  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;
  uniform sampler2D uVelocity;
  uniform sampler2D uCurl;
  uniform float uCurlStrength;
  uniform float uDt;

  void main() {
    float L = texture2D(uCurl, vL).x;
    float R = texture2D(uCurl, vR).x;
    float T = texture2D(uCurl, vT).x;
    float B = texture2D(uCurl, vB).x;
    float C = texture2D(uCurl, vUv).x;

    vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
    force /= length(force) + 0.0001;
    force *= uCurlStrength * C;
    force.y *= -1.0;

    vec2 velocity = texture2D(uVelocity, vUv).xy;
    velocity += force * uDt;
    velocity = clamp(velocity, vec2(-1000.0), vec2(1000.0));
    gl_FragColor = vec4(velocity, 0.0, 1.0);
  }
`;

const DIVERGENCE_FRAGMENT = `
  precision highp float;
  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;
  uniform sampler2D uVelocity;

  void main() {
    float L = texture2D(uVelocity, vL).x;
    float R = texture2D(uVelocity, vR).x;
    float T = texture2D(uVelocity, vT).y;
    float B = texture2D(uVelocity, vB).y;
    vec2 C = texture2D(uVelocity, vUv).xy;

    if (vL.x < 0.0) L = -C.x;
    if (vR.x > 1.0) R = -C.x;
    if (vT.y > 1.0) T = -C.y;
    if (vB.y < 0.0) B = -C.y;

    float div = 0.5 * (R - L + T - B);
    gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
  }
`;

const PRESSURE_FRAGMENT = `
  precision highp float;
  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;
  uniform sampler2D uPressure;
  uniform sampler2D uDivergence;

  void main() {
    float L = texture2D(uPressure, vL).x;
    float R = texture2D(uPressure, vR).x;
    float T = texture2D(uPressure, vT).x;
    float B = texture2D(uPressure, vB).x;
    float divergence = texture2D(uDivergence, vUv).x;
    float pressure = (L + R + B + T - divergence) * 0.25;
    gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
  }
`;

const GRADIENT_SUBTRACT_FRAGMENT = `
  precision highp float;
  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;
  uniform sampler2D uPressure;
  uniform sampler2D uVelocity;

  void main() {
    float L = texture2D(uPressure, vL).x;
    float R = texture2D(uPressure, vR).x;
    float T = texture2D(uPressure, vT).x;
    float B = texture2D(uPressure, vB).x;
    vec2 velocity = texture2D(uVelocity, vUv).xy;
    velocity.xy -= vec2(R - L, T - B);
    gl_FragColor = vec4(velocity, 0.0, 1.0);
  }
`;

const ADVECTION_FRAGMENT = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uVelocity;
  uniform sampler2D uSource;
  uniform vec2 uTexelSize;
  uniform float uDt;
  uniform float uDissipation;

  void main() {
    vec2 coord = vUv - uDt * texture2D(uVelocity, vUv).xy * uTexelSize;
    vec4 result = texture2D(uSource, coord);
    float decay = 1.0 + uDissipation * uDt;
    gl_FragColor = result / decay;
  }
`;

const CLEAR_FRAGMENT = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTexture;
  uniform float uValue;

  void main() {
    gl_FragColor = uValue * texture2D(uTexture, vUv);
  }
`;

const DISPLAY_FRAGMENT = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTexture;
  uniform vec2 uTexelSize;

  void main() {
    vec3 c = texture2D(uTexture, vUv).rgb;

    // Subtle 4-tap neighbor bloom to give the indigo fluid ribbons a silky plasma halo
    vec3 b1 = texture2D(uTexture, vUv + vec2(uTexelSize.x * 2.0, 0.0)).rgb;
    vec3 b2 = texture2D(uTexture, vUv - vec2(uTexelSize.x * 2.0, 0.0)).rgb;
    vec3 b3 = texture2D(uTexture, vUv + vec2(0.0, uTexelSize.y * 2.0)).rgb;
    vec3 b4 = texture2D(uTexture, vUv - vec2(0.0, uTexelSize.y * 2.0)).rgb;
    vec3 glow = (b1 + b2 + b3 + b4) * 0.16;

    vec3 combined = c + glow;
    float intensity = max(combined.r, max(combined.g, combined.b));

    // White-hot electric core transitioning through periwinkle/indigo smoke wisps
    vec3 indigo = vec3(0.30, 0.44, 1.0);
    vec3 hotCore = vec3(0.92, 0.96, 1.0);
    vec3 color = mix(combined * indigo * 1.45, hotCore * intensity, smoothstep(0.45, 1.35, intensity));
    color = max(color, combined * 0.85);

    float alpha = clamp(intensity * 1.15, 0.0, 0.96);
    gl_FragColor = vec4(color, alpha);
  }
`;

interface DoubleFBO {
  read: THREE.WebGLRenderTarget;
  write: THREE.WebGLRenderTarget;
  swap: () => void;
  dispose: () => void;
}

function createFBO(w: number, h: number, type: THREE.TextureDataType, filter: THREE.MagnificationTextureFilter) {
  return new THREE.WebGLRenderTarget(w, h, {
    type,
    format: THREE.RGBAFormat,
    minFilter: filter,
    magFilter: filter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  });
}

function createDoubleFBO(
  w: number,
  h: number,
  type: THREE.TextureDataType,
  filter: THREE.MagnificationTextureFilter
): DoubleFBO {
  let fbo1 = createFBO(w, h, type, filter);
  let fbo2 = createFBO(w, h, type, filter);
  return {
    get read() {
      return fbo1;
    },
    get write() {
      return fbo2;
    },
    swap() {
      const temp = fbo1;
      fbo1 = fbo2;
      fbo2 = temp;
    },
    dispose() {
      fbo1.dispose();
      fbo2.dispose();
    },
  };
}

export function FluidCursorOverlay() {
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
        antialias: false,
        alpha: true,
        powerPreference: 'high-performance',
      });
    } catch {
      return;
    }

    const gl = renderer.getContext();
    gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('EXT_color_buffer_half_float');
    gl.getExtension('OES_texture_half_float_linear');

    const dpr = isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setPixelRatio(dpr);
    renderer.setClearColor(0x000000, 0);

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
    const quadGeo = new THREE.PlaneGeometry(2, 2);

    const texType = THREE.HalfFloatType;
    const aspect = initW / Math.max(initH, 1);
    const simH = isSoftwareGl ? 96 : 128;
    const simW = Math.max(96, Math.min(256, Math.round(simH * aspect)));
    const dyeH = isSoftwareGl ? 256 : 512;
    const dyeW = Math.max(256, Math.min(896, Math.round(dyeH * aspect)));

    const velocity = createDoubleFBO(simW, simH, texType, THREE.LinearFilter);
    const dye = createDoubleFBO(dyeW, dyeH, texType, THREE.LinearFilter);
    const divergence = createFBO(simW, simH, texType, THREE.NearestFilter);
    const curl = createFBO(simW, simH, texType, THREE.NearestFilter);
    const pressure = createDoubleFBO(simW, simH, texType, THREE.NearestFilter);

    const simTexel = new THREE.Vector2(1 / simW, 1 / simH);
    const dyeTexel = new THREE.Vector2(1 / dyeW, 1 / dyeH);
    const splatPoint = new THREE.Vector2(0.5, 0.5);
    const splatColor = new THREE.Vector3(0, 0, 0);

    const makeMat = (fragmentShader: string, extraUniforms: Record<string, THREE.IUniform>) =>
      new THREE.ShaderMaterial({
        vertexShader: BASE_VERTEX,
        fragmentShader,
        uniforms: {
          uTexelSize: { value: simTexel },
          ...extraUniforms,
        },
        depthWrite: false,
        depthTest: false,
      });

    const splatMat = makeMat(SPLAT_FRAGMENT, {
      uTarget: { value: null },
      uAspectRatio: { value: aspect },
      uColor: { value: splatColor },
      uPoint: { value: splatPoint },
      uRadius: { value: 0.0014 },
    });

    const curlMat = makeMat(CURL_FRAGMENT, {
      uVelocity: { value: null },
    });

    const vorticityMat = makeMat(VORTICITY_FRAGMENT, {
      uVelocity: { value: null },
      uCurl: { value: null },
      uCurlStrength: { value: 32.0 },
      uDt: { value: 0.016 },
    });

    const divergenceMat = makeMat(DIVERGENCE_FRAGMENT, {
      uVelocity: { value: null },
    });

    const pressureMat = makeMat(PRESSURE_FRAGMENT, {
      uPressure: { value: null },
      uDivergence: { value: null },
    });

    const gradientSubtractMat = makeMat(GRADIENT_SUBTRACT_FRAGMENT, {
      uPressure: { value: null },
      uVelocity: { value: null },
    });

    const advectionMat = makeMat(ADVECTION_FRAGMENT, {
      uVelocity: { value: null },
      uSource: { value: null },
      uDt: { value: 0.016 },
      uDissipation: { value: 1.0 },
    });

    const clearMat = makeMat(CLEAR_FRAGMENT, {
      uTexture: { value: null },
      uValue: { value: 0.8 },
    });

    const displayMat = makeMat(DISPLAY_FRAGMENT, {
      uTexture: { value: null },
      uTexelSize: { value: dyeTexel },
    });
    displayMat.transparent = true;

    const quadMesh = new THREE.Mesh(quadGeo, displayMat);
    scene.add(quadMesh);

    const blit = (target: THREE.WebGLRenderTarget | null, mat: THREE.ShaderMaterial) => {
      quadMesh.material = mat;
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
    };

    const splat = (x: number, y: number, dx: number, dy: number) => {
      const currAspect = window.innerWidth / Math.max(window.innerHeight, 1);

      splatMat.uniforms.uTarget.value = velocity.read.texture;
      splatMat.uniforms.uAspectRatio.value = currAspect;
      splatPoint.set(x, y);
      splatColor.set(dx, dy, 0.0);
      splatMat.uniforms.uRadius.value = 0.0018;
      blit(velocity.write, splatMat);
      velocity.swap();

      // Luminous periwinkle-indigo & white-blue plasma smoke dye
      const speed = Math.min(1.6, Math.sqrt(dx * dx + dy * dy) * 0.0042);
      const energy = 0.35 + speed * 0.75;
      splatMat.uniforms.uTarget.value = dye.read.texture;
      splatColor.set(0.38 * energy, 0.56 * energy, 1.35 * energy);
      splatMat.uniforms.uRadius.value = 0.0012;
      blit(dye.write, splatMat);
      dye.swap();
    };

    // Pointer state queue for continuous interpolated trails
    let lastPtrX = 0.5;
    let lastPtrY = 0.5;
    let hasPointer = false;
    const pendingSplats: Array<{ x: number; y: number; dx: number; dy: number }> = [];

    const handlePointerMove = (e: PointerEvent) => {
      const nx = e.clientX / Math.max(window.innerWidth, 1);
      const ny = 1.0 - e.clientY / Math.max(window.innerHeight, 1);

      if (!hasPointer) {
        lastPtrX = nx;
        lastPtrY = ny;
        hasPointer = true;
        return;
      }

      const rawDx = nx - lastPtrX;
      const rawDy = ny - lastPtrY;
      const dist = Math.sqrt(rawDx * rawDx + rawDy * rawDy);
      const steps = Math.min(5, Math.max(1, Math.ceil(dist * 60)));
      const currAspect = window.innerWidth / Math.max(window.innerHeight, 1);

      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const px = lastPtrX + rawDx * t;
        const py = lastPtrY + rawDy * t;
        const stepDx = (rawDx / steps) * 5200 * currAspect;
        const stepDy = (rawDy / steps) * 5200;
        pendingSplats.push({ x: px, y: py, dx: stepDx, dy: stepDy });
      }

      if (pendingSplats.length > 24) {
        pendingSplats.splice(0, pendingSplats.length - 24);
      }

      lastPtrX = nx;
      lastPtrY = ny;
    };

    window.addEventListener('pointermove', handlePointerMove, { passive: true });

    const onResize = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', onResize);

    const clock = new THREE.Clock();
    let frameId = 0;
    let disposed = false;

    function afterDraw(cb: () => void) {
      const glCtx = renderer.getContext() as WebGL2RenderingContext;
      const sync = glCtx.fenceSync ? glCtx.fenceSync(glCtx.SYNC_GPU_COMMANDS_COMPLETE, 0) : null;
      if (!sync) {
        frameId = window.setTimeout(cb, 80);
        return;
      }
      glCtx.flush();
      const poll = () => {
        if (disposed) return;
        const state = glCtx.getSyncParameter(sync, glCtx.SYNC_STATUS);
        if (state === glCtx.UNSIGNALED) {
          frameId = window.setTimeout(poll, 5);
        } else {
          glCtx.deleteSync(sync);
          frameId = window.setTimeout(cb, 80);
        }
      };
      frameId = window.setTimeout(poll, 5);
    }

    function tick() {
      if (disposed) return;
      const dt = Math.min(clock.getDelta(), 0.033);

      // Process queued pointer splats
      for (let i = 0; i < pendingSplats.length; i++) {
        const sp = pendingSplats[i];
        splat(sp.x, sp.y, sp.dx, sp.dy);
      }
      pendingSplats.length = 0;

      // 1. Curl
      curlMat.uniforms.uTexelSize.value = simTexel;
      curlMat.uniforms.uVelocity.value = velocity.read.texture;
      blit(curl, curlMat);

      // 2. Vorticity confinement
      vorticityMat.uniforms.uTexelSize.value = simTexel;
      vorticityMat.uniforms.uVelocity.value = velocity.read.texture;
      vorticityMat.uniforms.uCurl.value = curl.texture;
      vorticityMat.uniforms.uDt.value = dt;
      blit(velocity.write, vorticityMat);
      velocity.swap();

      // 3. Divergence
      divergenceMat.uniforms.uTexelSize.value = simTexel;
      divergenceMat.uniforms.uVelocity.value = velocity.read.texture;
      blit(divergence, divergenceMat);

      // 4. Clear pressure & Jacobi pressure solve
      clearMat.uniforms.uTexelSize.value = simTexel;
      clearMat.uniforms.uTexture.value = pressure.read.texture;
      clearMat.uniforms.uValue.value = 0.8;
      blit(pressure.write, clearMat);
      pressure.swap();

      pressureMat.uniforms.uTexelSize.value = simTexel;
      pressureMat.uniforms.uDivergence.value = divergence.texture;
      const iters = isSoftwareGl ? 7 : 14;
      for (let i = 0; i < iters; i++) {
        pressureMat.uniforms.uPressure.value = pressure.read.texture;
        blit(pressure.write, pressureMat);
        pressure.swap();
      }

      // 5. Subtract pressure gradient
      gradientSubtractMat.uniforms.uTexelSize.value = simTexel;
      gradientSubtractMat.uniforms.uPressure.value = pressure.read.texture;
      gradientSubtractMat.uniforms.uVelocity.value = velocity.read.texture;
      blit(velocity.write, gradientSubtractMat);
      velocity.swap();

      // 6. Advect velocity
      advectionMat.uniforms.uTexelSize.value = simTexel;
      advectionMat.uniforms.uVelocity.value = velocity.read.texture;
      advectionMat.uniforms.uSource.value = velocity.read.texture;
      advectionMat.uniforms.uDt.value = dt;
      advectionMat.uniforms.uDissipation.value = 0.9;
      blit(velocity.write, advectionMat);
      velocity.swap();

      // 7. Advect dye
      advectionMat.uniforms.uTexelSize.value = simTexel;
      advectionMat.uniforms.uVelocity.value = velocity.read.texture;
      advectionMat.uniforms.uSource.value = dye.read.texture;
      advectionMat.uniforms.uDt.value = dt;
      advectionMat.uniforms.uDissipation.value = 1.45;
      blit(dye.write, advectionMat);
      dye.swap();

      // 8. Composite luminous fluid wisps onto transparent screen canvas
      displayMat.uniforms.uTexture.value = dye.read.texture;
      displayMat.uniforms.uTexelSize.value = dyeTexel;
      blit(null, displayMat);

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
      quadGeo.dispose();
      splatMat.dispose();
      curlMat.dispose();
      vorticityMat.dispose();
      divergenceMat.dispose();
      pressureMat.dispose();
      gradientSubtractMat.dispose();
      advectionMat.dispose();
      clearMat.dispose();
      displayMat.dispose();
      velocity.dispose();
      dye.dispose();
      divergence.dispose();
      curl.dispose();
      pressure.dispose();
      renderer.dispose();
    };
  }, []);

  return (
    <div
      ref={mountRef}
      aria-hidden="true"
      className="fixed inset-0 z-[1] pointer-events-none no-print"
    />
  );
}

export default FluidCursorOverlay;
