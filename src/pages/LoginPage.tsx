import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Database,
  KeyRound,
  Lock,
  Moon,
  RefreshCw,
  ShieldCheck,
  Sun,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { apiRequest } from '../lib/api';

export const LoginPage: React.FC = () => {
  const {
    needsSetup,
    authError,
    theme,
    toggleTheme,
    setupInitialAdmin,
    loginWithPassword,
    retryConnection,
  } = useAuth();

  const [health, setHealth] = useState<{ status: string; database: string; engine?: string } | null>(
    null
  );
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // First-Time Setup / Login fields
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [requiresTwoFactor, setRequiresTwoFactor] = useState(false);

  // Forgot Password state
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotMessage, setForgotMessage] = useState<string | null>(null);

  const checkHealth = () => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((data) => setHealth(data))
      .catch(() => setHealth({ status: 'degraded', database: 'unavailable' }));
  };

  useEffect(() => {
    checkHealth();
  }, []);

  const handleSetupSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (password !== confirmPassword) {
      setFormError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      await setupInitialAdmin({ email, displayName, password });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Initial Super Admin setup failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const res = await loginWithPassword({
        email,
        password,
        totpCode: requiresTwoFactor ? totpCode : undefined,
      });
      if (res.requiresTwoFactor) {
        setRequiresTwoFactor(true);
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Authentication failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleForgotSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setForgotMessage(null);
    try {
      const res = await apiRequest<{ message: string }>('/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email: forgotEmail || email }),
      });
      setForgotMessage(res.message);
    } catch (err) {
      setForgotMessage(
        err instanceof Error ? err.message : 'Unable to submit password reset request.'
      );
    }
  };

  const combinedError = formError || authError;

  return (
    <div className="flex min-h-screen flex-col bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="flex h-14 items-center justify-between border-b border-slate-200 bg-white px-4 sm:px-6 dark:border-slate-800 dark:bg-slate-950">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-600 text-white">
            <ShieldCheck className="h-4 w-4" strokeWidth={2} />
          </div>
          <span className="font-display text-sm font-semibold tracking-tight">
            Aegis Enterprise Console
          </span>
        </div>

        <button
          type="button"
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-900"
        >
          {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-1 items-center px-4 py-5 sm:px-6 lg:py-10">
        <div className="grid w-full items-stretch gap-6 lg:grid-cols-12 lg:gap-8">
          {/* Primary Auth / Bootstrap Card — Always first above the fold on mobile */}
          <section className="order-first flex flex-col justify-center rounded-xl border border-slate-200 bg-white p-6 sm:p-8 lg:order-last lg:col-span-5 dark:border-slate-800 dark:bg-slate-900">
            {needsSetup ? (
              <>
                <div className="flex items-center gap-2 text-xs font-semibold text-blue-600 dark:text-blue-400">
                  <KeyRound className="h-4 w-4" />
                  <span>First-Time Installation</span>
                </div>
                <h2 className="mt-2 font-display text-lg font-semibold text-slate-900 dark:text-slate-100">
                  Create Super Admin Account
                </h2>
                <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                  No users exist in the D1 database yet. Provision the initial Super Admin
                  account; setup locks permanently once created.
                </p>

                {combinedError && (
                  <div
                    role="alert"
                    className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300"
                  >
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{combinedError}</span>
                  </div>
                )}

                <form onSubmit={handleSetupSubmit} className="mt-5 space-y-3.5">
                  <div>
                    <label htmlFor="setup-name" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                      Full Name
                    </label>
                    <input
                      id="setup-name"
                      type="text"
                      required
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder="Jane Doe"
                      className="mt-1 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-950"
                    />
                  </div>
                  <div>
                    <label htmlFor="setup-email" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                      Administrator Email
                    </label>
                    <input
                      id="setup-email"
                      type="email"
                      required
                      autoComplete="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="admin@company.com"
                      className="mt-1 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-950"
                    />
                  </div>
                  <div>
                    <label htmlFor="setup-password" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                      Password
                    </label>
                    <input
                      id="setup-password"
                      type="password"
                      required
                      autoComplete="new-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="12+ chars, upper, lower, number, symbol"
                      className="mt-1 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-950"
                    />
                  </div>
                  <div>
                    <label htmlFor="setup-confirm" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                      Confirm Password
                    </label>
                    <input
                      id="setup-confirm"
                      type="password"
                      required
                      autoComplete="new-password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      className="mt-1 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-950"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={submitting}
                    className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                  >
                    <span>{submitting ? 'Provisioning Super Admin...' : 'Initialize Super Admin'}</span>
                    <ArrowRight className="h-4 w-4" />
                  </button>
                </form>
              </>
            ) : (
              <>
                <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">
                  Administrator Sign-In
                </h2>
                <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                  Authenticate with your administrator email and password. Sessions use HttpOnly
                  cookies protected by PBKDF2-SHA256 and server-side RBAC.
                </p>

                {combinedError && (
                  <div
                    role="alert"
                    className="mt-4 space-y-2 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300"
                  >
                    <div className="flex items-start gap-2">
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>{combinedError}</span>
                    </div>
                    {authError && (
                      <button
                        type="button"
                        onClick={() => {
                          checkHealth();
                          void retryConnection();
                        }}
                        className="inline-flex items-center gap-1 rounded border border-red-300 bg-white px-2.5 py-1 text-[11px] font-medium text-red-700 hover:bg-red-50 dark:border-red-800 dark:bg-slate-900 dark:text-red-300"
                      >
                        <RefreshCw className="h-3 w-3" />
                        Retry Connection
                      </button>
                    )}
                  </div>
                )}

                <form onSubmit={handleLoginSubmit} className="mt-5 space-y-3.5">
                  <div>
                    <label htmlFor="login-email" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                      Email Address
                    </label>
                    <input
                      id="login-email"
                      type="email"
                      required
                      autoComplete="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="admin@company.com"
                      className="mt-1 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-950"
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between">
                      <label htmlFor="login-password" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                        Password
                      </label>
                      <button
                        type="button"
                        onClick={() => {
                          setForgotOpen((v) => !v);
                          setForgotMessage(null);
                        }}
                        className="text-[11px] font-medium text-blue-600 hover:underline dark:text-blue-400"
                      >
                        Forgot password?
                      </button>
                    </div>
                    <input
                      id="login-password"
                      type="password"
                      required
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="mt-1 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-950"
                    />
                  </div>

                  {requiresTwoFactor && (
                    <div>
                      <label htmlFor="login-totp" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                        Two-Factor TOTP Code
                      </label>
                      <input
                        id="login-totp"
                        type="text"
                        required
                        inputMode="numeric"
                        maxLength={6}
                        value={totpCode}
                        onChange={(e) => setTotpCode(e.target.value)}
                        placeholder="6-digit authenticator code"
                        className="mt-1 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 font-mono text-sm focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-950"
                      />
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={submitting}
                    className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                  >
                    <span>{submitting ? 'Signing in...' : 'Sign In'}</span>
                    <ArrowRight className="h-4 w-4" />
                  </button>
                </form>

                {forgotOpen && (
                  <form
                    onSubmit={handleForgotSubmit}
                    className="mt-4 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950"
                  >
                    <p className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                      Password Reset Request
                    </p>
                    <div className="flex gap-2">
                      <input
                        type="email"
                        required
                        value={forgotEmail || email}
                        onChange={(e) => setForgotEmail(e.target.value)}
                        placeholder="Enter administrator email"
                        className="h-9 flex-1 rounded-md border border-slate-200 bg-white px-2.5 text-xs dark:border-slate-700 dark:bg-slate-900"
                      />
                      <button
                        type="submit"
                        className="h-9 rounded-md border border-slate-300 bg-white px-3 text-xs font-medium hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800"
                      >
                        Request
                      </button>
                    </div>
                    {forgotMessage && (
                      <p className="text-[11px] leading-relaxed text-slate-600 dark:text-slate-400">
                        {forgotMessage}
                      </p>
                    )}
                  </form>
                )}
              </>
            )}

            <p className="mt-4 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
              Protected by HttpOnly session cookies, login rate limiting, CSRF origin checks,
              and hash-chained audit logs.
            </p>
          </section>

          {/* Architecture & System Status Info Card */}
          <section className="order-last flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-6 sm:p-8 lg:order-first lg:col-span-7 dark:border-slate-800 dark:bg-slate-900">
            <div>
              <p className="text-xs font-medium text-blue-600 dark:text-blue-400">
                Enterprise Administration Platform
              </p>
              <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl dark:text-slate-100">
                Unified Governance, Security, and Operations
              </h1>
              <p className="mt-3 max-w-xl text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                Zero-cost serverless administration running on Cloudflare Workers &amp; D1 SQLite.
                Administer users, granular RBAC policies, D1 backups, audit hash chains, support
                queues, and GitHub CI/CD telemetry from one unified console.
              </p>

              <div className="mt-6 grid gap-4 sm:mt-8 sm:grid-cols-2">
                <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
                  <div className="flex items-center gap-2 text-xs font-semibold text-slate-900 dark:text-slate-100">
                    <Lock className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                    <span>Zero Hardcoded Credentials</span>
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                    PBKDF2-SHA256 passwords, HttpOnly session cookies, brute-force lockout, and optional RFC 6238 TOTP 2FA.
                  </p>
                </div>
                <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
                  <div className="flex items-center gap-2 text-xs font-semibold text-slate-900 dark:text-slate-100">
                    <Database className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                    <span>Cloudflare D1 &amp; Hash-Chained Audit</span>
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                    26 relational SQLite tables with SHA-256 hash-chained audit logs and verifiable logical backups.
                  </p>
                </div>
              </div>
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-4 border-t border-slate-100 pt-4 text-xs text-slate-500 sm:mt-8 dark:border-slate-800 dark:text-slate-400">
              <span>
                API Status:{' '}
                <strong
                  className={
                    health?.status === 'ok'
                      ? 'font-medium text-emerald-600 dark:text-emerald-400'
                      : 'font-medium text-slate-700 dark:text-slate-200'
                  }
                >
                  {health ? health.status : 'checking'}
                </strong>
              </span>
              <span aria-hidden="true">·</span>
              <span>
                D1 SQLite:{' '}
                <strong
                  className={
                    health?.database === 'connected'
                      ? 'font-medium text-emerald-600 dark:text-emerald-400'
                      : 'font-medium text-slate-700 dark:text-slate-200'
                  }
                >
                  {health ? health.database : 'checking'}
                </strong>
              </span>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
};
