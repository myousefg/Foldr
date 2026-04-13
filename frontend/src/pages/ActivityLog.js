import { useState, useEffect, useCallback } from 'react';
import { activityApi } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import { ArrowRight, RotateCcw, Trash2, RefreshCw, ExternalLink } from 'lucide-react';

const isElectron = !!window.electronAPI;

export default function ActivityLog() {
  const [log, setLog] = useState([]);
  const [loading, setLoading] = useState(false);

  const fetchLog = useCallback(async () => {
    try { setLog(await activityApi.getAll(100)); } catch { console.error('load log failed'); }
  }, []);

  useEffect(() => { fetchLog(); }, [fetchLog]);

  const undo = async (id) => {
    try {
      await activityApi.undo(id);
      toast.success('File moved back to original location');
      fetchLog();
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Undo failed');
    }
  };

  const clearAll = async () => {
    setLoading(true);
    try {
      await activityApi.clear();
      setLog([]);
      toast.success('Log cleared');
    } catch { toast.error('Failed to clear log'); }
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
            <Trash2 className="w-3.5 h-3.5 mr-1.5" />
            Clear
          </Button>
        </div>
      </div>

      <Separator />

      {log.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <ArrowRight className="w-10 h-10 text-muted-foreground/30 mb-4" />
          <p className="text-sm font-medium text-muted-foreground">No activity yet</p>
          <p className="text-xs text-muted-foreground mt-1">Files moved by Foldr will appear here.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {/* Column headers */}
          <div className="grid grid-cols-[80px_1fr_1fr_180px_64px] gap-3 px-4 pb-1">
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Time</span>
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Original</span>
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Renamed to</span>
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Destination</span>
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground text-right">Actions</span>
          </div>

          {log.map(entry => (
            <div
              key={entry.id}
              className={`grid grid-cols-[80px_1fr_1fr_180px_64px] gap-3 items-center border rounded-lg px-4 py-3 transition-colors ${
                entry.undone ? 'opacity-40 bg-muted/10' : 'bg-background hover:bg-muted/20'
              }`}
              data-testid="activity-entry"
            >
              {/* Time */}
              <span className="font-mono text-xs text-muted-foreground tabular-nums">
                {new Date(entry.timestamp).toLocaleTimeString([], {
                  hour: '2-digit', minute: '2-digit', second: '2-digit'
                })}
              </span>

              {/* Original name */}
              <span className="font-mono text-xs text-muted-foreground truncate" title={entry.original_name}>
                {entry.original_name}
              </span>

              {/* New name */}
              <div className="flex items-center gap-1.5 min-w-0">
                <ArrowRight className="w-3 h-3 text-muted-foreground shrink-0" />
                <span className="font-mono text-xs font-medium text-foreground truncate" title={entry.new_name}>
                  {entry.new_name}
                </span>
              </div>

              {/* Destination folder */}
              <div className="min-w-0">
                <Badge
                  variant="secondary"
                  className="text-[10px] font-mono max-w-full truncate block text-center"
                  title={entry.destination_folder}
                >
                  {entry.destination_folder}
                </Badge>
              </div>

              {/* Actions */}
              <div className="flex items-center justify-end gap-1.5 shrink-0">
                {entry.undone && (
                  <span className="text-[9px] text-muted-foreground uppercase tracking-wider">undone</span>
                )}
                {isElectron && entry.new_path && !entry.undone && (
                  <button
                    onClick={() => openFolder(entry.new_path)}
                    className="text-muted-foreground hover:text-foreground p-1 rounded transition-colors"
                    title="Open folder"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </button>
                )}
                {!entry.undone && (
                  <button
                    onClick={() => undo(entry.id)}
                    className="text-muted-foreground hover:text-foreground p-1 rounded transition-colors"
                    title="Undo — move file back"
                  >
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