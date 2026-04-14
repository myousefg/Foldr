import { useState, useEffect, useCallback, useMemo } from 'react';
import { activityApi } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import { ArrowRight, RotateCcw, Trash2, RefreshCw, ExternalLink, Search, X } from 'lucide-react';

const isElectron = !!window.electronAPI;

export default function ActivityLog() {
  const [log, setLog]           = useState([]);
  const [loading, setLoading]   = useState(false);
  const [search, setSearch]     = useState('');
  const [filterRule, setFilterRule] = useState('ALL');

  const fetchLog = useCallback(async () => {
    try { setLog(await activityApi.getAll(200)); } catch { console.error('load log failed'); }
  }, []);

  useEffect(() => { fetchLog(); }, [fetchLog]);

  // Unique rule names for filter dropdown
  const ruleNames = useMemo(() => {
    const names = [...new Set(log.map(e => e.rule_name).filter(Boolean))].sort();
    return ['ALL', ...names];
  }, [log]);

  // Filtered log
  const filtered = useMemo(() => {
    let result = log;
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
  }, [log, search, filterRule]);

  const undo = async (id) => {
    try {
      await activityApi.undo(id);
      toast.success('File moved back to original location');
      fetchLog();
    } catch (e) { toast.error(e.response?.data?.detail || 'Undo failed'); }
  };

  const clearAll = async () => {
    setLoading(true);
    try { await activityApi.clear(); setLog([]); toast.success('Log cleared'); }
    catch { toast.error('Failed to clear log'); }
    setLoading(false);
  };

  const openFolder = async (path) => {
    if (!isElectron || !path) return;
    const sep = path.includes('\\') ? '\\' : '/';
    const dir = path.substring(0, path.lastIndexOf(sep));
    if (dir) await window.electronAPI.openFolder(dir);
  };

  return (
    <div className="space-y-6 animate-fade-in" data-testid="activity-page">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">Activity Log</h1>
          <p className="text-sm text-muted-foreground mt-1">Every file move, timestamped. Undo in one click.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={fetchLog}>
            <RefreshCw className="w-3.5 h-3.5" />
          </Button>
          <Button variant="outline" size="sm" onClick={clearAll} disabled={loading || log.length === 0}>
            <Trash2 className="w-3.5 h-3.5 mr-1.5" />Clear
          </Button>
        </div>
      </div>

      <Separator />

      {/* Search + Filter */}
      {log.length > 0 && (
        <div className="flex items-center gap-3">
          {/* Search */}
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search filenames…"
              className="pl-9 text-sm h-9"
            />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Rule filter */}
          <select
            value={filterRule}
            onChange={e => setFilterRule(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          >
            {ruleNames.map(name => (
              <option key={name} value={name}>{name === 'ALL' ? 'All rules' : name}</option>
            ))}
          </select>

          {/* Result count */}
          {(search || filterRule !== 'ALL') && (
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
          <p className="text-sm font-medium text-muted-foreground">No activity yet</p>
          <p className="text-xs text-muted-foreground mt-1">Files moved by Foldr will appear here.</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center border border-dashed rounded-lg">
          <Search className="w-8 h-8 text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">No entries match your search.</p>
          <button onClick={() => { setSearch(''); setFilterRule('ALL'); }} className="text-xs text-primary mt-2 hover:underline">
            Clear filters
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {/* Column headers */}
          <div className="grid grid-cols-[80px_1fr_1fr_180px_64px] gap-3 px-4 pb-1">
            {['Time','Original','Renamed to','Destination',''].map((h,i) => (
              <span key={i} className="text-[10px] uppercase tracking-widest text-muted-foreground">{h}</span>
            ))}
          </div>

          {filtered.map(entry => (
            <div
              key={entry.id}
              className={`grid grid-cols-[80px_1fr_1fr_180px_64px] gap-3 items-center border rounded-lg px-4 py-3 transition-colors ${
                entry.undone ? 'opacity-40 bg-muted/10' : 'bg-background hover:bg-muted/20'
              }`}
            >
              <span className="font-mono text-xs text-muted-foreground tabular-nums">
                {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
              <span className="font-mono text-xs text-muted-foreground truncate" title={entry.original_name}>
                {entry.original_name}
              </span>
              <div className="flex items-center gap-1.5 min-w-0">
                <ArrowRight className="w-3 h-3 text-muted-foreground shrink-0" />
                <span className="font-mono text-xs font-medium truncate" title={entry.new_name}>{entry.new_name}</span>
              </div>
              <div className="min-w-0">
                <Badge variant="secondary" className="text-[10px] font-mono max-w-full truncate block text-center" title={entry.destination_folder}>
                  {entry.destination_folder}
                </Badge>
              </div>
              <div className="flex items-center justify-end gap-1.5 shrink-0">
                {entry.undone && <span className="text-[9px] text-muted-foreground uppercase tracking-wider">undone</span>}
                {isElectron && entry.new_path && !entry.undone && (
                  <button onClick={() => openFolder(entry.new_path)} className="text-muted-foreground hover:text-foreground p-1 rounded transition-colors" title="Open folder">
                    <ExternalLink className="w-3.5 h-3.5" />
                  </button>
                )}
                {!entry.undone && (
                  <button onClick={() => undo(entry.id)} className="text-muted-foreground hover:text-foreground p-1 rounded transition-colors" title="Undo">
                    <RotateCcw className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}