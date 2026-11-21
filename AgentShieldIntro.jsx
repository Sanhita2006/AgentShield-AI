import React, { useEffect, useRef, useState } from 'react';

const TOTAL_DURATION = 10000; // 10 seconds
const PARTICLE_COUNT = 2600;

export default function AgentShieldIntro({ onEnter }) {
  const canvasRef = useRef(null);
  const [phase, setPhase] = useState(1);
  const [showUI, setShowUI] = useState(false);
  const [replayKey, setReplayKey] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    let width = (canvas.width = window.innerWidth);
    let height = (canvas.height = window.innerHeight);

    const handleResize = () => {
      if (!canvas) return;
      width = canvas.width = window.innerWidth;
      height = canvas.height = window.innerHeight;
      buildTargets();
    };
    window.addEventListener('resize', handleResize);

    // Helper: sample points from an offscreen shape/drawing
    const sampleShapePoints = (drawFn, count) => {
      const off = document.createElement('canvas');
      off.width = width;
      off.height = height;
      const octx = off.getContext('2d');
      drawFn(octx, width, height);

      const imgData = octx.getImageData(0, 0, width, height).data;
      const candidates = [];
      const step = Math.max(2, Math.floor(Math.sqrt((width * height) / 45000)));

      for (let y = 0; y < height; y += step) {
        for (let x = 0; x < width; x += step) {
          const idx = (y * width + x) * 4;
          const alpha = imgData[idx + 3];
          if (alpha > 40) {
            candidates.push({
              x,
              y,
              brightness: alpha / 255,
              isCore: imgData[idx] > 200
            });
          }
        }
      }

      const result = [];
      if (candidates.length === 0) {
        for (let i = 0; i < count; i++) {
          result.push({ x: width / 2, y: height / 2, brightness: 1, isCore: false });
        }
        return result;
      }

      for (let i = 0; i < count; i++) {
        const pick = candidates[Math.floor(Math.random() * candidates.length)];
        result.push({
          x: pick.x + (Math.random() - 0.5) * step,
          y: pick.y + (Math.random() - 0.5) * step,
          brightness: pick.brightness,
          isCore: pick.isCore
        });
      }
      return result;
    };

    let humanTargets = [];
    let eyeTargets = [];

    const buildTargets = () => {
      const cx = width * 0.5;
      const cy = height * 0.5;
      const scale = Math.min(width, height) / 800;

      // 1. Sample Phase 2: Human Silhouette + Pedestal + Data aura
      humanTargets = sampleShapePoints((octx) => {
        octx.save();
        octx.translate(cx, cy + 20 * scale);
        octx.scale(scale, scale);

        // Glowing pedestal ellipse
        octx.strokeStyle = 'rgba(255,255,255,0.85)';
        octx.lineWidth = 10;
        octx.beginPath();
        octx.ellipse(0, 215, 175, 28, 0, 0, Math.PI * 2);
        octx.stroke();

        // Head
        octx.fillStyle = '#ffffff';
        octx.beginPath();
        octx.arc(0, -165, 34, 0, Math.PI * 2);
        octx.fill();

        // Neck & Shoulders & Torso
        octx.beginPath();
        octx.moveTo(-14, -132);
        octx.lineTo(14, -132);
        octx.lineTo(54, -105);
        octx.lineTo(68, 25);
        octx.lineTo(46, 28);
        octx.lineTo(38, -68);
        octx.lineTo(34, 45);
        octx.lineTo(38, 205);
        octx.lineTo(12, 205);
        octx.lineTo(4, 65);
        octx.lineTo(-4, 65);
        octx.lineTo(-12, 205);
        octx.lineTo(-38, 205);
        octx.lineTo(-34, 45);
        octx.lineTo(-38, -68);
        octx.lineTo(-46, 28);
        octx.lineTo(-68, 25);
        octx.lineTo(-54, -105);
        octx.closePath();
        octx.fill();

        // Holographic circuit/code aura around body
        octx.fillStyle = 'rgba(255,255,255,0.55)';
        for (let i = 0; i < 24; i++) {
          const rx = (Math.sin(i * 7.3) * 110);
          const ry = -130 + (i / 24) * 310;
          octx.fillRect(rx - 18, ry, 36, 4);
        }
        octx.restore();
      }, PARTICLE_COUNT);

      // 2. Sample Phase 3: Cybernetic Eye Logo (shifted slightly up so text sits cleanly below)
      eyeTargets = sampleShapePoints((octx) => {
        octx.save();
        octx.translate(cx, cy - 55 * scale);
        octx.scale(scale, scale);

        // Outer mechanical orb rings
        octx.strokeStyle = 'rgba(255,255,255,0.45)';
        octx.lineWidth = 6;
        octx.beginPath();
        octx.arc(0, 0, 155, 0, Math.PI * 2);
        octx.stroke();

        // Almond eyelids
        octx.strokeStyle = '#ffffff';
        octx.lineWidth = 10;
        octx.beginPath();
        octx.moveTo(-195, 0);
        octx.quadraticCurveTo(0, -115, 195, 0);
        octx.quadraticCurveTo(0, 115, -195, 0);
        octx.stroke();

        // Horizontal digital scanline wings
        octx.lineWidth = 4;
        octx.beginPath();
        octx.moveTo(-270, 0);
        octx.lineTo(-175, 0);
        octx.moveTo(175, 0);
        octx.lineTo(270, 0);
        octx.stroke();

        // Iris outer & inner tech rings
        octx.lineWidth = 9;
        octx.beginPath();
        octx.arc(0, 0, 76, 0, Math.PI * 2);
        octx.stroke();

        octx.lineWidth = 5;
        octx.beginPath();
        octx.arc(0, 0, 52, 0, Math.PI * 2);
        octx.stroke();

        // Radial iris fibers
        octx.lineWidth = 2.5;
        for (let a = 0; a < Math.PI * 2; a += Math.PI / 18) {
          octx.beginPath();
          octx.moveTo(Math.cos(a) * 34, Math.sin(a) * 34);
          octx.lineTo(Math.cos(a) * 74, Math.sin(a) * 74);
          octx.stroke();
        }
        octx.restore();
      }, PARTICLE_COUNT);
    };

    buildTargets();

    // Initialize particles
    const particles = Array.from({ length: PARTICLE_COUNT }, (_, i) => {
      const ribbon = i % 3;
      const u = (i / PARTICLE_COUNT) * 2 - 1;
      const strand = ((i * 17) % 40) / 40 - 0.5;
      return {
        x: Math.random() * width,
        y: Math.random() * height,
        ribbon,
        u,
        strand,
        size: 1 + Math.random() * 2.4,
        bokeh: Math.random() > 0.86 ? 4 + Math.random() * 6 : 0,
        seed: Math.random() * Math.PI * 2,
        scatterX: (Math.random() - 0.5) * width * 0.85,
        scatterY: (Math.random() - 0.5) * height * 0.85,
        isBinary: i % 55 === 0,
        binaryText: Math.random() > 0.5 ? '0101' : '1010'
      };
    });

    const easeInOutCubic = (t) =>
      t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

    const lerp = (a, b, t) => a + (b - a) * t;

    let startTime = performance.now();
    let animId;

    const render = (now) => {
      const elapsed = now - startTime;
      const tSec = Math.min(elapsed / 1000, 10);

      // Update UI state milestones
      if (tSec < 3) {
        setPhase(1);
        setShowUI(false);
      } else if (tSec < 6) {
        setPhase(2);
        setShowUI(false);
      } else {
        setPhase(3);
        if (tSec >= 8.2) setShowUI(true);
      }

      // Clear background with deep obsidian gradient
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#040508';
      ctx.fillRect(0, 0, width, height);

      // Subtle atmospheric radial glow
      const bgGrad = ctx.createRadialGradient(
        width * 0.5,
        height * 0.48,
        20,
        width * 0.5,
        height * 0.5,
        Math.max(width, height) * 0.65
      );
      if (tSec < 3) {
        bgGrad.addColorStop(0, 'rgba(88, 42, 165, 0.14)');
      } else {
        bgGrad.addColorStop(0, 'rgba(14, 165, 233, 0.14)');
      }
      bgGrad.addColorStop(1, 'rgba(4, 5, 8, 0)');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, width, height);

      // Compute morph weights
      // 0..2.2s: pure fibers
      // 2.2..4.2s: fibers -> human
      // 4.2..6.0s: human holds & pulses with binary/circuits
      // 6.0..8.8s: human dismantles (bursts outward mid-transition) -> eye logo
      // 8.8..10.0s: eye logo holds & breathes
      const toHuman = easeInOutCubic(Math.max(0, Math.min(1, (tSec - 2.2) / 1.8)));
      const toEye = easeInOutCubic(Math.max(0, Math.min(1, (tSec - 6.0) / 2.6)));
      const dismantleBurst = Math.sin(Math.PI * Math.max(0, Math.min(1, (tSec - 6.0) / 2.6)));

      // Color interpolation: Purple (#8b5cf6) -> Electric Cyan (#22d3ee)
      const colorBlend = easeInOutCubic(Math.max(0, Math.min(1, (tSec - 2.3) / 1.7)));
      const r = Math.round(lerp(139, 34, colorBlend));
      const g = Math.round(lerp(92, 211, colorBlend));
      const b = Math.round(lerp(246, 238, colorBlend));

      ctx.globalCompositeOperation = 'lighter';

      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const p = particles[i];

        // --- Position 1: GhostFibers Ribbon Wave ---
        const u = p.u;
        const ribbonOffset = (p.ribbon - 1) * 95;
        const twist = Math.sin(u * 3.2 + now * 0.0014 + p.ribbon) * (55 + p.strand * 90);
        const waveY =
          Math.sin(u * 2.4 - now * 0.0012 + p.ribbon * 1.4) * 110 -
          u * height * 0.24 +
          ribbonOffset +
          twist;
        const fx = width * 0.5 + u * width * 0.52 + p.strand * 35;
        const fy = height * 0.5 + waveY;

        // --- Position 2: Cybernetic Human ---
        const ht = humanTargets[i] || { x: width / 2, y: height / 2, isCore: false };
        const jitter2 = (1 - toEye) * toHuman * 2.2;
        const hx = ht.x + Math.sin(now * 0.004 + p.seed) * jitter2;
        const hy = ht.y + Math.cos(now * 0.003 + p.seed) * jitter2;

        // --- Position 3: Cybernetic Eye ---
        const et = eyeTargets[i] || { x: width / 2, y: height / 2, isCore: false };
        const pulseEye = 1 + Math.sin(now * 0.003 + p.seed) * 0.012;
        const ex = width * 0.5 + (et.x - width * 0.5) * pulseEye;
        const ey = height * 0.5 - 55 + (et.y - (height * 0.5 - 55)) * pulseEye;

        // Blend coordinates across timeline
        let x = lerp(fx, hx, toHuman);
        let y = lerp(fy, hy, toHuman);

        if (toEye > 0) {
          x = lerp(x, ex, toEye) + p.scatterX * dismantleBurst * 0.42;
          y = lerp(y, ey, toEye) + p.scatterY * dismantleBurst * 0.42;
        }

        // Hot white-core highlight along ribbon folds or eye/body edges
        const isFoldHotspot =
          tSec < 3.5 && Math.abs(Math.sin(u * 3.2 + now * 0.0014 + p.ribbon)) < 0.14;
        const alpha =
          tSec < 0.5
            ? (tSec / 0.5) * 0.75
            : isFoldHotspot || ht.isCore || et.isCore
            ? 0.85
            : 0.45;

        if (isFoldHotspot) {
          ctx.fillStyle = `rgba(245, 235, 255, ${alpha})`;
        } else {
          ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }

        // Draw particle (or bokeh circle in phase 1)
        const radius = p.bokeh > 0 && toHuman < 0.5 ? p.bokeh * (1 - toHuman) + p.size : p.size;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();

        // Draw floating "0101" telemetry tags during Phase 2
        if (p.isBinary && toHuman > 0.65 && toEye < 0.45) {
          const binAlpha = Math.min(toHuman, 1 - toEye * 2) * 0.65;
          ctx.font = '10px monospace';
          ctx.fillStyle = `rgba(103, 232, 249, ${binAlpha})`;
          ctx.fillText(p.binaryText, x + 10, y - 6);
        }
      }

      if (elapsed < TOTAL_DURATION + 4000) {
        animId = requestAnimationFrame(render);
      }
    };

    animId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', handleResize);
    };
  }, [replayKey]);

  return (
    <div
      style={{
        position: 'relative',
        width: '100vw',
        height: '100vh',
        overflow: 'hidden',
        backgroundColor: '#040508',
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
        color: '#ffffff',
        userSelect: 'none'
      }}
    >
      {/* Interactive Particle Sequence Canvas */}
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          display: 'block'
        }}
      />

      {/* Phase 3 Final Brand Reveal: AgentShield Typography + CTA */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'flex-end',
          paddingBottom: '11vh',
          pointerEvents: showUI ? 'auto' : 'none',
          opacity: showUI ? 1 : 0,
          transform: showUI ? 'translateY(0px)' : 'translateY(18px)',
          transition: 'opacity 1.1s ease, transform 1.1s ease',
          zIndex: 10
        }}
      >
        <h1
          style={{
            margin: 0,
            fontSize: 'clamp(2.2rem, 5vw, 4rem)',
            fontWeight: 800,
            letterSpacing: '0.26em',
            textTransform: 'uppercase',
            background: 'linear-gradient(90deg, #e0f2fe 0%, #22d3ee 50%, #38bdf8 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            textShadow: '0 0 32px rgba(34, 211, 238, 0.45)'
          }}
        >
          AGENTSHIELD
        </h1>

        <p
          style={{
            marginTop: '0.65rem',
            marginBottom: '1.75rem',
            fontSize: '0.95rem',
            letterSpacing: '0.22em',
            textTransform: 'uppercase',
            color: 'rgba(186, 230, 253, 0.78)'
          }}
        >
          Autonomous AI Defense &amp; Oversight
        </p>

        <div style={{ display: 'flex', gap: '1rem' }}>
          <button
            onClick={onEnter}
            style={{
              padding: '0.85rem 2.2rem',
              fontSize: '0.9rem',
              fontWeight: 600,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: '#040508',
              background: '#22d3ee',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              boxShadow: '0 0 24px rgba(34, 211, 238, 0.5)'
            }}
          >
            Enter Platform
          </button>

          <button
            onClick={() => {
              setShowUI(false);
              setReplayKey((k) => k + 1);
            }}
            style={{
              padding: '0.85rem 1.4rem',
              fontSize: '0.85rem',
              fontWeight: 500,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: '#bae6fd',
              background: 'rgba(15, 23, 42, 0.65)',
              border: '1px solid rgba(34, 211, 238, 0.35)',
              borderRadius: '4px',
              cursor: 'pointer'
            }}
          >
            Replay Intro
          </button>
        </div>
      </div>

      {/* Subtle Timeline Progress Bar at Bottom */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          height: '2px',
          width: '100%',
          background: 'rgba(255,255,255,0.08)',
          zIndex: 20
        }}
      >
        <div
          key={replayKey}
          style={{
            height: '100%',
            background: phase === 1 ? '#8b5cf6' : '#22d3ee',
            animation: `agentShieldProgress ${TOTAL_DURATION}ms linear forwards`
          }}
        />
      </div>

      <style>{`
        @keyframes agentShieldProgress {
          from { width: 0%; }
          to { width: 100%; }
        }
      `}</style>
    </div>
  );
}