import React, { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Clock, Search, X } from 'lucide-react';
import { apiRequest } from '../../lib/api';
import { SIDEBAR_MODULES } from '../../config/navigation';
import { useAuth } from '../../contexts/AuthContext';

interface SearchResult {
  id: string;
  entityId: string | number;
  type: string;
  title: string;
  subtitle: string;
  targetView: string;
}

interface CommandSearchProps {
  open: boolean;
  onClose: () => void;
  onNavigate: (viewId: string) => void;
}

const FILTER_TYPES = [
  { id: 'all', label: 'All' },
  { id: 'apps', label: 'Apps' },
  { id: 'users', label: 'Users' },
  { id: 'content', label: 'Content' },
  { id: 'transactions', label: 'Transactions' },
  { id: 'tickets', label: 'Tickets' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'settings', label: 'Settings' },
  { id: 'logs', label: 'Logs' },
];

export const CommandSearch: React.FC<CommandSearchProps> = ({ open, onClose, onNavigate }) => {
  const { hasPerm } = useAuth();
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [history, setHistory] = useState<string[]>(() => {
    try {
      const raw = window.localStorage.getItem('aegis-search-history');
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });

  const matchingPages = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pages: SearchResult[] = [];
    for (const mod of SIDEBAR_MODULES) {
      if (mod.permission && !hasPerm(mod.permission)) continue;
      for (const sub of mod.submenus) {
        if (sub.permission && !hasPerm(sub.permission)) continue;
        if (!q || sub.label.toLowerCase().includes(q) || mod.label.toLowerCase().includes(q)) {
          pages.push({
            id: `page-${sub.id}`,
            entityId: sub.id,
            type: 'page',
            title: sub.label,
            subtitle: `${mod.label} module`,
            targetView: sub.id,
          });
        }
      }
    }
    return pages.slice(0, q ? 6 : 8);
  }, [query, hasPerm]);

  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!q) {
      setResults([]);
      setActiveIndex(0);
      return;
    }

    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await apiRequest<{ results: SearchResult[] }>(
          `/search?q=${encodeURIComponent(q)}&type=${encodeURIComponent(typeFilter)}`
        );
        setResults(res.results);
        setActiveIndex(0);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 180);

    return () => clearTimeout(timer);
  }, [query, typeFilter, open]);

  const combinedResults = useMemo(() => {
    if (typeFilter === 'all') {
      return [...results, ...matchingPages];
    }
    return results;
  }, [results, matchingPages, typeFilter]);

  const selectItem = (item: SearchResult) => {
    if (query.trim()) {
      const nextHist = [query.trim(), ...history.filter((h) => h !== query.trim())].slice(0, 6);
      setHistory(nextHist);
      window.localStorage.setItem('aegis-search-history', JSON.stringify(nextHist));
    }
    onNavigate(item.targetView);
    onClose();
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => Math.min(Math.max(0, combinedResults.length - 1), i + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter' && combinedResults[activeIndex]) {
        e.preventDefault();
        selectItem(combinedResults[activeIndex]);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Global command search"
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/55 px-4 pt-20 backdrop-blur-[1px]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <Search className="h-4 w-4 text-slate-400" />
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search users, content, transactions, tickets, settings, logs, or pages..."
            aria-label="Global search query"
            className="flex-1 bg-transparent text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none dark:text-slate-100"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close global search"
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Entity type filter bar */}
        <div className="flex items-center gap-1 overflow-x-auto border-b border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-950">
          {FILTER_TYPES.map((ft) => (
            <button
              key={ft.id}
              type="button"
              onClick={() => setTypeFilter(ft.id)}
              className={`whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                typeFilter === ft.id
                  ? 'bg-white text-slate-900 shadow-xs dark:bg-slate-800 dark:text-slate-100'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
              }`}
            >
              {ft.label}
            </button>
          ))}
        </div>

        {/* Search History */}
        {!query.trim() && history.length > 0 && (
          <div className="border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
            <p className="mb-1.5 text-[11px] font-medium text-slate-400">Recent Searches</p>
            <div className="flex flex-wrap gap-2">
              {history.map((h) => (
                <button
                  key={h}
                  type="button"
                  onClick={() => setQuery(h)}
                  className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  <Clock className="h-3 w-3" />
                  {h}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Results */}
        <div className="max-h-96 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800/80">
          {loading ? (
            <div className="p-6 text-center text-xs text-slate-500">Searching database records...</div>
          ) : combinedResults.length === 0 ? (
            <div className="p-6 text-center text-xs text-slate-500">
              No permitted records matched "{query}".
            </div>
          ) : (
            combinedResults.map((item, idx) => (
              <button
                key={item.id}
                type="button"
                onClick={() => selectItem(item)}
                className={`flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors ${
                  idx === activeIndex
                    ? 'bg-blue-50/70 dark:bg-blue-950/40'
                    : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'
                }`}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                    {item.title}
                  </p>
                  <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                    <span className="capitalize">{item.type}</span> · {item.subtitle}
                  </p>
                </div>
                <ArrowRight className="h-4 w-4 shrink-0 text-slate-400" />
              </button>
            ))
          )}
        </div>

        <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-4 py-2 text-[11px] text-slate-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-400">
          <span>Use Up/Down arrows and Enter to open</span>
          <span className="font-mono">ESC to close</span>
        </div>
      </div>
    </div>
  );
};
