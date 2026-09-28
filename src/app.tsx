import { useEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { analyzeProject, brailleCellCount, makeRule, outputText, updateRuleInSet } from './braille';
import {
  CHANGED_FIELD_LABELS,
  KIND_LABELS,
  NEW_TARGET,
  SETTING_LABELS,
  createArchive,
  diffRuleSets,
  mergeRuleSet,
  parseArchive,
  serializeArchive,
  settingDisplay,
  suggestArchiveTarget,
  uniqueRuleSetName,
} from './archive';
import type {
  MergeSelection,
  ParseResult,
  RuleComparison,
  RuleSetArchive,
  RuleSetDiff,
  SettingKey,
  SideChoice,
} from './archive';
import { createInitialProject } from './sample';
import type { HistoryState, ProofIssue, ProjectState, RuleSet, TextbookLine, VersionSnapshot } from './types';

const STORAGE_KEY = 'sologsb-1010-braille-project-v1';
const HISTORY_LIMIT = 60;

type HistoryAction =
  | { type: 'commit'; label: string; update: (state: ProjectState) => ProjectState }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'restore'; label: string; state: ProjectState };

function cloneState(state: ProjectState): ProjectState {
  return structuredClone(state);
}

function historyReducer(state: HistoryState, action: HistoryAction): HistoryState {
  if (action.type === 'undo') {
    const previous = state.past.at(-1);
    if (!previous) return state;
    return {
      past: state.past.slice(0, -1),
      present: previous,
      future: [state.present, ...state.future].slice(0, HISTORY_LIMIT),
      lastAction: '撤销',
    };
  }

  if (action.type === 'redo') {
    const next = state.future[0];
    if (!next) return state;
    return {
      past: [...state.past, state.present].slice(-HISTORY_LIMIT),
      present: next,
      future: state.future.slice(1),
      lastAction: '重做',
    };
  }

  const next = action.type === 'restore' ? cloneState(action.state) : action.update(cloneState(state.present));
  if (next === state.present) return state;
  return {
    past: [...state.past, state.present].slice(-HISTORY_LIMIT),
    present: next,
    future: [],
    lastAction: action.label,
  };
}

function loadInitialState(): ProjectState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ProjectState;
      return analyzeProject(parsed);
    }
  } catch {
    // 清除损坏草稿并使用内置示例。
  }
  return createInitialProject();
}

function useProject() {
  const [history, dispatch] = useReducer(historyReducer, undefined, () => ({
    past: [],
    present: loadInitialState(),
    future: [],
    lastAction: '已恢复本地草稿',
  }));

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history.present));
  }, [history.present]);

  const commit = (label: string, update: (state: ProjectState) => ProjectState) => dispatch({ type: 'commit', label, update });
  const undo = () => dispatch({ type: 'undo' });
  const redo = () => dispatch({ type: 'redo' });
  const restore = (state: ProjectState) => dispatch({ type: 'restore', label: '恢复版本', state });

  return { state: history.present, history, commit, undo, redo, restore };
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', month: '2-digit', day: '2-digit' }).format(new Date(value));
}

function issueLabel(issue: ProofIssue): string {
  if (issue.severity === 'error') return '阻断';
  if (issue.severity === 'warning') return '可疑';
  return '建议';
}

function Section({ title, subtitle, action, children }: { title: string; subtitle?: string; action?: ComponentChildren; children: ComponentChildren }) {
  return (
    <section class="panel-section">
      <div class="section-heading">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function RuleSetPanel({
  state,
  onSelect,
  onUpdateRule,
  onToggleContractions,
  onAddRule,
  onRecheck,
  onExportArchive,
  onImportArchive,
}: {
  state: ProjectState;
  onSelect: (id: string) => void;
  onUpdateRule: (ruleId: string, patch: Record<string, unknown>) => void;
  onToggleContractions: () => void;
  onAddRule: (source: string, output: string, suspicious: boolean) => void;
  onRecheck: () => void;
  onExportArchive: () => void;
  onImportArchive: () => void;
}) {
  const active = state.ruleSets.find((ruleSet) => ruleSet.id === state.activeRuleSetId) ?? state.ruleSets[0];
  const [showAllRules, setShowAllRules] = useState(false);
  const [newSource, setNewSource] = useState('');
  const [newOutput, setNewOutput] = useState('');
  const [suspicious, setSuspicious] = useState(true);
  const visibleRules = showAllRules ? active.rules : active.rules.filter((rule) => rule.kind === 'contraction' || rule.suspicious);

  return (
    <aside class="left-panel scroll-pane" aria-label="规则集与规则编辑">
      <Section title="规则集" subtitle="切换后会自动重转录全部行">
        <div class="stack-sm">
          {state.ruleSets.map((ruleSet) => (
            <button class={`rule-set-card ${ruleSet.id === active.id ? 'active' : ''}`} key={ruleSet.id} onClick={() => onSelect(ruleSet.id)}>
              <span>
                <strong>{ruleSet.name}</strong>
                <small>{ruleSet.rules.filter((rule) => rule.enabled).length} 条启用规则</small>
              </span>
              <span class="radio-dot" aria-hidden="true" />
            </button>
          ))}
        </div>
      </Section>

      <Section title="规则档案互传" subtitle="把校订好的整套规则发给同校老师，或接收对方的档案">
        <div class="archive-actions">
          <md-outlined-button onClick={onImportArchive}>接收档案…</md-outlined-button>
          <md-filled-tonal-button onClick={onExportArchive}>导出「{active.name}」档案</md-filled-tonal-button>
        </div>
        <p class="archive-actions-hint">档案包含规则集说明、缩写开关、断词方式和全部规则（含停用与可疑标记）。</p>
      </Section>

      <Section
        title="当前规则"
        subtitle={active.description}
        action={<md-text-button onClick={onRecheck}>重新检查</md-text-button>}
      >
        <div class="inline-controls">
          <md-checkbox checked={active.contractions} onInput={onToggleContractions} label="启用缩写" />
          <md-filled-tonal-button onClick={() => setShowAllRules((value) => !value)}>
            {showAllRules ? '只看常用规则' : '查看全部规则'}
          </md-filled-tonal-button>
        </div>
      </Section>

      <Section title="缩写与标点" subtitle="可疑规则会在校对区生成提醒">
        <div class="rule-list">
          {visibleRules.map((rule) => (
            <div class={`rule-row ${rule.suspicious ? 'suspicious' : ''}`} key={rule.id}>
              <md-checkbox checked={rule.enabled} onInput={() => onUpdateRule(rule.id, { enabled: !rule.enabled })} aria-label={`启用 ${rule.source}`} />
              <md-outlined-text-field
                class="rule-source"
                value={rule.source}
                label="原文"
                onInput={(event: any) => onUpdateRule(rule.id, { source: event.currentTarget.value })}
              />
              <md-outlined-text-field
                class="rule-output"
                value={rule.output}
                label="盲文"
                onInput={(event: any) => onUpdateRule(rule.id, { output: event.currentTarget.value })}
              />
              <md-icon-button
                class={rule.suspicious ? 'warning-button active' : 'warning-button'}
                aria-label={rule.suspicious ? '取消可疑标记' : '标记为可疑'}
                title={rule.suspicious ? '取消可疑标记' : '标记为可疑'}
                onClick={() => onUpdateRule(rule.id, { suspicious: !rule.suspicious })}
              >
                {rule.suspicious ? '!' : '○'}
              </md-icon-button>
            </div>
          ))}
        </div>
      </Section>

      <Section title="新增规则" subtitle="可添加缩写、字母组合或自定义符号">
        <div class="stack-sm">
          <md-outlined-text-field value={newSource} label="原文或组合" onInput={(event: any) => setNewSource(event.currentTarget.value)} />
          <md-outlined-text-field value={newOutput} label="盲文单元" onInput={(event: any) => setNewOutput(event.currentTarget.value)} />
          <md-checkbox checked={suspicious} onInput={() => setSuspicious((value) => !value)} label="标记为可疑规则" />
          <md-filled-button
            disabled={!newSource.trim() || !newOutput.trim()}
            onClick={() => {
              onAddRule(newSource.trim(), newOutput.trim(), suspicious);
              setNewSource('');
              setNewOutput('');
            }}
          >
            添加并检查
          </md-filled-button>
        </div>
      </Section>
    </aside>
  );
}

function LineCard({
  line,
  index,
  selected,
  issues,
  onSelect,
  onChange,
  onNote,
  onStatus,
  onDelete,
}: {
  line: TextbookLine;
  index: number;
  selected: boolean;
  issues: ProofIssue[];
  onSelect: () => void;
  onChange: (source: string) => void;
  onNote: (note: string) => void;
  onStatus: (status: TextbookLine['status']) => void;
  onDelete: () => void;
}) {
  const unresolved = issues.filter((issue) => !issue.resolved);
  const lineIssues = unresolved.filter((issue) => issue.lineId === line.id);

  return (
    <article class={`line-card ${selected ? 'selected' : ''}`} id={`line-card-${line.id}`} onClick={onSelect}>
      <div class="line-gutter">
        <span>{String(index + 1).padStart(2, '0')}</span>
        <span class={`line-status ${line.status}`} title={`状态：${line.status}`} />
      </div>
      <div class="line-body">
        <div class="line-source">
          <textarea
            aria-label={`第 ${index + 1} 行原文`}
            value={line.source}
            rows={Math.max(1, Math.ceil(line.source.length / 52))}
            onFocus={onSelect}
            onInput={(event) => onChange((event.currentTarget as HTMLTextAreaElement).value)}
          />
          <div class="line-actions">
            <md-icon-button aria-label="标记待核对" title="标记待核对" onClick={(event: MouseEvent) => { event.stopPropagation(); onStatus('questionable'); }}>?</md-icon-button>
            <md-icon-button aria-label="标记已校对" title="标记已校对" onClick={(event: MouseEvent) => { event.stopPropagation(); onStatus('reviewed'); }}>✓</md-icon-button>
            <md-icon-button aria-label="批准此行" title="批准此行" onClick={(event: MouseEvent) => { event.stopPropagation(); onStatus('approved'); }}>★</md-icon-button>
            <md-icon-button aria-label="删除此行" title="删除此行" onClick={(event: MouseEvent) => { event.stopPropagation(); onDelete(); }}>×</md-icon-button>
          </div>
        </div>
        <div class="braille-preview" aria-label={`第 ${index + 1} 行盲文预览`}>
          {line.tokens.length === 0 && <span class="empty-preview">空行</span>}
          {line.tokens.map((token) => (
            token.text === ' ' ? <span class="space-token" title="分词空格" /> : (
              <span
                class={`braille-token ${token.suspicious ? 'suspicious' : ''} ${token.braille.includes('⟦') ? 'error' : ''}`}
                title={`${token.text || '标记'} → ${token.braille}`}
              >
                <b>{token.text || '标记'}</b>
                <span>{token.braille}</span>
              </span>
            )
          ))}
        </div>
        {lineIssues.length > 0 && (
          <div class="line-warnings">
            {lineIssues.slice(0, 3).map((item) => (
              <span class={`issue-chip ${item.severity}`} key={item.id}>{issueLabel(item)} · {item.message}</span>
            ))}
          </div>
        )}
        {selected && (
          <md-outlined-text-field
            class="note-field"
            value={line.note}
            label="校对备注"
            onInput={(event: any) => onNote(event.currentTarget.value)}
          />
        )}
      </div>
    </article>
  );
}

function EditorPanel({
  state,
  onSelectLine,
  onChangeLine,
  onNote,
  onStatus,
  onDelete,
  onAddLine,
  onSplitLongLines,
  onImport,
}: {
  state: ProjectState;
  onSelectLine: (id: string) => void;
  onChangeLine: (id: string, source: string) => void;
  onNote: (id: string, note: string) => void;
  onStatus: (id: string, status: TextbookLine['status']) => void;
  onDelete: (id: string) => void;
  onAddLine: () => void;
  onSplitLongLines: () => void;
  onImport: (text: string) => void;
}) {
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState('');

  return (
    <main class="editor-panel" aria-label="逐行转录校对区">
      <div class="editor-toolbar">
        <div>
          <span class="eyebrow">逐行校对</span>
          <h1>{state.title}</h1>
          <p>{state.author} · {state.lines.length} 行 · {brailleCellCount(state)} 格</p>
        </div>
        <div class="toolbar-actions">
          <md-outlined-button onClick={() => setShowImport((value) => !value)}>导入课文</md-outlined-button>
          <md-outlined-button onClick={onSplitLongLines}>按句拆分</md-outlined-button>
          <md-filled-button onClick={onAddLine}>新增行</md-filled-button>
        </div>
      </div>

      {showImport && (
        <div class="import-strip">
          <md-outlined-text-field
            type="textarea"
            rows={5}
            value={importText}
            label="粘贴课文；换行或句末标点将被拆成行"
            onInput={(event: any) => setImportText(event.currentTarget.value)}
          />
          <div>
            <md-text-button onClick={() => { setImportText(''); setShowImport(false); }}>取消</md-text-button>
            <md-filled-button
              disabled={!importText.trim()}
              onClick={() => {
                onImport(importText);
                setImportText('');
                setShowImport(false);
              }}
            >
              替换并重新转录
            </md-filled-button>
          </div>
        </div>
      )}

      <div class="line-list scroll-pane">
        {state.lines.map((line, index) => (
          <LineCard
            key={line.id}
            line={line}
            index={index}
            selected={state.selectedLineId === line.id}
            issues={state.issues}
            onSelect={() => onSelectLine(line.id)}
            onChange={(source) => onChangeLine(line.id, source)}
            onNote={(note) => onNote(line.id, note)}
            onStatus={(status) => onStatus(line.id, status)}
            onDelete={() => onDelete(line.id)}
          />
        ))}
      </div>
    </main>
  );
}

function IssuesPanel({
  issues,
  lines,
  onJump,
  onResolve,
  onBatchFix,
}: {
  issues: ProofIssue[];
  lines: TextbookLine[];
  onJump: (lineId: string) => void;
  onResolve: (issueId: string) => void;
  onBatchFix: (ruleId: string) => void;
}) {
  const unresolved = issues.filter((issue) => !issue.resolved);
  const grouped = useMemo(() => {
    const map = new Map<string, ProofIssue[]>();
    unresolved.forEach((item) => {
      const key = item.ruleId ? `rule:${item.ruleId}` : `code:${item.code}`;
      map.set(key, [...(map.get(key) ?? []), item]);
    });
    return [...map.entries()];
  }, [unresolved]);

  return (
    <div class="inspector-body">
      {grouped.length === 0 && <div class="empty-state"><span>✓</span><strong>没有未处理问题</strong><p>可以记录版本或导出打印稿。</p></div>}
      {grouped.map(([key, group]) => {
        const lineNumbers = group.map((item) => lines.findIndex((line) => line.id === item.lineId) + 1).join('、');
        return (
          <div class="issue-group" key={key}>
            <div class="issue-group-head">
              <span class={`severity-dot ${group[0].severity}`} />
              <div>
                <strong>{group[0].message}</strong>
                <p>影响第 {lineNumbers} 行 · 共 {group.length} 处</p>
              </div>
            </div>
            <div class="issue-actions">
              <md-text-button onClick={() => onJump(group[0].lineId)}>定位首处</md-text-button>
              {group[0].ruleId && group.length > 1 && (
                <md-filled-tonal-button onClick={() => onBatchFix(group[0].ruleId!)}>停用规则并修正同类</md-filled-tonal-button>
              )}
              {!group[0].ruleId && group.length > 1 && (
                <md-filled-tonal-button onClick={() => group.forEach((item) => onResolve(item.id))}>全部标记已处理</md-filled-tonal-button>
              )}
              <md-icon-button aria-label="标记此项已处理" title="标记已处理" onClick={() => onResolve(group[0].id)}>✓</md-icon-button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RuleDetailPanel({ state, onUpdateRule, onDeleteRule }: { state: ProjectState; onUpdateRule: (id: string, patch: Record<string, unknown>) => void; onDeleteRule: (id: string) => void }) {
  const active = state.ruleSets.find((ruleSet) => ruleSet.id === state.activeRuleSetId) ?? state.ruleSets[0];
  return (
    <div class="inspector-body">
      <div class="rule-summary">
        <strong>{active.name}</strong>
        <p>{active.description}</p>
        <div class="metric-row"><span>{active.rules.filter((rule) => rule.enabled).length} 条启用</span><span>{active.rules.filter((rule) => rule.suspicious).length} 条可疑</span></div>
      </div>
      {active.rules.map((rule) => (
        <div class="rule-detail-card" key={rule.id}>
          <div>
            <strong>{rule.source || '数字符'}</strong>
            <span>{rule.output} · {rule.kind}</span>
            {rule.description && <p>{rule.description}</p>}
          </div>
          <div class="rule-detail-actions">
            <md-checkbox checked={rule.suspicious} onInput={() => onUpdateRule(rule.id, { suspicious: !rule.suspicious })} label="可疑" />
            <md-icon-button aria-label="删除规则" title="删除规则" onClick={() => onDeleteRule(rule.id)}>×</md-icon-button>
          </div>
        </div>
      ))}
    </div>
  );
}

function VersionsPanel({ state, onSnapshot, onRestore }: { state: ProjectState; onSnapshot: () => void; onRestore: (version: VersionSnapshot) => void }) {
  return (
    <div class="inspector-body">
      <div class="snapshot-callout">
        <div><strong>本地版本记录</strong><p>保存当前规则、原文、状态和备注的完整快照。</p></div>
        <md-filled-button onClick={onSnapshot}>记录版本</md-filled-button>
      </div>
      {state.versions.length === 0 && <div class="empty-state compact"><strong>还没有版本快照</strong><p>完成一轮校对后记录版本，便于比较和恢复。</p></div>}
      <div class="timeline">
        {state.versions.map((version) => (
          <div class="timeline-item" key={version.id}>
            <span class="timeline-dot" />
            <div>
              <strong>{version.name}</strong>
              <p>{version.action} · {formatTime(version.createdAt)}</p>
              <div class="metric-row"><span>{version.snapshot.lines.length} 行</span><span>{version.snapshot.issues.filter((issue) => !issue.resolved).length} 个未处理问题</span></div>
              <md-text-button onClick={() => onRestore(version)}>恢复此版本</md-text-button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface ArchiveSelectionState {
  targetId: string;
  decisions: Record<string, SideChoice>;
  included: Record<string, boolean>;
  settings: Partial<Record<SettingKey, SideChoice>>;
}

function ArchiveDialog({
  state,
  onClose,
  onApply,
}: {
  state: ProjectState;
  onClose: () => void;
  onApply: (archive: RuleSetArchive, targetId: string, selection: MergeSelection) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [parse, setParse] = useState<ParseResult | null>(null);
  const [selectionState, setSelectionState] = useState<ArchiveSelectionState | null>(null);
  const [pasteText, setPasteText] = useState('');

  const archive = parse?.ok ? parse.archive : undefined;
  const archiveWarnings = parse?.warnings ?? [];
  const target: RuleSet | undefined = selectionState && selectionState.targetId !== NEW_TARGET
    ? state.ruleSets.find((set) => set.id === selectionState.targetId)
    : undefined;
  const diff: RuleSetDiff | null = archive ? diffRuleSets(target, archive.ruleSet) : null;

  const loadArchiveText = (raw: string) => {
    const result = parseArchive(raw);
    setParse(result);
    setPasteText('');
    if (result.ok && result.archive) {
      setSelectionState({
        targetId: suggestArchiveTarget(state.ruleSets, result.archive),
        decisions: {},
        included: {},
        settings: { description: 'incoming', contractions: 'incoming', hyphenMode: 'incoming' },
      });
    }
  };

  const onFile = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => loadArchiveText(String(reader.result ?? ''));
    reader.onerror = () => setParse({ ok: false, errors: ['读取档案文件失败，请重新发送方获取文件。'], warnings: [] });
    reader.readAsText(file);
  };

  const chooseAllConflicts = (choice: SideChoice) => {
    if (!diff || !selectionState) return;
    const decisions = { ...selectionState.decisions };
    diff.conflicts.forEach((item) => { decisions[item.key] = choice; });
    setSelectionState({ ...selectionState, decisions });
  };

  const setAllAdded = (included: boolean) => {
    if (!diff || !selectionState) return;
    const next = { ...selectionState.included };
    diff.added.forEach((item) => { next[item.key] = included; });
    setSelectionState({ ...selectionState, included: next });
  };

  const resolvedConflicts = diff?.conflicts.filter((item) => selectionState?.decisions[item.key]).length ?? 0;
  const acceptedAdded = diff?.added.filter((item) => selectionState?.included[item.key] !== false).length ?? 0;
  const canApply = Boolean(diff && selectionState && resolvedConflicts === diff.conflicts.length && (target || acceptedAdded > 0));

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const activeTag = (event.target as HTMLElement)?.tagName;
      if (activeTag !== 'INPUT' && activeTag !== 'TEXTAREA') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const incomingLabel = archive ? `档案 · ${archive.exporter}` : '档案';

  return (
    <div class="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div class="archive-dialog" role="dialog" aria-modal="true" aria-label="接收规则档案">
        <div class="archive-dialog-head">
          <div>
            <span class="eyebrow">规则档案互传</span>
            <h2>接收校订后的规则档案</h2>
            <p>先查看新增、替换和冲突；确认前当前项目保持原样。</p>
          </div>
          <md-icon-button aria-label="关闭" title="关闭（Esc）" onClick={onClose}>×</md-icon-button>
        </div>

        {!archive && (
          <div class="archive-dialog-body scroll-pane">
            {parse && !parse.ok && (
              <div class="archive-alert error">
                <strong>无法读取档案</strong>
                {parse.errors.map((message) => <p key={message}>{message}</p>)}
              </div>
            )}
            {parse?.ok === false && parse.warnings.length > 0 && (
              <ul class="archive-alert-list">{parse.warnings.map((message) => <li>{message}</li>)}</ul>
            )}
            <div class="archive-dropzone">
              <span aria-hidden="true">⇪</span>
              <strong>选择规则档案文件</strong>
              <p>由其他老师在“导出规则档案”中生成的 .json 文件。</p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                style={{ display: 'none' }}
                onChange={(event: any) => onFile(event.currentTarget.files?.[0])}
              />
              <md-filled-button onClick={() => fileInputRef.current?.click()}>选择文件</md-filled-button>
            </div>
            <div class="archive-paste">
              <md-outlined-text-field
                type="textarea"
                rows={4}
                value={pasteText}
                label="或把档案全文粘贴到这里"
                onInput={(event: any) => setPasteText(event.currentTarget.value)}
              />
              <md-text-button disabled={!pasteText.trim()} onClick={() => loadArchiveText(pasteText)}>解析粘贴内容</md-text-button>
            </div>
          </div>
        )}

        {archive && diff && selectionState && (
          <div class="archive-dialog-body scroll-pane">
            <div class="archive-meta">
              <div>
                <strong>{archive.ruleSet.name}</strong>
                <p>
                  来源项目：{archive.sourceProject} · 校订者：{archive.exporter}
                  {archive.exportedAt && Number.isFinite(Date.parse(archive.exportedAt)) ? ` · 导出于 ${formatTime(archive.exportedAt)}` : ''}
                </p>
                <p class="archive-meta-stats">
                  共 {archive.ruleSet.rules.length} 条规则 ·
                  {' '}缩写{archive.ruleSet.contractions ? '开' : '关'} ·
                  {' '}{archive.ruleSet.hyphenMode === 'cross-line' ? '跨行断词' : '行内连字符'}
                </p>
              </div>
              <div>
                <label class="archive-target-label" for="archive-target">合并到</label>
                <select
                  id="archive-target"
                  class="archive-target-select"
                  value={selectionState.targetId}
                  onChange={(event: any) => setSelectionState({
                    ...selectionState,
                    targetId: event.currentTarget.value,
                    decisions: {},
                    included: {},
                  })}
                >
                  {state.ruleSets.map((set) => (
                    <option value={set.id} key={set.id}>
                      {set.id === archive.ruleSet.id || set.name === archive.ruleSet.name ? '◆ ' : ''}{set.name}
                    </option>
                  ))}
                  <option value={NEW_TARGET}>＋ 作为新规则集导入（不动现有规则）</option>
                </select>
              </div>
            </div>

            {archiveWarnings.length > 0 && (
              <div class="archive-alert warning">
                <strong>档案有 {archiveWarnings.length} 条提示（已自动处理）</strong>
                <ul class="archive-alert-list">
                  {archiveWarnings.map((message) => <li key={message}>{message}</li>)}
                </ul>
              </div>
            )}

            {!target && (
              <div class="archive-alert info">
                <strong>将作为全新规则集“{uniqueRuleSetName(state.ruleSets.map((set) => set.name), archive.ruleSet.name)}”加入</strong>
                <p>现有三套规则与课文均不改变；确认后可在左栏切换到它，切换会重转录全文。规则集说明、缩写开关和断词方式全部采用档案。</p>
              </div>
            )}

            {target && diff.settingDiffs.length > 0 && (
              <div class="archive-section">
                <h3>规则集设置差异（{diff.settingDiffs.length}）</h3>
                <div class="archive-setting-list">
                  {diff.settingDiffs.map((item) => {
                    const choice = selectionState.settings[item.key] ?? 'incoming';
                    return (
                      <div class="archive-setting-row" key={item.key}>
                        <div class="archive-setting-label">{SETTING_LABELS[item.key]}</div>
                        <div class="side-cards">
                          <button
                            class={`side-card local ${choice === 'local' ? 'picked' : ''}`}
                            onClick={() => setSelectionState({ ...selectionState, settings: { ...selectionState.settings, [item.key]: 'local' } })}
                          >
                            <small>本项目</small>
                            <span>{settingDisplay(item.key, item.local)}</span>
                          </button>
                          <span class="side-arrow">→</span>
                          <button
                            class={`side-card incoming ${choice === 'incoming' ? 'picked' : ''}`}
                            onClick={() => setSelectionState({ ...selectionState, settings: { ...selectionState.settings, [item.key]: 'incoming' } })}
                          >
                            <small>{incomingLabel}</small>
                            <span>{settingDisplay(item.key, item.incoming)}</span>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div class="archive-section">
              <div class="archive-section-head">
                <h3>新增规则（{diff.added.length}）</h3>
                {diff.added.length > 0 && (
                  <div class="archive-bulk">
                    <md-text-button onClick={() => setAllAdded(true)}>全部接收</md-text-button>
                    <md-text-button onClick={() => setAllAdded(false)}>全部舍弃</md-text-button>
                  </div>
                )}
              </div>
              {diff.added.length === 0 && <p class="archive-empty-line">档案中没有本项目缺少的规则。</p>}
              {diff.added.map((item) => {
                const included = selectionState.included[item.key] !== false;
                return (
                  <div
                    class={`archive-rule-row added ${included ? '' : 'discarded'}`}
                    key={item.key}
                    role="checkbox"
                    aria-checked={included}
                    tabIndex={0}
                    onClick={() => setSelectionState({ ...selectionState, included: { ...selectionState.included, [item.key]: !included } })}
                    onKeyDown={(event: KeyboardEvent) => {
                      if (event.key === ' ' || event.key === 'Enter') {
                        event.preventDefault();
                        setSelectionState({ ...selectionState, included: { ...selectionState.included, [item.key]: !included } });
                      }
                    }}
                  >
                    <md-checkbox checked={included} style={{ pointerEvents: 'none' }} />
                    <span class="rule-kind-tag">{KIND_LABELS[item.kind]}</span>
                    <span class="rule-text"><b>{item.incoming?.source}</b> → {item.incoming?.output}</span>
                    <span class="rule-source-tag incoming">仅{incomingLabel}有</span>
                  </div>
                );
              })}
            </div>

            <div class="archive-section">
              <div class="archive-section-head">
                <h3>冲突 · 原文相同但盲文或设置不同（{diff.conflicts.length}）</h3>
                {diff.conflicts.length > 0 && (
                  <div class="archive-bulk">
                    <md-text-button onClick={() => chooseAllConflicts('local')}>全部保留本项目</md-text-button>
                    <md-text-button onClick={() => chooseAllConflicts('incoming')}>全部采用档案</md-text-button>
                  </div>
                )}
              </div>
              {diff.conflicts.length === 0 && <p class="archive-empty-line">没有冲突条目。</p>}
              {diff.conflicts.map((item) => {
                const choice = selectionState.decisions[item.key];
                return (
                  <div class={`conflict-block ${choice ? '' : 'undecided'}`} key={item.key}>
                    <div class="conflict-head">
                      <span class="rule-kind-tag">{KIND_LABELS[item.kind]}</span>
                      <strong>{item.source}</strong>
                      <span class="conflict-tags">
                        {item.changedFields.map((field) => <span class="conflict-field-tag" key={field}>{CHANGED_FIELD_LABELS[field]}</span>)}
                      </span>
                      {!choice && <span class="conflict-pending">请选择保留哪条</span>}
                    </div>
                    <div class="side-cards">
                      <button
                        class={`side-card local ${choice === 'local' ? 'picked' : ''}`}
                        onClick={() => setSelectionState({ ...selectionState, decisions: { ...selectionState.decisions, [item.key]: 'local' } })}
                      >
                        <small>本项目 · {state.author}</small>
                        <span class="side-braille">{item.local?.output}</span>
                        <span class="side-meta">{item.local?.enabled === false ? '已停用 · ' : ''}{item.local?.suspicious ? '可疑 · ' : ''}{item.local?.description || '无说明'}</span>
                      </button>
                      <button
                        class={`side-card incoming ${choice === 'incoming' ? 'picked' : ''}`}
                        onClick={() => setSelectionState({ ...selectionState, decisions: { ...selectionState.decisions, [item.key]: 'incoming' } })}
                      >
                        <small>{incomingLabel}</small>
                        <span class="side-braille">{item.incoming?.output}</span>
                        <span class="side-meta">{item.incoming?.enabled === false ? '已停用 · ' : ''}{item.incoming?.suspicious ? '可疑 · ' : ''}{item.incoming?.description || '无说明'}</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            <details class="archive-section archive-details">
              <summary>原文与盲文完全一致（{diff.same.length}）</summary>
              {diff.same.map((item) => (
                <div class="archive-rule-row same" key={item.key}>
                  <span class="rule-kind-tag">{KIND_LABELS[item.kind]}</span>
                  <span class="rule-text"><b>{item.source}</b> → {item.local?.output}</span>
                  <span class="rule-source-tag same">双方一致</span>
                </div>
              ))}
            </details>

            {target && (
              <details class="archive-section archive-details">
                <summary>本项目独有（{diff.localOnly.length}，合并后始终保留）</summary>
                {diff.localOnly.length === 0 && <p class="archive-empty-line">无。</p>}
                {diff.localOnly.map((item: RuleComparison) => (
                  <div class="archive-rule-row local-only" key={item.key}>
                    <span class="rule-kind-tag">{KIND_LABELS[item.kind]}</span>
                    <span class="rule-text"><b>{item.source}</b> → {item.local?.output}</span>
                    <span class="rule-source-tag local">仅本项目有</span>
                  </div>
                ))}
              </details>
            )}
          </div>
        )}

        <div class="archive-dialog-foot">
          {archive && diff && (
            <div class="archive-foot-summary">
              {target
                ? `新增 ${diff.added.length}（接收 ${acceptedAdded}） · 冲突 ${diff.conflicts.length}（已决 ${resolvedConflicts}） · 一致 ${diff.same.length} · 本项目独有 ${diff.localOnly.length}`
                : `新规则集 ${acceptedAdded} 条规则 · 缩写${archive.ruleSet.contractions ? '开' : '关'} · ${archive.ruleSet.hyphenMode === 'cross-line' ? '跨行断词' : '行内连字符'}`}
            </div>
          )}
          <div class="archive-foot-actions">
            <md-text-button onClick={onClose}>{archive ? '取消（项目保持原样）' : '关闭'}</md-text-button>
            {archive && selectionState && (
              <md-filled-button
                disabled={!canApply}
                onClick={() => onApply(archive, selectionState.targetId, {
                  decisions: selectionState.decisions,
                  included: selectionState.included,
                  settings: selectionState.settings,
                })}
              >
                确认合并并重转录全文
              </md-filled-button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const { state, history, commit, undo, redo, restore } = useProject();
  const [inspectorTab, setInspectorTab] = useState<'issues' | 'rules' | 'versions'>('issues');
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const selectedLineRef = useRef(state.selectedLineId);
  selectedLineRef.current = state.selectedLineId;

  const activeRuleSet = state.ruleSets.find((ruleSet) => ruleSet.id === state.activeRuleSetId) ?? state.ruleSets[0];
  const unresolvedCount = state.issues.filter((issue) => !issue.resolved).length;
  const approvedCount = state.lines.filter((line) => line.status === 'approved').length;
  const progress = state.lines.length ? Math.round((approvedCount / state.lines.length) * 100) : 0;

  const selectLine = (lineId: string, scroll = false) => {
    commit('切换当前行', (current) => ({ ...current, selectedLineId: lineId }));
    if (scroll) requestAnimationFrame(() => document.querySelector(`#line-card-${lineId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  };

  const changeLine = (lineId: string, source: string) => {
    commit('修改课文原文', (current) => analyzeProject({ ...current, lines: current.lines.map((line) => line.id === lineId ? { ...line, source } : line) }));
  };

  const changeStatus = (lineId: string, status: TextbookLine['status']) => {
    commit('更新校对状态', (current) => {
      const lines = current.lines.map((line) => line.id === lineId ? { ...line, status } : line);
      const issues = current.issues.map((item) => item.lineId === lineId && status === 'approved' ? { ...item, resolved: true } : item);
      return { ...current, lines, issues, updatedAt: new Date().toISOString() };
    });
  };

  const navigateLine = (direction: number) => {
    const index = state.lines.findIndex((line) => line.id === selectedLineRef.current);
    const next = state.lines[Math.max(0, Math.min(state.lines.length - 1, index + direction))];
    if (next && next.id !== selectedLineRef.current) selectLine(next.id, true);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey;
      const target = event.target as HTMLElement;
      const editing = /INPUT|TEXTAREA/.test(target.tagName) || target.isContentEditable;
      if (modifier && event.key.toLocaleLowerCase() === 'z') {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
        return;
      }
      if (modifier && event.key.toLocaleLowerCase() === 's') {
        event.preventDefault();
        recordVersion('快捷保存');
        return;
      }
      if (modifier && event.key === 'Enter') {
        event.preventDefault();
        changeStatus(selectedLineRef.current, 'approved');
        const index = state.lines.findIndex((line) => line.id === selectedLineRef.current);
        if (state.lines[index + 1]) selectLine(state.lines[index + 1].id, true);
        return;
      }
      if (!editing && (event.key === 'ArrowDown' || event.key === 'j')) {
        event.preventDefault();
        navigateLine(1);
      }
      if (!editing && (event.key === 'ArrowUp' || event.key === 'k')) {
        event.preventDefault();
        navigateLine(-1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const createSnapshot = (action: string, source = state): VersionSnapshot => {
    const { versions: _versions, ...snapshot } = cloneState(source);
    return {
      id: `version-${Date.now().toString(36)}`,
      name: `${action} · ${source.lines.filter((line) => line.status === 'approved').length}/${source.lines.length} 行完成`,
      createdAt: new Date().toISOString(),
      action,
      snapshot,
    };
  };

  const recordVersion = (action = '手动记录') => {
    commit('记录版本快照', (current) => ({ ...current, versions: [createSnapshot(action, current), ...current.versions].slice(0, 20), updatedAt: new Date().toISOString() }));
  };

  const exportText = () => {
    const blob = new Blob([`${state.title}\n规则集：${activeRuleSet.name}\n\n${outputText(state)}\n`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${state.title.replace(/[^\p{L}\p{N}-]+/gu, '-')}-盲文.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const exportPrint = () => {
    const printWindow = window.open('', '_blank', 'width=900,height=1100');
    if (!printWindow) return;
    const rows = state.lines.map((line, index) => `
      <tr><td>${index + 1}</td><td>${line.source.replace(/[<>&]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[char] ?? char))}</td><td class="braille">${line.tokens.map((token) => token.braille).join('')}</td></tr>
    `).join('');
    printWindow.document.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${state.title}</title><style>body{font-family:Georgia,serif;color:#111;margin:36px}h1{font-size:22px}table{width:100%;border-collapse:collapse}th,td{padding:10px;border-bottom:1px solid #bbb;text-align:left;vertical-align:top}td:first-child{width:36px;color:#666}.braille{font-family:"Apple Braille",sans-serif;font-size:24px}@media print{body{margin:16mm}}</style></head><body><h1>${state.title}</h1><p>${state.author} · ${activeRuleSet.name} · ${new Date().toLocaleDateString('zh-CN')}</p><table><thead><tr><th>#</th><th>原文</th><th>盲文校对稿</th></tr></thead><tbody>${rows}</tbody></table><script>window.onload=()=>setTimeout(()=>window.print(),150)</script></body></html>`);
    printWindow.document.close();
  };

  const updateRule = (ruleId: string, patch: Record<string, unknown>) => {
    commit('修改转录规则', (current) => {
      const ruleSet = current.ruleSets.find((set) => set.id === current.activeRuleSetId) ?? current.ruleSets[0];
      const nextSet = updateRuleInSet(ruleSet, ruleId, patch);
      return analyzeProject({ ...current, ruleSets: current.ruleSets.map((set) => set.id === nextSet.id ? nextSet : set) });
    });
  };

  const exportArchive = () => {
    const archive = createArchive(activeRuleSet, { exporter: state.author, sourceProject: state.title });
    const blob = new Blob([serializeArchive(archive)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `规则档案-${activeRuleSet.name.replace(/[^\p{L}\p{N}]+/gu, '-')}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const applyArchive = (archive: RuleSetArchive, targetId: string, selection: MergeSelection) => {
    commit('接收规则档案并合并', (current) => {
      let mergedSet: RuleSet;
      let mergedId: string;
      if (targetId === NEW_TARGET) {
        const base = mergeRuleSet(undefined, archive.ruleSet, selection);
        mergedId = `ruleset-import-${Date.now().toString(36)}`;
        mergedSet = {
          ...base,
          id: mergedId,
          name: uniqueRuleSetName(current.ruleSets.map((set) => set.name), archive.ruleSet.name),
        };
      } else {
        const local = current.ruleSets.find((set) => set.id === targetId) ?? current.ruleSets[0];
        mergedId = local.id;
        mergedSet = mergeRuleSet(local, archive.ruleSet, selection);
      }
      const ruleSets = targetId === NEW_TARGET
        ? [...current.ruleSets, mergedSet]
        : current.ruleSets.map((set) => (set.id === mergedId ? mergedSet : set));
      return analyzeProject({ ...current, ruleSets, activeRuleSetId: mergedId });
    });
    setArchiveDialogOpen(false);
  };

  const batchFixRule = (ruleId: string) => {
    commit('批量修正同类问题', (current) => {
      const ruleSet = current.ruleSets.find((set) => set.id === current.activeRuleSetId) ?? current.ruleSets[0];
      const nextSet = updateRuleInSet(ruleSet, ruleId, { enabled: false });
      return analyzeProject({ ...current, ruleSets: current.ruleSets.map((set) => set.id === nextSet.id ? nextSet : set) });
    });
  };

  const importCourse = (text: string) => {
    const sourceLines = text
      .replace(/\r/g, '')
      .split(/\n+|(?<=[.!?。！？])\s+/)
      .map((line) => line.trim())
      .filter(Boolean);
    commit('导入课文', (current) => analyzeProject({
      ...current,
      lines: sourceLines.map((source, index) => ({ id: `line-import-${Date.now()}-${index}`, source, tokens: [], status: index === 0 ? 'questionable' : 'unchecked', note: index === 0 ? '导入后待确认规则集。' : '', continuesPrevious: false, continuesNext: false })),
      selectedLineId: '',
      issues: [],
    }));
  };

  return (
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark" aria-hidden="true">⠿</div>
          <div><strong>BrailleAtelier</strong><span>盲文教材转录与校对工具</span></div>
        </div>
        <div class="topbar-center">
          <span class={`connection-dot ${navigator.onLine ? 'online' : ''}`} />
          {navigator.onLine ? '浏览器本地保存' : '离线模式 · 本地保存可继续'}
          <small>上次自动保存 {formatTime(state.updatedAt)}</small>
        </div>
        <div class="topbar-actions">
          <md-icon-button onClick={undo} disabled={history.past.length === 0} aria-label="撤销" title="撤销 ⌘Z">↶</md-icon-button>
          <md-icon-button onClick={redo} disabled={history.future.length === 0} aria-label="重做" title="重做 ⇧⌘Z">↷</md-icon-button>
          <md-outlined-button onClick={exportText}>导出文本</md-outlined-button>
          <md-filled-button onClick={exportPrint}>打印版导出</md-filled-button>
        </div>
      </header>

      <div class="status-ribbon">
        <div class="progress-block">
          <div><strong>{progress}%</strong><span>已批准 {approvedCount}/{state.lines.length} 行</span></div>
          <md-linear-progress value={progress / 100} aria-label="校对进度" />
        </div>
        <div class="status-stat warning"><strong>{unresolvedCount}</strong><span>未处理问题</span></div>
        <div class="status-stat"><strong>{state.lines.filter((line) => line.status === 'questionable').length}</strong><span>待核对行</span></div>
        <div class="status-stat"><strong>{activeRuleSet.rules.filter((rule) => rule.enabled).length}</strong><span>启用规则</span></div>
        <div class="shortcut-hint">快捷键：⌘/Ctrl Z 撤销 · ⇧⌘/Ctrl Z 重做 · ⌘/Ctrl Enter 批准并下一行 · J/K 切换行</div>
      </div>

      <div class="workspace-grid">
        <RuleSetPanel
          state={state}
          onSelect={(id) => commit('切换规则集并重新检查', (current) => analyzeProject({ ...current, activeRuleSetId: id, issues: [] }))}
          onUpdateRule={updateRule}
          onToggleContractions={() => {
            const ruleSet = activeRuleSet;
            commit('切换缩写规则', (current) => analyzeProject({ ...current, ruleSets: current.ruleSets.map((set) => set.id === ruleSet.id ? { ...set, contractions: !set.contractions } : set) }));
          }}
          onAddRule={(source, output, suspicious) => {
            commit('新增转写规则', (current) => analyzeProject({
              ...current,
              ruleSets: current.ruleSets.map((set) => set.id === current.activeRuleSetId ? { ...set, rules: [...set.rules, makeRule(source, output, suspicious)] } : set),
            }));
          }}
          onRecheck={() => commit('重新检查全部内容', analyzeProject)}
          onExportArchive={exportArchive}
          onImportArchive={() => setArchiveDialogOpen(true)}
        />

        <EditorPanel
          state={state}
          onSelectLine={selectLine}
          onChangeLine={changeLine}
          onNote={(lineId, note) => commit('添加校对备注', (current) => ({ ...current, lines: current.lines.map((line) => line.id === lineId ? { ...line, note } : line) }))}
          onStatus={changeStatus}
          onDelete={(lineId) => commit('删除课文行', (current) => {
            const lines = current.lines.filter((line) => line.id !== lineId);
            return analyzeProject({ ...current, lines: lines.length ? lines : [{ id: `line-${Date.now()}`, source: '', tokens: [], status: 'unchecked', note: '', continuesPrevious: false, continuesNext: false }], selectedLineId: lines[0]?.id ?? '' });
          })}
          onAddLine={() => commit('新增课文行', (current) => {
            const line: TextbookLine = { id: `line-${Date.now()}`, source: '', tokens: [], status: 'unchecked', note: '', continuesPrevious: false, continuesNext: false };
            return analyzeProject({ ...current, lines: [...current.lines, line], selectedLineId: line.id });
          })}
          onSplitLongLines={() => commit('按句拆分长行', (current) => {
            const lines = current.lines.flatMap((line) => line.source
              .split(/(?<=[.!?。！？])\s+|;\s*/)
              .filter((part) => part.trim())
              .map((source, index) => ({ ...line, id: index === 0 ? line.id : `line-split-${Date.now()}-${index}`, source: source.trim(), tokens: [], note: index === 0 ? line.note : '' })));
            return analyzeProject({ ...current, lines });
          })}
          onImport={importCourse}
        />

        <aside class="right-panel">
          <div class="inspector-tabs" role="tablist">
            <button class={inspectorTab === 'issues' ? 'active' : ''} onClick={() => setInspectorTab('issues')}>问题 {unresolvedCount > 0 && <span>{unresolvedCount}</span>}</button>
            <button class={inspectorTab === 'rules' ? 'active' : ''} onClick={() => setInspectorTab('rules')}>规则详情</button>
            <button class={inspectorTab === 'versions' ? 'active' : ''} onClick={() => setInspectorTab('versions')}>版本 {state.versions.length > 0 && <span>{state.versions.length}</span>}</button>
          </div>
          {inspectorTab === 'issues' && (
            <IssuesPanel
              issues={state.issues}
              lines={state.lines}
              onJump={(lineId) => selectLine(lineId, true)}
              onResolve={(issueId) => commit('标记问题已处理', (current) => ({ ...current, issues: current.issues.map((item) => item.id === issueId ? { ...item, resolved: true } : item) }))}
              onBatchFix={batchFixRule}
            />
          )}
          {inspectorTab === 'rules' && <RuleDetailPanel state={state} onUpdateRule={updateRule} onDeleteRule={(ruleId) => {
            commit('删除转录规则', (current) => analyzeProject({
              ...current,
              ruleSets: current.ruleSets.map((set) => set.id === current.activeRuleSetId ? { ...set, rules: set.rules.filter((rule) => rule.id !== ruleId) } : set),
            }));
          }} />}
          {inspectorTab === 'versions' && <VersionsPanel state={state} onSnapshot={() => recordVersion()} onRestore={(version) => {
            const restored: ProjectState = cloneState({ ...version.snapshot, versions: state.versions });
            restore(restored);
          }} />}
        </aside>
      </div>

      {archiveDialogOpen && (
        <ArchiveDialog
          state={state}
          onClose={() => setArchiveDialogOpen(false)}
          onApply={applyArchive}
        />
      )}
    </div>
  );
}
