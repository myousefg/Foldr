import { useState, useEffect, useCallback, useRef } from 'react';
import { statsApi, settingsApi, pendingApi } from '@/lib/api';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { FileText, ListFilter, FolderOpen, Clock, ArrowRight, Check, X, Bell, RefreshCw, ExternalLink, Folder } from 'lucide-react';

const isElectron = !!window.electronAPI;

export default function Dashboard() {
  const [stats, setStats]         = useState(null);
  const [settings, setSettings]   = useState(null);
  const [pending, setPending]     = useState([]);
  const [selected, setSelected]   = useState(new Set());
  const [showPending, setShowPending] = useState(false);
  const [loading, setLoading]     = useState(false);
  const lastActivityId             = useRef(null);

  const fetchAll = useCallback(async () => {
    try {
      const [s, cfg, pend] = await Promise.all([
        statsApi.get(), settingsApi.get(), pendingApi.getAll()
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
      setSelected(new Set(pend.map(p => p.id)));
      // Update tray badge
      if (isElectron) window.electronAPI.setTrayBadge(pend.length);
    } catch (e) { console.error(e); }
  }, []);

  // Seed lastActivityId on first load
  useEffect(() => {
    statsApi.get().then(s => {
      if (s.recent_activity?.[0]) lastActivityId.current = s.recent_activity[0].id;
    }).catch(() => {});
  }, []);

  useEffect(() => {
    fetchAll();
    const id = setInterval(fetchAll, 4000);
    return () => clearInterval(id);
  }, [fetchAll]);

  const toggleMonitoring = async () => {
    try {
      const updated = await settingsApi.update({ monitoring_enabled: !settings.monitoring_enabled });
      setSettings(updated);
      toast.success(`Monitoring ${updated.monitoring_enabled ? 'enabled' : 'disabled'}`);
    } catch { toast.error('Failed to toggle monitoring'); }
  };

  const selectFolder = async () => {
    if (!isElectron) { toast.error('Folder picker only available in the desktop app'); return; }
    const folder = await window.electronAPI.selectFolder({ title: 'Select folder to monitor' });
    if (!folder) return;
    const updated = await settingsApi.update({ monitored_folder: folder });
    setSettings(updated);
    toast.success('Monitored folder updated');
  };

  const openFolder = async (path) => {
    if (isElectron && path) await window.electronAPI.openFolder(path);
  };

  const applySelected = async () => {
    if (selected.size === 0) return;
    setLoading(true);
    try {
      const result = await pendingApi.apply([...selected]);
      toast.success(`Applied ${result.applied} move${result.applied !== 1 ? 's' : ''}`);
      setShowPending(false);
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
          <span className="text-xs tracking-[0.15em] uppercase text-muted-foreground font-medium">Monitoring</span>
          <Switch checked={!!settings?.monitoring_enabled} onCheckedChange={toggleMonitoring} />
          <Badge variant={settings?.monitoring_enabled ? 'default' : 'secondary'} className="text-[10px] tracking-wider">
            {settings?.monitoring_enabled ? 'ACTIVE' : 'PAUSED'}
          </Badge>
        </div>
      </div>

      <Separator />

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="FILES TODAY"     value={stats?.files_today ?? 0}  icon={FileText}   />
        <StatCard label="ACTIVE RULES"    value={stats?.active_rules ?? 0} icon={ListFilter} />
        <StatCard label="TOTAL ORGANIZED" value={stats?.total_files ?? 0}  icon={FolderOpen} />
        <StatCard label="THIS WEEK"       value={stats?.files_week ?? 0}   icon={Clock}      />
      </div>

      {/* Monitored folder */}
      <div className="border border-border rounded-lg">
        <div className="p-4 border-b border-border flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold tracking-tight">Monitored Folder</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Foldr watches this folder and moves new files automatically.</p>
          </div>
          <Button variant="outline" size="sm" onClick={selectFolder}>
            <Folder className="w-3.5 h-3.5 mr-1.5" />
            {settings?.monitored_folder ? 'Change' : 'Select Folder'}
          </Button>
        </div>
        <div className="p-4">
          {settings?.monitored_folder ? (
            <div className="flex items-center justify-between bg-muted/40 border border-border rounded px-3 py-2">
              <span className="font-mono text-xs text-foreground truncate">{settings.monitored_folder}</span>
              <button onClick={() => openFolder(settings.monitored_folder)} className="text-muted-foreground hover:text-foreground ml-3 shrink-0">
                <ExternalLink className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground italic">No folder selected. Click "Select Folder" to start.</p>
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
                  <div key={f.folder} className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      <FolderOpen className="w-3.5 h-3.5 text-muted-foreground" />
                      <span className="font-mono">{f.folder}</span>
                    </div>
                    <span className="text-muted-foreground font-mono">{f.count}</span>
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
      <Dialog open={showPending} onOpenChange={setShowPending}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">Review Pending Moves</DialogTitle>
            <p className="text-xs text-muted-foreground">Select which moves to apply. Unselected files stay in place.</p>
          </DialogHeader>
          <ScrollArea className="max-h-[400px]">
            <div className="space-y-2 pr-4">
              {pending.map(p => (
                <div
                  key={p.id}
                  className={`border rounded-lg p-3 text-xs transition-colors cursor-pointer ${
                    selected.has(p.id) ? 'border-primary/40 bg-primary/5' : 'border-border opacity-50'
                  }`}
                  onClick={() => toggleSelect(p.id)}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2">
                      <div className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center shrink-0 ${
                        selected.has(p.id) ? 'bg-primary border-primary' : 'border-muted-foreground'
                      }`}>
                        {selected.has(p.id) && <Check className="w-2.5 h-2.5 text-primary-foreground" />}
                      </div>
                      <span className="font-medium text-muted-foreground">{p.rule_name}</span>
                    </div>
                    <button onClick={e => { e.stopPropagation(); skipOne(p.id); }} className="text-muted-foreground hover:text-destructive">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="font-mono space-y-1 ml-5">
                    <div className="text-muted-foreground truncate">{p.original_path}</div>
                    <div className="flex items-center gap-1.5">
                      <ArrowRight className="w-3 h-3 shrink-0" />
                      <span className="text-foreground truncate">{p.proposed_path}</span>
                    </div>
                  </div>
                </div>
              ))}
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