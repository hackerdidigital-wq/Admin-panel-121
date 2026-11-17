import React, { useState } from 'react';
import { ChevronDown, ChevronRight, PanelLeftClose, PanelLeftOpen, ShieldCheck, X } from 'lucide-react';
import { SIDEBAR_MODULES } from '../../config/navigation';
import { useAuth } from '../../contexts/AuthContext';

interface SidebarProps {
  activeView: string;
  collapsed: boolean;
  mobileOpen: boolean;
  onToggleCollapse: () => void;
  onCloseMobile: () => void;
  onSelectView: (viewId: string) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeView,
  collapsed,
  mobileOpen,
  onToggleCollapse,
  onCloseMobile,
  onSelectView,
}) => {
  const { hasPerm } = useAuth();
  const [expandedModules, setExpandedModules] = useState<string[]>(['overview', 'users']);

  const toggleModule = (modId: string) => {
    setExpandedModules((prev) =>
      prev.includes(modId) ? prev.filter((id) => id !== modId) : [...prev, modId]
    );
  };

  const visibleModules = SIDEBAR_MODULES.filter(
    (m) => !m.permission || hasPerm(m.permission)
  );

  const navContent = (
    <div className="flex h-full flex-col border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
      {/* Brand Header */}
      <div className="flex h-14 items-center justify-between border-b border-slate-200 px-3.5 dark:border-slate-800">
        {!collapsed && (
          <div className="flex items-center gap-2.5 overflow-hidden">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white">
              <ShieldCheck className="h-4 w-4" strokeWidth={2} />
            </div>
            <span className="truncate font-display text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100">
              Aegis Console
            </span>
          </div>
        )}
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="hidden h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900 lg:inline-flex dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
        >
          {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
        </button>
        <button
          type="button"
          onClick={onCloseMobile}
          aria-label="Close navigation menu"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 lg:hidden dark:text-slate-400"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Multi-level Module List */}
      <nav aria-label="Primary administration modules" className="flex-1 overflow-y-auto px-2.5 py-3">
        <ul className="space-y-1">
          {visibleModules.map((mod) => {
            const Icon = mod.icon;
            const visibleSubs = mod.submenus.filter(
              (s) => !s.permission || hasPerm(s.permission)
            );
            if (visibleSubs.length === 0) return null;

            const hasActiveChild = visibleSubs.some((s) => s.id === activeView);
            const isExpanded = expandedModules.includes(mod.id) || hasActiveChild;

            return (
              <li key={mod.id}>
                <button
                  type="button"
                  aria-expanded={isExpanded}
                  onClick={() => {
                    if (collapsed) {
                      onSelectView(visibleSubs[0].id);
                    } else {
                      toggleModule(mod.id);
                    }
                  }}
                  title={collapsed ? mod.label : undefined}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-medium transition-colors ${
                    hasActiveChild
                      ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300'
                      : 'text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-900'
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <Icon className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                    {!collapsed && <span className="truncate">{mod.label}</span>}
                  </span>
                  {!collapsed &&
                    (isExpanded ? (
                      <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-60" />
                    ))}
                </button>

                {!collapsed && isExpanded && (
                  <ul className="mt-1 space-y-0.5 pl-7">
                    {visibleSubs.map((sub) => {
                      const isActive = activeView === sub.id;
                      return (
                        <li key={sub.id}>
                          <button
                            type="button"
                            onClick={() => {
                              onSelectView(sub.id);
                              onCloseMobile();
                            }}
                            className={`flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
                              isActive
                                ? 'bg-slate-100 font-semibold text-slate-900 dark:bg-slate-800 dark:text-slate-100'
                                : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-900 dark:hover:text-slate-200'
                            }`}
                          >
                            <span className="truncate">{sub.label}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );

  return (
    <>
      {/* Desktop Sidebar */}
      <aside
        className={`hidden shrink-0 transition-[width] duration-150 lg:block ${
          collapsed ? 'w-16' : 'w-64'
        }`}
      >
        <div className="sticky top-0 h-screen">{navContent}</div>
      </aside>

      {/* Mobile Drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <div className="fixed inset-0 bg-slate-950/50" onClick={onCloseMobile} />
          <aside className="relative z-10 h-full w-72 max-w-[85vw]">{navContent}</aside>
        </div>
      )}
    </>
  );
};
