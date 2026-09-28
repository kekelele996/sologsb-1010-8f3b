import type {
  ArchiveMergeStats,
  ArchiveRuleSet,
  ProjectState,
  RuleArchive,
  RuleArchiveRecord,
  RuleSet,
  TranscriptionRule,
} from './types';

export const ARCHIVE_FORMAT = 'braille-atelier-rules';
export const ARCHIVE_VERSION = 1;

export const HYPHEN_LABELS: Record<RuleSet['hyphenMode'], string> = {
  'cross-line': '跨行连字',
  inline: '行内保留连字符',
};

export const KIND_LABELS: Record<TranscriptionRule['kind'], string> = {
  letter: '字母',
  number: '数字',
  punctuation: '标点',
  contraction: '缩写',
  special: '特殊',
};

const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const keyOf = (kind: TranscriptionRule['kind'], source: string) => `${kind}::${source.trim().toLocaleLowerCase()}`;
const ruleKey = (rule: TranscriptionRule) => keyOf(rule.kind, rule.source);

export type RuleChangeType = 'new' | 'replace' | 'conflict' | 'identical';

export interface RuleChange {
  key: string;
  kind: TranscriptionRule['kind'];
  source: string;
  type: RuleChangeType;
  local?: TranscriptionRule;
  incoming: TranscriptionRule;
  apply: boolean;
  /** 冲突项：true 取来件，false 保留本条（本校） */
  takeIncoming: boolean;
}

export type SettingField = 'description' | 'contractions' | 'hyphenMode';

export interface SettingChange {
  field: SettingField;
  label: string;
  localValue: string;
  incomingValue: string;
  apply: boolean;
}

export interface RuleSetDiff {
  ruleSet: ArchiveRuleSet;
  isNew: boolean;
  include: boolean;
  changes: RuleChange[];
  settings: SettingChange[];
}

export interface ArchiveDiff {
  archive: RuleArchive;
  sets: RuleSetDiff[];
  added: number;
  replaced: number;
  conflicts: number;
}

const SETTING_META: Array<{ field: SettingField; label: string }> = [
  { field: 'description', label: '规则集说明' },
  { field: 'contractions', label: '缩写开关' },
  { field: 'hyphenMode', label: '断词方式' },
];

function settingValue(ruleSet: Pick<RuleSet, SettingField>, field: SettingField): string {
  if (field === 'description') return ruleSet.description;
  if (field === 'contractions') return ruleSet.contractions ? '启用缩写' : '关闭缩写';
  return HYPHEN_LABELS[ruleSet.hyphenMode];
}

function normalizeRule(rule: TranscriptionRule): TranscriptionRule {
  return {
    id: String(rule.id ?? ''),
    source: String(rule.source ?? ''),
    output: String(rule.output ?? ''),
    kind: rule.kind,
    enabled: rule.enabled !== false,
    suspicious: Boolean(rule.suspicious),
    description: String(rule.description ?? ''),
  };
}

function rulesEquivalent(a: TranscriptionRule, b: TranscriptionRule): boolean {
  return a.output === b.output
    && a.enabled === b.enabled
    && a.suspicious === b.suspicious
    && (a.description ?? '') === (b.description ?? '');
}

export function buildArchive(
  ruleSets: RuleSet[],
  selectedIds: string[],
  meta: { school: string; teacher: string; note: string },
): RuleArchive {
  const picked = ruleSets.filter((ruleSet) => selectedIds.includes(ruleSet.id));
  return {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    exportedAt: new Date().toISOString(),
    school: meta.school.trim(),
    teacher: meta.teacher.trim(),
    note: meta.note.trim(),
    ruleSets: picked.map((ruleSet) => ({
      id: ruleSet.id,
      name: ruleSet.name,
      description: ruleSet.description,
      contractions: ruleSet.contractions,
      hyphenMode: ruleSet.hyphenMode,
      rules: ruleSet.rules.map((rule) => ({ ...rule })),
    })),
  };
}

export function parseArchive(raw: string): RuleArchive {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('档案不是有效的 JSON 文件，请确认选择的是规则档案。');
  }
  const archive = parsed as Partial<RuleArchive>;
  if (!parsed || typeof parsed !== 'object' || archive.format !== ARCHIVE_FORMAT) {
    throw new Error('缺少规则档案标识，可能不是本工具导出的档案。');
  }
  if (!Array.isArray(archive.ruleSets) || archive.ruleSets.length === 0) {
    throw new Error('档案里没有任何规则集。');
  }
  return {
    format: ARCHIVE_FORMAT,
    version: Number(archive.version ?? 1),
    exportedAt: String(archive.exportedAt ?? ''),
    school: String(archive.school ?? ''),
    teacher: String(archive.teacher ?? ''),
    note: String(archive.note ?? ''),
    ruleSets: archive.ruleSets.map((set) => ({
      id: String(set.id ?? uid('ruleset')),
      name: String(set.name ?? '未命名规则集'),
      description: String(set.description ?? ''),
      contractions: Boolean(set.contractions),
      hyphenMode: set.hyphenMode === 'inline' ? 'inline' : 'cross-line',
      rules: Array.isArray(set.rules) ? set.rules.map(normalizeRule) : [],
    })),
  };
}

export function diffArchive(state: ProjectState, archive: RuleArchive): ArchiveDiff {
  const sets: RuleSetDiff[] = archive.ruleSets.map((incomingSet) => {
    const localSet = state.ruleSets.find((set) => set.id === incomingSet.id);

    const settings: SettingChange[] = localSet
      ? SETTING_META
        .map((meta) => ({
          field: meta.field,
          label: meta.label,
          localValue: settingValue(localSet, meta.field),
          incomingValue: settingValue(incomingSet, meta.field),
          apply: false,
        }))
        .filter((change) => change.localValue !== change.incomingValue)
      : [];

    // 本地可能出现同 kind+原文 的重复规则，按出现顺序依次配对，其余视为新增。
    const localPools = new Map<string, TranscriptionRule[]>();
    localSet?.rules.forEach((rule) => {
      const key = ruleKey(rule);
      localPools.set(key, [...(localPools.get(key) ?? []), rule]);
    });

    const changes: RuleChange[] = incomingSet.rules.map((rawIncoming) => {
      const incoming = normalizeRule(rawIncoming);
      const key = ruleKey(incoming);
      const pool = localPools.get(key) ?? [];
      const local = pool.shift();

      if (!local) {
        return { key, kind: incoming.kind, source: incoming.source, type: 'new', incoming, apply: true, takeIncoming: true };
      }

      if (rulesEquivalent(local, incoming)) {
        return { key, kind: incoming.kind, source: incoming.source, type: 'identical', local, incoming, apply: true, takeIncoming: true };
      }

      const conflict = local.output !== incoming.output;
      return {
        key,
        kind: incoming.kind,
        source: incoming.source,
        type: conflict ? 'conflict' : 'replace',
        local,
        incoming,
        // 默认采纳非冲突替换；冲突默认保留本校，由老师逐条选择。
        apply: true,
        takeIncoming: !conflict,
      };
    });

    return {
      ruleSet: incomingSet,
      isNew: !localSet,
      include: true,
      changes,
      settings,
    };
  });

  return {
    archive,
    sets,
    added: sets.reduce((total, set) => total + (set.isNew ? set.ruleSet.rules.length : set.changes.filter((change) => change.type === 'new' && change.apply).length), 0),
    replaced: sets.reduce((total, set) => total + set.changes.filter((change) => change.type === 'replace' && change.apply).length, 0),
    conflicts: sets.reduce((total, set) => total + set.changes.filter((change) => change.type === 'conflict').length, 0),
  };
}

function applyRuleChange(rules: TranscriptionRule[], change: RuleChange): TranscriptionRule[] {
  if (!change.apply) return rules;
  if (change.type === 'new') {
    return [...rules, { ...change.incoming, id: uid('rule') }];
  }
  if (change.type === 'identical') return rules;

  const local = change.local!;
  if (!change.takeIncoming) return rules;
  return rules.map((rule) => (rule.id === local.id ? {
    ...rule,
    output: change.incoming.output,
    enabled: change.incoming.enabled,
    suspicious: change.incoming.suspicious,
    description: change.incoming.description,
  } : rule));
}

export function mergeArchive(state: ProjectState, diff: ArchiveDiff): { state: ProjectState; stats: ArchiveMergeStats } {
  let ruleSets = state.ruleSets.map((ruleSet) => ({ ...ruleSet, rules: [...ruleSet.rules] }));
  const stats: ArchiveMergeStats = { added: 0, replaced: 0, conflictsTaken: 0, conflictsKept: 0, settingsApplied: 0, newSets: 0 };

  diff.sets.forEach((setDiff) => {
    if (!setDiff.include) return;
    const incomingSet = setDiff.ruleSet;
    const existing = ruleSets.find((set) => set.id === incomingSet.id);

    if (!existing) {
      ruleSets = [...ruleSets, {
        id: incomingSet.id,
        name: incomingSet.name,
        description: incomingSet.description,
        contractions: incomingSet.contractions,
        hyphenMode: incomingSet.hyphenMode,
        rules: incomingSet.rules.map((rule) => ({ ...normalizeRule(rule), id: uid('rule') })),
      }];
      stats.newSets += 1;
      stats.added += incomingSet.rules.length;
      return;
    }

    let rules = existing.rules;
    setDiff.changes.forEach((change) => {
      const before = rules;
      rules = applyRuleChange(rules, change);
      if (!change.apply || rules === before) return;
      if (change.type === 'new') stats.added += 1;
      if (change.type === 'replace') stats.replaced += 1;
      if (change.type === 'conflict') stats.conflictsTaken += 1;
    });
    setDiff.changes.forEach((change) => {
      if (change.type === 'conflict' && change.apply && !change.takeIncoming) stats.conflictsKept += 1;
    });

    let nextSet: RuleSet = { ...existing, rules };
    setDiff.settings.forEach((setting) => {
      if (!setting.apply) return;
      stats.settingsApplied += 1;
      if (setting.field === 'description') nextSet = { ...nextSet, description: incomingSet.description };
      if (setting.field === 'contractions') nextSet = { ...nextSet, contractions: incomingSet.contractions };
      if (setting.field === 'hyphenMode') nextSet = { ...nextSet, hyphenMode: incomingSet.hyphenMode };
    });

    ruleSets = ruleSets.map((set) => (set.id === nextSet.id ? nextSet : set));
  });

  return {
    state: { ...state, ruleSets },
    stats,
  };
}

export function archiveRuleCount(archive: RuleArchive): number {
  return archive.ruleSets.reduce((total, ruleSet) => total + ruleSet.rules.length, 0);
}

export function makeArchiveRecord(direction: 'export' | 'import', archive: RuleArchive, fileName: string, stats?: ArchiveMergeStats): RuleArchiveRecord {
  return {
    id: uid('archive'),
    direction,
    at: new Date().toISOString(),
    school: archive.school,
    teacher: archive.teacher,
    note: archive.note,
    fileName,
    setCount: archive.ruleSets.length,
    ruleCount: archiveRuleCount(archive),
    stats,
    payload: archive,
  };
}

export function archiveFileName(archive: RuleArchive, direction: 'export' | 'import' = 'export'): string {
  const school = archive.school || '本校';
  const stamp = new Date(archive.exportedAt || Date.now()).toISOString().slice(0, 10);
  const suffix = direction === 'export' ? '规则档案' : '已接收规则档案';
  return `${school}-${suffix}-${stamp}.braille-rules.json`.replace(/[\\/:*?"<>|]+/gu, '_');
}
