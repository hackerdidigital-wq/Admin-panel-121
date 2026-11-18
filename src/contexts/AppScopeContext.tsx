import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { apiRequest } from '../lib/api';
import { useAuth } from './AuthContext';

export interface ConnectedAppRecord {
  id: number;
  appUid: string;
  slug: string;
  name: string;
  platform: 'android' | 'unity' | 'game' | 'website' | 'ios' | 'api' | string;
  packageOrDomain: string;
  description: string;
  status: 'connected' | 'disconnected' | 'maintenance' | string;
  currentVersion: string;
  minSupportedVersion: string;
  forceUpdate: boolean;
  maintenanceMessage: string;
  admobAppId: string;
  adsEnabled: boolean;
  healthStatus: 'healthy' | 'degraded' | 'offline' | string;
  lastHeartbeatAt: string | null;
  lastLatencyMs: number;
  errorCount24h: number;
  backendNamespace?: string;
  integrationMode?: 'aegis_managed' | 'external_backend' | 'hybrid' | string;
  backendBaseUrl?: string;
  manifestUrl?: string;
  discoveredCapabilities?: Record<string, unknown>;
  enabledModules?: string[];
  syncStatus?: 'unverified' | 'verified' | 'partial' | 'sync_failed' | string;
  endUsersCount?: number;
  activeKeysCount?: number;
  hasWebhookSecret?: boolean;
  createdAt: string;
  updatedAt: string;
}

export type AppScopeValue = 'all' | number;

interface AppScopeContextValue {
  apps: ConnectedAppRecord[];
  selectedAppId: AppScopeValue;
  selectedApp: ConnectedAppRecord | null;
  loading: boolean;
  setSelectedAppId: (id: AppScopeValue) => void;
  refreshApps: () => Promise<void>;
  appQueryParam: string | null;
}

const AppScopeContext = createContext<AppScopeContextValue | null>(null);

export const AppScopeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { adminUser, hasPerm } = useAuth();
  const [apps, setApps] = useState<ConnectedAppRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedAppId, setSelectedAppIdState] = useState<AppScopeValue>(() => {
    if (typeof window === 'undefined') return 'all';
    const raw = window.localStorage.getItem('aegis-selected-app-id');
    if (!raw || raw === 'all') return 'all';
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 'all';
  });

  const setSelectedAppId = useCallback((id: AppScopeValue) => {
    setSelectedAppIdState(id);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('aegis-selected-app-id', String(id));
    }
  }, []);

  const refreshApps = useCallback(async () => {
    if (!adminUser || (!hasPerm('apps.read') && !hasPerm('dashboard.read'))) {
      setApps([]);
      return;
    }
    setLoading(true);
    try {
      const res = await apiRequest<{ data: ConnectedAppRecord[] }>('/apps');
      setApps(res.data || []);
      setSelectedAppIdState((prev) => {
        if (prev === 'all') return 'all';
        const exists = (res.data || []).some((a) => a.id === prev);
        if (!exists) {
          if (typeof window !== 'undefined') {
            window.localStorage.setItem('aegis-selected-app-id', 'all');
          }
          return 'all';
        }
        return prev;
      });
    } catch {
      // Non-fatal if role lacks apps.read
    } finally {
      setLoading(false);
    }
  }, [adminUser, hasPerm]);

  useEffect(() => {
    if (adminUser) {
      void refreshApps();
    } else {
      setApps([]);
    }
  }, [adminUser, refreshApps]);

  const selectedApp = useMemo(
    () => (selectedAppId === 'all' ? null : apps.find((a) => a.id === selectedAppId) ?? null),
    [apps, selectedAppId]
  );

  const appQueryParam = selectedAppId === 'all' ? null : String(selectedAppId);

  return (
    <AppScopeContext.Provider
      value={{
        apps,
        selectedAppId,
        selectedApp,
        loading,
        setSelectedAppId,
        refreshApps,
        appQueryParam,
      }}
    >
      {children}
    </AppScopeContext.Provider>
  );
};

export function useAppScope(): AppScopeContextValue {
  const ctx = useContext(AppScopeContext);
  if (!ctx) throw new Error('useAppScope must be used inside AppScopeProvider');
  return ctx;
}
