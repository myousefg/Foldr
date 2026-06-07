import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { statsApi, settingsApi, pendingApi, organizeApi, monitoredFoldersApi } from '@/lib/api';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { FileText, ListFilter, FolderOpen, Clock, ArrowRight, Check, X, Bell, RefreshCw, ExternalLink, Folder, Plus, Eye, EyeOff, Zap, Loader2, AlertTriangle } from 'lucide-react';

import { isElectron, openFolder } from '@/lib/electron';

export default function Dashboard() {
  const navigate = useNavigate();
  const [stats, setStats]             = useState(null);
  const [settings, setSettings]       = useState(null);
  const [pending, setPending]         = useState([]);
  const [monFolders, setMonFolders]   = useState([]);
  const [organizing, setOrganizing]   = useState(false);
  const [dupActions, setDupActions]   = useState({});  // { [pendingId]: 'skip'|'overwrite'|'rename' }
  const [selected, setSelected]       = useState(new Set());
  const [showPending, setShowPending] = useState(false);
  const [loading, setLoading]     = useState(false);
  const lastActivityId             = useRef(null);
  const abortRef                   = useRef(null);
  const seenPendingIds             = useRef(new Set());

  const fetchAll = useCallback(async () => {
    // Cancel any in-flight request from the previous interval tick
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;

    try {
      const [s, cfg, pend, mf] = await Promise.all([
        statsApi.get(signal), settingsApi.get(signal), pendingApi.getAll(signal),
        monitoredFoldersApi.getAll(),
      ]);
      setStats(prev => {
        // Fire notification when a NEW activity entry appears
        if (isElectron && prev && s.recent_activity?.[0]?.id !== lastActivityId.current && lastActivityId.current !== null) {
          const a = s.recent_activity[0];
          window.electronAPI.notify('Foldr — File Organized', `${a.original_name}  →  ${a.new_name}`);
        }
        if (s.recent_activity?.[0]) lastActivityId.current = s.recent_activity[0].id;
        return s;
      });
      setSettings(cfg);
      setPending(pend);
      setMonFolders(mf);

      setSelected(prev => {
        const pendingIds = new Set(pend.map(p => p.id));
        const next = new Set([...prev].filter(id => pendingIds.has(id)));
        pend.forEach(p => {
          if (!seenPendingIds.current.has(p.id)) next.add(p.id);
        });
        pend.forEach(p => seenPendingIds.current.add(p.id));
        return next;
      });

      // Update tray badge
      if (isElectron) window.electronAPI.setTrayBadge(pend.length);
    } catch (e) {
      // Ignore errors from intentionally aborted requests
      if (e.name === 'AbortError' || e.name === 'CanceledError') return;
      console.error(e);
    }
  }, []);

  // Seed lastActivityId on first load
  useEffect(() => {
    statsApi.get().then(s => {
      if (s.recent_activity?.[0]) lastActivityId.current = s.recent_activity[0].id;
    }).catch(() => {});
  }, []);

  // Reconcile stale file records on mount so Folders section is immediately accurate
  useEffect(() => {
    organizeApi.reconcile().catch(() => {});
  }, []);

  useEffect(() => {
    fetchAll();
    const id = setInterval(fetchAll, 4000);
    return () => {
      clearInterval(id);
      abortRef.current?.abort();
    };
  }, [fetchAll]);

  const toggleMonitoring = async () => {
    try {
      const updated = await settingsApi.update({ monitoring_enabled: !settings.monitoring_enabled });
      setSettings(updated);
      toast.success(`Monitoring ${updated.monitoring_enabled ? 'enabled' : 'disabled'}`);
    } catch { toast.error('Failed to toggle monitoring'); }
  };

  const organizeNow = async () => {
    if (organizing) return;
    setOrganizing(true);
    try {
      const result = await organizeApi.organizeNow();
      const { actioned, scanned, folders, preview_mode } = result;
      if (actioned === 0) {
        toast.info('Nothing to organize', {
          description: `Scanned ${scanned} file${scanned !== 1 ? 's' : ''} — all already organized or no matching rules.`,
        });
      } else {
        const verb = preview_mode ? 'queued for review' : 'organized';
        const folderList = folders.length > 0
          ? `into: ${folders.slice(0, 3).join(', ')}${folders.length > 3 ? ` +${folders.length - 3} more` : ''}`
          : '';
        toast.success(`${actioned} file${actioned !== 1 ? 's' : ''} ${verb}`, {
          description: `Scanned ${scanned} files. ${folderList}`,
        });
      }
      fetchAll();
    } catch (e) {
      const msg = e?.response?.data?.detail || 'Organize Now failed';
      toast.error(msg);
    } finally {
      setOrganizing(false);
    }
  };

  const applySelected = async () => {
    if (selected.size === 0) return;
    setLoading(true);
    try {
      const ids = [...selected];
      const actions = ids
        .filter(id => dupActions[id])
        .map(id => ({ id, duplicate_action: dupActions[id] }));
      const result = await pendingApi.apply(ids, actions.length ? actions : undefined);

      // result now returns { applied, stale }
      if (result.applied > 0 && result.stale > 0) {
        toast.success(`Moved ${result.applied} file${result.applied !== 1 ? 's' : ''}`, {
          description: `${result.stale} file${result.stale !== 1 ? 's were' : ' was'} already gone and removed from the queue.`,
        });
      } else if (result.applied > 0) {
        toast.success(`Moved ${result.applied} file${result.applied !== 1 ? 's' : ''}`);
      } else if (result.stale > 0) {
        toast.warning(`No files moved — all ${result.stale} selected file${result.stale !== 1 ? 's were' : ' was'} already deleted.`);
      } else {
        toast.error('No files were moved');
      }

      setShowPending(false);
      setDupActions({});
      fetchAll();
    } catch { toast.error('Apply failed'); }
    setLoading(false);
  };

  const skipOne = async (id) => {
    await pendingApi.skip(id);
    setPending(prev => prev.filter(p => p.id !== id));
    setSelected(prev => { const n = new Set(prev); n.delete(id); return n; });
  };

  const toggleSelect = (id) => {
    setSelected(prev => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  return (
    <div className="space-y-6 animate-fade-in" data-testid="dashboard-page">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-1">Set once. Forget forever.</p>
        </div>
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={organizeNow}
            disabled={organizing || monFolders.filter(f => f.enabled).length === 0}
            title={monFolders.filter(f => f.enabled).length === 0 ? 'No active monitored folders' : 'Scan and organize all existing files now'}
          >
            {organizing
              ? <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />Organizing…</>
              : <><Zap className="w-3.5 h-3.5 mr-1.5" />Organize Now</>}
          </Button>
          <span className="text-xs tracking-[0.15em] uppercase text-muted-foreground font-medium">Monitoring</span>
          <Switch checked={!!settings?.monitoring_enabled} onCheckedChange={toggleMonitoring} />
          <Badge variant={settings?.monitoring_enabled ? 'default' : 'secondary'} className="text-[10px] tracking-wider">
            {settings?.monitoring_enabled ? 'ACTIVE' : 'PAUSED'}
          </Badge>
        </div>
      </div>

      <Separator />

      {/* Organize Now progress bar */}
      {organizing && (
        <div className="w-full rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 flex items-center gap-3">
          <Loader2 className="w-4 h-4 text-primary animate-spin shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-medium text-primary">Scanning and organizing files…</p>
            <p className="text-xs text-muted-foreground mt-0.5">Applying rules to all existing files in monitored folders.</p>
          </div>
          <div className="w-32 h-1.5 bg-primary/20 rounded-full overflow-hidden">
            <div className="h-full bg-primary rounded-full animate-pulse w-2/3" />
          </div>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="FILES TODAY"     value={stats?.files_today ?? 0}  icon={FileText}   />
        <StatCard label="ACTIVE RULES"    value={stats?.active_rules ?? 0} icon={ListFilter} />
        <StatCard label="TOTAL ORGANIZED" value={stats?.total_files ?? 0}  icon={FolderOpen} />
        <StatCard label="THIS WEEK"       value={stats?.files_week ?? 0}   icon={Clock}      />
      </div>

      {/* Monitored folders */}
      <div className="border border-border rounded-lg">
        <div className="p-4 border-b border-border flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold tracking-tight">Monitored Folders</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {monFolders.length > 0
                ? `${monFolders.filter(f => f.enabled).length} of ${monFolders.length} active`
                : 'No folders configured yet'}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => navigate('/settings')}>
            <Plus className="w-3.5 h-3.5 mr-1.5" />
            Manage
          </Button>
        </div>
        <div className="p-4 space-y-2">
          {monFolders.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">
              No folders added. Go to Settings → Monitored Folders to add one.
            </p>
          ) : (
            monFolders.map(f => (
              <div key={f.id} className="flex items-center gap-2 bg-muted/30 border border-border rounded px-3 py-2">
                <Folder className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                <span className={`font-mono text-xs flex-1 truncate ${!f.enabled ? 'opacity-40 line-through' : ''}`}>
                  {f.path}
                </span>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={async () => {
                      const updated = await monitoredFoldersApi.toggle(f.id, !f.enabled);
                      setMonFolders(prev => prev.map(x => x.id === f.id ? updated : x));
                      toast.success(updated.enabled ? 'Folder resumed' : 'Folder paused');
                    }}
                    title={f.enabled ? 'Pause this folder' : 'Resume this folder'}
                    className="text-muted-foreground hover:text-foreground transition-colors p-0.5 rounded"
                  >
                    {f.enabled
                      ? <Eye className="w-3.5 h-3.5" />
                      : <EyeOff className="w-3.5 h-3.5" />}
                  </button>
                  {isElectron && (
                    <button
                      onClick={() => openFolder(f.path)}
                      title="Open in Explorer"
                      className="text-muted-foreground hover:text-foreground transition-colors p-0.5 rounded"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Pending banner */}
      {pending.length > 0 && (
        <button
          onClick={() => setShowPending(true)}
          className="w-full flex items-center justify-between border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 rounded-lg px-4 py-3 hover:bg-amber-100 dark:hover:bg-amber-950/50 transition-colors"
        >
          <div className="flex items-center gap-2.5">
            <Bell className="w-4 h-4 text-amber-600 dark:text-amber-400" />
            <span className="text-sm font-medium text-amber-800 dark:text-amber-300">
              {pending.length} file{pending.length !== 1 ? 's' : ''} waiting for review
            </span>
          </div>
          <Badge variant="outline" className="border-amber-400 text-amber-700 dark:text-amber-400 text-[10px]">REVIEW →</Badge>
        </button>
      )}

      {/* Bottom grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="border border-border rounded-lg">
          <div className="p-4 border-b border-border flex items-center justify-between">
            <h2 className="text-sm font-semibold tracking-tight">Recent Activity</h2>
            <button onClick={fetchAll} className="text-muted-foreground hover:text-foreground">
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="p-4">
            {stats?.recent_activity?.length > 0 ? (
              <div className="space-y-2">
                {stats.recent_activity.map(a => (
                  <div key={a.id} className="flex items-center gap-2 text-xs">
                    <span className="font-mono text-muted-foreground truncate max-w-[130px]">{a.original_name}</span>
                    <ArrowRight className="w-3 h-3 text-muted-foreground shrink-0" />
                    <span className="font-mono text-foreground truncate max-w-[130px]">{a.new_name}</span>
                    <Badge variant="secondary" className="text-[9px] ml-auto shrink-0">{a.destination_folder}</Badge>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No recent activity</p>
            )}
          </div>
        </div>

        <div className="border border-border rounded-lg">
          <div className="p-4 border-b border-border">
            <h2 className="text-sm font-semibold tracking-tight">Folders</h2>
          </div>
          <div className="p-4">
            {stats?.folder_breakdown?.length > 0 ? (
              <div className="space-y-2">
                {stats.folder_breakdown.map(f => (
                  <div key={f.folder} className="flex items-center justify-between text-xs group">
                    <div className="flex items-center gap-2 min-w-0">
                      <FolderOpen className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      <span className="font-mono truncate">{f.folder}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 ml-2">
                      <span className="text-muted-foreground font-mono">{f.count}</span>
                      <button
                        onClick={() => openFolder(f.full_path)}
                        disabled={!isElectron || !f.full_path}
                        title={f.full_path ? `Open in Explorer: ${f.full_path}` : 'Path unavailable'}
                        className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground disabled:opacity-20 disabled:cursor-not-allowed p-0.5 rounded"
                      >
                        <ExternalLink className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No folders yet</p>
            )}
          </div>
        </div>
      </div>

      {/* Pending review dialog */}
      <Dialog open={showPending} onOpenChange={(open) => { setShowPending(open); if (open) fetchAll(); }}>
        <DialogContent className="max-w-xl overflow-hidden">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">Review Pending Moves</DialogTitle>
            <p className="text-xs text-muted-foreground">Select which moves to apply. Unselected files stay in place.</p>
          </DialogHeader>
          <ScrollArea className="max-h-[400px]">
            <div className="space-y-2 pr-4 w-full min-w-0">
              {pending.map(p => {
                const isDup = !!p.duplicate_of;
                const dupAction = dupActions[p.id] || (isDup ? 'rename' : null);
                return (
                <div
                  key={p.id}
                  className={`border rounded-lg p-3 text-xs transition-colors cursor-pointer overflow-hidden ${
                    selected.has(p.id) ? 'border-primary/40 bg-primary/5' : 'border-border opacity-50'
                  } ${isDup ? 'border-amber-400/50' : ''}`}
                  onClick={() => toggleSelect(p.id)}
                >
                  <div className="grid gap-2 mb-1.5" style={{gridTemplateColumns: '1fr auto'}}>
                    <div className="flex items-center gap-2 min-w-0">
                      <div className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center shrink-0 ${
                        selected.has(p.id) ? 'bg-primary border-primary' : 'border-muted-foreground'
                      }`}>
                        {selected.has(p.id) && <Check className="w-2.5 h-2.5 text-primary-foreground" />}
                      </div>
                      <span className="font-medium text-muted-foreground truncate">{p.rule_name}</span>
                      {isDup && (
                        <span className="flex items-center gap-1 text-amber-500 shrink-0">
                          <AlertTriangle className="w-3 h-3" />
                          <span className="text-[10px] font-semibold uppercase tracking-wide">Duplicate</span>
                        </span>
                      )}
                    </div>
                    <button
                      onClick={e => { e.stopPropagation(); skipOne(p.id); }}
                      className="text-muted-foreground hover:text-destructive"
                      title="Skip this file"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  <div className="font-mono space-y-1 ml-5 w-full pr-12">
                    <div className="text-muted-foreground break-all">{p.original_path}</div>
                    <div className="flex items-start gap-1.5 w-full">
                      <ArrowRight className="w-3 h-3 shrink-0 mt-0.5" />
                      <span className="text-foreground break-all">{p.proposed_path}</span>
                    </div>
                  </div>

                  {isDup && (
                    <div className="mt-2 ml-5" onClick={e => e.stopPropagation()}>
                      <p className="text-[10px] text-amber-500 mb-1.5">
                        ⚠️ Identical file already exists at destination. Choose action:
                      </p>
                      <div className="flex gap-1.5">
                        {['skip','overwrite','rename'].map(action => (
                          <button
                            key={action}
                            onClick={() => setDupActions(prev => ({ ...prev, [p.id]: action }))}
                            className={`px-2 py-1 rounded text-[10px] font-medium border transition-colors capitalize ${
                              dupAction === action
                                ? action === 'skip'      ? 'bg-red-500/20 border-red-500 text-red-400'
                                : action === 'overwrite' ? 'bg-amber-500/20 border-amber-500 text-amber-400'
                                :                          'bg-primary/20 border-primary text-primary'
                                : 'border-border text-muted-foreground hover:border-muted-foreground'
                            }`}
                          >
                            {action === 'skip' ? 'Skip' : action === 'overwrite' ? 'Overwrite' : 'Rename (_001)'}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                );
              })}
            </div>
          </ScrollArea>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShowPending(false)}>Cancel</Button>
            <Button size="sm" onClick={applySelected} disabled={loading || selected.size === 0}>
              <Check className="w-3.5 h-3.5 mr-1.5" />
              Apply {selected.size > 0 ? `(${selected.size})` : ''} Moves
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatCard({ label, value, icon: Icon }) {
  return (
    <div className="border border-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] tracking-[0.2em] uppercase text-muted-foreground font-medium">{label}</span>
        <Icon className="w-4 h-4 text-muted-foreground" strokeWidth={1.5} />
      </div>
      <span className="text-2xl font-semibold tracking-tight">{value}</span>
    </div>
  );
}