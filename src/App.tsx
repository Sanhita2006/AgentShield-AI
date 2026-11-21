import React, { useEffect, useRef, useState } from 'react';
import { LogIn, Moon, RotateCcw, Shield, Sun, UserCheck, Volume2, VolumeX, X } from 'lucide-react';
import { LandingPage, type AppRoute } from './components/LandingPage.tsx';
import { CustomerApp } from './components/CustomerApp.tsx';
import { BankConsole } from './components/BankConsole.tsx';
import { AttackLab } from './components/AttackLab.tsx';
import { AuditExplorer } from './components/AuditExplorer.tsx';
import { DocsPage } from './components/DocsPage.tsx';
import { ThreeShieldCanvas } from './components/ThreeShieldCanvas.tsx';
import FluidCursorOverlay from './components/FluidCursorOverlay.tsx';
import { soundEngine } from './utils/soundEffects.ts';
import AgentShieldIntro from '../AgentShieldIntro.jsx';

interface UserSession {
  userId: string;
  email: string;
  name: string;
  role: 'customer' | 'bank_admin';
}

interface ToastItem {
  id: string;
  msg: string;
  tone: 'info' | 'warn' | 'error' | 'success';
}

export default function App() {
  const [introDone, setIntroDone] = useState(false);
  const [route, setRoute] = useState<AppRoute>('landing');
  const [isDark, setIsDark] = useState(true);
  const [sseTick, setSseTick] = useState(0);
  const [user, setUser] = useState<UserSession | null>(null);
  const [demoMode, setDemoMode] = useState(true);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [pulseMode, setPulseMode] = useState<'allow' | 'ask' | 'block' | null>(null);
  const [auditBroken, setAuditBroken] = useState(false);
  const [soundMuted, setSoundMuted] = useState(false);
  const [scrollPct, setScrollPct] = useState(0);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [loginEmail, setLoginEmail] = useState('arjun.sen@example.in');
  const [loginPassword, setLoginPassword] = useState('arjun2026');

  const scrollProgressRef = useRef(0);

  const pushToast = (msg: string, tone: ToastItem['tone'] = 'info') => {
    const id = `${Date.now()}_${Math.random()}`;
    setToasts((prev) => [{ id, msg, tone }, ...prev].slice(0, 4));
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4500);
  };

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('dark');
    if (isDark) root.classList.remove('solid-black-cards');
    else root.classList.add('solid-black-cards');
  }, [isDark]);

  // Global scroll progress listener powering 3D choreography across ALL pages
  useEffect(() => {
    const onScroll = () => {
      const maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      const p = Math.min(1, Math.max(0, window.scrollY / maxScroll));
      scrollProgressRef.current = p;
      setScrollPct(Math.round(p * 100));
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [route]);

  // Reset scroll smoothly when switching routes
  const navigateTo = (nextRoute: AppRoute) => {
    setRoute(nextRoute);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/auth/me', { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setUser(d.user);
        setDemoMode(d.demoMode !== false);
        if (!d.user) setShowLoginModal(true);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  // Real-time Server-Sent Events subscription + automated threat/approval audio cues
  useEffect(() => {
    const es = new EventSource('/api/events/stream');
    const bump = () => setSseTick((t) => t + 1);

    es.addEventListener('gateway:decision', (ev) => {
      bump();
      try {
        const d = JSON.parse((ev as MessageEvent).data) as { verdict?: string };
        if (d.verdict === 'BLOCK') {
          setPulseMode('block');
          soundEngine.playDangerSound();
        } else if (d.verdict === 'ASK_CUSTOMER') {
          setPulseMode('ask');
          soundEngine.playWarningSound();
        } else if (d.verdict === 'ALLOW') {
          setPulseMode('allow');
        }
      } catch {
        // ignore
      }
    });
    es.addEventListener('grant:created', bump);
    es.addEventListener('grant:revoked', () => {
      bump();
      soundEngine.playRevokeSound();
    });
    es.addEventListener('agent:status', bump);
    es.addEventListener('settings:updated', bump);
    es.addEventListener('demo:reset', () => {
      setAuditBroken(false);
      setPulseMode(null);
      bump();
    });
    es.addEventListener('audit:tampered', () => {
      setAuditBroken(true);
      soundEngine.playDangerSound();
      bump();
    });
    es.addEventListener('approval:resolved', (ev) => {
      bump();
      try {
        const d = JSON.parse((ev as MessageEvent).data) as { status?: string };
        if (d.status === 'approved') soundEngine.playApproveSound();
      } catch {
        // ignore
      }
    });
    es.addEventListener('approval:created', (ev) => {
      bump();
      soundEngine.playWarningSound();
      try {
        const data = JSON.parse((ev as MessageEvent).data) as { summary?: string };
        if (data.summary) {
          pushToast(`Approval Required: ${data.summary}`, 'warn');
        }
      } catch {
        // ignore
      }
    });

    return () => {
      es.close();
    };
  }, []);

  const toggleSound = () => {
    const next = !soundMuted;
    setSoundMuted(next);
    soundEngine.setMuted(next);
  };

  const switchRole = async (role: 'customer' | 'bank_admin') => {
    try {
      const resp = await fetch('/api/auth/switch-role', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role }),
      });
      if (resp.ok) {
        const json = (await resp.json()) as { user: UserSession };
        setUser(json.user);
        setSseTick((t) => t + 1);
        pushToast(`Switched session to ${json.user.name} (${json.user.role})`, 'info');
      } else {
        pushToast('Unable to switch session role.', 'error');
      }
    } catch {
      pushToast('Network error switching session role.', 'error');
    }
  };

  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const resp = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: loginEmail, password: loginPassword }),
      });
      if (resp.ok) {
        const json = (await resp.json()) as { user: UserSession };
        setUser(json.user);
        setShowLoginModal(false);
        setSseTick((t) => t + 1);
        soundEngine.playApproveSound();
        pushToast(`Signed in as ${json.user.name} (${json.user.role})`, 'success');
      } else {
        soundEngine.playDangerSound();
        pushToast('Invalid email or password', 'error');
      }
    } catch {
      pushToast('Network error signing in.', 'error');
    }
  };

  const resetDemo = async () => {
    try {
      const resp = await fetch('/api/reset-demo', { method: 'POST' });
      if (resp.ok) {
        setAuditBroken(false);
        setPulseMode(null);
        setSseTick((t) => t + 1);
        soundEngine.playApproveSound();
        pushToast('Demo reset to clean 30-day Indian banking baseline.', 'success');
      } else {
        pushToast('Failed to reset demo.', 'error');
      }
    } catch {
      pushToast('Network error resetting demo.', 'error');
    }
  };

  const navItems: Array<{ id: AppRoute; label: string }> = [
    { id: 'landing', label: 'Overview' },
    { id: 'customer', label: 'Customer' },
    { id: 'console', label: 'Bank Console' },
    { id: 'audit', label: 'Audit Chain' },
    { id: 'docs', label: 'SDK & Docs' },
  ];

  // Play the cinematic intro first; the app mounts only after "Enter Platform".
  if (!introDone) {
    return <AgentShieldIntro onEnter={() => setIntroDone(true)} />;
  }

  return (
    <div className="relative min-h-screen bg-black text-slate-100">
      {/* Persistent Full-Viewport 3D Three.js Scene Across ALL Pages */}
      <div className="no-print">
        <ThreeShieldCanvas
          route={route}
          scrollProgressRef={scrollProgressRef}
          activeThreatPulse={pulseMode}
          auditBroken={auditBroken}
          isDark={isDark}
          soundMuted={soundMuted}
          onToggleSound={toggleSound}
        />
      </div>

      {/* Luminous Indigo Fluid Cursor Trail on Overview, Bank Console, Audit Chain & SDK Docs */}
      {(route === 'landing' || route === 'console' || route === 'audit' || route === 'docs') && (
        <FluidCursorOverlay />
      )}

      {/* Subtle Right-Edge Scroll Progress Indicator Across Every Page */}
      <div className="fixed right-4 top-1/2 -translate-y-1/2 z-20 hidden xl:flex flex-col items-center gap-2 pointer-events-none no-print">
        <span className="font-mono text-[11px] text-slate-400 tabular-nums">{scrollPct}%</span>
        <div className="w-1 h-28 rounded-full bg-slate-800 overflow-hidden">
          <div
            className="w-full bg-orange-500 transition-transform duration-150 origin-top"
            style={{ height: '100%', transform: `scaleY(${Math.max(0.05, scrollPct / 100)})` }}
          />
        </div>
      </div>

      {/* 3-Zone Top Bar Contract: [Brand wordmark] — [5 single-line nav links] — [1 primary CTA] */}
      <header className="sticky top-0 z-40 border-b border-white/12 bg-black/88 text-slate-100 no-print">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between gap-8">
          <button
            type="button"
            onClick={() => navigateTo('landing')}
            className="font-display text-lg font-bold tracking-tight whitespace-nowrap shrink-0 flex items-center gap-2 text-white"
          >
            <Shield className="w-5 h-5 text-orange-500" />
            <span>AgentShield</span>
          </button>

          <nav className="hidden md:flex items-center gap-6 text-sm font-medium">
            {navItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => navigateTo(item.id)}
                className={`whitespace-nowrap shrink-0 pb-0.5 transition-colors border-b-2 ${
                  route === item.id
                    ? 'border-orange-500 text-orange-400'
                    : 'border-transparent text-slate-300 hover:text-white'
                }`}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <div className="shrink-0">
            <button
              type="button"
              onClick={() => navigateTo('attack-lab')}
              className="px-4 py-2 text-xs font-semibold bg-orange-500 hover:bg-orange-600 text-white rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              Attack Lab
            </button>
          </div>
        </div>

        <div className="md:hidden px-4 pb-2.5 flex items-center gap-4 overflow-x-auto text-xs font-medium">
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => navigateTo(item.id)}
              className={`whitespace-nowrap shrink-0 ${
                route === item.id ? 'text-orange-400 font-semibold' : 'text-slate-400'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </header>

      {/* Workspace Utility Toolbar (below header on app routes) */}
      {route !== 'landing' && (
        <div className="relative z-20 border-b border-white/10 bg-black/82 text-slate-200 no-print">
          <div className="max-w-7xl mx-auto px-6 py-2 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex flex-wrap items-center gap-2 text-slate-300">
              <UserCheck className="w-3.5 h-3.5 text-orange-400" />
              <span>Session: {user ? `${user.name} (${user.role})` : 'Signed out'}</span>
              {demoMode && (
                <>
                  <span className="text-slate-500">·</span>
                  <button
                    type="button"
                    onClick={() => switchRole('customer')}
                    className={`hover:text-orange-400 ${user?.role === 'customer' ? 'font-semibold text-orange-400' : ''}`}
                  >
                    Customer View
                  </button>
                  <span className="text-slate-500">/</span>
                  <button
                    type="button"
                    onClick={() => switchRole('bank_admin')}
                    className={`hover:text-orange-400 ${user?.role === 'bank_admin' ? 'font-semibold text-orange-400' : ''}`}
                  >
                    Bank Admin
                  </button>
                </>
              )}
              <span className="text-slate-500">·</span>
              <button
                type="button"
                onClick={() => setShowLoginModal(true)}
                className="flex items-center gap-1 hover:text-orange-400"
              >
                <LogIn className="w-3 h-3" />
                <span>Sign In</span>
              </button>
            </div>

            <div className="flex items-center gap-4">
              <button type="button" onClick={toggleSound} className="flex items-center gap-1.5 hover:text-orange-400">
                {soundMuted ? <VolumeX className="w-3.5 h-3.5 text-slate-400" /> : <Volume2 className="w-3.5 h-3.5 text-emerald-400" />}
                <span>{soundMuted ? 'Muted' : 'Sound On'}</span>
              </button>
              <button
                type="button"
                onClick={() => setIsDark((d) => !d)}
                className="flex items-center gap-1.5 hover:text-orange-400"
              >
                {isDark ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
                <span>{isDark ? 'High-Contrast Cards' : 'Black Glass Cards'}</span>
              </button>
              {demoMode && (
                <button type="button" onClick={resetDemo} className="flex items-center gap-1.5 hover:text-orange-400">
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Reset Demo</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Email + Password Login Modal */}
      {showLoginModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <form
            onSubmit={handleEmailLogin}
            className="w-full max-w-sm rounded-2xl border border-slate-700 bg-[#0D1424] p-6 text-slate-100 space-y-4 shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <h2 className="font-display text-lg font-bold">AgentShield Session Sign In</h2>
              <button type="button" onClick={() => setShowLoginModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="text-xs text-slate-400 space-y-1">
              <div>Customer: <span className="font-mono text-slate-200">arjun.sen@example.in / arjun2026</span></div>
              <div>Admin: <span className="font-mono text-slate-200">admin@agentshield.bank / admin2026</span></div>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Email</label>
              <input
                type="email"
                required
                value={loginEmail}
                onChange={(e) => setLoginEmail(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-700 bg-slate-900 text-white"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Password</label>
              <input
                type="password"
                required
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-700 bg-slate-900 text-white"
              />
            </div>
            <button
              type="submit"
              className="w-full py-2 text-sm font-semibold bg-orange-500 hover:bg-orange-600 text-white rounded-lg"
            >
              Sign In
            </button>
          </form>
        </div>
      )}

      {/* Live Toast Notifications */}
      {toasts.length > 0 && (
        <div className="fixed top-20 right-4 z-50 space-y-2 max-w-sm w-full pointer-events-none no-print">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`pointer-events-auto rounded-xl border px-4 py-3 text-xs font-medium shadow-lg ${
                t.tone === 'error'
                  ? 'bg-rose-950 border-rose-500/60 text-rose-100'
                  : t.tone === 'warn'
                  ? 'bg-amber-950 border-amber-500/60 text-amber-100'
                  : t.tone === 'success'
                  ? 'bg-emerald-950 border-emerald-500/60 text-emerald-100'
                  : 'bg-slate-900 border-slate-700 text-slate-100'
              }`}
            >
              {t.msg}
            </div>
          ))}
        </div>
      )}

      {/* Foreground Route Content Floating Cleanly Over Persistent Black 3D Line World */}
      <main className="relative z-10 pb-24">
        {route === 'landing' && <LandingPage onNavigate={navigateTo} onPulse={setPulseMode} />}
        {route === 'customer' && <CustomerApp sseTick={sseTick} onToast={pushToast} onNavigate={navigateTo} />}
        {route === 'console' && <BankConsole sseTick={sseTick} onToast={pushToast} />}
        {route === 'attack-lab' && <AttackLab onToast={pushToast} onNavigate={navigateTo} />}
        {route === 'audit' && (
          <AuditExplorer sseTick={sseTick} onToast={pushToast} onAuditTamperChange={setAuditBroken} />
        )}
        {route === 'docs' && <DocsPage />}
      </main>
    </div>
  );
}
