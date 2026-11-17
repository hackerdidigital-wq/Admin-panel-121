import React, { useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Bookmark,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Download,
  RefreshCw,
  Search,
  SlidersHorizontal,
} from 'lucide-react';
import { toCsv } from '../../lib/csv';

export interface TableColumn<T> {
  key: string;
  label: string;
  sortable?: boolean;
  align?: 'left' | 'right';
  width?: number;
  render?: (row: T) => React.ReactNode;
  csvValue?: (row: T) => unknown;
}

export interface DataTableProps<T extends { id: string | number }> {
  tableId: string;
  columns: TableColumn<T>[];
  rows: T[];
  total?: number;
  page?: number;
  pageSize?: number;
  onPageChange?: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  search?: string;
  onSearchChange?: (val: string) => void;
  searchPlaceholder?: string;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  onSortChange?: (key: string) => void;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: React.ReactNode;
  selectable?: boolean;
  selectedIds?: Array<string | number>;
  onSelectionChange?: (ids: Array<string | number>) => void;
  bulkActions?: React.ReactNode;
  filterControls?: React.ReactNode;
  dateRange?: { from: string; to: string };
  onDateRangeChange?: (range: { from: string; to: string }) => void;
  exportFilename?: string;
  onRowClick?: (row: T) => void;
}

export function DataTable<T extends { id: string | number }>({
  tableId,
  columns,
  rows,
  total,
  page = 1,
  pageSize = 20,
  onPageChange,
  onPageSizeChange,
  search = '',
  onSearchChange,
  searchPlaceholder = 'Search records...',
  sortBy,
  sortDir = 'desc',
  onSortChange,
  loading = false,
  error = null,
  onRetry,
  emptyTitle = 'No matching records',
  emptyDescription = 'Adjust your filters or add a new record to populate this view.',
  emptyAction,
  selectable = false,
  selectedIds = [],
  onSelectionChange,
  bulkActions,
  filterControls,
  dateRange,
  onDateRangeChange,
  exportFilename,
  onRowClick,
}: DataTableProps<T>) {
  const [hiddenCols, setHiddenCols] = useState<string[]>([]);
  const [colWidths, setColWidths] = useState<Record<string, number>>({});
  const [showColMenu, setShowColMenu] = useState(false);
  const [showDateFilters, setShowDateFilters] = useState(false);
  const [savedFilterName, setSavedFilterName] = useState('');
  const [savedFilters, setSavedFilters] = useState<Array<{ name: string; search: string }>>(() => {
    try {
      const raw = window.localStorage.getItem(`aegis-filters-${tableId}`);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });

  const visibleColumns = useMemo(
    () => columns.filter((c) => !hiddenCols.includes(c.key)),
    [columns, hiddenCols]
  );

  const totalCount = total ?? rows.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  const allSelected = rows.length > 0 && rows.every((r) => selectedIds.includes(r.id));

  const toggleAll = () => {
    if (!onSelectionChange) return;
    if (allSelected) {
      onSelectionChange([]);
    } else {
      onSelectionChange(rows.map((r) => r.id));
    }
  };

  const toggleRow = (id: string | number) => {
    if (!onSelectionChange) return;
    if (selectedIds.includes(id)) {
      onSelectionChange(selectedIds.filter((i) => i !== id));
    } else {
      onSelectionChange([...selectedIds, id]);
    }
  };

  const handleExportCsv = () => {
    const headers = visibleColumns.map((c) => c.label);
    const data = rows.map((row) => {
      const obj: Record<string, unknown> = {};
      for (const col of visibleColumns) {
        obj[col.label] = col.csvValue
          ? col.csvValue(row)
          : (row as Record<string, unknown>)[col.key];
      }
      return obj;
    });
    const csv = toCsv(headers, data);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exportFilename || `${tableId}-export.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const saveCurrentFilter = () => {
    const name = savedFilterName.trim();
    if (!name) return;
    const next = [...savedFilters.filter((f) => f.name !== name), { name, search }];
    setSavedFilters(next);
    setSavedFilterName('');
    window.localStorage.setItem(`aegis-filters-${tableId}`, JSON.stringify(next));
  };

  const startResize = (key: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const initialWidth = colWidths[key] || 160;
    const onMove = (moveEv: MouseEvent) => {
      const nextWidth = Math.max(90, Math.min(480, initialWidth + (moveEv.clientX - startX)));
      setColWidths((prev) => ({ ...prev, [key]: nextWidth }));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 p-4 dark:border-slate-800">
        <div className="flex flex-wrap items-center gap-2.5">
          {onSearchChange && (
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="search"
                value={search}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                className="h-9 w-64 rounded-lg border border-slate-200 bg-slate-50 pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:focus:bg-slate-900"
              />
            </div>
          )}
          {filterControls}
          {onDateRangeChange && (
            <button
              type="button"
              onClick={() => setShowDateFilters((v) => !v)}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              Date Range
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {selectedIds.length > 0 && bulkActions}

          {savedFilters.length > 0 && onSearchChange && (
            <select
              aria-label="Apply saved filter"
              value=""
              onChange={(e) => {
                const found = savedFilters.find((f) => f.name === e.target.value);
                if (found) onSearchChange(found.search);
              }}
              className="h-9 rounded-lg border border-slate-200 bg-white px-2.5 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            >
              <option value="">Saved filters ({savedFilters.length})</option>
              {savedFilters.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.name}
                </option>
              ))}
            </select>
          )}

          {onSearchChange && search.trim() !== '' && (
            <div className="flex items-center gap-1">
              <input
                type="text"
                value={savedFilterName}
                onChange={(e) => setSavedFilterName(e.target.value)}
                placeholder="Save filter as..."
                aria-label="Saved filter name"
                className="h-9 w-32 rounded-lg border border-slate-200 bg-white px-2.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
              <button
                type="button"
                onClick={saveCurrentFilter}
                aria-label="Save filter preset"
                className="inline-flex h-9 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
              >
                <Bookmark className="h-3.5 w-3.5" />
                Save
              </button>
            </div>
          )}

          <div className="relative">
            <button
              type="button"
              onClick={() => setShowColMenu((v) => !v)}
              aria-label="Toggle column visibility"
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              <Columns3 className="h-3.5 w-3.5" />
              Columns
            </button>
            {showColMenu && (
              <div className="absolute right-0 top-11 z-20 w-52 rounded-lg border border-slate-200 bg-white p-2 shadow-lg dark:border-slate-700 dark:bg-slate-900">
                {columns.map((col) => {
                  const checked = !hiddenCols.includes(col.key);
                  return (
                    <label
                      key={col.key}
                      className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setHiddenCols((prev) =>
                            checked ? [...prev, col.key] : prev.filter((k) => k !== col.key)
                          )
                        }
                      />
                      <span>{col.label}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={handleExportCsv}
            disabled={rows.length === 0}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </button>
        </div>
      </div>

      {/* Optional Date Range Filter Bar */}
      {showDateFilters && onDateRangeChange && (
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-xs dark:border-slate-800 dark:bg-slate-950">
          <label className="flex items-center gap-2 text-slate-600 dark:text-slate-400">
            <span>From</span>
            <input
              type="date"
              value={dateRange?.from || ''}
              onChange={(e) =>
                onDateRangeChange({ from: e.target.value, to: dateRange?.to || '' })
              }
              className="rounded border border-slate-200 bg-white px-2 py-1 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            />
          </label>
          <label className="flex items-center gap-2 text-slate-600 dark:text-slate-400">
            <span>To</span>
            <input
              type="date"
              value={dateRange?.to || ''}
              onChange={(e) =>
                onDateRangeChange({ from: dateRange?.from || '', to: e.target.value })
              }
              className="rounded border border-slate-200 bg-white px-2 py-1 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            />
          </label>
          <button
            type="button"
            onClick={() => onDateRangeChange({ from: '', to: '' })}
            className="text-blue-600 hover:underline dark:text-blue-400"
          >
            Clear dates
          </button>
        </div>
      )}

      {/* Error State */}
      {error && (
        <div className="flex items-center justify-between gap-4 border-b border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
          <span>{error}</span>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-1.5 rounded-md border border-red-300 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50 dark:border-red-800 dark:bg-slate-900 dark:text-red-300"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Retry
            </button>
          )}
        </div>
      )}

      {/* Table Body */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50/75 text-xs font-medium text-slate-500 dark:border-slate-800 dark:bg-slate-950/60 dark:text-slate-400">
              {selectable && (
                <th className="w-10 px-4 py-2.5">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    aria-label="Select all visible rows"
                  />
                </th>
              )}
              {visibleColumns.map((col) => {
                const isSorted = sortBy === col.key;
                const widthStyle = colWidths[col.key]
                  ? { width: colWidths[col.key], minWidth: colWidths[col.key] }
                  : col.width
                    ? { width: col.width }
                    : undefined;

                return (
                  <th
                    key={col.key}
                    style={widthStyle}
                    className={`relative select-none whitespace-nowrap px-4 py-2.5 ${
                      col.align === 'right' ? 'text-right' : 'text-left'
                    }`}
                  >
                    {col.sortable && onSortChange ? (
                      <button
                        type="button"
                        onClick={() => onSortChange(col.key)}
                        className="inline-flex items-center gap-1 font-medium text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
                      >
                        <span>{col.label}</span>
                        {isSorted ? (
                          sortDir === 'asc' ? (
                            <ArrowUp className="h-3.5 w-3.5 text-blue-600" />
                          ) : (
                            <ArrowDown className="h-3.5 w-3.5 text-blue-600" />
                          )
                        ) : (
                          <ArrowUpDown className="h-3.5 w-3.5 opacity-40" />
                        )}
                      </button>
                    ) : (
                      <span>{col.label}</span>
                    )}
                    <span
                      onMouseDown={(e) => startResize(col.key, e)}
                      aria-hidden="true"
                      className="absolute right-0 top-1.5 h-5 w-1.5 cursor-col-resize rounded hover:bg-blue-400"
                    />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
            {loading ? (
              Array.from({ length: 5 }).map((_, idx) => (
                <tr key={idx} className="animate-pulse">
                  {selectable && (
                    <td className="px-4 py-3">
                      <div className="h-4 w-4 rounded bg-slate-200 dark:bg-slate-800" />
                    </td>
                  )}
                  {visibleColumns.map((col) => (
                    <td key={col.key} className="px-4 py-3">
                      <div className="h-4 w-28 rounded bg-slate-200 dark:bg-slate-800" />
                    </td>
                  ))}
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td
                  colSpan={visibleColumns.length + (selectable ? 1 : 0)}
                  className="px-6 py-12 text-center"
                >
                  <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    {emptyTitle}
                  </p>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    {emptyDescription}
                  </p>
                  {emptyAction && <div className="mt-4">{emptyAction}</div>}
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const isSelected = selectedIds.includes(row.id);
                return (
                  <tr
                    key={row.id}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    className={`transition-colors ${
                      onRowClick ? 'cursor-pointer' : ''
                    } ${
                      isSelected
                        ? 'bg-blue-50/60 dark:bg-blue-950/30'
                        : 'hover:bg-slate-50/80 dark:hover:bg-slate-800/40'
                    }`}
                  >
                    {selectable && (
                      <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleRow(row.id)}
                          aria-label={`Select row ${row.id}`}
                        />
                      </td>
                    )}
                    {visibleColumns.map((col) => (
                      <td
                        key={col.key}
                        className={`px-4 py-2.5 text-slate-700 dark:text-slate-300 ${
                          col.align === 'right' ? 'text-right tabular-nums' : 'text-left'
                        }`}
                      >
                        {col.render
                          ? col.render(row)
                          : String((row as Record<string, unknown>)[col.key] ?? '—')}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination Footer */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
        <div className="flex items-center gap-3 tabular-nums">
          <span>
            Showing {rows.length} of {totalCount} records
          </span>
          {onPageSizeChange && (
            <label className="flex items-center gap-1.5">
              <span>Rows</span>
              <select
                value={pageSize}
                onChange={(e) => onPageSizeChange(Number(e.target.value))}
                aria-label="Rows per page"
                className="rounded border border-slate-200 bg-white px-1.5 py-1 text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
              >
                {[10, 20, 50, 100].map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {onPageChange && (
          <div className="flex items-center gap-2 tabular-nums">
            <span>
              Page {page} of {totalPages}
            </span>
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => onPageChange(page - 1)}
              aria-label="Previous page"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => onPageChange(page + 1)}
              aria-label="Next page"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
