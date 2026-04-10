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
import {
  Plus, Pencil, Trash2, ChevronUp, ChevronDown,
  GraduationCap, Briefcase, Code, Folder
} from 'lucide-react';

const isElectron = !!window.electronAPI;

const templateMeta = {
  student:    { label: 'Student',    icon: GraduationCap, desc: 'PDFs, Docs, Presentations, Spreadsheets' },
  freelancer: { label: 'Freelancer', icon: Briefcase,     desc: 'Invoices, Contracts, Documents, Assets' },
  developer:  { label: 'Developer',  icon: Code,          desc: 'Code, Config, Docs, Archives' },
};

const defaultForm = {
  name: '', condition_type: 'extension', condition_value: '',
  destination_folder: '', rename_template: '{date}_{originalname_cleaned}', enabled: true,
};

export default function RulesManager() {
  const [rules, setRules] = useState([]);
  const [showDialog, setShowDialog] = useState(false);
  const [editingRule, setEditingRule] = useState(null);
  const [form, setForm] = useState(defaultForm);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState('');

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
    const dest = form.destination_folder || 'Documents';
    // Simple client-side preview (mirrors Python logic)
    const date = new Date().toISOString().slice(0, 10);
    let cleaned = sample.replace(/\s*\(\d+\)\s*/g, '')
      .replace(/^(IMG|DSC|VID)[-_]?\d+[-_]?/i, '')
      .replace(/_/g, ' ').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '').replace(/^\./, '');
    const nameNoExt = sample.includes('.') ? sample.slice(0, sample.lastIndexOf('.')) : sample;
    const ext = sample.includes('.') ? sample.slice(sample.lastIndexOf('.')) : '';
    let result = form.rename_template
      .replace('{date}', date)
      .replace('{YYYY-MM-DD}', date)
      .replace('{originalname}', nameNoExt)
      .replace('{originalname_cleaned}', cleaned || 'file')
      .replace('{cleaned_name}', cleaned || 'file')
      .replace('{sequence}', '001')
      .replace('{category}', dest.toLowerCase().replace(/\s+/g, '-'));
    result = result.replace(/[-_]{2,}/g, '_').replace(/^[-_]+|[-_]+$/g, '') + ext;
    setPreview(`${sample}  →  ${dest}\\${result}`);
  }, [form.rename_template, form.condition_type, form.condition_value, form.destination_folder]);

  const openAdd = () => { setEditingRule(null); setForm(defaultForm); setShowDialog(true); };
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
      else { await rulesApi.create(form); toast.success('Rule created'); }
      setShowDialog(false); fetchRules();
    } catch { toast.error('Failed to save rule'); }
    setSaving(false);
  };

  const handleDelete = async id => {
    try { await rulesApi.delete(id); toast.success('Rule deleted'); fetchRules(); }
    catch { toast.error('Delete failed'); }
  };

  const handleToggle = async (rule) => {
    try { await rulesApi.update(rule.id, { enabled: !rule.enabled }); fetchRules(); }
    catch { toast.error('Update failed'); }
  };

  const move = async (idx, dir) => {
    const arr = [...rules];
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
      toast.success(`${templateMeta[type].label} template applied`);
      fetchRules();
    } catch { toast.error('Template apply failed'); }
  };

  return (
    <div className="space-y-6 animate-fade-in" data-testid="rules-page">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">Rules</h1>
          <p className="text-sm text-muted-foreground mt-1">Conditions + destinations. Evaluated top-to-bottom.</p>
        </div>
        <Button size="sm" onClick={openAdd} data-testid="add-rule-btn">
          <Plus className="w-3.5 h-3.5 mr-1.5"/>New Rule
        </Button>
      </div>

      <Separator/>

      {/* Quick-start templates */}
      {rules.length === 0 && (
        <div className="border border-dashed border-border rounded-lg p-5 space-y-3">
          <p className="text-sm font-medium">Quick-start templates</p>
          <div className="flex flex-wrap gap-2">
            {Object.entries(templateMeta).map(([key, { label, icon: Icon, desc }]) => (
              <button
                key={key}
                onClick={() => applyTemplate(key)}
                className="flex items-center gap-2 border border-border rounded-lg px-3 py-2 text-xs hover:bg-accent transition-colors"
                data-testid={`template-${key}`}
              >
                <Icon className="w-3.5 h-3.5 text-muted-foreground"/>
                <div className="text-left">
                  <div className="font-medium">{label}</div>
                  <div className="text-muted-foreground">{desc}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Rules list */}
      {rules.length > 0 && (
        <div className="space-y-1" data-testid="rules-list">
          {rules.map((rule, idx) => (
            <div
              key={rule.id}
              className="flex items-center gap-3 border border-border rounded-lg px-3 py-2.5 bg-background hover:bg-muted/30 transition-colors"
              data-testid="rule-item"
            >
              {/* Priority arrows */}
              <div className="flex flex-col gap-0.5 shrink-0">
                <button onClick={() => move(idx, -1)} disabled={idx === 0} className="text-muted-foreground hover:text-foreground disabled:opacity-20">
                  <ChevronUp className="w-3 h-3"/>
                </button>
                <button onClick={() => move(idx, 1)} disabled={idx === rules.length - 1} className="text-muted-foreground hover:text-foreground disabled:opacity-20">
                  <ChevronDown className="w-3 h-3"/>
                </button>
              </div>

              {/* Name */}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{rule.name}</p>
                <p className="text-xs text-muted-foreground font-mono truncate">
                  {rule.condition_type === 'extension' ? `ext = ${rule.condition_value}` : `name ∋ "${rule.condition_value}"`}
                  {' → '}
                  <span className="text-foreground">{rule.destination_folder}</span>
                </p>
              </div>

              {/* Template badge */}
              <Badge variant="outline" className="text-[9px] hidden sm:flex font-mono shrink-0">
                {rule.rename_template || 'no rename'}
              </Badge>

              {/* Toggle */}
              <Switch
                checked={!!rule.enabled}
                onCheckedChange={() => handleToggle(rule)}
                data-testid="rule-toggle"
              />

              {/* Edit / Delete */}
              <button onClick={() => openEdit(rule)} className="text-muted-foreground hover:text-foreground">
                <Pencil className="w-3.5 h-3.5"/>
              </button>
              <button onClick={() => handleDelete(rule.id)} className="text-muted-foreground hover:text-destructive">
                <Trash2 className="w-3.5 h-3.5"/>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add/Edit dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold tracking-tight">
              {editingRule ? 'Edit Rule' : 'New Rule'}
            </DialogTitle>
          </DialogHeader>
          <ScrollArea className="max-h-[70vh]">
            <div className="space-y-4 pr-1">

              <Field label="Rule Name">
                <Input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                  placeholder="e.g. PDFs to Documents" className="text-sm"/>
              </Field>

              <Field label="Condition Type">
                <Select value={form.condition_type} onValueChange={v => setForm(p => ({ ...p, condition_type: v }))}>
                  <SelectTrigger className="text-sm"><SelectValue/></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="extension">File Extension</SelectItem>
                    <SelectItem value="keyword">Filename Keyword</SelectItem>
                  </SelectContent>
                </Select>
              </Field>

              <Field label={form.condition_type === 'extension' ? 'Extension (e.g. .pdf)' : 'Keyword (e.g. invoice)'}>
                <Input value={form.condition_value}
                  onChange={e => setForm(p => ({ ...p, condition_value: e.target.value }))}
                  placeholder={form.condition_type === 'extension' ? '.pdf' : 'invoice'}
                  className="font-mono text-sm"/>
              </Field>

              <Field label="Destination Folder">
                <div className="flex gap-2">
                  <Input value={form.destination_folder}
                    onChange={e => setForm(p => ({ ...p, destination_folder: e.target.value }))}
                    placeholder="Documents  or  C:\Users\You\Finance"
                    className="font-mono text-sm flex-1"/>
                  {isElectron && (
                    <Button variant="outline" size="sm" onClick={pickDestination} title="Browse">
                      <Folder className="w-4 h-4"/>
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Relative paths use the Base Output Folder from Settings. Absolute paths work anywhere.
                </p>
              </Field>

              <Field label="Rename Template">
                <Input value={form.rename_template}
                  onChange={e => setForm(p => ({ ...p, rename_template: e.target.value }))}
                  placeholder="{date}_{originalname_cleaned}"
                  className="font-mono text-sm"/>
                <p className="text-xs text-muted-foreground mt-1">
                  Tokens: <code className="bg-muted px-1 rounded">{'{date}'}</code>&nbsp;
                  <code className="bg-muted px-1 rounded">{'{originalname_cleaned}'}</code>&nbsp;
                  <code className="bg-muted px-1 rounded">{'{originalname}'}</code>&nbsp;
                  <code className="bg-muted px-1 rounded">{'{sequence}'}</code>
                </p>
              </Field>

              {/* Live preview */}
              {preview && (
                <div className="bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 rounded-lg p-3">
                  <p className="text-[10px] font-semibold tracking-wider uppercase text-emerald-700 dark:text-emerald-400 mb-1">Preview</p>
                  <p className="font-mono text-xs text-emerald-800 dark:text-emerald-300 break-all">{preview}</p>
                </div>
              )}

              <div className="flex items-center justify-between pt-1">
                <Label className="text-sm">Enabled</Label>
                <Switch checked={!!form.enabled} onCheckedChange={v => setForm(p => ({ ...p, enabled: v }))}/>
              </div>
            </div>
          </ScrollArea>
          <DialogFooter>
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
    <div className="space-y-1.5">
      <Label className="text-xs font-medium tracking-wide uppercase text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
