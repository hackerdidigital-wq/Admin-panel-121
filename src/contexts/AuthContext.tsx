import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { ApiError, apiRequest } from '../lib/api';

export interface AdminUserProfile {
  id: number;
  uid: string;
  email: string;
  displayName: string;
  avatarUrl: string;
  status: string;
  roleId: number | null;
  roleSlug: string;
  roleName: string;
  hierarchyLevel: number;
  twoFactorEnabled: boolean;
  preferences: {
    theme?: 'light' | 'dark' | 'system';
    language?: string;
    timezone?: string;
    dateFormat?: string;
    sidebarCollapsed?: boolean;
  };
}

export interface SessionInfo {
  id: number;
  deviceName: string;
  browser: string;
  os: string;
  ipAddress: string;
  isActive: boolean;
  lastActivityAt: string;
  expiresAt: string;
  createdAt: string;
}

interface AuthContextValue {
  adminUser: AdminUserProfile | null;
  permissions: Set<string>;
  sessions: SessionInfo[];
  loading: boolean;
  authError: string | null;
  needsSetup: boolean;
  emailProviderConfigured: boolean;
  theme: 'light' | 'dark';
  toggleTheme: () => void;
  setThemeMode: (mode: 'light' | 'dark') => void;
  hasPerm: (perm: string | string[]) => boolean;
  setupInitialAdmin: (input: { password: string }) => Promise<void>;
  loginWithPassword: (input: {
    password: string;
    totpCode?: string;
  }) => Promise<{ requiresTwoFactor: boolean }>;
  logout: () => Promise<void>;
  refreshSession: () => Promise<void>;
  retryConnection: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [adminUser, setAdminUser] = useState<AdminUserProfile | null>(null);
  const [permissions, setPermissions] = useState<Set<string>>(new Set());
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [emailProviderConfigured, setEmailProviderConfigured] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = typeof window !== 'undefined' ? window.localStorage.getItem('aegis-theme') : null;
    return saved === 'dark' ? 'dark' : 'light';
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    window.localStorage.setItem('aegis-theme', theme);
  }, [theme]);

  const checkBootstrapStatus = useCallback(async () => {
    const status = await apiRequest<{
      authenticated?: boolean;
      needsSetup: boolean;
      databaseReady: boolean;
      emailProviderConfigured: boolean;
    }>('/auth/status', { timeoutMs: 6_000 });
    setNeedsSetup(Boolean(status.needsSetup));
    setEmailProviderConfigured(Boolean(status.emailProviderConfigured));
    return status;
  }, []);

  const refreshSession = useCallback(async () => {
    setAuthError(null);
    try {
      const status = await checkBootstrapStatus();
      if (!status.authenticated) {
        setAdminUser(null);
        setPermissions(new Set());
        setSessions([]);
        return;
      }

      const data = await apiRequest<{
        user: AdminUserProfile;
        permissions: string[];
        sessions: SessionInfo[];
      }>('/auth/session', { timeoutMs: 6_000 });

      setAdminUser(data.user);
      setPermissions(new Set(data.permissions));
      setSessions(data.sessions);
      setNeedsSetup(false);

      if (data.user.preferences?.theme === 'dark' || data.user.preferences?.theme === 'light') {
        setTheme(data.user.preferences.theme);
      }
    } catch (err) {
      setAdminUser(null);
      setPermissions(new Set());
      setSessions([]);

      if (err instanceof ApiError && err.status === 401) {
        try {
          await checkBootstrapStatus();
        } catch (statusErr) {
          setAuthError(
            statusErr instanceof Error
              ? statusErr.message
              : 'Unable to verify server and database status.'
          );
        }
      } else {
        setAuthError(
          err instanceof Error ? err.message : 'Unable to reach authentication service.'
        );
      }
    } finally {
      setLoading(false);
    }
  }, [checkBootstrapStatus]);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  const retryConnection = useCallback(async () => {
    setLoading(true);
    await refreshSession();
  }, [refreshSession]);

  const setupInitialAdmin = useCallback(
    async (input: { password: string }) => {
      setAuthError(null);
      await apiRequest('/auth/setup', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      await refreshSession();
    },
    [refreshSession]
  );

  const loginWithPassword = useCallback(
    async (input: { password: string; totpCode?: string }) => {
      setAuthError(null);
      const res = await apiRequest<{ ok?: boolean; requiresTwoFactor?: boolean }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (res.requiresTwoFactor) {
        return { requiresTwoFactor: true };
      }
      await refreshSession();
      return { requiresTwoFactor: false };
    },
    [refreshSession]
  );

  const logout = useCallback(async () => {
    try {
      await apiRequest('/auth/logout', { method: 'POST' });
    } catch {
      // Clear local session state even if server session was already invalidated
    } finally {
      setAdminUser(null);
      setPermissions(new Set());
      setSessions([]);
      setAuthError(null);
      void checkBootstrapStatus().catch(() => {});
    }
  }, [checkBootstrapStatus]);

  const setThemeMode = useCallback(
    (mode: 'light' | 'dark') => {
      setTheme(mode);
      if (adminUser) {
        void apiRequest('/auth/preferences', {
          method: 'PATCH',
          body: JSON.stringify({ theme: mode }),
        }).catch(() => {});
      }
    },
    [adminUser]
  );

  const toggleTheme = useCallback(() => {
    setThemeMode(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setThemeMode]);

  const hasPerm = useCallback(
    (perm: string | string[]) => {
      if (Array.isArray(perm)) {
        return perm.some((p) => permissions.has(p));
      }
      return permissions.has(perm);
    },
    [permissions]
  );

  return (
    <AuthContext.Provider
      value={{
        adminUser,
        permissions,
        sessions,
        loading,
        authError,
        needsSetup,
        emailProviderConfigured,
        theme,
        toggleTheme,
        setThemeMode,
        hasPerm,
        setupInitialAdmin,
        loginWithPassword,
        logout,
        refreshSession,
        retryConnection,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
