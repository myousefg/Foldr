import { useState, useEffect, useCallback } from 'react';
import { settingsApi, monitoredFoldersApi } from '@/lib/api';
import { useTheme } from '@/context/ThemeProvider';
import { useI18n } from '@/context/I18nProvider';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import { Folder, ExternalLink, Sun, Moon, Monitor, Plus, Trash2, Eye, EyeOff } from 'lucide-react';

const isElectron = !!window.electronAPI;

const themeOptions = [
  { value: 'light',  icon: Sun,     label: 'Light'  },
  { value: 'dark',   icon: Moon,    label: 'Dark'   },
  { value: 'system', icon: Monitor, label: 'System' },
];

function FolderInput({ label, description, value, onChange, placeholder }) {
  const pick = async () => {
    if (!isElectron) return;
    const f = await window.electronAPI.selectFolder({ title: label });
    if (f) onChange(f);
  };
  const open = async () => { if (isElectron && value) await window.electronAPI.openFolder(value); };
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium tracking-wide uppercase text-muted-foreground">{label}</Label>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
      <div className="flex gap-2">
        <Input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} className="font-mono text-sm flex-1" />
        {isElectron && (
          <>
            <Button variant="outline" size="sm" onClick={pick} title="Browse"><Folder className="w-4 h-4" /></Button>
            {value && <Button variant="outline" size="sm" onClick={open} title="Open in Explorer"><ExternalLink className="w-4 h-4" /></Button>}
          </>
        )}
      </div>
    </div>
  );
}

function MonitoredFoldersList({ folders, onAdd, onToggle, onRemove }) {
  const [newPath, setNewPath] = useState('');
  const [adding, setAdding] = useState(false);
  const { t } = useI18n();

  const pickFolder = async () => {
    if (!isElectron) return;
    const f = await window.electronAPI.selectFolder({ title: 'Add Monitored Folder' });
    if (f) setNewPath(f);
  };

  const handleAdd = async () => {
    const trimmed = newPath.trim();
    if (!trimmed) return;
    setAdding(true);
    try {
      await onAdd(trimmed);
      setNewPath('');
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="space-y-3">
      <Label className="text-xs font-medium tracking-wide uppercase text-muted-foreground">
        {t('settings.monitoredFolders')}
      </Label>
      <p className="text-xs text-muted-foreground">
        {t('settings.monitoredFoldersDesc')}
      </p>

      {/* Existing folders list */}
      {folders.length === 0 ? (
        <p className="text-xs text-muted-foreground italic py-2">{t('settings.noFolders')}</p>
      ) : (
        <div className="space-y-2">
          {folders.map(f => (
            <div key={f.id} className="flex items-center gap-2 p-2 rounded-lg border bg-muted/30">
              <Folder className="w-4 h-4 shrink-0 text-muted-foreground" />
              <span className={`font-mono text-xs flex-1 truncate ${!f.enabled ? 'opacity-40' : ''}`}>{f.path}</span>
              <div className="flex items-center gap-1 shrink-0">
                <Button
                  variant="ghost" size="sm"
                  onClick={() => onToggle(f.id, !f.enabled)}
                  title={f.enabled ? t('settings.pauseFolder') : t('settings.resumeFolder')}
                  className="h-7 w-7 p-0"
                >
                  {f.enabled
                    ? <Eye className="w-3.5 h-3.5 text-muted-foreground" />
                    : <EyeOff className="w-3.5 h-3.5 text-muted-foreground" />}
                </Button>
                {isElectron && (
                  <Button
                    variant="ghost" size="sm"
                    onClick={() => window.electronAPI.openFolder(f.path)}
                    title={t('settings.openExplorer')}
                    className="h-7 w-7 p-0"
                  >
                    <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
                  </Button>
                )}
                <Button
                  variant="ghost" size="sm"
                  onClick={() => onRemove(f.id)}
                  title={t('settings.removeFolder')}
                  className="h-7 w-7 p-0 hover:text-destructive"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add new folder row */}
      <div className="flex gap-2">
        <Input
          value={newPath}
          onChange={e => setNewPath(e.target.value)}
          placeholder={t('settings.folderPlaceholder')}
          className="font-mono text-sm flex-1"
          onKeyDown={e => e.key === 'Enter' && handleAdd()}
        />
        {isElectron && (
          <Button variant="outline" size="sm" onClick={pickFolder} title={t('common.browse')}>
            <Folder className="w-4 h-4" />
          </Button>
        )}
        <Button size="sm" onClick={handleAdd} disabled={adding || !newPath.trim()}>
          <Plus className="w-4 h-4 mr-1" />
          {t('settings.addFolder')}
        </Button>
      </div>
    </div>
  );
}

export default function Settings() {
  const [cfg, setCfg]                     = useState(null);
  const [dirty, setDirty]                 = useState({});
  const [saving, setSaving]               = useState(false);
  const [autoStart, setAutoStart]         = useState(false);
  const [monFolders, setMonFolders]       = useState([]);
  const { theme, setTheme }               = useTheme();
  const { lang, setLang, t }              = useI18n();

  const load = useCallback(async () => {
    try {
      const [s, mf] = await Promise.all([
        settingsApi.get(),
        monitoredFoldersApi.getAll(),
      ]);
      setCfg(s);
      setMonFolders(mf);
      if (isElectron) {
        const as = await window.electronAPI.getAutoStart();
        setAutoStart(as);
      }
    } catch { console.error('load settings failed'); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const set = (k, v) => { setCfg(p => ({ ...p, [k]: v })); setDirty(p => ({ ...p, [k]: v })); };

  const save = async () => {
    if (!Object.keys(dirty).length) return;
    setSaving(true);
    try { await settingsApi.update(dirty); setDirty({}); toast.success(t('settings.saved')); }
    catch { toast.error(t('settings.saveFailed')); }
    setSaving(false);
  };

  const handleAutoStart = async (enabled) => {
    if (!isElectron) { toast.error(t('settings.autoStartElectronOnly')); return; }
    try {
      await window.electronAPI.setAutoStart(enabled);
      setAutoStart(enabled);
      toast.success(enabled ? t('settings.autoStartEnabled') : t('settings.autoStartDisabled'));
    } catch { toast.error(t('settings.autoStartFailed')); }
  };

  const handleAddFolder = async (path) => {
    try {
      const added = await monitoredFoldersApi.add(path);
      setMonFolders(prev => [...prev, added]);
      toast.success(t('settings.folderAdded', { path }));
    } catch (err) {
      const msg = err?.response?.data?.detail || t('common.error');
      toast.error(msg);
    }
  };

  const handleToggleFolder = async (id, enabled) => {
    try {
      const updated = await monitoredFoldersApi.toggle(id, enabled);
      setMonFolders(prev => prev.map(f => f.id === id ? updated : f));
      toast.success(enabled ? t('settings.folderResumed') : t('settings.folderPaused'));
    } catch { toast.error(t('common.error')); }
  };

  const handleRemoveFolder = async (id) => {
    try {
      await monitoredFoldersApi.remove(id);
      setMonFolders(prev => prev.filter(f => f.id !== id));
      toast.success(t('settings.folderRemoved'));
    } catch { toast.error(t('common.error')); }
  };

  if (!cfg) return <div className="p-6 text-sm text-muted-foreground">{t('common.loading')}</div>;

  return (
    <div className="space-y-8 animate-fade-in max-w-2xl">
      <div>
        <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">{t('settings.title')}</h1>
        <p className="text-sm text-muted-foreground mt-1">{t('settings.subtitle')}</p>
      </div>

      <Separator />

      {/* Folders */}
      <section className="space-y-5">
        <h2 className="text-xs font-semibold tracking-[0.15em] uppercase text-muted-foreground">{t('settings.folders')}</h2>
        <MonitoredFoldersList
          folders={monFolders}
          onAdd={handleAddFolder}
          onToggle={handleToggleFolder}
          onRemove={handleRemoveFolder}
        />
        <FolderInput
          label={t('settings.baseOutputFolder')}
          description={t('settings.baseOutputDesc')}
          value={cfg.base_output_folder || ''}
          onChange={v => set('base_output_folder', v)}
          placeholder="e.g. C:\Users\You"
        />
      </section>

      <Separator />

      {/* Behaviour */}
      <section className="space-y-5">
        <h2 className="text-xs font-semibold tracking-[0.15em] uppercase text-muted-foreground">{t('settings.behaviour')}</h2>
        <ToggleRow
          label={t('settings.previewBeforeMove')}
          description={t('settings.previewBeforeMoveDesc')}
          checked={!!cfg.preview_before_apply}
          onChange={v => set('preview_before_apply', v)}
        />
        <ToggleRow
          label={t('settings.monitoringEnabled')}
          description={t('settings.monitoringEnabledDesc')}
          checked={!!cfg.monitoring_enabled}
          onChange={v => set('monitoring_enabled', v)}
        />
        <ToggleRow
          label={t('settings.autoClean')}
          description={t('settings.autoCleanDesc')}
          checked={!!cfg.auto_clean_names}
          onChange={v => set('auto_clean_names', v)}
        />
        <ToggleRow
          label={t('settings.startWithWindows')}
          description={t('settings.startWithWindowsDesc')}
          checked={autoStart}
          onChange={handleAutoStart}
        />
      </section>

      <Separator />

      {/* Rename template */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold tracking-[0.15em] uppercase text-muted-foreground">{t('settings.renameTemplate')}</h2>
        <p className="text-xs text-muted-foreground">
          {t('settings.renameTemplateDesc')}&nbsp;
          Tokens:&nbsp;
          <code className="bg-muted px-1 rounded text-[11px]">{'{date}'}</code>&nbsp;
          <code className="bg-muted px-1 rounded text-[11px]">{'{originalname_cleaned}'}</code>&nbsp;
          <code className="bg-muted px-1 rounded text-[11px]">{'{originalname}'}</code>&nbsp;
          <code className="bg-muted px-1 rounded text-[11px]">{'{sequence}'}</code>
        </p>
        <Input
          value={cfg.default_rename_template || ''}
          onChange={e => set('default_rename_template', e.target.value)}
          className="font-mono text-sm"
          placeholder="{date}_{originalname_cleaned}"
        />
      </section>

      <Separator />

      {/* Appearance */}
      <section className="space-y-4">
        <h2 className="text-xs font-semibold tracking-[0.15em] uppercase text-muted-foreground">{t('settings.appearance')}</h2>
        <p className="text-xs text-muted-foreground">{t('settings.appearanceDesc')}</p>
        <div className="flex gap-2">
          {[
            { value: 'light',  icon: Sun,     labelKey: 'settings.light'  },
            { value: 'dark',   icon: Moon,    labelKey: 'settings.dark'   },
            { value: 'system', icon: Monitor, labelKey: 'settings.system' },
          ].map(opt => {
            const Icon   = opt.icon;
            const active = theme === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => setTheme(opt.value)}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${
                  active
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-background text-muted-foreground border-border hover:bg-accent hover:text-foreground'
                }`}
              >
                <Icon className="w-4 h-4" strokeWidth={1.8} />
                {t(opt.labelKey)}
              </button>
            );
          })}
        </div>
      </section>

      <Separator />

      {/* Language */}
      <section className="space-y-4">
        <h2 className="text-xs font-semibold tracking-[0.15em] uppercase text-muted-foreground">{t('settings.language')}</h2>
        <p className="text-xs text-muted-foreground">{t('settings.languageDesc')}</p>
        <div className="flex gap-2">
          {[
            { value: 'en', label: 'English' },
            { value: 'id', label: 'Bahasa Indonesia' },
          ].map(opt => (
            <button
              key={opt.value}
              onClick={() => setLang(opt.value)}
              className={`px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${
                lang === opt.value
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-background text-muted-foreground border-border hover:bg-accent hover:text-foreground'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </section>

      <div className="flex justify-end pt-2">
        <Button onClick={save} disabled={saving || !Object.keys(dirty).length}>
          {saving ? t('settings.saving') : t('settings.saveSettings')}
        </Button>
      </div>
    </div>
  );
}

function ToggleRow({ label, description, checked, onChange }) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} className="shrink-0 mt-0.5" />
    </div>
  );
}
