import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Database,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  Moon,
  RefreshCw,
  ShieldCheck,
  Sun,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

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

  // Password-only authentication state
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [totpCode, setTotpCode] = useState('');
  const [requiresTwoFactor, setRequiresTwoFactor] = useState(false);

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
      await setupInitialAdmin({ password });
      setPassword('');
      setConfirmPassword('');
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Initial administrator setup failed.');
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
        password,
        totpCode: requiresTwoFactor ? totpCode : undefined,
      });
      if (res.requiresTwoFactor) {
        setRequiresTwoFactor(true);
      } else {
        setPassword('');
        setTotpCode('');
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Authentication failed.');
    } finally {
      setSubmitting(false);
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
          {/* Primary Password-Only Auth Card — Always first above the fold on mobile */}
          <section className="order-first flex flex-col justify-center rounded-xl border border-slate-200 bg-white p-6 sm:p-8 lg:order-last lg:col-span-5 dark:border-slate-800 dark:bg-slate-900">
            {needsSetup ? (
              <>
                <div className="flex items-center gap-2 text-xs font-semibold text-blue-600 dark:text-blue-400">
                  <KeyRound className="h-4 w-4" />
                  <span>First-Time Installation</span>
                </div>
                <h2 className="mt-2 font-display text-lg font-semibold text-slate-900 dark:text-slate-100">
                  Create Administrator Password
                </h2>
                <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                  Create your own administrator password to secure this console. No email or
                  username is required, and no default or random password is ever generated.
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
                    <label
                      htmlFor="setup-password"
                      className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                    >
                      Administrator Password
                    </label>
                    <div className="relative mt-1">
                      <input
                        id="setup-password"
                        type={showPassword ? 'text' : 'password'}
                        required
                        autoComplete="new-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="12+ chars, upper, lower, number, symbol"
                        className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-3 pr-10 text-sm focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-950"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((v) => !v)}
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                      >
                        {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>

                  <div>
                    <label
                      htmlFor="setup-confirm"
                      className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                    >
                      Confirm Password
                    </label>
                    <div className="relative mt-1">
                      <input
                        id="setup-confirm"
                        type={showConfirmPassword ? 'text' : 'password'}
                        required
                        autoComplete="new-password"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        placeholder="Re-enter your password"
                        className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-3 pr-10 text-sm focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-950"
                      />
                      <button
                        type="button"
                        onClick={() => setShowConfirmPassword((v) => !v)}
                        aria-label={showConfirmPassword ? 'Hide confirm password' : 'Show confirm password'}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                      >
                        {showConfirmPassword ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                  </div>

                  <p className="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                    Minimum 12 characters including uppercase, lowercase, a number, and a symbol.
                    Stored using PBKDF2-SHA256 (100,000 iterations).
                  </p>

                  <button
                    type="submit"
                    disabled={submitting}
                    className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                  >
                    <span>{submitting ? 'Saving Password...' : 'Set Password & Enter Console'}</span>
                    <ArrowRight className="h-4 w-4" />
                  </button>
                </form>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2 text-xs font-semibold text-blue-600 dark:text-blue-400">
                  <Lock className="h-4 w-4" />
                  <span>Password Authentication</span>
                </div>
                <h2 className="mt-2 font-display text-lg font-semibold text-slate-900 dark:text-slate-100">
                  Administrator Sign-In
                </h2>
                <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                  Enter your administrator password to unlock the console. No email or username is
                  required.
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
                    <label
                      htmlFor="login-password"
                      className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                    >
                      Administrator Password
                    </label>
                    <div className="relative mt-1">
                      <input
                        id="login-password"
                        type={showPassword ? 'text' : 'password'}
                        required
                        autoComplete="current-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Enter your administrator password"
                        className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-3 pr-10 text-sm focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-950"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((v) => !v)}
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                      >
                        {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>

                  {requiresTwoFactor && (
                    <div>
                      <label
                        htmlFor="login-totp"
                        className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                      >
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
              </>
            )}

            <p className="mt-4 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
              Protected by HttpOnly session cookies, sliding-window rate limiting, CSRF origin
              checks, and hash-chained audit logs.
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
                    Password-only PBKDF2-SHA256 authentication, HttpOnly session cookies, no
                    third-party OAuth required, and optional RFC 6238 TOTP 2FA.
                  </p>
                </div>
                <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
                  <div className="flex items-center gap-2 text-xs font-semibold text-slate-900 dark:text-slate-100">
                    <Database className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                    <span>Cloudflare D1 &amp; Hash-Chained Audit</span>
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                    39 relational SQLite tables with Multi-App isolation, SHA-256 hash-chained audit
                    logs, and verifiable logical backups.
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
