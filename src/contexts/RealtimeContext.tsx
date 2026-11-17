import React, { createContext, useContext, useEffect, useState } from 'react';
import { apiRequest } from '../lib/api';
import { useAuth } from './AuthContext';

export interface RealtimeEvent {
  type: string;
  payload: unknown;
  receivedAt: string;
}

interface RealtimeContextValue {
  connected: boolean;
  onlineUserIds: number[];
  activeConnections: number;
  lastHeartbeatAt: number | null;
  recentEvents: RealtimeEvent[];
}

const RealtimeContext = createContext<RealtimeContextValue>({
  connected: false,
  onlineUserIds: [],
  activeConnections: 0,
  lastHeartbeatAt: null,
  recentEvents: [],
});

export const RealtimeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { adminUser } = useAuth();
  const [connected, setConnected] = useState(false);
  const [onlineUserIds, setOnlineUserIds] = useState<number[]>([]);
  const [activeConnections, setActiveConnections] = useState(0);
  const [lastHeartbeatAt, setLastHeartbeatAt] = useState<number | null>(null);
  const [recentEvents, setRecentEvents] = useState<RealtimeEvent[]>([]);

  useEffect(() => {
    if (!adminUser) {
      setConnected(false);
      setOnlineUserIds([]);
      setActiveConnections(0);
      setRecentEvents([]);
      return;
    }

    let cancelled = false;

    const pollSnapshot = async () => {
      try {
        const res = await apiRequest<{
          onlineUserIds: number[];
          activeConnections: number;
          recentEvents: RealtimeEvent[];
        }>('/realtime/snapshot', { timeoutMs: 8_000 });
        if (cancelled) return;
        setConnected(true);
        setOnlineUserIds(res.onlineUserIds);
        setActiveConnections(res.activeConnections);
        setRecentEvents(res.recentEvents);
        setLastHeartbeatAt(Date.now());
      } catch {
        if (!cancelled) setConnected(false);
      }
    };

    void pollSnapshot();
    const timer = setInterval(() => {
      void pollSnapshot();
    }, 15_000);

    return () => {
      cancelled = true;
      clearInterval(timer);
      setConnected(false);
    };
  }, [adminUser]);

  return (
    <RealtimeContext.Provider
      value={{ connected, onlineUserIds, activeConnections, lastHeartbeatAt, recentEvents }}
    >
      {children}
    </RealtimeContext.Provider>
  );
};

export function useRealtime(): RealtimeContextValue {
  return useContext(RealtimeContext);
}
