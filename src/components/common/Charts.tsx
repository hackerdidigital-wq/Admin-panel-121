import React from 'react';

export interface ChartPoint {
  label: string;
  value: number;
  secondaryValue?: number;
}

export const SimpleBarChart: React.FC<{
  data: ChartPoint[];
  primaryLabel?: string;
  secondaryLabel?: string;
  emptyMessage?: string;
  height?: number;
}> = ({
  data,
  primaryLabel = 'Primary',
  secondaryLabel,
  emptyMessage = 'No recorded database events in this window.',
  height = 180,
}) => {
  if (!data || data.length === 0) {
    return (
      <div
        style={{ height }}
        className="flex items-center justify-center rounded-lg border border-dashed border-slate-200 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400"
      >
        {emptyMessage}
      </div>
    );
  }

  const maxVal = Math.max(
    1,
    ...data.map((d) => Math.max(d.value, d.secondaryValue ?? 0))
  );

  return (
    <div className="space-y-3">
      <div
        style={{ height }}
        className="flex items-end gap-2 border-b border-slate-200 pb-2 pt-4 dark:border-slate-800"
      >
        {data.map((point) => {
          const pct = Math.max(4, Math.round((point.value / maxVal) * 100));
          const secPct =
            point.secondaryValue !== undefined
              ? Math.max(4, Math.round((point.secondaryValue / maxVal) * 100))
              : null;

          return (
            <div key={point.label} className="group flex h-full flex-1 flex-col items-center justify-end gap-1">
              <div className="flex h-full w-full items-end justify-center gap-1">
                <div
                  title={`${point.label} · ${primaryLabel}: ${point.value}`}
                  style={{ height: `${pct}%` }}
                  className="w-full max-w-[18px] rounded-t bg-blue-600 transition-opacity group-hover:opacity-85 dark:bg-blue-500"
                />
                {secPct !== null && (
                  <div
                    title={`${point.label} · ${secondaryLabel}: ${point.secondaryValue}`}
                    style={{ height: `${secPct}%` }}
                    className="w-full max-w-[18px] rounded-t bg-red-500 transition-opacity group-hover:opacity-85"
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between gap-2 overflow-x-auto text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
        {data.map((d) => (
          <span key={d.label} className="truncate text-center">
            {d.label.slice(5)}
          </span>
        ))}
      </div>
    </div>
  );
};
