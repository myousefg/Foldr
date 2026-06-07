import { useState, useEffect, useCallback, useRef } from 'react';
import { rulesApi, organizeApi } from '@/lib/api';
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
import { Plus, Pencil, Trash2, ChevronUp, ChevronDown, GraduationCap, Briefcase, Code, Folder, Camera, Palette, BookOpen, Upload, Download, AlertTriangle, X } from 'lucide-react';

const isElectron = !!window.electronAPI;

const templateMeta = {
  student:    { label: 'Student',      icon: GraduationCap, desc: 'PDFs, Docs, Presentations, Spreadsheets' },
  freelancer: { label: 'Freelancer',   icon: Briefcase,     desc: 'Invoices, Contracts, Proposals, Assets'  },
  developer:  { label: 'Developer',    icon: Code,          desc: 'Code, Config, Docs, Archives, TypeScript' },
  photographer:{ label: 'Photographer',icon: Camera,        desc: 'JPG, JPEG, PNG, HEIC, RAW, XMP, Videos'  },
  designer:   { label: 'Designer',     icon: Palette,       desc: 'Figma, PSD, AI, XD, SVG, Fonts'          },
  writer:     { label: 'Writer',       icon: BookOpen,      desc: 'Docs, PDFs, Notes, Drafts, Finals'        },
};

const defaultCondition = { condition_type: 'extension', condition_value: '' };
const defaultForm = {
  name: '',
  conditions: [{ condition_type: 'extension', condition_value: '' }],
  destination_folder: '', rename_template: '{date}_{originalname_cleaned}', enabled: true,
};

export default function RulesManager() {
  const [rules, setRules]             = useState([]);
  const [showDialog, setShowDialog]   = useState(false);
  const [editingRule, setEditingRule] = useState(null);
  const [form, setForm]               = useState(defaultForm);
  const [saving, setSaving]           = useState(false);
  const [preview, setPreview]         = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [applyingPreset, setApplyingPreset] = useState(null);
  const importRef                     = useRef(null);
  const previewAbort                  = useRef(null);

  const fetchRules = useCallback(async () => {
    try { setRules(await rulesApi.getAll()); } catch { console.error('rules fetch failed'); }
  }, []);

  useEffect(() => { fetchRules(); }, [fetchRules]);

  // Live rename preview — calls backend /api/organize/preview to guarantee
  // 100% match with the real apply_template() + clean_filename() logic (Option 1).
  useEffect(() => {
    if (!form.rename_template) { setPreview(''); setPreviewLoading(false); return; }

    // Build a representative sample filename that exercises the first condition
    const primaryCondition = form.conditions[0] || { condition_type: 'extension', condition_value: '.pdf' };
    const sampleFilename = primaryCondition.condition_type === 'extension'
      ? `IMG_9283 (1)${primaryCondition.condition_value || '.pdf'}`
      : `${primaryCondition.condition_value || 'invoice'}_draft.pdf`;

    // Cancel any in-flight request before firing a new one
    if (previewAbort.current) previewAbort.current.abort();
    const controller = new AbortController();
    previewAbort.current = controller;

    setPreviewLoading(true);

    organizeApi.templatePreview(sampleFilename, form.rename_template, form.destination_folder || 'Documents')
      .then(r => {
        if (controller.signal.aborted) return;
        if (r) {
          setPreview(`${r.original_name}  →  ${r.destination_folder}\\${r.new_name}`);
        } else {
          setPreview('');
        }
      })
      .catch(err => {
        if (err?.name === 'CanceledError' || err?.name === 'AbortError' || controller.signal.aborted) return;
        // Graceful fallback when backend is unreachable — approximate preview only
        const dest = form.destination_folder || 'Documents';
        const date = new Date().toISOString().slice(0, 10);
        const nameNoExt = sampleFilename.includes('.') ? sampleFilename.slice(0, sampleFilename.lastIndexOf('.')) : sampleFilename;
        const ext       = sampleFilename.includes('.') ? sampleFilename.slice(sampleFilename.lastIndexOf('.')) : '';
        let result = form.rename_template
          .replace('{date}', date).replace('{YYYY-MM-DD}', date)
          .replace('{YYYY}', date.slice(0,4)).replace('{MM}', date.slice(5,7)).replace('{DD}', date.slice(8,10))
          .replace('{originalname}', nameNoExt)
          .replace('{originalname_cleaned}', nameNoExt.toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9\-]/g,'') || 'file')
          .replace('{cleaned_name}',         nameNoExt.toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9\-]/g,'') || 'file')
          .replace('{sequence}', '001')
          .replace('{category}', dest.toLowerCase().replace(/\s+/g,'-'));
        result = result.replace(/[-_]{2,}/g,'_').replace(/^[-_]+|[-_]+$/g,'') + ext;
        setPreview(`${sampleFilename}  →  ${dest}\\${result} ⚠ backend offline`);
      })
      .finally(() => { if (!controller.signal.aborted) setPreviewLoading(false); });

    return () => controller.abort();
  }, [form.rename_template, form.conditions, form.destination_folder]);

  const openAdd  = () => { setEditingRule(null); setForm(defaultForm); setShowDialog(true); };
  const openEdit = r => {
    setEditingRule(r);
    const conditions = r.conditions && r.conditions.length > 0
      ? r.conditions
      : [{ condition_type: r.condition_type, condition_value: r.condition_value }];
    setForm({
      name: r.name,
      conditions,
      destination_folder: r.destination_folder,
      rename_template: r.rename_template || '',
      enabled: r.enabled,
    });
    setShowDialog(true);
  };

  const pickDestination = async () => {
    if (!isElectron) return;
    const f = await window.electronAPI.selectFolder({ title: 'Select destination folder' });
    if (f) setForm(p => ({ ...p, destination_folder: f }));
  };

  const handleSave = async () => {
    const hasEmptyCondition = form.conditions.some(c => !c.condition_value.trim());
    if (!form.name || hasEmptyCondition || !form.destination_folder) {
      toast.error('Fill in all required fields'); return;
    }
    const payload = {
      name: form.name,
      conditions: form.conditions,
      // Keep legacy fields in sync with primary condition for older backend versions
      condition_type: form.conditions[0].condition_type,
      condition_value: form.conditions[0].condition_value,
      destination_folder: form.destination_folder,
      rename_template: form.rename_template,
      enabled: form.enabled,
    };
    setSaving(true);
    try {
      if (editingRule) { await rulesApi.update(editingRule.id, payload); toast.success('Rule updated'); }
      else             { await rulesApi.create(payload);                  toast.success('Rule created'); }
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
    const arr = [...rules]; const swap = idx + dir;
    if (swap < 0 || swap >= arr.length) return;
    [arr[idx], arr[swap]] = [arr[swap], arr[idx]];
    setRules(arr);
    try { await rulesApi.reorder(arr.map(r => r.id)); } catch { fetchRules(); }
  };

  const applyTemplate = async type => {
    if (applyingPreset) return;
    setApplyingPreset(type);
    try {
      const result = await rulesApi.applyTemplate(type);
      const added   = result?.added   ?? 0;
      const skipped = result?.skipped ?? 0;
      if (added === 0 && skipped > 0)       toast.info(`All ${templateMeta[type].label} rules already exist — nothing added.`);
      else if (added > 0 && skipped > 0)    toast.success(`${added} rule${added !== 1 ? 's' : ''} added, ${skipped} already existed and skipped.`);
      else if (added > 0)                   toast.success(`${templateMeta[type].label} preset applied — ${added} rules added.`);
      else                                  toast.info('No new rules to add.');
      fetchRules();
    } catch (e) {
      if (e.response?.status === 409) toast.warning('Already applying a preset, please wait.');
      else toast.error('Preset apply failed');
    } finally { setApplyingPreset(null); }
  };

  const removeDuplicates = async () => {
    try {
      const r = await rulesApi.removeDuplicates();
      if (r.deleted === 0) toast.info('No duplicate rules found.');
      else toast.success(`Removed ${r.deleted} duplicate rule${r.deleted !== 1 ? 's' : ''}.`);
      fetchRules();
    } catch { toast.error('Failed to remove duplicates'); }
  };

  const exportRules = async () => {
    try {
      const data = await rulesApi.exportRules();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = `foldr-rules-${new Date().toISOString().slice(0,10)}.json`;
      a.click(); URL.revokeObjectURL(url);
      toast.success(`Exported ${data.length} rules`);
    } catch { toast.error('Export failed'); }
  };

  const importRules = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!Array.isArray(data)) { toast.error('Invalid file — expected a JSON array'); return; }
      const result = await rulesApi.importRules({ rules: data, replace: false });
      toast.success(`Imported ${result.added} rules${result.skipped > 0 ? `, ${result.skipped} skipped (already exist)` : ''}`);
      fetchRules();
    } catch { toast.error('Import failed — check file format'); }
    e.target.value = '';
  };

  return (
    <div className="space-y-6 animate-fade-in" data-testid="rules-page">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">Rules</h1>
          <p className="text-sm text-muted-foreground mt-1">Conditions + destinations. Evaluated top-to-bottom.</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Export */}
          <Button variant="outline" size="sm" onClick={exportRules} title="Export rules as JSON">
            <Download className="w-3.5 h-3.5 mr-1.5" />Export
          </Button>
          {/* Import */}
          <Button variant="outline" size="sm" onClick={() => importRef.current?.click()} title="Import rules from JSON">
            <Upload className="w-3.5 h-3.5 mr-1.5" />Import
          </Button>
          <input ref={importRef} type="file" accept=".json" className="hidden" onChange={importRules} />
          {/* New rule */}
          <Button size="sm" onClick={openAdd}>
            <Plus className="w-3.5 h-3.5 mr-1.5" />New Rule
          </Button>
        </div>
      </div>

      <Separator />

      {/* Rules list */}
      {rules.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center border border-dashed rounded-lg">
          <p className="text-sm font-medium text-muted-foreground">No rules yet</p>
          <p className="text-xs text-muted-foreground mt-1 mb-4">Add a rule manually or apply a preset below.</p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {rules.map((rule, idx) => (
            <div key={rule.id} className="flex items-center gap-3 border rounded-lg px-4 py-3 bg-background hover:bg-muted/20 transition-colors">
              <div className="flex flex-col gap-0.5 shrink-0">
                <button onClick={() => move(idx, -1)} disabled={idx === 0} className="text-muted-foreground hover:text-foreground disabled:opacity-20 transition-colors">
                  <ChevronUp className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => move(idx, 1)} disabled={idx === rules.length - 1} className="text-muted-foreground hover:text-foreground disabled:opacity-20 transition-colors">
                  <ChevronDown className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold truncate">{rule.name}</p>
                <p className="text-xs text-muted-foreground font-mono mt-0.5 truncate">
                  {(rule.conditions && rule.conditions.length > 0 ? rule.conditions : [{condition_type: rule.condition_type, condition_value: rule.condition_value}])
                    .map((c, i) => (
                      <span key={i}>{i > 0 && <span className="opacity-50"> AND </span>}
                        {c.condition_type === 'extension' ? `ext=${c.condition_value}` : `∋"${c.condition_value}"`}
                      </span>
                    ))}
                  {' → '}<span className="text-foreground">{rule.destination_folder}</span>
                </p>
              </div>
              <Badge variant="outline" className="text-[10px] font-mono hidden lg:flex shrink-0 max-w-[180px] truncate">
                {rule.rename_template || 'no rename'}
              </Badge>
              <Switch checked={!!rule.enabled} onCheckedChange={() => handleToggle(rule)} />
              <button onClick={() => openEdit(rule)} className="text-muted-foreground hover:text-foreground p-1 rounded transition-colors">
                <Pencil className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => handleDelete(rule.id)} className="text-muted-foreground hover:text-destructive p-1 rounded transition-colors">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── Presets ── */}
      <div className="pt-2">
        <Separator className="mb-5" />
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-semibold tracking-[0.15em] uppercase text-muted-foreground">Quick-start Presets</p>
          <button onClick={removeDuplicates} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-destructive transition-colors" title="Remove any duplicate rules">
            <AlertTriangle className="w-3.5 h-3.5" />Remove duplicates
          </button>
        </div>
        <p className="text-xs text-muted-foreground mb-4">Apply any preset at any time — existing rules are never duplicated.</p>
        <div className="grid grid-cols-3 gap-3">
          {Object.entries(templateMeta).map(([key, { label, icon: Icon, desc }]) => (
            <button
              key={key}
              onClick={() => applyTemplate(key)}
              disabled={!!applyingPreset}
              className={`flex items-center gap-3 border border-border rounded-lg px-4 py-3 text-sm transition-colors ${
                applyingPreset === key   ? 'opacity-60 cursor-not-allowed bg-accent' :
                applyingPreset           ? 'opacity-40 cursor-not-allowed' :
                                           'hover:bg-accent cursor-pointer'
              }`}
            >
              {applyingPreset === key ? (
                <svg className="w-4 h-4 animate-spin text-muted-foreground shrink-0" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z"/>
                </svg>
              ) : (
                <Icon className="w-4 h-4 text-muted-foreground shrink-0" />
              )}
              <div className="text-left">
                <div className="font-medium">{applyingPreset === key ? 'Applying…' : label}</div>
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
                <Input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                  placeholder="PDFs to Documents" className="text-sm" />
              </Field>
              <Field label="Conditions">
                <div className="space-y-2">
                  {form.conditions.map((cond, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      {idx > 0 && (
                        <span className="text-[10px] font-bold text-muted-foreground shrink-0 w-8 text-center">AND</span>
                      )}
                      {idx === 0 && <div className="w-8" />}
                      <Select
                        value={cond.condition_type}
                        onValueChange={v => setForm(p => {
                          const conditions = [...p.conditions];
                          conditions[idx] = { ...conditions[idx], condition_type: v };
                          return { ...p, conditions };
                        })}
                      >
                        <SelectTrigger className="text-sm w-36 shrink-0"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="extension">Extension</SelectItem>
                          <SelectItem value="keyword">Keyword</SelectItem>
                        </SelectContent>
                      </Select>
                      <Input
                        value={cond.condition_value}
                        onChange={e => setForm(p => {
                          const conditions = [...p.conditions];
                          conditions[idx] = { ...conditions[idx], condition_value: e.target.value };
                          return { ...p, conditions };
                        })}
                        placeholder={cond.condition_type === 'extension' ? '.pdf' : 'invoice'}
                        className="font-mono text-sm flex-1"
                      />
                      {form.conditions.length > 1 && (
                        <button
                          onClick={() => setForm(p => ({
                            ...p,
                            conditions: p.conditions.filter((_, i) => i !== idx),
                          }))}
                          className="text-muted-foreground hover:text-destructive p-1 rounded transition-colors shrink-0"
                          title="Remove condition"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  ))}
                  <button
                    onClick={() => setForm(p => ({
                      ...p,
                      conditions: [...p.conditions, { condition_type: 'extension', condition_value: '' }],
                    }))}
                    className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground mt-1 transition-colors"
                  >
                    <Plus className="w-3 h-3" /> Add Condition
                  </button>
                </div>
              </Field>
              <Field label="Destination Folder">
                <div className="flex gap-2">
                  <Input value={form.destination_folder}
                    onChange={e => setForm(p => ({ ...p, destination_folder: e.target.value }))}
                    placeholder="Documents" className="font-mono text-sm flex-1" />
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
                <Input value={form.rename_template}
                  onChange={e => setForm(p => ({ ...p, rename_template: e.target.value }))}
                  placeholder="{date}_{originalname_cleaned}" className="font-mono text-sm" />
                <p className="text-xs text-muted-foreground mt-1">
                  Tokens:&nbsp;
                  <code className="bg-muted px-1 rounded">{'{date}'}</code>&nbsp;
                  <code className="bg-muted px-1 rounded">{'{originalname_cleaned}'}</code>&nbsp;
                  <code className="bg-muted px-1 rounded">{'{sequence}'}</code>
                </p>
              </Field>
              {(previewLoading || preview) && (
                <div className={`rounded-lg px-4 py-3 border ${
                  preview?.includes('⚠ backend offline')
                    ? 'bg-yellow-50 dark:bg-yellow-950/30 border-yellow-200 dark:border-yellow-800'
                    : 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800'
                }`}>
                  <p className={`text-[10px] font-semibold tracking-widest uppercase mb-1 ${
                    preview?.includes('⚠ backend offline')
                      ? 'text-yellow-700 dark:text-yellow-400'
                      : 'text-emerald-700 dark:text-emerald-400'
                  }`}>Preview</p>
                  {previewLoading
                    ? <p className="font-mono text-xs text-muted-foreground animate-pulse">Computing…</p>
                    : <p className="font-mono text-xs text-emerald-800 dark:text-emerald-300 break-all">{preview}</p>
                  }
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
            <Button size="sm" onClick={handleSave} disabled={saving}>
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