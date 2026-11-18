import React, { useCallback, useEffect, useState } from 'react';
import { Download, Edit3, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { apiRequest, downloadWithAuth } from '../lib/api';
import { DataTable, type TableColumn } from '../components/common/DataTable';
import { ConfirmDialog } from '../components/common/ConfirmDialog';
import { useToast } from '../components/common/Toast';
import { useAppScope } from '../contexts/AppScopeContext';
import { useAuth } from '../contexts/AuthContext';

interface TransactionRow {
  id: number;
  appId: number | null;
  reference: string;
  userEmail: string | null;
  amountCents: number;
  currency: string;
  type: string;
  status: string;
  paymentMethodLabel: string;
  fraudScore: number;
  createdAt: string;
}

interface AdRow {
  id: number;
  appId: number | null;
  name: string;
  network: string;
  adFormat: string;
  placement: string;
  admobUnitId: string;
  ecpmCents: number;
  frequencyCap: number;
  isEnabled: boolean;
  visibilityRule: string;
  impressions: number;
  clicks: number;
  revenueCents: number;
  errorMessage: string;
}

export const FinancePage: React.FC<{ subview: string }> = ({ subview }) => {
  const { hasPerm } = useAuth();
  const { pushToast } = useToast();
  const { selectedAppId, selectedApp } = useAppScope();
  const [rows, setRows] = useState<TransactionRow[]>([]);
  const [summary, setSummary] = useState({
    succeededCents: 0,
    refundedCents: 0,
    payoutsCents: 0,
    failedCount: 0,
    flaggedCount: 0,
  });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [amountUsd, setAmountUsd] = useState('49.00');
  const [type, setType] = useState('payment');
  const [methodLabel, setMethodLabel] = useState('Visa •••• 4242');
  const [refundTarget, setRefundTarget] = useState<TransactionRow | null>(null);

  const loadFinance = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ search });
      if (subview === 'finance-failed') qs.set('status', 'failed');
      if (subview === 'finance-refunds') qs.set('status', 'refunded');
      if (subview === 'finance-payouts') qs.set('type', 'payout');
      if (subview === 'finance-fraud') qs.set('status', 'flagged');
      if (selectedAppId !== 'all') qs.set('appId', String(selectedAppId));

      const res = await apiRequest<{ data: TransactionRow[]; summary: typeof summary }>(
        `/finance/transactions?${qs.toString()}`
      );
      setRows(res.data);
      setSummary(res.summary);
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Failed to load financial records',
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setLoading(false);
    }
  }, [subview, search, selectedAppId, pushToast]);

  useEffect(() => {
    void loadFinance();
  }, [loadFinance]);

  const recordTransaction = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const amountCents = Math.round(Number(amountUsd) * 100);
      await apiRequest('/finance/transactions', {
        method: 'POST',
        body: JSON.stringify({
          amountCents,
          type,
          paymentMethodLabel: methodLabel,
          appId: selectedAppId !== 'all' ? selectedAppId : null,
        }),
      });
      pushToast({ type: 'success', title: 'Transaction recorded' });
      setShowCreate(false);
      await loadFinance();
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Could not record entry',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const processRefund = async () => {
    if (!refundTarget) return;
    try {
      await apiRequest(`/finance/transactions/${refundTarget.id}/refund`, { method: 'POST' });
      pushToast({ type: 'success', title: `Refunded ${refundTarget.reference}` });
      setRefundTarget(null);
      await loadFinance();
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Refund failed',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const exportSuffix = selectedAppId !== 'all' ? `?appId=${selectedAppId}` : '';

  const columns: TableColumn<TransactionRow>[] = [
    { key: 'reference', label: 'Reference', render: (r) => <span className="font-mono text-xs">{r.reference}</span> },
    { key: 'type', label: 'Type', render: (r) => <span className="capitalize">{r.type}</span> },
    {
      key: 'amountCents',
      label: 'Amount',
      align: 'right',
      render: (r) => (
        <span className="font-mono tabular-nums">
          {(r.amountCents / 100).toFixed(2)} {r.currency}
        </span>
      ),
    },
    { key: 'paymentMethodLabel', label: 'Method (Masked)' },
    { key: 'status', label: 'Status', render: (r) => <span className="capitalize">{r.status}</span> },
    {
      key: 'actions',
      label: 'Actions',
      align: 'right',
      render: (r) =>
        hasPerm('finance.manage') && r.status === 'succeeded' ? (
          <button
            type="button"
            onClick={() => setRefundTarget(r)}
            className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-xs hover:bg-slate-50 dark:border-slate-700"
          >
            <RotateCcw className="h-3 w-3" />
            Refund
          </button>
        ) : null,
    },
  ];

  const netCents = summary.succeededCents - summary.refundedCents - summary.payoutsCents;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold">
            {subview === 'finance-analytics' ? 'Revenue & Ledger Analytics' : 'Financial Management'}
            {selectedApp ? ` · ${selectedApp.name}` : ''}
          </h1>
          <p className="mt-0.5 text-xs text-slate-500">
            Payment ledger, refunds, payouts, and fraud score review. Sensitive credentials are never stored.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void downloadWithAuth(`/finance/export.csv${exportSuffix}`, 'finance-ledger.csv')}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium dark:border-slate-700 dark:bg-slate-900"
          >
            <Download className="h-3.5 w-3.5" />
            CSV
          </button>
          <button
            type="button"
            onClick={() => void downloadWithAuth(`/finance/export.json${exportSuffix}`, 'finance-ledger.json')}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium dark:border-slate-700 dark:bg-slate-900"
          >
            <Download className="h-3.5 w-3.5" />
            JSON
          </button>
          {hasPerm('finance.manage') && (
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 text-xs font-medium text-white"
            >
              <Plus className="h-4 w-4" />
              Record Entry
            </button>
          )}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <p className="text-xs text-slate-500">Succeeded Revenue</p>
          <p className="mt-1 font-display text-xl font-semibold tabular-nums">
            ${(summary.succeededCents / 100).toFixed(2)}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <p className="text-xs text-slate-500">Net Settled</p>
          <p className="mt-1 font-display text-xl font-semibold tabular-nums">
            ${(netCents / 100).toFixed(2)}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <p className="text-xs text-slate-500">Refunded Volume</p>
          <p className="mt-1 font-display text-xl font-semibold tabular-nums">
            ${(summary.refundedCents / 100).toFixed(2)}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <p className="text-xs text-slate-500">Failed Payments</p>
          <p className="mt-1 font-display text-xl font-semibold tabular-nums">{summary.failedCount}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <p className="text-xs text-slate-500">Fraud Alerts</p>
          <p className="mt-1 font-display text-xl font-semibold tabular-nums">{summary.flaggedCount}</p>
        </div>
      </div>

      <DataTable<TransactionRow>
        tableId="finance-ledger"
        columns={columns}
        rows={rows}
        search={search}
        onSearchChange={setSearch}
        loading={loading}
      />

      {showCreate && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
          <form onSubmit={recordTransaction} className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
            <h2 className="font-display text-base font-semibold">Record Ledger Transaction</h2>
            <div className="mt-4 space-y-3 text-xs">
              <div>
                <label className="block font-medium">Amount (USD)</label>
                <input
                  type="number"
                  step="0.01"
                  required
                  value={amountUsd}
                  onChange={(e) => setAmountUsd(e.target.value)}
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block font-medium">Type</label>
                <select
                  value={type}
                  onChange={(e) => setType(e.target.value)}
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
                >
                  <option value="payment">Payment</option>
                  <option value="payout">Payout</option>
                  <option value="refund">Refund</option>
                </select>
              </div>
              <div>
                <label className="block font-medium">Masked Payment Method Label</label>
                <input
                  value={methodLabel}
                  onChange={(e) => setMethodLabel(e.target.value)}
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" onClick={() => setShowCreate(false)} className="rounded-lg border border-slate-200 px-4 py-2 text-xs">
                Cancel
              </button>
              <button type="submit" className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white">
                Save Entry
              </button>
            </div>
          </form>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(refundTarget)}
        title="Process Refund"
        description={`Mark transaction ${refundTarget?.reference} as refunded?`}
        destructive
        onConfirm={() => void processRefund()}
        onCancel={() => setRefundTarget(null)}
      />
    </div>
  );
};

export const AdsPage: React.FC<{ subview?: string }> = ({ subview = 'ads-networks' }) => {
  const { hasPerm } = useAuth();
  const { pushToast } = useToast();
  const { selectedAppId, selectedApp } = useAppScope();
  const [ads, setAds] = useState<AdRow[]>([]);
  const [name, setName] = useState('');
  const [network, setNetwork] = useState('Google AdMob');
  const [adFormat, setAdFormat] = useState('banner');
  const [placement, setPlacement] = useState('dashboard_footer');
  const [admobUnitId, setAdmobUnitId] = useState('');
  const [ecpmUsd, setEcpmUsd] = useState('2.50');
  const [frequencyCap, setFrequencyCap] = useState('3');
  const [editingAd, setEditingAd] = useState<AdRow | null>(null);
  const [deleteAdTarget, setDeleteAdTarget] = useState<AdRow | null>(null);

  const loadAds = useCallback(async () => {
    try {
      const qs = selectedAppId !== 'all' ? `?appId=${selectedAppId}` : '';
      const res = await apiRequest<{ data: AdRow[] }>(`/ads${qs}`);
      setAds(res.data);
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Failed to load ad units',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  }, [selectedAppId, pushToast]);

  useEffect(() => {
    void loadAds();
  }, [loadAds]);

  const createAd = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiRequest('/ads', {
        method: 'POST',
        body: JSON.stringify({
          name,
          network,
          adFormat,
          placement,
          admobUnitId,
          ecpmCents: Math.max(0, Math.round(Number(ecpmUsd) * 100)),
          frequencyCap: Math.max(1, Number(frequencyCap) || 3),
          isEnabled: true,
          appId: selectedAppId !== 'all' ? selectedAppId : null,
        }),
      });
      setName('');
      setAdmobUnitId('');
      pushToast({ type: 'success', title: 'Ad unit configuration saved' });
      await loadAds();
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Could not save ad unit',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const totalImpressions = ads.reduce((s, a) => s + a.impressions, 0);
  const totalClicks = ads.reduce((s, a) => s + a.clicks, 0);
  const totalAdRevenueCents = ads.reduce((s, a) => s + a.revenueCents, 0);
  const ctr = totalImpressions > 0 ? ((totalClicks / totalImpressions) * 100).toFixed(2) : '0.00';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-xl font-semibold">
          {subview === 'ads-performance'
            ? 'AdMob Performance & Revenue'
            : subview === 'ads-placements'
              ? 'Ad Placements & Formats'
              : 'Advertisement & AdMob Management'}
          {selectedApp ? ` · ${selectedApp.name}` : ''}
        </h1>
        <p className="mt-0.5 text-xs text-slate-500">
          Manage AdMob Unit IDs, networks, formats, frequency caps, and per-app SDK ad monetization.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <p className="text-xs text-slate-500">Active Placements</p>
          <p className="mt-1 font-display text-xl font-semibold tabular-nums">
            {ads.filter((a) => a.isEnabled).length} / {ads.length}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <p className="text-xs text-slate-500">Total Impressions</p>
          <p className="mt-1 font-display text-xl font-semibold tabular-nums">
            {totalImpressions.toLocaleString()}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <p className="text-xs text-slate-500">Clicks / CTR</p>
          <p className="mt-1 font-display text-xl font-semibold tabular-nums">
            {totalClicks.toLocaleString()} ({ctr}%)
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <p className="text-xs text-slate-500">Ad Revenue</p>
          <p className="mt-1 font-display text-xl font-semibold tabular-nums">
            ${(totalAdRevenueCents / 100).toFixed(2)}
          </p>
        </div>
      </div>

      {hasPerm('ads.manage') && subview !== 'ads-performance' && (
        <form
          onSubmit={createAd}
          className="grid gap-3 rounded-xl border border-slate-200 bg-white p-5 sm:grid-cols-3 lg:grid-cols-6 dark:border-slate-800 dark:bg-slate-900"
        >
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Unit name"
            className="h-9 rounded-lg border border-slate-200 px-3 text-xs dark:border-slate-700 dark:bg-slate-950"
          />
          <input
            required
            value={network}
            onChange={(e) => setNetwork(e.target.value)}
            placeholder="Google AdMob"
            className="h-9 rounded-lg border border-slate-200 px-3 text-xs dark:border-slate-700 dark:bg-slate-950"
          />
          <select
            value={adFormat}
            onChange={(e) => setAdFormat(e.target.value)}
            aria-label="Ad format"
            className="h-9 rounded-lg border border-slate-200 px-3 text-xs dark:border-slate-700 dark:bg-slate-950"
          >
            <option value="banner">Banner</option>
            <option value="interstitial">Interstitial</option>
            <option value="rewarded">Rewarded</option>
            <option value="native">Native</option>
          </select>
          <input
            required
            value={placement}
            onChange={(e) => setPlacement(e.target.value)}
            placeholder="Placement key"
            className="h-9 rounded-lg border border-slate-200 px-3 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
          />
          <input
            value={admobUnitId}
            onChange={(e) => setAdmobUnitId(e.target.value)}
            placeholder="ca-app-pub-.../unit"
            className="h-9 rounded-lg border border-slate-200 px-3 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
          />
          <div className="flex gap-2">
            <input
              type="number"
              step="0.1"
              value={ecpmUsd}
              onChange={(e) => setEcpmUsd(e.target.value)}
              aria-label="eCPM USD"
              title="Target eCPM USD"
              className="h-9 w-16 rounded-lg border border-slate-200 px-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
            />
            <input
              type="number"
              min={1}
              value={frequencyCap}
              onChange={(e) => setFrequencyCap(e.target.value)}
              aria-label="Frequency cap per session"
              title="Frequency Cap"
              className="h-9 w-14 rounded-lg border border-slate-200 px-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
            />
            <button type="submit" className="h-9 flex-1 rounded-lg bg-blue-600 px-3 text-xs font-medium text-white">
              Add Unit
            </button>
          </div>
        </form>
      )}

      <div className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
        {ads.length === 0 ? (
          <p className="p-8 text-center text-xs text-slate-500">No ad placements configured.</p>
        ) : (
          ads.map((ad) => (
            <div key={ad.id} className="flex flex-wrap items-center justify-between gap-4 p-4 text-xs">
              <div>
                <p className="font-semibold text-slate-900 dark:text-slate-100">
                  {ad.name} · {ad.network} ({ad.adFormat})
                </p>
                <p className="font-mono text-[11px] text-slate-500">
                  Placement: {ad.placement} {ad.admobUnitId ? `· Unit: ${ad.admobUnitId}` : ''} · eCPM ${(ad.ecpmCents / 100).toFixed(2)} · Cap {ad.frequencyCap}/session
                </p>
                <p className="mt-0.5 font-mono text-[11px] text-slate-400">
                  {ad.impressions.toLocaleString()} impressions · {ad.clicks.toLocaleString()} clicks · Rev ${(ad.revenueCents / 100).toFixed(2)}
                </p>
              </div>
              {hasPerm('ads.manage') && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setEditingAd(ad)}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 hover:bg-slate-50 dark:border-slate-700"
                  >
                    <Edit3 className="h-3.5 w-3.5" />
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void apiRequest(`/ads/${ad.id}`, {
                        method: 'PATCH',
                        body: JSON.stringify({ isEnabled: !ad.isEnabled }),
                      }).then(() => loadAds())
                    }
                    className={`rounded-lg px-3 py-1.5 font-medium ${
                      ad.isEnabled
                        ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                        : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
                    }`}
                  >
                    {ad.isEnabled ? 'Enabled' : 'Disabled'}
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ad unit ${ad.name}`}
                    onClick={() => setDeleteAdTarget(ad)}
                    className="rounded-lg border border-red-200 p-1.5 text-red-600 dark:border-red-900"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {editingAd && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await apiRequest(`/ads/${editingAd.id}`, {
                method: 'PATCH',
                body: JSON.stringify({
                  name: editingAd.name,
                  admobUnitId: editingAd.admobUnitId,
                  ecpmCents: editingAd.ecpmCents,
                  frequencyCap: editingAd.frequencyCap,
                  visibilityRule: editingAd.visibilityRule,
                }),
              });
              pushToast({ type: 'success', title: 'Ad unit updated' });
              setEditingAd(null);
              await loadAds();
            }}
            className="w-full max-w-md space-y-3 rounded-xl border border-slate-200 bg-white p-6 text-xs dark:border-slate-800 dark:bg-slate-900"
          >
            <h2 className="font-display text-base font-semibold">Edit Ad Unit: {editingAd.name}</h2>
            <div>
              <label className="block font-medium">Name</label>
              <input
                required
                value={editingAd.name}
                onChange={(e) => setEditingAd({ ...editingAd, name: e.target.value })}
                className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 dark:border-slate-700 dark:bg-slate-950"
              />
            </div>
            <div>
              <label className="block font-medium">AdMob Unit ID</label>
              <input
                value={editingAd.admobUnitId}
                onChange={(e) => setEditingAd({ ...editingAd, admobUnitId: e.target.value })}
                className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 font-mono dark:border-slate-700 dark:bg-slate-950"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block font-medium">eCPM (cents)</label>
                <input
                  type="number"
                  value={editingAd.ecpmCents}
                  onChange={(e) => setEditingAd({ ...editingAd, ecpmCents: Number(e.target.value) })}
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 font-mono dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block font-medium">Frequency Cap</label>
                <input
                  type="number"
                  value={editingAd.frequencyCap}
                  onChange={(e) => setEditingAd({ ...editingAd, frequencyCap: Number(e.target.value) })}
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 font-mono dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setEditingAd(null)} className="rounded-lg border border-slate-200 px-3 py-1.5">
                Cancel
              </button>
              <button type="submit" className="rounded-lg bg-blue-600 px-4 py-1.5 font-medium text-white">
                Save
              </button>
            </div>
          </form>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(deleteAdTarget)}
        title="Delete Ad Placement"
        description={`Remove "${deleteAdTarget?.name}"?`}
        destructive
        onConfirm={async () => {
          if (!deleteAdTarget) return;
          await apiRequest(`/ads/${deleteAdTarget.id}`, { method: 'DELETE' });
          pushToast({ type: 'success', title: 'Ad unit deleted' });
          setDeleteAdTarget(null);
          await loadAds();
        }}
        onCancel={() => setDeleteAdTarget(null)}
      />
    </div>
  );
};
