import { useState, useEffect, useCallback } from 'react';
import { activityApi } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
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
    const dir = path.includes('\\') ? path.substring(0, path.lastIndexOf('\\'))
                                    : path.substring(0, path.lastIndexOf('/'));
    if (dir) await window.electronAPI.openFolder(dir);
  };

  return (
    <div className="space-y-6 animate-fade-in" data-testid="activity-page">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">Activity Log</h1>
          <p className="text-sm text-muted-foreground mt-1">Every file move, timestamped. Undo in one click.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={fetchLog}>
            <RefreshCw className="w-3.5 h-3.5"/>
          </Button>
          <Button variant="outline" size="sm" onClick={clearAll} disabled={loading || log.length === 0}>
            <Trash2 className="w-3.5 h-3.5 mr-1.5"/>
            Clear
          </Button>
        </div>
      </div>

      <Separator/>

      {log.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <ArrowRight className="w-10 h-10 text-muted-foreground/30 mb-4"/>
          <p className="text-sm font-medium text-muted-foreground">No activity yet</p>
          <p className="text-xs text-muted-foreground mt-1">Files moved by Foldr will appear here.</p>
        </div>
      ) : (
        <ScrollArea className="h-[calc(100vh-220px)]">
          <div className="space-y-1 pr-2">
            {log.map(entry => (
              <div
                key={entry.id}
                className={`flex items-center gap-3 border rounded-lg px-3 py-2.5 text-xs transition-colors ${
                  entry.undone ? 'opacity-40 bg-muted/20' : 'bg-background hover:bg-muted/30'
                }`}
                data-testid="activity-entry"
              >
                {/* Timestamp */}
                <span className="font-mono text-muted-foreground shrink-0 w-[70px]">
                  {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>

                {/* Rule */}
                <Badge variant="outline" className="text-[9px] shrink-0 hidden sm:flex">
                  {entry.rule_name || '—'}
                </Badge>

                {/* Original → New */}
                <div className="flex items-center gap-1.5 flex-1 min-w-0">
                  <span className="font-mono text-muted-foreground truncate">{entry.original_name}</span>
                  <ArrowRight className="w-3 h-3 text-muted-foreground shrink-0"/>
                  <span className="font-mono text-foreground font-medium truncate">{entry.new_name}</span>
                </div>

                {/* Destination folder */}
                <Badge variant="secondary" className="text-[9px] shrink-0 hidden md:flex">
                  {entry.destination_folder}
                </Badge>

                {/* Undone label */}
                {entry.undone && (
                  <Badge variant="outline" className="text-[9px] text-muted-foreground shrink-0">UNDONE</Badge>
                )}

                {/* Actions */}
                <div className="flex items-center gap-1 shrink-0">
                  {isElectron && entry.new_path && !entry.undone && (
                    <button
                      onClick={() => openFolder(entry.new_path)}
                      className="text-muted-foreground hover:text-foreground"
                      title="Open destination folder"
                    >
                      <ExternalLink className="w-3.5 h-3.5"/>
                    </button>
                  )}
                  {!entry.undone && (
                    <button
                      onClick={() => undo(entry.id)}
                      className="text-muted-foreground hover:text-foreground"
                      title="Undo — move file back"
                    >
                      <RotateCcw className="w-3.5 h-3.5"/>
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
