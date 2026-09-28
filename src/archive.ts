import type { RuleKind, RuleSet, TranscriptionRule } from './types';

export const ARCHIVE_FORMAT = 'braille-atelier-ruleset-archive';
export const ARCHIVE_VERSION = 1;
export const NEW_TARGET = '__new__';

const RULE_KINDS: RuleKind[] = ['letter', 'number', 'punctuation', 'contraction', 'special'];

export const KIND_LABELS: Record<RuleKind, string> = {
  letter: '字母',
  number: '数字',
  punctuation: '标点',
  contraction: '缩写',
  special: '特殊',
};

export type SettingKey = 'description' | 'contractions' | 'hyphenMode';
export type SideChoice = 'local' | 'incoming';

export const SETTING_LABELS: Record<SettingKey, string> = {
  description: '规则集说明',
  contractions: '缩写开关',
  hyphenMode: '断词方式',
};

export interface ArchiveRuleSet {
  id: string;
  name: string;
  description: string;
  contractions: boolean;
  hyphenMode: 'cross-line' | 'inline';
  rules: TranscriptionRule[];
}

export interface RuleSetArchive {
  format: typeof ARCHIVE_FORMAT;
  version: number;
  exportedAt: string;
  exporter: string;
  sourceProject: string;
  ruleSet: ArchiveRuleSet;
}

export interface ParseResult {
  ok: boolean;
  archive?: RuleSetArchive;
  errors: string[];
  warnings: string[];
}

export interface RuleComparison {
  key: string;
  kind: RuleKind;
  source: string;
  local?: TranscriptionRule;
  incoming?: TranscriptionRule;
  changedFields: Array<'output' | 'enabled' | 'suspicious' | 'description'>;
}

export interface SettingDiff {
  key: SettingKey;
  local: string | boolean;
  incoming: string | boolean;
}

export interface RuleSetDiff {
  added: RuleComparison[];
  conflicts: RuleComparison[];
  same: RuleComparison[];
  localOnly: RuleComparison[];
  settingDiffs: SettingDiff[];
}

export interface MergeSelection {
  /** 冲突条目逐条选择：local 保留本项目，incoming 采用档案 */
  decisions: Record<string, SideChoice>;
  /** 新增条目是否接收，缺省视为接收 */
  included: Record<string, boolean>;
  /** 规则集级设置选择，合并到已有规则集时使用；缺省采用档案 */
  settings: Partial<Record<SettingKey, SideChoice>>;
}

const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function ruleKey(kind: RuleKind, source: string): string {
  return `${kind} ${source.toLocaleLowerCase()}`;
}

export function createArchive(
  ruleSet: RuleSet,
  meta: { exporter: string; sourceProject: string },
): RuleSetArchive {
  return {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    exportedAt: new Date().toISOString(),
    exporter: meta.exporter.trim() || '未署名教师',
    sourceProject: meta.sourceProject.trim() || '未命名项目',
    ruleSet: structuredClone(ruleSet),
  };
}

export function serializeArchive(archive: RuleSetArchive): string {
  return JSON.stringify(archive, null, 2);
}

/** 解析并校验档案文本；损坏、格式不符或版本过新都会返回错误，不改动当前项目。 */
export function parseArchive(raw: string): ParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, errors: ['档案不是有效的 JSON 文件，请确认发送方导出的是完整的规则档案。'], warnings };
  }

  if (!isObject(data)) {
    return { ok: false, errors: ['档案内容结构不正确：顶层应为规则档案对象。'], warnings };
  }
  if (data.format !== ARCHIVE_FORMAT) {
    return { ok: false, errors: [`档案格式标记为“${String(data.format ?? '缺失')}”，不是 BrailleAtelier 规则档案。`], warnings };
  }
  if (typeof data.version !== 'number') {
    errors.push('档案缺少版本号。');
  } else if (data.version > ARCHIVE_VERSION) {
    errors.push(`档案版本 v${data.version} 比当前软件支持的 v${ARCHIVE_VERSION} 新，请先升级本工具再接收。`);
  }

  const rawSet = data.ruleSet;
  if (!isObject(rawSet)) {
    errors.push('档案中缺少规则集内容。');
    return { ok: false, errors, warnings };
  }

  const name = typeof rawSet.name === 'string' && rawSet.name.trim() ? rawSet.name.trim() : '';
  if (!name) errors.push('档案中的规则集缺少名称。');

  const description = typeof rawSet.description === 'string' ? rawSet.description : '';
  if (typeof rawSet.description !== 'string') warnings.push('规则集说明缺失，已按空说明处理。');

  const contractions = rawSet.contractions === true;
  if (typeof rawSet.contractions !== 'boolean') warnings.push('缩写开关缺失，已按“关闭缩写”处理。');

  let hyphenMode: ArchiveRuleSet['hyphenMode'];
  if (rawSet.hyphenMode === 'cross-line' || rawSet.hyphenMode === 'inline') {
    hyphenMode = rawSet.hyphenMode;
  } else {
    hyphenMode = 'inline';
    warnings.push('断词方式缺失或无法识别，已按“行内连字符”处理。');
  }

  const rules: TranscriptionRule[] = [];
  const seenKeys = new Set<string>();
  if (!Array.isArray(rawSet.rules)) {
    warnings.push('档案中没有规则数组，按 0 条规则处理。');
  } else {
    rawSet.rules.forEach((item, index) => {
      if (!isObject(item)) {
        warnings.push(`第 ${index + 1} 条规则结构损坏，已跳过。`);
        return;
      }
      const kind = RULE_KINDS.includes(item.kind as RuleKind) ? item.kind as RuleKind : undefined;
      const source = typeof item.source === 'string' ? item.source : '';
      const output = typeof item.output === 'string' ? item.output : '';
      if (!kind || !source.trim() || !output.trim()) {
        warnings.push(`第 ${index + 1} 条规则（原文“${source || '缺失'}”）类型或原文/盲文不完整，已跳过。`);
        return;
      }
      const key = ruleKey(kind, source);
      if (seenKeys.has(key)) {
        warnings.push(`原文“${source}”（${KIND_LABELS[kind]}）在档案中重复，保留第一条，其余跳过。`);
        return;
      }
      seenKeys.add(key);
      rules.push({
        id: typeof item.id === 'string' && item.id ? item.id : uid('rule'),
        source,
        output,
        kind,
        enabled: item.enabled === undefined ? true : item.enabled === true,
        suspicious: item.suspicious === true,
        description: typeof item.description === 'string' ? item.description : '',
      });
    });
  }

  if (errors.length > 0) return { ok: false, errors, warnings };

  const archive: RuleSetArchive = {
    format: ARCHIVE_FORMAT,
    version: typeof data.version === 'number' ? data.version : ARCHIVE_VERSION,
    exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : '',
    exporter: typeof data.exporter === 'string' && data.exporter.trim() ? data.exporter : '未署名教师',
    sourceProject: typeof data.sourceProject === 'string' && data.sourceProject.trim() ? data.sourceProject : '未命名项目',
    ruleSet: {
      id: typeof rawSet.id === 'string' && rawSet.id ? rawSet.id : uid('ruleset'),
      name,
      description,
      contractions,
      hyphenMode,
      rules,
    },
  };
  return { ok: true, archive, errors: [], warnings };
}

function compareFields(local: TranscriptionRule, incoming: TranscriptionRule): RuleComparison['changedFields'] {
  const fields: RuleComparison['changedFields'] = [];
  if (local.output !== incoming.output) fields.push('output');
  if (local.enabled !== incoming.enabled) fields.push('enabled');
  if (local.suspicious !== incoming.suspicious) fields.push('suspicious');
  if (local.description !== incoming.description) fields.push('description');
  return fields;
}

/** 以“规则类型 + 原文（不区分大小写）”为对应键，逐条比较本项目与档案。 */
export function diffRuleSets(local: RuleSet | undefined, incoming: ArchiveRuleSet): RuleSetDiff {
  const added: RuleComparison[] = [];
  const conflicts: RuleComparison[] = [];
  const same: RuleComparison[] = [];
  const localOnly: RuleComparison[] = [];

  const localByKey = new Map(
    (local?.rules ?? []).map((rule) => [ruleKey(rule.kind, rule.source), rule]),
  );
  const incomingByKey = new Map(
    incoming.rules.map((rule) => [ruleKey(rule.kind, rule.source), rule]),
  );

  for (const rule of incoming.rules) {
    const key = ruleKey(rule.kind, rule.source);
    const localRule = localByKey.get(key);
    if (!localRule) {
      added.push({ key, kind: rule.kind, source: rule.source, incoming: rule, changedFields: [] });
      continue;
    }
    const changedFields = compareFields(localRule, rule);
    const comparison: RuleComparison = { key, kind: rule.kind, source: rule.source, local: localRule, incoming: rule, changedFields };
    (changedFields.length > 0 ? conflicts : same).push(comparison);
  }

  for (const rule of local?.rules ?? []) {
    const key = ruleKey(rule.kind, rule.source);
    if (!incomingByKey.has(key)) {
      localOnly.push({ key, kind: rule.kind, source: rule.source, local: rule, changedFields: [] });
    }
  }

  const settingDiffs: SettingDiff[] = [];
  if (local) {
    if (local.description !== incoming.description) {
      settingDiffs.push({ key: 'description', local: local.description, incoming: incoming.description });
    }
    if (local.contractions !== incoming.contractions) {
      settingDiffs.push({ key: 'contractions', local: local.contractions, incoming: incoming.contractions });
    }
    if (local.hyphenMode !== incoming.hyphenMode) {
      settingDiffs.push({ key: 'hyphenMode', local: local.hyphenMode, incoming: incoming.hyphenMode });
    }
  }

  return { added, conflicts, same, localOnly, settingDiffs };
}

export function settingDisplay(key: SettingKey, value: string | boolean): string {
  if (key === 'contractions') return value ? '启用缩写' : '关闭缩写';
  if (key === 'hyphenMode') return value === 'cross-line' ? '跨行连字符（允许断词跨行）' : '行内连字符（不在跨行处压缩）';
  const text = String(value);
  return text.trim() ? text : '（空说明）';
}

export const CHANGED_FIELD_LABELS: Record<RuleComparison['changedFields'][number], string> = {
  output: '盲文不同',
  enabled: '启用不同',
  suspicious: '可疑标记不同',
  description: '说明不同',
};

export function suggestArchiveTarget(ruleSets: RuleSet[], archive: RuleSetArchive): string {
  const byId = ruleSets.find((set) => set.id === archive.ruleSet.id);
  if (byId) return byId.id;
  const byName = ruleSets.find((set) => set.name === archive.ruleSet.name);
  return byName?.id ?? NEW_TARGET;
}

export function uniqueRuleSetName(existingNames: string[], base: string): string {
  const used = new Set(existingNames);
  if (!used.has(base)) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}（导入 ${index}）`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}（导入 ${Date.now().toString(36)}）`;
}

/**
 * 按老师的逐条选择合并规则集。
 * - 冲突条目选 local 保留本项目原条，选 incoming 用档案条目覆盖（保留本项目规则 id）。
 * - 新增条目可逐条接收或舍弃；接收时分配新 id，避免与本项目规则撞号。
 * - 本项目独有条目一律原样保留。
 * - local 为 undefined 时作为全新规则集加入，全部采用档案设置。
 */
export function mergeRuleSet(
  local: RuleSet | undefined,
  incoming: ArchiveRuleSet,
  selection: MergeSelection,
): RuleSet {
  const diff = diffRuleSets(local, incoming);
  const conflictKeys = new Set(diff.conflicts.map((item) => item.key));
  const incomingByKey = new Map(incoming.rules.map((rule) => [ruleKey(rule.kind, rule.source), rule]));

  const rules: TranscriptionRule[] = [];

  for (const localRule of local?.rules ?? []) {
    const key = ruleKey(localRule.kind, localRule.source);
    const incomingRule = incomingByKey.get(key);
    if (incomingRule && conflictKeys.has(key) && selection.decisions[key] === 'incoming') {
      rules.push({ ...incomingRule, id: localRule.id });
    } else {
      rules.push(localRule);
    }
  }

  for (const item of diff.added) {
    if (selection.included[item.key] === false) continue;
    rules.push({ ...item.incoming!, id: uid('rule') });
  }

  const pickSetting = (key: SettingKey, localValue: string | boolean, incomingValue: string | boolean) =>
    selection.settings[key] === 'local' ? localValue : incomingValue;

  if (!local) {
    return {
      id: uid('ruleset'),
      name: incoming.name,
      description: incoming.description,
      contractions: incoming.contractions,
      hyphenMode: incoming.hyphenMode,
      rules,
    };
  }

  return {
    ...local,
    description: pickSetting('description', local.description, incoming.description) as string,
    contractions: pickSetting('contractions', local.contractions, incoming.contractions) as boolean,
    hyphenMode: pickSetting('hyphenMode', local.hyphenMode, incoming.hyphenMode) as RuleSet['hyphenMode'],
    rules,
  };
}
