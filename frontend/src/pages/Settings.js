import { useState, useEffect, useCallback } from 'react';
import { settingsApi } from '@/lib/api';
import { useTheme } from '@/context/ThemeProvider';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import { Folder, ExternalLink, Sun, Moon, Monitor } from 'lucide-react';

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
  const open = async () => {
    if (isElectron && value) await window.electronAPI.openFolder(value);
  };
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium tracking-wide uppercase text-muted-foreground">{label}</Label>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
      <div className="flex gap-2">
        <Input
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          className="font-mono text-sm flex-1"
        />
        {isElectron && (
          <>
            <Button variant="outline" size="sm" onClick={pick} title="Browse">
              <Folder className="w-4 h-4" />
            </Button>
            {value && (
              <Button variant="outline" size="sm" onClick={open} title="Open in Explorer">
                <ExternalLink className="w-4 h-4" />
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function Settings() {
  const [cfg, setCfg]     = useState(null);
  const [dirty, setDirty] = useState({});
  const [saving, setSaving] = useState(false);
  const { theme, setTheme } = useTheme();

  const load = useCallback(async () => {
    try { setCfg(await settingsApi.get()); } catch { console.error('load settings failed'); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const set = (k, v) => {
    setCfg(prev => ({ ...prev, [k]: v }));
    setDirty(prev => ({ ...prev, [k]: v }));
  };

  const save = async () => {
    if (!Object.keys(dirty).length) return;
    setSaving(true);
    try {
      await settingsApi.update(dirty);
      setDirty({});
      toast.success('Settings saved');
    } catch { toast.error('Failed to save'); }
    setSaving(false);
  };

  if (!cfg) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;

  return (
    <div className="space-y-8 animate-fade-in max-w-2xl">

      <div>
        <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">Configure monitoring, naming, and appearance.</p>
      </div>

      <Separator />

      {/* Folders */}
      <section className="space-y-5">
        <h2 className="text-xs font-semibold tracking-[0.15em] uppercase text-muted-foreground">Folders</h2>

        <FolderInput
          label="Monitored Folder"
          description="Foldr watches this folder for new files."
          value={cfg.monitored_folder || ''}
          onChange={v => set('monitored_folder', v)}
          placeholder="e.g. C:\Users\You\Downloads"
        />

        <FolderInput
          label="Base Output Folder"
          description='Rule destinations like "Documents" are relative to this. Leave blank to use your home directory.'
          value={cfg.base_output_folder || ''}
          onChange={v => set('base_output_folder', v)}
          placeholder="e.g. C:\Users\You  (default: home directory)"
        />
      </section>

      <Separator />

      {/* Behaviour */}
      <section className="space-y-5">
        <h2 className="text-xs font-semibold tracking-[0.15em] uppercase text-muted-foreground">Behaviour</h2>

        <ToggleRow
          label="Preview before moving"
          description="Queue detected files for your review instead of moving them immediately."
          checked={!!cfg.preview_before_apply}
          onChange={v => set('preview_before_apply', v)}
        />
        <ToggleRow
          label="Monitoring enabled"
          description="Pause monitoring without losing your folder or rule configuration."
          checked={!!cfg.monitoring_enabled}
          onChange={v => set('monitoring_enabled', v)}
        />
        <ToggleRow
          label="Auto-clean filenames"
          description="Strip camera codes (IMG_, DSC_), copy markers, and normalise spacing."
          checked={!!cfg.auto_clean_names}
          onChange={v => set('auto_clean_names', v)}
        />
      </section>

      <Separator />

      {/* Rename template */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold tracking-[0.15em] uppercase text-muted-foreground">Default Rename Template</h2>
        <p className="text-xs text-muted-foreground">
          Used when a rule has no template.&nbsp;
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
        <h2 className="text-xs font-semibold tracking-[0.15em] uppercase text-muted-foreground">Appearance</h2>
        <p className="text-xs text-muted-foreground">Choose the colour theme for the app.</p>
        <div className="flex gap-2">
          {themeOptions.map(opt => {
            const Icon = opt.icon;
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
                {opt.label}
              </button>
            );
          })}
        </div>
      </section>

      <div className="flex justify-end pt-2">
        <Button onClick={save} disabled={saving || !Object.keys(dirty).length}>
          {saving ? 'Saving…' : 'Save Settings'}
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