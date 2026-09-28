import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  HYPHEN_LABELS,
  KIND_LABELS,
  archiveFileName,
  archiveRuleCount,
  buildArchive,
  diffArchive,
  makeArchiveRecord,
  parseArchive,
} from './archive';
import type { ArchiveDiff, RuleChange, RuleSetDiff } from './archive';
import type { ArchiveMergeStats, ProjectState, RuleArchive, RuleArchiveRecord } from './types';

type Tab = 'export' | 'import' | 'records';
type ImportStage = 'input' | 'preview' | 'done';

interface ArchiveDialogProps {
  open: boolean;
  state: ProjectState;
  onClose: () => void;
  onExportArchive: (archive: RuleArchive, fileName: string) => void;
  onImportArchive: (diff: ArchiveDiff, record: RuleArchiveRecord) => ArchiveMergeStats;
  onDeleteRecord: (id: string) => void;
}

function downloadJson(fileName: string, archive: RuleArchive): void {
  const blob = new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function partyLabel(archive: RuleArchive): string {
  return [archive.school, archive.teacher].filter(Boolean).join(' · ') || '外校老师';
}

function Badge({ direction }: { direction: RuleArchiveRecord['direction'] }) {
  return <span class={`archive-badge ${direction}`}>{direction === 'export' ? '发出' : '接收'}</span>;
}

function ChangeRow({ change, counterpartLabel, onToggle, onChooseConflict }: {
  change: RuleChange;
  counterpartLabel: string;
  onToggle: () => void;
  onChooseConflict: (takeIncoming: boolean) => void;
}) {
  if (change.type === 'identical') return null;

  return (
    <div class={`change-row ${change.type} ${change.apply ? '' : 'skipped'}`}>
      <div class="change-head">
        <span class="change-kind">{KIND_LABELS[change.kind]}</span>
        <strong class="change-source">{change.source || '（空原文）'}</strong>
        <span class="change-tag">{change.type === 'new' ? '新增' : change.type === 'replace' ? '替换' : '冲突'}</span>
        {change.type === 'conflict' ? (
          <label class="change-skip">
            <input type="checkbox" checked={change.takeIncoming === false} onChange={() => onChooseConflict(false)} />
            保留本校
          </label>
        ) : (
          <label class="change-skip">
            <input type="checkbox" checked={change.apply} onChange={onToggle} />
            {change.type === 'new' ? '加入' : '替换'}
          </label>
        )}
      </div>
      <div class="change-bodies">
        {change.local && (
          <div class={`change-side local ${change.type === 'conflict' && !change.takeIncoming ? 'picked' : ''}`}>
            <span class="side-label">本校（当前项目）</span>
            <span class="side-braille">{change.local.output || '—'}</span>
            {change.type === 'conflict' && (
              <button class="side-pick" type="button" onClick={() => onChooseConflict(false)}>
                {change.takeIncoming ? '保留这版' : '✓ 已保留'}
              </button>
            )}
          </div>
        )}
        <div class={`change-side incoming ${change.type === 'conflict' && change.takeIncoming ? 'picked' : ''}`}>
          <span class="side-label">来件 · {counterpartLabel}</span>
          <span class="side-braille">{change.incoming.output || '—'}</span>
          {change.type === 'conflict' && (
            <button class="side-pick" type="button" onClick={() => onChooseConflict(true)}>
              {change.takeIncoming ? '✓ 取这版' : '取这版'}
            </button>
          )}
        </div>
      </div>
      {(change.local?.description || change.incoming.description) && (
        <p class="change-note">
          {change.local?.description && <>本校说明：{change.local.description}</>}
          {change.local?.description && change.incoming.description && '　｜　'}
          {change.incoming.description && <>来件说明：{change.incoming.description}</>}
        </p>
      )}
    </div>
  );
}

function SetDiffBlock({ setDiff, counterpartLabel, onToggleSet, onToggleSetting, onToggleChange, onChooseConflict, onBatchConflict }: {
  setDiff: RuleSetDiff;
  counterpartLabel: string;
  onToggleSet: () => void;
  onToggleSetting: (field: RuleSetDiff['settings'][number]['field']) => void;
  onToggleChange: (key: string) => void;
  onChooseConflict: (key: string, takeIncoming: boolean) => void;
  onBatchConflict: (takeIncoming: boolean) => void;
}) {
  const { ruleSet, changes } = setDiff;
  const conflicts = changes.filter((change) => change.type === 'conflict');
  const replaces = changes.filter((change) => change.type === 'replace');
  const additions = changes.filter((change) => change.type === 'new');
  const identical = changes.filter((change) => change.type === 'identical');
  const [showIdentical, setShowIdentical] = useState(false);

  return (
    <section class={`diff-set ${setDiff.include ? '' : 'excluded'}`}>
      <header class="diff-set-head">
        <label class="diff-set-title">
          <input type="checkbox" checked={setDiff.include} onChange={onToggleSet} />
          <div>
            <strong>{ruleSet.name}</strong>
            <span>
              {setDiff.isNew
                ? `新规则集 · ${ruleSet.rules.length} 条规则`
                : `新增 ${additions.length} · 替换 ${replaces.length} · 冲突 ${conflicts.length} · 相同 ${identical.length}`}
            </span>
          </div>
        </label>
        {conflicts.length > 0 && (
          <div class="conflict-batch">
            <md-text-button type="button" onClick={() => onBatchConflict(false)}>冲突全保留本校</md-text-button>
            <md-text-button type="button" onClick={() => onBatchConflict(true)}>冲突全取来件</md-text-button>
          </div>
        )}
      </header>

      {setDiff.include && (
        <>
          {setDiff.isNew && (
            <p class="set-meta-line">
              来件设置：{ruleSet.contractions ? '启用缩写' : '关闭缩写'} · {HYPHEN_LABELS[ruleSet.hyphenMode]} · {ruleSet.description || '无说明'}
            </p>
          )}

          {setDiff.settings.length > 0 && (
            <div class="setting-diffs">
              <p class="sub-label">规则集设置差异（默认保持本校，勾选后才采用来件）</p>
              {setDiff.settings.map((setting) => (
                <label class="setting-row" key={setting.field}>
                  <input type="checkbox" checked={setting.apply} onChange={() => onToggleSetting(setting.field)} />
                  <span class="setting-label">{setting.label}</span>
                  <span class="setting-values">
                    <del>{setting.localValue}</del>
                    <em>→ {setting.incomingValue}</em>
                  </span>
                </label>
              ))}
            </div>
          )}

          <div class="change-groups">
            {conflicts.map((change) => (
              <ChangeRow
                key={change.key}
                change={change}
                counterpartLabel={counterpartLabel}
                onToggle={() => onToggleChange(change.key)}
                onChooseConflict={(takeIncoming) => onChooseConflict(change.key, takeIncoming)}
              />
            ))}
            {replaces.map((change) => (
              <ChangeRow
                key={change.key}
                change={change}
                counterpartLabel={counterpartLabel}
                onToggle={() => onToggleChange(change.key)}
                onChooseConflict={() => undefined}
              />
            ))}
            {additions.map((change) => (
              <ChangeRow
                key={change.key}
                change={change}
                counterpartLabel={counterpartLabel}
                onToggle={() => onToggleChange(change.key)}
                onChooseConflict={() => undefined}
              />
            ))}
            {changes.length === 0 && <p class="empty-inline">该规则集没有随档规则。</p>}
          </div>

          {identical.length > 0 && (
            <button class="identical-toggle" type="button" onClick={() => setShowIdentical((value) => !value)}>
              {showIdentical ? '收起' : '查看'}两版完全相同的 {identical.length} 条（无需处理）
            </button>
          )}
          {showIdentical && identical.map((change) => (
            <div class="change-row identical" key={change.key}>
              <div class="change-head">
                <span class="change-kind">{KIND_LABELS[change.kind]}</span>
                <strong class="change-source">{change.source || '（空原文）'}</strong>
                <span class="change-tag">相同</span>
                <span class="side-braille">{change.incoming.output}</span>
              </div>
            </div>
          ))}
        </>
      )}
    </section>
  );
}

export default function ArchiveDialog({ open, state, onClose, onExportArchive, onImportArchive, onDeleteRecord }: ArchiveDialogProps) {
  const [tab, setTab] = useState<Tab>('export');

  // 导出页签
  const [school, setSchool] = useState('');
  const [teacher, setTeacher] = useState(state.author);
  const [note, setNote] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>(state.ruleSets.map((ruleSet) => ruleSet.id));
  const [exportedHint, setExportedHint] = useState('');

  // 接收页签
  const [rawText, setRawText] = useState('');
  const [parseError, setParseError] = useState('');
  const [stage, setStage] = useState<ImportStage>('input');
  const [diff, setDiff] = useState<ArchiveDiff | null>(null);
  const [stats, setStats] = useState<ArchiveMergeStats | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setStage('input');
      setRawText('');
      setParseError('');
      setDiff(null);
      setStats(null);
      setExportedHint('');
    }
  }, [open]);

  const records = state.ruleArchives ?? [];

  const totals = useMemo(() => {
    if (!diff) return { added: 0, replaced: 0, conflictsTake: 0, conflictsKeep: 0, settings: 0, newSets: 0, actionable: 0 };
    let added = 0;
    let replaced = 0;
    let conflictsTake = 0;
    let conflictsKeep = 0;
    let settings = 0;
    let newSets = 0;
    diff.sets.forEach((setDiff) => {
      if (!setDiff.include) return;
      if (setDiff.isNew) {
        newSets += 1;
        added += setDiff.ruleSet.rules.length;
        return;
      }
      setDiff.changes.forEach((change) => {
        if (!change.apply) return;
        if (change.type === 'new') added += 1;
        if (change.type === 'replace') replaced += 1;
        if (change.type === 'conflict') (change.takeIncoming ? (conflictsTake += 1) : (conflictsKeep += 1));
      });
      settings += setDiff.settings.filter((setting) => setting.apply).length;
    });
    return { added, replaced, conflictsTake, conflictsKeep, settings, newSets, actionable: added + replaced + conflictsTake + settings + newSets };
  }, [diff]);

  if (!open) return null;

  const toggleSetSelected = (id: string) => {
    setSelectedIds((ids) => (ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]));
  };

  const handleExport = () => {
    const archive = buildArchive(state.ruleSets, selectedIds, { school, teacher, note });
    const fileName = archiveFileName(archive);
    onExportArchive(archive, fileName);
    downloadJson(fileName, archive);
    setExportedHint(`已导出 ${archive.ruleSets.length} 个规则集、${archiveRuleCount(archive)} 条规则，并记入互传记录。`);
  };

  const readFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      setRawText(String(reader.result ?? ''));
      setParseError('');
    };
    reader.onerror = () => setParseError('读取文件失败，请重试。');
    reader.readAsText(file);
  };

  const previewArchive = () => {
    try {
      const archive = parseArchive(rawText);
      setDiff(diffArchive(state, archive));
      setStage('preview');
      setParseError('');
    } catch (error) {
      setParseError(error instanceof Error ? error.message : '档案解析失败。');
    }
  };

  const mutateDiff = (mutate: (draft: ArchiveDiff) => void) => {
    setDiff((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      mutate(next);
      return next;
    });
  };

  const handleConfirm = () => {
    if (!diff) return;
    const fileName = archiveFileName(diff.archive, 'import');
    // stats 由应用层合并后给出（保证记录里的数字与实际落盘一致）
    const record = makeArchiveRecord('import', diff.archive, fileName);
    const result = onImportArchive(diff, record);
    setStats(result);
    setStage('done');
  };

  const counterpart = diff ? partyLabel(diff.archive) : '';

  return (
    <div class="dialog-backdrop" onClick={onClose}>
      <div class="archive-dialog" role="dialog" aria-modal="true" aria-label="规则档案互传" onClick={(event) => event.stopPropagation()}>
        <header class="archive-header">
          <div>
            <h2>规则档案互传</h2>
            <p>把校订好的规则集发给同校老师，或接收对方校订的档案；接收时先核对差异，确认后才会改动当前项目。</p>
          </div>
          <md-icon-button aria-label="关闭" onClick={onClose}>×</md-icon-button>
        </header>

        <div class="archive-tabs" role="tablist">
          <button class={tab === 'export' ? 'active' : ''} onClick={() => setTab('export')}>导出档案</button>
          <button class={tab === 'import' ? 'active' : ''} onClick={() => setTab('import')}>接收档案</button>
          <button class={tab === 'records' ? 'active' : ''} onClick={() => setTab('records')}>
            互传记录{records.length > 0 && <span>{records.length}</span>}
          </button>
        </div>

        <div class="archive-body scroll-pane">
          {tab === 'export' && (
            <div class="archive-pane">
              <div class="form-grid">
                <md-outlined-text-field label="学校（收件老师据此辨认来源）" value={school} onInput={(event: any) => setSchool(event.currentTarget.value)} />
                <md-outlined-text-field label="校订教师" value={teacher} onInput={(event: any) => setTeacher(event.currentTarget.value)} />
                <md-outlined-text-field type="textarea" rows={2} label="本版说明（如：修订了 for/ing 两条缩写）" value={note} onInput={(event: any) => setNote(event.currentTarget.value)} />
              </div>

              <p class="sub-label">选择要导出的规则集（含规则集说明、缩写开关、断词方式和全部规则）</p>
              <div class="export-set-list">
                {state.ruleSets.map((ruleSet) => (
                  <label class={`export-set ${selectedIds.includes(ruleSet.id) ? 'picked' : ''}`} key={ruleSet.id}>
                    <input type="checkbox" checked={selectedIds.includes(ruleSet.id)} onChange={() => toggleSetSelected(ruleSet.id)} />
                    <div>
                      <strong>{ruleSet.name}</strong>
                      <span>{ruleSet.rules.length} 条规则 · {ruleSet.contractions ? '启用缩写' : '关闭缩写'} · {HYPHEN_LABELS[ruleSet.hyphenMode]}</span>
                      <p>{ruleSet.description}</p>
                    </div>
                  </label>
                ))}
              </div>

              {exportedHint && <p class="export-hint">✓ {exportedHint}</p>}
            </div>
          )}

          {tab === 'import' && (
            <div class="archive-pane">
              {stage === 'input' && (
                <>
                  <div class="import-source">
                    <input
                      ref={fileInputRef}
                      class="hidden-file-input"
                      type="file"
                      accept=".json,application/json"
                      onChange={(event: any) => {
                        const file = event.currentTarget.files?.[0] as File | undefined;
                        if (file) readFile(file);
                      }}
                    />
                    <md-filled-button type="button" onClick={() => fileInputRef.current?.click()}>选择规则档案文件</md-filled-button>
                    <span class="or">或直接粘贴档案内容</span>
                  </div>
                  <md-outlined-text-field
                    type="textarea"
                    rows={9}
                    label="规则档案（.braille-rules.json）内容"
                    value={rawText}
                    onInput={(event: any) => setRawText(event.currentTarget.value)}
                  />
                  {parseError && <p class="parse-error">✕ {parseError}</p>}
                  <p class="safe-note">先预览再确认；在你确认合并之前，当前项目保持原样。</p>
                </>
              )}

              {stage === 'preview' && diff && (
                <>
                  <div class="incoming-meta">
                    <div>
                      <span class="eyebrow">来件来源</span>
                      <strong>{counterpart}</strong>
                      {diff.archive.note && <p>{diff.archive.note}</p>}
                    </div>
                    <div class="incoming-stats">
                      <span><b>{diff.sets.filter((set) => set.isNew).length}</b> 个新规则集</span>
                      <span><b>{totals.added}</b> 条新增</span>
                      <span><b>{totals.replaced}</b> 条替换</span>
                      <span class="conflict-count"><b>{diff.conflicts}</b> 条原文相同、盲文不同</span>
                    </div>
                  </div>

                  {diff.sets.map((setDiff) => (
                    <SetDiffBlock
                      key={setDiff.ruleSet.id}
                      setDiff={setDiff}
                      counterpartLabel={counterpart}
                      onToggleSet={() => mutateSet(setDiff.ruleSet.id, (draft) => { draft.include = !draft.include; })}
                      onToggleSetting={(field) => mutateSet(setDiff.ruleSet.id, (draft) => {
                        const target = draft.settings.find((item) => item.field === field);
                        if (target) target.apply = !target.apply;
                      })}
                      onToggleChange={(key) => mutateSet(setDiff.ruleSet.id, (draft) => {
                        const target = draft.changes.find((item) => item.key === key);
                        if (target) target.apply = !target.apply;
                      })}
                      onChooseConflict={(key, takeIncoming) => mutateSet(setDiff.ruleSet.id, (draft) => {
                        const target = draft.changes.find((item) => item.key === key);
                        if (target) {
                          target.apply = true;
                          target.takeIncoming = takeIncoming;
                        }
                      })}
                      onBatchConflict={(takeIncoming) => mutateSet(setDiff.ruleSet.id, (draft) => {
                        draft.changes.forEach((item) => {
                          if (item.type === 'conflict') {
                            item.apply = true;
                            item.takeIncoming = takeIncoming;
                          }
                        });
                      })}
                    />
                  ))}

                  <p class="safe-note">冲突项已同时标出本校与来件来源，可逐条选择；未勾选的新增与替换不会进入当前项目。</p>
                </>
              )}

              {stage === 'done' && stats && diff && (
                <div class="merge-done">
                  <span class="done-mark">✓</span>
                  <h3>合并完成，全文已按最新规则重新转录</h3>
                  <ul>
                    {stats.newSets > 0 && <li>新增规则集 {stats.newSets} 个</li>}
                    <li>新增规则 {stats.added} 条</li>
                    <li>替换规则 {stats.replaced} 条</li>
                    <li>采用来件设置 {stats.settingsApplied} 项</li>
                    <li>冲突处理：取来件 {stats.conflictsTaken} 条，保留本校 {stats.conflictsKept} 条</li>
                  </ul>
                  <p>本次接收已记入互传记录，重新打开档案仍可查；如需反悔可使用顶部撤销或版本记录恢复。</p>
                </div>
              )}
            </div>
          )}

          {tab === 'records' && (
            <div class="archive-pane">
              {records.length === 0 && <div class="empty-state compact"><strong>还没有互传记录</strong><p>导出或接收规则档案后，会在这里留下可复查的记录。</p></div>}
              {records.map((record) => (
                <RecordCard key={record.id} record={record} onDelete={() => onDeleteRecord(record.id)} />
              ))}
            </div>
          )}
        </div>

        <footer class="archive-footer">
          {tab === 'export' && (
            <>
              <span class="footer-summary">已选 {selectedIds.length} 个规则集</span>
              <md-text-button onClick={onClose}>关闭</md-text-button>
              <md-filled-button disabled={selectedIds.length === 0} onClick={handleExport}>导出规则档案</md-filled-button>
            </>
          )}
          {tab === 'import' && stage === 'input' && (
            <>
              <span class="footer-summary">未确认前当前项目不会被修改</span>
              <md-text-button onClick={onClose}>取消</md-text-button>
              <md-filled-button disabled={!rawText.trim()} onClick={previewArchive}>预览差异</md-filled-button>
            </>
          )}
          {tab === 'import' && stage === 'preview' && (
            <>
              <span class="footer-summary">
                将新增 {totals.added} 条 · 替换 {totals.replaced} 条 · 冲突取来件 {totals.conflictsTake}、保留本校 {totals.conflictsKeep} · 设置 {totals.settings} 项
              </span>
              <md-text-button onClick={() => setStage('input')}>返回</md-text-button>
              <md-text-button onClick={onClose}>取消（项目保持原样）</md-text-button>
              <md-filled-button disabled={totals.actionable === 0} onClick={handleConfirm}>确认合并并重转录全文</md-filled-button>
            </>
          )}
          {tab === 'import' && stage === 'done' && (
            <>
              <span class="footer-summary">合并结果已保存到本地草稿与互传记录</span>
              <md-filled-button onClick={onClose}>完成</md-filled-button>
            </>
          )}
          {tab === 'records' && <md-text-button onClick={onClose}>关闭</md-text-button>}
        </footer>
      </div>
    </div>
  );

  function mutateSet(setId: string, mutate: (draftSet: RuleSetDiff) => void): void {
    mutateDiff((draft) => {
      const target = draft.sets.find((item) => item.ruleSet.id === setId);
      if (target) mutate(target);
    });
  }
}

function formatRecordTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function RecordCard({ record, onDelete }: { record: RuleArchiveRecord; onDelete: () => void }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <article class="record-card">
      <header>
        <Badge direction={record.direction} />
        <div class="record-main">
          <strong>{[record.school, record.teacher].filter(Boolean).join(' · ') || '未署名'}</strong>
          <span>{formatRecordTime(record.at)} · {record.fileName}</span>
          {record.note && <p>{record.note}</p>}
        </div>
        <div class="record-counts">
          <span>{record.setCount} 个规则集</span>
          <span>{record.ruleCount} 条规则</span>
        </div>
      </header>
      {record.direction === 'import' && record.stats && (
        <p class="record-stats">
          合并：新增 {record.stats.added} · 替换 {record.stats.replaced} · 冲突取来件 {record.stats.conflictsTaken} / 保留本校 {record.stats.conflictsKept} · 设置 {record.stats.settingsApplied} 项
        </p>
      )}
      <div class="record-actions">
        <md-text-button onClick={() => setExpanded((value) => !value)}>{expanded ? '收起明细' : '查看档案明细'}</md-text-button>
        <md-text-button onClick={() => downloadJson(record.fileName, record.payload)}>重新下载档案</md-text-button>
        <md-text-button onClick={onDelete}>删除记录</md-text-button>
      </div>
      {expanded && (
        <ul class="record-detail">
          {record.payload.ruleSets.map((ruleSet) => (
            <li key={ruleSet.id}>
              <strong>{ruleSet.name}</strong>
              <span>{ruleSet.rules.length} 条 · {ruleSet.contractions ? '启用缩写' : '关闭缩写'} · {HYPHEN_LABELS[ruleSet.hyphenMode]}</span>
              <p>{ruleSet.description}</p>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
