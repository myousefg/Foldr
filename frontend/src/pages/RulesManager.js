import { useState, useEffect, useCallback } from 'react';
import { rulesApi } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, ChevronUp, ChevronDown, GraduationCap, Briefcase, Code, Folder } from 'lucide-react';

const isElectron = !!window.electronAPI;

const templateMeta = {
  student:    { label: 'Student',    icon: GraduationCap, desc: 'PDFs, Docs, Presentations, Spreadsheets' },
  freelancer: { label: 'Freelancer', icon: Briefcase,     desc: 'Invoices, Contracts, Documents, Assets'  },
  developer:  { label: 'Developer',  icon: Code,          desc: 'Code, Config, Docs, Archives'            },
};

const defaultForm = {
  name: '', condition_type: 'extension', condition_value: '',
  destination_folder: '', rename_template: '{date}_{originalname_cleaned}', enabled: true,
};

export default function RulesManager() {
  const [rules, setRules]         = useState([]);
  const [showDialog, setShowDialog] = useState(false);
  const [editingRule, setEditingRule] = useState(null);
  const [form, setForm]           = useState(defaultForm);
  const [saving, setSaving]       = useState(false);
  const [preview, setPreview]     = useState('');

  const fetchRules = useCallback(async () => {
    try { setRules(await rulesApi.getAll()); } catch { console.error('rules fetch failed'); }
  }, []);

  useEffect(() => { fetchRules(); }, [fetchRules]);

  // Live rename preview
  useEffect(() => {
    if (!form.rename_template) { setPreview(''); return; }
    const sample = form.condition_type === 'extension'
      ? `IMG_9283 (1)${form.condition_value || '.pdf'}`
      : `${form.condition_value || 'invoice'}_draft.pdf`;
    const dest  = form.destination_folder || 'Documents';
    const date  = new Date().toISOString().slice(0, 10);
    let cleaned = sample
      .replace(/\s*\(\d+\)\s*/g, '')
      .replace(/^(IMG|DSC|VID)[-_]?\d+[-_]?/i, '')
      .replace(/_/g, ' ').trim().toLowerCase().replace(/\s+/g, '-')
      .replace(/[^a-z0-9\-]/g, '').replace(/^\./, '') || 'file';
    const nameNoExt = sample.includes('.') ? sample.slice(0, sample.lastIndexOf('.')) : sample;
    const ext = sample.includes('.') ? sample.slice(sample.lastIndexOf('.')) : '';
    let result = form.rename_template
      .replace('{date}', date).replace('{YYYY-MM-DD}', date)
      .replace('{originalname}', nameNoExt)
      .replace('{originalname_cleaned}', cleaned)
      .replace('{cleaned_name}', cleaned)
      .replace('{sequence}', '001')
      .replace('{category}', dest.toLowerCase().replace(/\s+/g, '-'));
    result = result.replace(/[-_]{2,}/g, '_').replace(/^[-_]+|[-_]+$/g, '') + ext;
    setPreview(`${sample}  →  ${dest}\\${result}`);
  }, [form.rename_template, form.condition_type, form.condition_value, form.destination_folder]);

  const openAdd  = () => { setEditingRule(null); setForm(defaultForm); setShowDialog(true); };
  const openEdit = r => {
    setEditingRule(r);
    setForm({ name: r.name, condition_type: r.condition_type, condition_value: r.condition_value,
              destination_folder: r.destination_folder, rename_template: r.rename_template || '', enabled: r.enabled });
    setShowDialog(true);
  };

  const pickDestination = async () => {
    if (!isElectron) return;
    const f = await window.electronAPI.selectFolder({ title: 'Select destination folder' });
    if (f) setForm(prev => ({ ...prev, destination_folder: f }));
  };

  const handleSave = async () => {
    if (!form.name || !form.condition_value || !form.destination_folder) {
      toast.error('Fill in all required fields'); return;
    }
    setSaving(true);
    try {
      if (editingRule) { await rulesApi.update(editingRule.id, form); toast.success('Rule updated'); }
      else             { await rulesApi.create(form);                 toast.success('Rule created'); }
      setShowDialog(false); fetchRules();
    } catch { toast.error('Failed to save rule'); }
    setSaving(false);
  };

  const handleDelete = async id => {
    try { await rulesApi.delete(id); toast.success('Rule deleted'); fetchRules(); }
    catch { toast.error('Delete failed'); }
  };

  const handleToggle = async rule => {
    try { await rulesApi.update(rule.id, { enabled: !rule.enabled }); fetchRules(); }
    catch { toast.error('Update failed'); }
  };

  const move = async (idx, dir) => {
    const arr  = [...rules];
    const swap = idx + dir;
    if (swap < 0 || swap >= arr.length) return;
    [arr[idx], arr[swap]] = [arr[swap], arr[idx]];
    setRules(arr);
    try { await rulesApi.reorder(arr.map(r => r.id)); }
    catch { fetchRules(); }
  };

  const applyTemplate = async type => {
    try {
      await rulesApi.applyTemplate(type);
      toast.success(`${templateMeta[type].label} preset applied`);
      fetchRules();
    } catch { toast.error('Template apply failed'); }
  };

  return (
    <div className="space-y-6 animate-fade-in" data-testid="rules-page">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">Rules</h1>
          <p className="text-sm text-muted-foreground mt-1">Conditions + destinations. Evaluated top-to-bottom.</p>
        </div>
        <Button size="sm" onClick={openAdd} data-testid="add-rule-btn">
          <Plus className="w-3.5 h-3.5 mr-1.5" />New Rule
        </Button>
      </div>

      <Separator />

      {/* Rules list */}
      {rules.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center border border-dashed rounded-lg">
          <p className="text-sm font-medium text-muted-foreground">No rules yet</p>
          <p className="text-xs text-muted-foreground mt-1 mb-4">Add a rule manually or apply a preset below.</p>
        </div>
      ) : (
        <div className="space-y-1.5" data-testid="rules-list">
          {rules.map((rule, idx) => (
            <div
              key={rule.id}
              className="flex items-center gap-3 border rounded-lg px-4 py-3 bg-background hover:bg-muted/20 transition-colors"
              data-testid="rule-item"
            >
              {/* Priority arrows */}
              <div className="flex flex-col gap-0.5 shrink-0">
                <button onClick={() => move(idx, -1)} disabled={idx === 0}
                  className="text-muted-foreground hover:text-foreground disabled:opacity-20 transition-colors">
                  <ChevronUp className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => move(idx, 1)} disabled={idx === rules.length - 1}
                  className="text-muted-foreground hover:text-foreground disabled:opacity-20 transition-colors">
                  <ChevronDown className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold truncate">{rule.name}</p>
                <p className="text-xs text-muted-foreground font-mono mt-0.5 truncate">
                  {rule.condition_type === 'extension' ? `ext = ${rule.condition_value}` : `name ∋ "${rule.condition_value}"`}
                  {' → '}
                  <span className="text-foreground">{rule.destination_folder}</span>
                </p>
              </div>

              {/* Template badge */}
              <Badge variant="outline" className="text-[10px] font-mono hidden lg:flex shrink-0 max-w-[180px] truncate">
                {rule.rename_template || 'no rename'}
              </Badge>

              {/* Toggle */}
              <Switch checked={!!rule.enabled} onCheckedChange={() => handleToggle(rule)} />

              {/* Edit / Delete */}
              <button onClick={() => openEdit(rule)}
                className="text-muted-foreground hover:text-foreground p-1 rounded transition-colors">
                <Pencil className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => handleDelete(rule.id)}
                className="text-muted-foreground hover:text-destructive p-1 rounded transition-colors">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── Presets ── always visible at bottom */}
      <div className="pt-2">
        <Separator className="mb-5" />
        <p className="text-xs font-semibold tracking-[0.15em] uppercase text-muted-foreground mb-3">
          Quick-start Presets
        </p>
        <p className="text-xs text-muted-foreground mb-4">
          Apply a preset to add a batch of rules instantly. You can apply multiple presets or mix with custom rules.
        </p>
        <div className="flex flex-wrap gap-2">
          {Object.entries(templateMeta).map(([key, { label, icon: Icon, desc }]) => (
            <button
              key={key}
              onClick={() => applyTemplate(key)}
              className="flex items-center gap-3 border border-border rounded-lg px-4 py-3 text-sm hover:bg-accent transition-colors"
              data-testid={`template-${key}`}
            >
              <Icon className="w-4 h-4 text-muted-foreground shrink-0" />
              <div className="text-left">
                <div className="font-medium">{label}</div>
                <div className="text-xs text-muted-foreground">{desc}</div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Add / Edit dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">
              {editingRule ? 'Edit Rule' : 'New Rule'}
            </DialogTitle>
          </DialogHeader>

          <ScrollArea className="max-h-[65vh]">
            <div className="space-y-5 px-1 pb-1">

              <Field label="Rule Name">
                <Input
                  value={form.name}
                  onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                  placeholder="PDFs to Documents"
                  className="text-sm"
                />
              </Field>

              <Field label="Condition Type">
                <Select value={form.condition_type} onValueChange={v => setForm(p => ({ ...p, condition_type: v }))}>
                  <SelectTrigger className="text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="extension">File Extension</SelectItem>
                    <SelectItem value="keyword">Filename Keyword</SelectItem>
                  </SelectContent>
                </Select>
              </Field>

              <Field label={form.condition_type === 'extension' ? 'Extension' : 'Keyword'}>
                <Input
                  value={form.condition_value}
                  onChange={e => setForm(p => ({ ...p, condition_value: e.target.value }))}
                  placeholder={form.condition_type === 'extension' ? '.pdf' : 'invoice'}
                  className="font-mono text-sm"
                />
              </Field>

              <Field label="Destination Folder">
                <div className="flex gap-2">
                  <Input
                    value={form.destination_folder}
                    onChange={e => setForm(p => ({ ...p, destination_folder: e.target.value }))}
                    placeholder="Documents"
                    className="font-mono text-sm flex-1"
                  />
                  {isElectron && (
                    <Button variant="outline" size="sm" onClick={pickDestination} title="Browse">
                      <Folder className="w-4 h-4" />
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Relative paths use Base Output Folder from Settings. Absolute paths work anywhere.
                </p>
              </Field>

              <Field label="Rename Template">
                <Input
                  value={form.rename_template}
                  onChange={e => setForm(p => ({ ...p, rename_template: e.target.value }))}
                  placeholder="{date}_{originalname_cleaned}"
                  className="font-mono text-sm"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Tokens:&nbsp;
                  <code className="bg-muted px-1 rounded">{'{date}'}</code>&nbsp;
                  <code className="bg-muted px-1 rounded">{'{originalname_cleaned}'}</code>&nbsp;
                  <code className="bg-muted px-1 rounded">{'{sequence}'}</code>
                </p>
              </Field>

              {/* Live preview */}
              {preview && (
                <div className="bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 rounded-lg px-4 py-3">
                  <p className="text-[10px] font-semibold tracking-widest uppercase text-emerald-700 dark:text-emerald-400 mb-1">Preview</p>
                  <p className="font-mono text-xs text-emerald-800 dark:text-emerald-300 break-all">{preview}</p>
                </div>
              )}

              <div className="flex items-center justify-between pt-1">
                <Label className="text-sm font-medium">Enabled</Label>
                <Switch checked={!!form.enabled} onCheckedChange={v => setForm(p => ({ ...p, enabled: v }))} />
              </div>

            </div>
          </ScrollArea>

          <DialogFooter className="pt-2">
            <Button variant="outline" size="sm" onClick={() => setShowDialog(false)}>Cancel</Button>
            <Button size="sm" onClick={handleSave} disabled={saving} data-testid="save-rule-btn">
              {saving ? 'Saving…' : editingRule ? 'Save Changes' : 'Create Rule'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}

function Field({ label, children }) {
  return (
    <div className="space-y-2">
      <Label className="text-xs font-semibold tracking-wide uppercase text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}