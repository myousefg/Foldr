import { useState, useEffect, useCallback, useRef } from 'react';
import { rulesApi, organizeApi } from '@/lib/api';
import { useI18n } from '@/context/I18nProvider';
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

const defaultForm = {
  name: '', condition_type: 'extension', condition_value: '',
  destination_folder: '', rename_template: '{date}_{originalname_cleaned}', enabled: true,
  extra_conditions: [],
  min_size_mb: '', max_age_days: '',
};

export default function RulesManager() {
  const { t } = useI18n();
  const [rules, setRules]             = useState([]);
  const [showDialog, setShowDialog]   = useState(false);
  const [editingRule, setEditingRule] = useState(null);
  const [form, setForm]               = useState(defaultForm);
  const [saving, setSaving]           = useState(false);
  const [sizeAgeOpen, setSizeAgeOpen] = useState(false);
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

    // Build a representative sample filename that exercises the condition
    const sampleFilename = form.condition_type === 'extension'
      ? `IMG_9283 (1)${form.condition_value || '.pdf'}`
      : `${form.condition_value || 'invoice'}_draft.pdf`;

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
  }, [form.rename_template, form.condition_type, form.condition_value, form.destination_folder, form.extra_conditions]);

  const openAdd  = () => { setEditingRule(null); setForm(defaultForm); setSizeAgeOpen(false); setShowDialog(true); };
  const openEdit = r => {
    setEditingRule(r);
    const minSizeMb = r.min_size_bytes ? (r.min_size_bytes / (1024 * 1024)).toString() : '';
    setForm({ name: r.name, condition_type: r.condition_type, condition_value: r.condition_value,
              destination_folder: r.destination_folder, rename_template: r.rename_template || '',
              enabled: r.enabled, extra_conditions: r.extra_conditions || [],
              min_size_mb: minSizeMb, max_age_days: r.max_age_days?.toString() || '' });
    setSizeAgeOpen(!!(r.min_size_bytes || r.max_age_days));
    setShowDialog(true);
  };

  const pickDestination = async () => {
    if (!isElectron) return;
    const f = await window.electronAPI.selectFolder({ title: 'Select destination folder' });
    if (f) setForm(p => ({ ...p, destination_folder: f }));
  };

  const handleSave = async () => {
    if (!form.name || !form.condition_value || !form.destination_folder) {
      toast.error('Fill in all required fields'); return;
    }
    for (const ec of form.extra_conditions) {
      if (!ec.condition_value.trim()) { toast.error('All conditions must have a value'); return; }
    }
    const minSizeBytes = form.min_size_mb !== '' ? Math.round(parseFloat(form.min_size_mb) * 1024 * 1024) : null;
    const maxAgeDays   = form.max_age_days !== '' ? parseInt(form.max_age_days, 10) : null;
    if (form.min_size_mb !== '' && (isNaN(minSizeBytes) || minSizeBytes < 0)) {
      toast.error('Min Size must be a positive number'); return;
    }
    if (form.max_age_days !== '' && (isNaN(maxAgeDays) || maxAgeDays < 0)) {
      toast.error('Max Age must be a positive integer'); return;
    }
    setSaving(true);
    try {
      const payload = { ...form, min_size_bytes: minSizeBytes, max_age_days: maxAgeDays };
      delete payload.min_size_mb;
      if (editingRule) { await rulesApi.update(editingRule.id, payload); toast.success(t('rules.ruleUpdated')); }
      else             { await rulesApi.create(payload);                  toast.success(t('rules.ruleCreated')); }
      setShowDialog(false); fetchRules();
    } catch { toast.error(t('rules.fillRequired')); }
    setSaving(false);
  };

  const handleDelete = async id => {
    try { await rulesApi.delete(id); toast.success(t('rules.ruleDeleted')); fetchRules(); }
    catch { toast.error(t('common.error')); }
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
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">{t('rules.title')}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t('rules.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Export */}
          <Button variant="outline" size="sm" onClick={exportRules} title={t('rules.export')}>
            <Download className="w-3.5 h-3.5 mr-1.5" />{t('rules.export')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => importRef.current?.click()} title={t('rules.import')}>
            <Upload className="w-3.5 h-3.5 mr-1.5" />{t('rules.import')}
          </Button>
          <input ref={importRef} type="file" accept=".json" className="hidden" onChange={importRules} />
          <Button size="sm" onClick={openAdd}>
            <Plus className="w-3.5 h-3.5 mr-1.5" />{t('rules.addRule')}
          </Button>
        </div>
      </div>

      <Separator />

      {/* Rules list */}
      {rules.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center border border-dashed rounded-lg">
          <p className="text-sm font-medium text-muted-foreground">{t('rules.noRules')}</p>
          <p className="text-xs text-muted-foreground mt-1 mb-4">{t('rules.noRulesDesc')}</p>
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
                <div className="flex flex-wrap items-center gap-1 mt-0.5">
                  <p className="text-xs text-muted-foreground font-mono">
                    {rule.condition_type === 'extension' ? `ext = ${rule.condition_value}` : `name ∋ "${rule.condition_value}"`}
                  </p>
                  {(rule.extra_conditions || []).map((ec, i) => (
                    <span key={i} className="flex items-center gap-1">
                      <span className="text-[10px] font-bold text-primary/70 uppercase tracking-wide">{t('common.and')}</span>
                      <span className="text-xs text-muted-foreground font-mono">
                        {ec.condition_type === 'extension' ? `ext = ${ec.condition_value}` : `name ∋ "${ec.condition_value}"`}
                      </span>
                    </span>
                  ))}
                  <span className="text-xs text-muted-foreground font-mono">
                    {' → '}<span className="text-foreground">{rule.destination_folder}</span>
                  </span>
                </div>
              </div>
              <Badge variant="outline" className="text-[10px] font-mono hidden lg:flex shrink-0 max-w-[180px] truncate">
                {rule.rename_template || t('rules.noRename')}
              </Badge>
              {(rule.min_size_bytes || rule.max_age_days) && (
                <Badge variant="outline" className="text-[10px] font-mono hidden lg:flex shrink-0 border-primary/30 text-primary/70">
                  {rule.min_size_bytes ? `≥${(rule.min_size_bytes/1048576).toFixed(1)}MB` : ''}
                  {rule.min_size_bytes && rule.max_age_days ? ' · ' : ''}
                  {rule.max_age_days ? `≤${rule.max_age_days}d` : ''}
                </Badge>
              )}
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
          <p className="text-xs font-semibold tracking-[0.15em] uppercase text-muted-foreground">{t('rules.presets')}</p>
          <button onClick={removeDuplicates} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-destructive transition-colors">
            <AlertTriangle className="w-3.5 h-3.5" />{t('rules.removeDuplicates')}
          </button>
        </div>
        <p className="text-xs text-muted-foreground mb-4">{t('rules.presetsDesc')}</p>
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
                <div className="font-medium">{applyingPreset === key ? t('rules.applying') : label}</div>
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
              {editingRule ? t('rules.editRule') : t('rules.newRule')}
            </DialogTitle>
          </DialogHeader>
          <ScrollArea className="max-h-[65vh]">
            <div className="space-y-5 px-1 pb-1">
              <Field label={t('rules.ruleName')}>
                <Input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                  placeholder={t('rules.ruleNamePlaceholder')} className="text-sm" />
              </Field>
              <Field label={t('rules.conditions')}>
                <p className="text-xs text-muted-foreground -mt-1 mb-2">{t('rules.conditionsDesc')}</p>
                <ConditionRow
                  condType={form.condition_type}
                  condValue={form.condition_value}
                  onTypeChange={v => setForm(p => ({ ...p, condition_type: v }))}
                  onValueChange={v => setForm(p => ({ ...p, condition_value: v }))}
                  canRemove={false}
                  label={t('rules.condition1')}
                />
                {form.extra_conditions.map((ec, i) => (
                  <ConditionRow
                    key={i}
                    condType={ec.condition_type}
                    condValue={ec.condition_value}
                    onTypeChange={v => setForm(p => ({
                      ...p,
                      extra_conditions: p.extra_conditions.map((c, j) => j === i ? { ...c, condition_type: v } : c)
                    }))}
                    onValueChange={v => setForm(p => ({
                      ...p,
                      extra_conditions: p.extra_conditions.map((c, j) => j === i ? { ...c, condition_value: v } : c)
                    }))}
                    onRemove={() => setForm(p => ({
                      ...p,
                      extra_conditions: p.extra_conditions.filter((_, j) => j !== i)
                    }))}
                    canRemove={true}
                    label={t('rules.conditionN', { n: i + 2 })}
                  />
                ))}
                <button
                  type="button"
                  onClick={() => setForm(p => ({
                    ...p,
                    extra_conditions: [...p.extra_conditions, { condition_type: 'extension', condition_value: '' }]
                  }))}
                  className="flex items-center gap-1.5 text-xs text-primary hover:underline mt-1"
                >
                  <Plus className="w-3.5 h-3.5" />
                  {t('rules.addCondition')}
                </button>
              </Field>
              <Field label={t('rules.destination')}>
                <div className="flex gap-2">
                  <Input value={form.destination_folder}
                    onChange={e => setForm(p => ({ ...p, destination_folder: e.target.value }))}
                    placeholder={t('rules.destinationPlaceholder')} className="font-mono text-sm flex-1" />
                  {isElectron && (
                    <Button variant="outline" size="sm" onClick={pickDestination} title={t('common.browse')}>
                      <Folder className="w-4 h-4" />
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-1">{t('rules.destinationHint')}</p>
              </Field>
              <Field label={t('rules.renameTemplate')}>
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
              {/* Size & Age Filters */}
              <div className="border border-border rounded-lg overflow-hidden">
                <button
                  type="button"
                  onClick={() => setSizeAgeOpen(p => !p)}
                  className="w-full flex items-center justify-between px-3 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:bg-muted/30 transition-colors"
                >
                  <span className="flex items-center gap-1.5">
                    {(form.min_size_mb || form.max_age_days) && (
                      <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" />
                    )}
                    {t('rules.sizeAgeFilters')}
                  </span>
                  <ChevronDown className={`w-3.5 h-3.5 transition-transform ${sizeAgeOpen ? 'rotate-180' : ''}`} />
                </button>
                {sizeAgeOpen && (
                  <div className="px-3 pb-3 pt-1 space-y-3 border-t border-border">
                    <p className="text-xs text-muted-foreground">{t('rules.sizeAgeDesc')}</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-muted-foreground">{t('rules.minSize')}</label>
                        <Input type="number" min="0" step="0.1" value={form.min_size_mb}
                          onChange={e => setForm(p => ({ ...p, min_size_mb: e.target.value }))}
                          placeholder="e.g. 1" className="font-mono text-sm" />
                        <p className="text-[10px] text-muted-foreground">{t('rules.minSizeHint')}</p>
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-muted-foreground">{t('rules.maxAge')}</label>
                        <Input type="number" min="0" step="1" value={form.max_age_days}
                          onChange={e => setForm(p => ({ ...p, max_age_days: e.target.value }))}
                          placeholder="e.g. 7" className="font-mono text-sm" />
                        <p className="text-[10px] text-muted-foreground">{t('rules.maxAgeHint')}</p>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between pt-1">
                <Label className="text-sm font-medium">{t('rules.enabled')}</Label>
                <Switch checked={!!form.enabled} onCheckedChange={v => setForm(p => ({ ...p, enabled: v }))} />
              </div>
            </div>
          </ScrollArea>
          <DialogFooter className="pt-2">
            <Button variant="outline" size="sm" onClick={() => setShowDialog(false)}>{t('common.cancel')}</Button>
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? t('rules.saving') : editingRule ? t('rules.saveChanges') : t('rules.createRule')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ConditionRow({ condType, condValue, onTypeChange, onValueChange, onRemove, canRemove, label }) {
  const { t } = useI18n();
  return (
    <div className="space-y-1.5 border border-border rounded-lg p-3 bg-muted/20 mb-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
        {canRemove && (
          <button type="button" onClick={onRemove} className="text-muted-foreground hover:text-destructive">
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      <div className="flex gap-2">
        <Select value={condType} onValueChange={onTypeChange}>
          <SelectTrigger className="text-xs w-40 shrink-0"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="extension">{t('rules.fileExtension')}</SelectItem>
            <SelectItem value="keyword">{t('rules.filenameKeyword')}</SelectItem>
          </SelectContent>
        </Select>
        <Input
          value={condValue}
          onChange={e => onValueChange(e.target.value)}
          placeholder={condType === 'extension' ? '.pdf' : 'telkom'}
          className="font-mono text-sm flex-1"
        />
      </div>
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