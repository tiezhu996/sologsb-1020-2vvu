import type { ArchiveRecord, FieldKey, MatchCandidate, ReconciliationScheme } from '../types';

export const schemeLabels: Record<ReconciliationScheme, string> = {
  identity: '身份优先',
  content: '内容优先'
};

export const schemeDescriptions: Record<ReconciliationScheme, string> = {
  identity: '更看重编号与人物，编号不同且人物不重合时标记关键冲突。',
  content: '更看重标题、日期和地点，内容证据冲突时标记关键冲突。'
};

// 两套口径的字段权重：身份优先突出编号/人物，内容优先突出标题/日期/地点
const schemeWeights: Record<ReconciliationScheme, Partial<Record<FieldKey, number>>> = {
  identity: { title: .18, date: .12, people: .3, places: .08, identifier: .32 },
  content: { title: .34, date: .28, people: .1, places: .2, identifier: .08 }
};

// 编号差异在多大字符相似度以下才算“编号不同”（同批次编号前缀重组不算）
const IDENTIFIER_DIVERGENCE = .35;
// 日期视为同一天的容差（天）
const DATE_WINDOW_DAYS = 2;

const normalize = (value: string) => value.toLowerCase().replace(/[\s·,，。:：;；()（）\-_/]/g, '');
const chars = (value: string) => {
  const text = normalize(value);
  if (text.length < 2) return [text];
  return Array.from({ length: text.length - 1 }, (_, index) => text.slice(index, index + 2));
};
const dice = (left: string, right: string) => {
  const a = chars(left);
  const b = chars(right);
  if (!a.length || !b.length) return 0;
  const remaining = [...b];
  let hits = 0;
  a.forEach((item) => {
    const index = remaining.indexOf(item);
    if (index >= 0) { hits += 1; remaining.splice(index, 1); }
  });
  return (2 * hits) / (a.length + b.length);
};
const jaccard = (left: string[], right: string[]) => {
  const a = new Set(left.map(normalize));
  const b = new Set(right.map(normalize));
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  a.forEach((item) => { if (b.has(item)) intersection += 1; });
  return intersection / (a.size + b.size - intersection);
};
const exactish = (left: string, right: string) => {
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length) + 0.15;
  return dice(a, b);
};
const displayValue = (record: ArchiveRecord, field: FieldKey) => {
  const value = record[field];
  return Array.isArray(value) ? value.join('、') : String(value);
};

export function scorePair(left: ArchiveRecord, right: ArchiveRecord) {
  const fieldScores: Record<FieldKey, number> = {
    title: exactish(left.title, right.title),
    date: exactish(left.date, right.date),
    people: jaccard(left.people, right.people),
    places: jaccard(left.places, right.places),
    identifier: exactish(left.identifier, right.identifier),
    medium: exactish(left.medium, right.medium),
    extent: exactish(left.extent, right.extent),
    rights: exactish(left.rights, right.rights),
    notes: exactish(left.notes, right.notes)
  };
  const scoreForScheme = (scheme: ReconciliationScheme) => {
    const weights = schemeWeights[scheme];
    return Math.min(1, Object.entries(weights).reduce(
      (sum, [field, weight]) => sum + fieldScores[field as FieldKey] * (weight as number), 0
    ));
  };
  const score = scoreForScheme('identity');
  const reasons: string[] = [];
  if (fieldScores.identifier > .8) reasons.push('编号高度一致');
  if (fieldScores.title > .58) reasons.push('标题相似');
  if (fieldScores.date > .9) reasons.push('日期一致');
  if (fieldScores.people > .8) reasons.push('人物一致');
  if (fieldScores.places > .6) reasons.push('地点相近');
  if (!reasons.length) reasons.push('组合字段达到匹配阈值');
  return { score, fieldScores, reasons, schemeScores: { identity: score, content: scoreForScheme('content') } };
}

const toDay = (value: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
};

// 身份优先：编号不同且人物不重合，即关键身份冲突
export function identityConflicts(left: ArchiveRecord, right: ArchiveRecord, fieldScores: Record<FieldKey, number>) {
  const reasons: string[] = [];
  const idLeft = normalize(left.identifier);
  const idRight = normalize(right.identifier);
  const identifierDiverges = !!idLeft && !!idRight && idLeft !== idRight && fieldScores.identifier < IDENTIFIER_DIVERGENCE;
  if (identifierDiverges) reasons.push('编号不同');
  if (left.people.length && right.people.length && fieldScores.people === 0) reasons.push('人物不重合');
  return { key: reasons.length > 0, reasons };
}

// 内容优先：标题对不上，或日期相差超过容差，或地点完全不重合，即关键内容冲突
export function contentConflicts(left: ArchiveRecord, right: ArchiveRecord, fieldScores: Record<FieldKey, number>) {
  const reasons: string[] = [];
  if (fieldScores.title > 0 && fieldScores.title < .3) reasons.push('标题对不上');
  const dayLeft = toDay(left.date);
  const dayRight = toDay(right.date);
  if (dayLeft !== undefined && dayRight !== undefined
    && Math.abs(dayLeft - dayRight) / 86_400_000 > DATE_WINDOW_DAYS) reasons.push('日期相差较大');
  if (left.places.length && right.places.length && fieldScores.places === 0) reasons.push('地点不重合');
  return { key: reasons.length > 0, reasons };
}

export const isKeyConflict = (match: MatchCandidate, scheme: ReconciliationScheme) =>
  scheme === 'identity' ? match.identityKeyConflict : match.contentKeyConflict;

export const keyConflictReasons = (match: MatchCandidate, scheme: ReconciliationScheme) =>
  scheme === 'identity' ? match.identityKeyReasons : match.contentKeyReasons;

export const scoreForScheme = (match: MatchCandidate, scheme: ReconciliationScheme) =>
  match.schemeScores?.[scheme] ?? match.score;

export function computeMatches(records: ArchiveRecord[], previous: MatchCandidate[] = []): MatchCandidate[] {
  const left = records.filter((record) => record.group === 'A');
  const right = records.filter((record) => record.group === 'B');
  const previousById = new Map(previous.map((match) => [match.id, match]));
  const collected = new Map<string, MatchCandidate>();

  const buildCandidate = (a: ArchiveRecord, b: ArchiveRecord): MatchCandidate => {
    const id = `match-${a.id}-${b.id}`;
    const prior = previousById.get(id);
    const scored = scorePair(a, b);
    const identity = identityConflicts(a, b, scored.fieldScores);
    const content = contentConflicts(a, b, scored.fieldScores);
    return {
      id,
      leftId: a.id,
      rightId: b.id,
      score: scored.score,
      fieldScores: scored.fieldScores,
      reasons: scored.reasons,
      schemeScores: scored.schemeScores,
      identityKeyConflict: identity.key,
      identityKeyReasons: identity.reasons,
      contentKeyConflict: content.key,
      contentKeyReasons: content.reasons,
      // 切换口径或重新导入只重排未作结论的候选；已确认/忽略/合并的结果原样保留
      ...(prior && prior.status !== 'suggested' ? {
        status: prior.status,
        reviewedAt: prior.reviewedAt,
        resolutionNote: prior.resolutionNote,
        resolvedScheme: prior.resolvedScheme
      } : { status: 'suggested' as const })
    };
  };

  // 候选集合取两套口径各自 top4 的并集，保证切换口径不会让未处理候选消失
  left.forEach((a) => {
    (['identity', 'content'] as ReconciliationScheme[]).forEach((scheme) => {
      right
        .map((b) => ({ b, ...scorePair(a, b) }))
        .map((item) => ({ ...item, schemeScore: item.schemeScores[scheme] ?? item.score }))
        .filter((item) => item.schemeScore >= .38)
        .sort((x, y) => y.schemeScore - x.schemeScore)
        .slice(0, 4)
        .forEach(({ b }) => {
          const id = `match-${a.id}-${b.id}`;
          if (!collected.has(id)) collected.set(id, buildCandidate(a, b));
        });
    });
  });

  return Array.from(collected.values());
}

export function fieldValue(record: ArchiveRecord, field: FieldKey): string {
  return displayValue(record, field);
}
