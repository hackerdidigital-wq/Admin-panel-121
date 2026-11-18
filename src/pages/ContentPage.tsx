import React, { useCallback, useEffect, useState } from 'react';
import { Check, History, Plus, Trash2 } from 'lucide-react';
import { apiRequest } from '../lib/api';
import { DataTable, type TableColumn } from '../components/common/DataTable';
import { useToast } from '../components/common/Toast';
import { useAppScope } from '../contexts/AppScopeContext';
import { useAuth } from '../contexts/AuthContext';

interface ContentRow {
  id: number;
  appId?: number | null;
  title: string;
  slug: string;
  excerpt: string;
  body: string;
  status: string;
  categoryId: number | null;
  categoryName: string | null;
  tags: string[];
  authorEmail: string | null;
  version: number;
  updatedAt: string;
}

interface CategoryRow {
  id: number;
  name: string;
  slug: string;
  description: string;
}

export const ContentPage: React.FC<{ subview: string }> = ({ subview }) => {
  const { hasPerm } = useAuth();
  const { appQueryParam, selectedApp } = useAppScope();
  const { pushToast } = useToast();
  const [rows, setRows] = useState<ContentRow[]>([]);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Array<string | number>>([]);

  // Editor modal
  const [editing, setEditing] = useState<ContentRow | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [excerpt, setExcerpt] = useState('');
  const [status, setStatus] = useState('draft');
  const [categoryId, setCategoryId] = useState('');
  const [tagsText, setTagsText] = useState('');

  // Versions modal
  const [versionsFor, setVersionsFor] = useState<{ title: string; items: Array<{ id: number; version: number; title: string; changeSummary: string; createdAt: string }> } | null>(null);

  // New Category
  const [catName, setCatName] = useState('');

  const statusFilter =
    subview === 'content-drafts'
      ? 'draft'
      : subview === 'content-approval'
        ? 'pending_approval'
        : subview === 'content-published'
          ? 'published'
          : subview === 'content-scheduled'
            ? 'scheduled'
            : subview === 'content-archived'
              ? 'archived'
              : subview === 'content-trash'
                ? 'trash'
                : 'all';

  const loadContent = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({
        page: String(page),
        pageSize: '20',
        search,
        status: statusFilter,
      });
      if (appQueryParam) qs.set('appId', appQueryParam);
      const res = await apiRequest<{
        data: ContentRow[];
        total: number;
        categories: CategoryRow[];
      }>(`/content?${qs.toString()}`);
      setRows(res.data);
      setTotal(res.total);
      setCategories(res.categories);
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Failed to load content',
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setLoading(false);
    }
  }, [page, search, statusFilter, appQueryParam, pushToast]);

  useEffect(() => {
    void loadContent();
  }, [loadContent]);

  useEffect(() => {
    if (subview === 'content-create') {
      setEditing(null);
      setTitle('');
      setBody('');
      setExcerpt('');
      setStatus('draft');
      setShowEditor(true);
    }
  }, [subview]);

  const saveContent = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const payload = {
        appId: selectedApp ? selectedApp.id : null,
        title,
        body,
        excerpt,
        status,
        categoryId: categoryId ? Number(categoryId) : null,
        tags: tagsText
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      };
      if (editing) {
        await apiRequest(`/content/${editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        pushToast({ type: 'success', title: 'Content updated (new version saved)' });
      } else {
        await apiRequest('/content', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        pushToast({ type: 'success', title: 'Content created' });
      }
      setShowEditor(false);
      await loadContent();
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Save failed',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const viewVersions = async (item: ContentRow) => {
    try {
      const res = await apiRequest<{
        versions: Array<{ id: number; version: number; title: string; changeSummary: string; createdAt: string }>;
      }>(`/content/${item.id}/versions`);
      setVersionsFor({ title: item.title, items: res.versions });
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Version lookup failed',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const bulkPublish = async () => {
    try {
      await apiRequest('/content/bulk-publish', {
        method: 'POST',
        body: JSON.stringify({ ids: selectedIds }),
      });
      pushToast({ type: 'success', title: `Published ${selectedIds.length} item(s)` });
      setSelectedIds([]);
      await loadContent();
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Bulk publish failed',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const createCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!catName.trim()) return;
    try {
      await apiRequest('/categories', {
        method: 'POST',
        body: JSON.stringify({ name: catName }),
      });
      setCatName('');
      pushToast({ type: 'success', title: 'Category created' });
      await loadContent();
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Failed to create category',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const updateRowStatus = async (id: number, nextStatus: string, label: string) => {
    try {
      await apiRequest(`/content/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: nextStatus }),
      });
      pushToast({ type: 'success', title: label });
      await loadContent();
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Status update failed',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  if (subview === 'content-categories') {
    return (
      <div className="space-y-6">
        <h1 className="font-display text-xl font-semibold">Content Categories & Tags</h1>
        {hasPerm('content.write') && (
          <form onSubmit={createCategory} className="flex max-w-md gap-2">
            <input
              value={catName}
              onChange={(e) => setCatName(e.target.value)}
              placeholder="New category name..."
              className="h-9 flex-1 rounded-lg border border-slate-200 bg-white px-3 text-xs dark:border-slate-700 dark:bg-slate-900"
            />
            <button type="submit" className="h-9 rounded-lg bg-blue-600 px-4 text-xs font-medium text-white">
              Add Category
            </button>
          </form>
        )}
        <div className="rounded-xl border border-slate-200 bg-white divide-y divide-slate-100 dark:border-slate-800 dark:bg-slate-900 dark:divide-slate-800">
          {categories.map((c) => (
            <div key={c.id} className="flex items-center justify-between px-4 py-3 text-xs">
              <div>
                <p className="font-medium text-slate-900 dark:text-slate-100">{c.name}</p>
                <p className="text-slate-500">/{c.slug} · {c.description}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const columns: TableColumn<ContentRow>[] = [
    {
      key: 'title',
      label: 'Title',
      render: (r) => (
        <div>
          <p className="font-medium text-slate-900 dark:text-slate-100">{r.title}</p>
          <p className="text-xs text-slate-500">/{r.slug} · v{r.version}</p>
        </div>
      ),
    },
    {
      key: 'categoryName',
      label: 'Category',
      render: (r) => <span>{r.categoryName || 'Uncategorized'}</span>,
    },
    {
      key: 'status',
      label: 'Status',
      render: (r) => <span className="capitalize">{r.status.replace('_', ' ')}</span>,
    },
    {
      key: 'actions',
      label: 'Actions',
      align: 'right',
      render: (r) => (
        <div className="inline-flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={() => void viewVersions(r)}
            aria-label={`View version history for ${r.title}`}
            className="rounded border border-slate-200 px-2 py-1 text-xs hover:bg-slate-50 dark:border-slate-700"
          >
            <History className="inline h-3.5 w-3.5 mr-1" />
            Versions
          </button>
          {hasPerm('content.publish') && r.status !== 'published' && (
            <button
              type="button"
              onClick={() => void updateRowStatus(r.id, 'published', 'Content published')}
              className="rounded bg-emerald-600 px-2 py-1 text-xs text-white"
            >
              <Check className="inline h-3.5 w-3.5 mr-1" />
              Publish
            </button>
          )}
          {hasPerm('content.delete') && r.status !== 'trash' && (
            <button
              type="button"
              onClick={() => void updateRowStatus(r.id, 'trash', 'Moved content to trash')}
              aria-label={`Move ${r.title} to trash`}
              className="rounded border border-red-200 px-2 py-1 text-xs text-red-600 dark:border-red-900"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold text-slate-900 dark:text-slate-100">
            Content Management
          </h1>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {selectedApp
              ? `Scoped to ${selectedApp.name} · Create, review, schedule, and publish in-app notices & articles.`
              : 'Create, review, schedule, version, and publish structured entries.'}
          </p>
        </div>
        {hasPerm('content.write') && (
          <button
            type="button"
            onClick={() => {
              setEditing(null);
              setTitle('');
              setBody('');
              setExcerpt('');
              setStatus('draft');
              setShowEditor(true);
            }}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 text-xs font-medium text-white hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" />
            New Content
          </button>
        )}
      </div>

      <DataTable<ContentRow>
        tableId="content-items"
        columns={columns}
        rows={rows}
        total={total}
        page={page}
        onPageChange={setPage}
        search={search}
        onSearchChange={setSearch}
        loading={loading}
        selectable={hasPerm('content.publish')}
        selectedIds={selectedIds}
        onSelectionChange={setSelectedIds}
        onRowClick={(r) => {
          setEditing(r);
          setTitle(r.title);
          setBody(r.body);
          setExcerpt(r.excerpt);
          setStatus(r.status);
          setCategoryId(r.categoryId ? String(r.categoryId) : '');
          setTagsText((r.tags || []).join(', '));
          setShowEditor(true);
        }}
        bulkActions={
          <button
            type="button"
            onClick={() => void bulkPublish()}
            className="rounded bg-emerald-600 px-3 py-1 text-xs font-medium text-white"
          >
            Bulk Publish ({selectedIds.length})
          </button>
        }
      />

      {showEditor && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4"
        >
          <form
            onSubmit={saveContent}
            className="w-full max-w-xl rounded-xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-slate-900"
          >
            <h2 className="font-display text-base font-semibold">
              {editing ? `Edit Content (v${editing.version})` : 'Create Content'}
            </h2>
            <div className="mt-4 space-y-3 text-xs">
              <div>
                <label className="block font-medium">Title *</label>
                <input
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium">Category</label>
                  <select
                    value={categoryId}
                    onChange={(e) => setCategoryId(e.target.value)}
                    className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
                  >
                    <option value="">Uncategorized</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-medium">Status</label>
                  <select
                    value={status}
                    onChange={(e) => setStatus(e.target.value)}
                    className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
                  >
                    <option value="draft">Draft</option>
                    <option value="pending_approval">Pending Approval</option>
                    {hasPerm('content.publish') && <option value="published">Published</option>}
                    <option value="archived">Archived</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block font-medium">Excerpt</label>
                <input
                  value={excerpt}
                  onChange={(e) => setExcerpt(e.target.value)}
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block font-medium">Body</label>
                <textarea
                  rows={5}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block font-medium">Tags (comma-separated)</label>
                <input
                  value={tagsText}
                  onChange={(e) => setTagsText(e.target.value)}
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowEditor(false)}
                className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-medium dark:border-slate-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white"
              >
                Save Content
              </button>
            </div>
          </form>
        </div>
      )}

      {versionsFor && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4"
        >
          <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
            <h2 className="font-display text-base font-semibold">
              Version History: {versionsFor.title}
            </h2>
            <ul className="mt-4 max-h-72 divide-y divide-slate-100 overflow-y-auto text-xs dark:divide-slate-800">
              {versionsFor.items.map((v) => (
                <li key={v.id} className="py-2.5">
                  <p className="font-medium">
                    v{v.version} · {v.title}
                  </p>
                  <p className="text-slate-500">
                    {v.changeSummary} · {new Date(v.createdAt).toLocaleString()}
                  </p>
                </li>
              ))}
            </ul>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => setVersionsFor(null)}
                className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-medium dark:border-slate-700"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
