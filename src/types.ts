export type RecordGroup = 'A' | 'B';
export type MatchStatus = 'suggested' | 'confirmed' | 'rejected' | 'merged';
export type FieldKey = 'title' | 'date' | 'people' | 'places' | 'identifier' | 'medium' | 'extent' | 'rights' | 'notes';
// 核对口径：identity = 身份优先，content = 内容优先
export type ReconciliationScheme = 'identity' | 'content';

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
  // 两套口径各自的综合分；score/fieldScores 为最近一次计算口径，保留以兼容旧数据
  schemeScores: Partial<Record<ReconciliationScheme, number>>;
  // 身份优先口径下判定的关键冲突（编号不同且人物不重合）
  identityKeyConflict: boolean;
  identityKeyReasons: string[];
  // 内容优先口径下判定的关键冲突（标题、日期、地点等内容性证据冲突）
  contentKeyConflict: boolean;
  contentKeyReasons: string[];
  // 关键冲突的处理说明；没有说明时不能确认或合并
  resolutionNote?: string;
  // 作出结论时所用的口径，用于区分历史结论按哪套标准形成
  resolvedScheme?: ReconciliationScheme;
}

export interface MergeResult {
  id: string;
  matchId: string;
  leftId: string;
  rightId: string;
  chosen: Partial<Record<FieldKey, RecordGroup | 'combine'>>;
  values: Partial<Record<FieldKey, string>>;
  mergedAt: string;
  // 合并时所用的口径与关键冲突处理说明
  scheme: ReconciliationScheme;
  resolutionNote?: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  action: string;
  detail: string;
  recordIds: string[];
  before?: string;
  after?: string;
  // 该操作发生时生效的核对口径
  scheme?: ReconciliationScheme;
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
  // 当前生效的核对口径
  activeScheme: ReconciliationScheme;
}
