import type { ArchiveRecord, FieldKey, MatchCandidate, ReconciliationScheme } from '../types';

/** 两套核对口径的字段权重：身份优先侧重编号与人物，内容优先侧重标题、日期与地点 */
export const SCHEME_WEIGHTS: Record<ReconciliationScheme, Record<string, number>> = {
  identity: { title: .3, date: .2, people: .2, places: .14, identifier: .16 },
  content: { title: .38, date: .26, people: .12, places: .2, identifier: .04 }
};

export const SCHEME_LABELS: Record<ReconciliationScheme, string> = {
  identity: '身份优先',
  content: '内容优先'
};

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

export interface KeyConflict {
  hasConflict: boolean;
  reasons: string[];
}

/**
 * 关键冲突检测。
 * 身份优先：编号不同或人物不重合即为关键冲突。
 * 内容优先：标题差异大、日期不一致或地点不重合即为关键冲突。
 */
export function detectKeyConflict(left: ArchiveRecord, right: ArchiveRecord, scheme: ReconciliationScheme): KeyConflict {
  const reasons: string[] = [];
  if (scheme === 'identity') {
    if (left.identifier && right.identifier && normalize(left.identifier) !== normalize(right.identifier)) {
      reasons.push('编号不同');
    }
    if (left.people.length && right.people.length && jaccard(left.people, right.people) === 0) {
      reasons.push('人物不重合');
    }
  } else {
    if (left.title && right.title && exactish(left.title, right.title) < .5) {
      reasons.push('标题差异大');
    }
    if (left.date && right.date && exactish(left.date, right.date) < .5) {
      reasons.push('日期不一致');
    }
    if (left.places.length && right.places.length && jaccard(left.places, right.places) === 0) {
      reasons.push('地点不重合');
    }
  }
  return { hasConflict: reasons.length > 0, reasons };
}

export function scorePair(left: ArchiveRecord, right: ArchiveRecord, scheme: ReconciliationScheme = 'identity') {
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
  const weights = SCHEME_WEIGHTS[scheme];
  const score = fieldScores.title * weights.title
    + fieldScores.date * weights.date
    + fieldScores.people * weights.people
    + fieldScores.places * weights.places
    + fieldScores.identifier * weights.identifier;
  const reasons: string[] = [];
  if (scheme === 'identity') {
    if (fieldScores.identifier > .8) reasons.push('编号高度一致');
    if (fieldScores.people > .8) reasons.push('人物一致');
    if (fieldScores.title > .58) reasons.push('标题相似');
    if (fieldScores.date > .9) reasons.push('日期一致');
    if (fieldScores.places > .6) reasons.push('地点相近');
  } else {
    if (fieldScores.title > .58) reasons.push('标题相似');
    if (fieldScores.date > .9) reasons.push('日期一致');
    if (fieldScores.places > .6) reasons.push('地点相近');
    if (fieldScores.people > .8) reasons.push('人物一致');
    if (fieldScores.identifier > .8) reasons.push('编号高度一致');
  }
  if (!reasons.length) reasons.push('组合字段达到匹配阈值');
  return { score: Math.min(1, score), fieldScores, reasons };
}

export function computeMatches(records: ArchiveRecord[], scheme: ReconciliationScheme = 'identity'): MatchCandidate[] {
  const left = records.filter((record) => record.group === 'A');
  const right = records.filter((record) => record.group === 'B');
  const matches: MatchCandidate[] = [];
  left.forEach((a) => {
    const candidates = right.map((b) => ({ record: b, ...scorePair(a, b, scheme) }))
      .filter((item) => item.score >= .38)
      .sort((x, y) => y.score - x.score)
      .slice(0, 4);
    candidates.forEach((candidate) => {
      const conflict = detectKeyConflict(a, candidate.record, scheme);
      matches.push({
        id: `match-${a.id}-${candidate.record.id}`,
        leftId: a.id,
        rightId: candidate.record.id,
        score: candidate.score,
        fieldScores: candidate.fieldScores,
        status: 'suggested',
        reasons: candidate.reasons,
        keyConflict: conflict.hasConflict,
        keyConflictReasons: conflict.reasons
      });
    });
  });
  return matches.sort((a, b) => b.score - a.score);
}

/**
 * 切换核对口径后，只重排未作结论的候选。
 * 已确认、忽略或合并的候选保持原样（分数、状态、冲突标记均不变）。
 */
export function rerankSuggested(records: ArchiveRecord[], matches: MatchCandidate[], scheme: ReconciliationScheme): MatchCandidate[] {
  const recordById = (id: string) => records.find((record) => record.id === id);
  return matches.map((match) => {
    if (match.status !== 'suggested') return match;
    const left = recordById(match.leftId);
    const right = recordById(match.rightId);
    if (!left || !right) return match;
    const { score, fieldScores, reasons } = scorePair(left, right, scheme);
    const conflict = detectKeyConflict(left, right, scheme);
    return { ...match, score, fieldScores, reasons, keyConflict: conflict.hasConflict, keyConflictReasons: conflict.reasons };
  }).sort((a, b) => b.score - a.score);
}

export function fieldValue(record: ArchiveRecord, field: FieldKey): string {
  return displayValue(record, field);
}
