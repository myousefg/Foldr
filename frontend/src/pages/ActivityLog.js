import { useState, useEffect, useCallback, useMemo } from 'react';
import { activityApi, pendingApi } from '@/lib/api';
import { useI18n } from '@/context/I18nProvider';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import { ArrowRight, RotateCcw, Trash2, RefreshCw, ExternalLink, Search, X, Bell, AlertTriangle } from 'lucide-react';

import { isElectron, openFolder } from '@/lib/electron';

/** Shared className for the native <select> filter controls. */
const SELECT_CLS = 'h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring';

export default function ActivityLog() {
  const { t } = useI18n();
  const [log, setLog]               = useState([]);
  const [loading, setLoading]       = useState(false);
  const [search, setSearch]         = useState('');
  const [filterRule, setFilterRule] = useState('ALL');
  const [filterStatus, setFilterStatus] = useState('ALL');
  const [pendingCount, setPendingCount] = useState(0); // tracks pending preview items

  const fetchLog = useCallback(async () => {
    try { setLog(await activityApi.getAll(200)); } catch { console.error('load log failed'); }
  }, []);

  const fetchPending = useCallback(async () => {
    try {
      const items = await pendingApi.getAll();
      setPendingCount(items.length);
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => {
    fetchLog();
    fetchPending();
    const id = setInterval(fetchPending, 4000);
    return () => clearInterval(id);
  }, [fetchLog, fetchPending]);

  // Unique rule names for filter dropdown
  const ruleNames = useMemo(() => {
    const names = [...new Set(log.map(e => e.rule_name).filter(Boolean))].sort();
    return ['ALL', ...names];
  }, [log]);

  // Filtered log
  const filtered = useMemo(() => {
    let result = log;
    if (filterStatus === 'ACTIVE')   result = result.filter(e => !e.undone && e.duplicate_action !== 'skipped_duplicate');
    if (filterStatus === 'UNDONE')   result = result.filter(e => e.undone);
    if (filterStatus === 'SKIPPED')  result = result.filter(e => e.duplicate_action === 'skipped_duplicate');
    if (filterRule !== 'ALL') result = result.filter(e => e.rule_name === filterRule);
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(e =>
        e.original_name?.toLowerCase().includes(q) ||
        e.new_name?.toLowerCase().includes(q) ||
        e.destination_folder?.toLowerCase().includes(q)
      );
    }
    return result;
  }, [log, search, filterRule, filterStatus]);

  const undo = async (id) => {
    if (pendingCount > 0) {
      toast.warning('Please review the pending files first before using Undo.', {
        description: 'Open the Dashboard to review and apply (or skip) the pending moves.',
      });
      return;
    }
    try {
      await activityApi.undo(id);
      toast.success('File moved back to original location');
      fetchLog();
    } catch (e) {
      const detail = e.response?.data?.detail || 'Undo failed';
      if (e.response?.status === 409) {
        toast.warning(detail, {
          description: 'Open the Dashboard to review pending files first.',
        });
        fetchPending(); // refresh the count so button disables immediately
      } else {
        toast.error(detail);
      }
    }
  };

  const clearAll = async () => {
    setLoading(true);
    try { await activityApi.clear(); setLog([]); toast.success(t('activity.clear')); }
    catch { toast.error(t('common.error')); }
    setLoading(false);
  };

  const undoBlocked = pendingCount > 0;
  const undoTooltip = undoBlocked
    ? `Please review files first before undo (${pendingCount} file${pendingCount !== 1 ? 's' : ''} pending)`
    : 'Undo — move file back to original location';

  return (
    <div className="space-y-6 animate-fade-in" data-testid="activity-page">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">{t('activity.title')}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t('activity.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={fetchLog}>
            <RefreshCw className="w-3.5 h-3.5" />
          </Button>
          <Button variant="outline" size="sm" onClick={clearAll} disabled={loading || log.length === 0}>
            <Trash2 className="w-3.5 h-3.5 mr-1.5" />{t('activity.clear')}
          </Button>
        </div>
      </div>

      <Separator />

      {/* ── Pending review warning banner ───────────────────────────────────
           Shown when there are files waiting for preview. Undo is disabled
           while this banner is visible to prevent the move→undo→move loop. */}
      {undoBlocked && (
        <div className="flex items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 px-4 py-3">
          <Bell className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
              {t('dashboard.filesWaiting', { count: pendingCount })}
            </p>
            <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
              {t('activity.undoPending')}
            </p>
          </div>
          <Badge variant="outline" className="border-amber-400 text-amber-700 dark:text-amber-400 text-[10px] shrink-0">
            {t('activity.undoLocked')}
          </Badge>
        </div>
      )}

      {/* Search + Filter */}
      {log.length > 0 && (
        <div className="flex items-center gap-3">
          {/* Search */}
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={t('activity.search')}
              className="pl-9 text-sm h-9"
            />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Status filter */}
          <select
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value)}
            className={SELECT_CLS}
          >
            <option value="ALL">{t('activity.allStatus')}</option>
            <option value="ACTIVE">{t('activity.moved')}</option>
            <option value="UNDONE">{t('activity.undone')}</option>
            <option value="SKIPPED">{t('activity.skippedDuplicate')}</option>
          </select>

          {/* Rule filter */}
          <select
            value={filterRule}
            onChange={e => setFilterRule(e.target.value)}
            className={SELECT_CLS}
          >
            {ruleNames.map(name => (
              <option key={name} value={name}>{name === 'ALL' ? t('activity.allRules') : name}</option>
            ))}
          </select>

          {/* Result count */}
          {(search || filterRule !== 'ALL' || filterStatus !== 'ALL') && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {filtered.length} of {log.length}
            </span>
          )}
        </div>
      )}

      {/* Empty states */}
      {log.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <ArrowRight className="w-10 h-10 text-muted-foreground/30 mb-4" />
          <p className="text-sm font-medium text-muted-foreground">{t('activity.noActivity')}</p>
          <p className="text-xs text-muted-foreground mt-1">{t('activity.noActivityDesc')}</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center border border-dashed rounded-lg">
          <Search className="w-8 h-8 text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">{t('activity.noResults', { query: search })}</p>
          <button onClick={() => { setSearch(''); setFilterRule('ALL'); setFilterStatus('ALL'); }} className="text-xs text-primary mt-2 hover:underline">
            {t('activity.clearFilters')}
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {/* Column headers */}
          <div className="grid grid-cols-[80px_1fr_1fr_180px_64px] gap-3 px-4 pb-1">
            {[t('activity.time'), t('activity.original'), t('activity.renamedTo'), t('activity.destination'), ''].map((h,i) => (
              <span key={i} className="text-[10px] uppercase tracking-widest text-muted-foreground">{h}</span>
            ))}
          </div>

          {filtered.map(entry => {
            const isSkippedDup = entry.duplicate_action === 'skipped_duplicate';
            return (
            <div
              key={entry.id}
              className={`grid grid-cols-[80px_1fr_1fr_180px_64px] gap-3 items-center border rounded-lg px-4 py-3 transition-colors ${
                entry.undone      ? 'opacity-40 bg-muted/10'
                : isSkippedDup   ? 'opacity-60 bg-amber-950/10 border-amber-900/30'
                :                  'bg-background hover:bg-muted/20'
              }`}
            >
              <span className="font-mono text-xs text-muted-foreground tabular-nums">
                {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
              <span className="font-mono text-xs text-muted-foreground truncate" title={entry.original_name}>
                {entry.original_name}
              </span>
              <div className="flex items-center gap-1.5 min-w-0">
                {isSkippedDup
                  ? <AlertTriangle className="w-3 h-3 text-amber-500 shrink-0" />
                  : <ArrowRight className="w-3 h-3 text-muted-foreground shrink-0" />}
                <span className="font-mono text-xs font-medium truncate" title={entry.new_name}>
                  {isSkippedDup ? t('activity.skippedDuplicateText') : entry.new_name}
                </span>
              </div>
              <div className="min-w-0">
                <Badge
                  variant="secondary"
                  className={`text-[10px] font-mono max-w-full truncate block text-center ${isSkippedDup ? 'border-amber-500/30 text-amber-500' : ''}`}
                  title={entry.destination_folder}
                >
                  {entry.destination_folder}
                </Badge>
              </div>
              <div className="flex items-center justify-end gap-1.5 shrink-0">
                {entry.undone && <span className="text-[9px] text-muted-foreground uppercase tracking-wider">{t('activity.undoneLabel')}</span>}
                {isSkippedDup && <span className="text-[9px] text-amber-500 uppercase tracking-wider">{t('activity.skippedLabel')}</span>}
                {isElectron && entry.new_path && !entry.undone && !isSkippedDup && (
                  <button
                    onClick={() => openFolder(entry.new_path)}
                    className="text-muted-foreground hover:text-foreground p-1 rounded transition-colors"
                    title="Open folder"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </button>
                )}
                {!entry.undone && !isSkippedDup && (
                  <button
                    onClick={() => undo(entry.id)}
                    disabled={undoBlocked}
                    title={undoTooltip}
                    className={`p-1 rounded transition-colors ${
                      undoBlocked
                        ? 'text-muted-foreground/30 cursor-not-allowed'
                        : 'text-muted-foreground hover:text-foreground cursor-pointer'
                    }`}
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          );})}
        </div>
      )}
    </div>
  );
}