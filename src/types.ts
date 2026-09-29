export type RecordGroup = 'A' | 'B';
export type MatchStatus = 'suggested' | 'confirmed' | 'rejected' | 'merged';
export type ReconciliationScheme = 'identity' | 'content';
export type FieldKey = 'title' | 'date' | 'people' | 'places' | 'identifier' | 'medium' | 'extent' | 'rights' | 'notes';

export interface ArchiveRecord {
  id: string;
  group: RecordGroup;
  title: string;
  date: string;
  people: string[];
  places: string[];
  identifier: string;
  medium: string;
  extent: string;
  rights: string;
  notes: string;
  updatedAt: string;
  status: 'unreviewed' | 'confirmed' | 'rejected' | 'merged';
}

export interface MatchCandidate {
  id: string;
  leftId: string;
  rightId: string;
  score: number;
  fieldScores: Record<FieldKey, number>;
  status: MatchStatus;
  reasons: string[];
  reviewedAt?: string;
  /** 作出结论时使用的核对方案；未作结论的候选不记录 */
  scheme?: ReconciliationScheme;
  /** 关键冲突处理说明；存在关键冲突时确认或合并的必填项 */
  conflictNote?: string;
  /** 旧结论：本次处理前的匹配状态 */
  previousStatus?: MatchStatus;
  /** 当前方案下是否存在关键冲突（编号不同或人物不重合等） */
  keyConflict?: boolean;
  /** 关键冲突字段说明，如「编号不同」「人物不重合」 */
  keyConflictReasons?: string[];
}

export interface MergeResult {
  id: string;
  matchId: string;
  leftId: string;
  rightId: string;
  chosen: Partial<Record<FieldKey, RecordGroup | 'combine'>>;
  values: Partial<Record<FieldKey, string>>;
  mergedAt: string;
  /** 合并时使用的核对方案 */
  scheme?: ReconciliationScheme;
  /** 关键冲突处理说明 */
  conflictNote?: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  action: string;
  detail: string;
  recordIds: string[];
  before?: string;
  after?: string;
  /** 处理时使用的核对方案 */
  scheme?: ReconciliationScheme;
  /** 关键冲突处理说明 */
  note?: string;
}

export interface ArchiveState {
  revision: number;
  records: ArchiveRecord[];
  matches: MatchCandidate[];
  merges: MergeResult[];
  audit: AuditEntry[];
  activeMatchId: string;
  selectedRecordIds: string[];
  hydrated: boolean;
  /** 当前核对口径：身份优先或内容优先 */
  scheme: ReconciliationScheme;
}
