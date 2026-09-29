import {
  $, component$, useComputed$, useSignal, useStore, useVisibleTask$
} from '@builder.io/qwik';
import { Checkbox, Modal, Tabs } from '@qwik-ui/headless';
import type { ArchiveRecord, ArchiveState, FieldKey, MatchCandidate, ReconciliationScheme, RecordGroup } from './types';
import {
  computeMatches, fieldValue, isKeyConflict, keyConflictReasons,
  scoreForScheme, schemeDescriptions, schemeLabels
} from './utils/matching';
import { seedState } from './data/seed';

const STORAGE_KEY = 'sologsb-1020-archive-state-v2';
const LEGACY_STORAGE_KEY = 'sologsb-1020-archive-state-v1';
const fieldLabels: Array<[FieldKey, string]> = [
  ['title', '标题'], ['date', '日期'], ['people', '人物'], ['places', '地点'], ['identifier', '编号'],
  ['medium', '载体'], ['extent', '数量'], ['rights', '权利'], ['notes', '备注']
];

const parseDate = (value: string) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.split('-').reverse().join('/');
  if (/^\d{4}$/.test(value)) return `${value}年`;
  return value || '未知';
};

const recordById = (state: ArchiveState, id: string) => state.records.find((record) => record.id === id);
const matchLabel = (state: ArchiveState, match: MatchCandidate) => {
  const left = recordById(state, match.leftId);
  const right = recordById(state, match.rightId);
  return `${left?.title ?? '未知记录'} ↔ ${right?.title ?? '未知记录'}`;
};

export default component$(() => {
  const state = useStore<ArchiveState>(seedState());
  const history = useSignal<string[]>([]);
  const future = useSignal<string[]>([]);
  const query = useSignal('');
  const groupFilter = useSignal<'all' | RecordGroup>('all');
  const statusFilter = useSignal<'all' | MatchCandidate['status']>('all');
  const visibleCount = useSignal(80);
  const selectedMatchIds = useSignal<string[]>([]);
  const importOpen = useSignal(false);
  const mergeOpen = useSignal(false);
  const importGroup = useSignal<RecordGroup>('A');
  const importRaw = useSignal('');
  const importText = useSignal('');
  const toast = useSignal('');
  const panelTab = useSignal(0);
  const noteDraft = useSignal('');

  const snapshot = () => JSON.stringify({
    revision: state.revision,
    records: state.records,
    matches: state.matches,
    merges: state.merges,
    audit: state.audit,
    activeScheme: state.activeScheme
  });

  const capture = () => {
    history.value = [...history.value.slice(-49), snapshot()];
    future.value = [];
  };

  const restore = (raw: string) => {
    const next = JSON.parse(raw) as Partial<ArchiveState>;
    state.revision = next.revision ?? state.revision;
    state.records = next.records ?? state.records;
    state.matches = next.matches ?? state.matches;
    state.merges = next.merges ?? state.merges;
    state.audit = next.audit ?? state.audit;
    state.activeScheme = next.activeScheme ?? 'identity';
  };

  const notify = (message: string) => {
    toast.value = message;
    window.setTimeout(() => { if (toast.value === message) toast.value = ''; }, 3200);
  };

  const commit = (action: string, detail: string, recordIds: string[] = [], scheme: ReconciliationScheme = state.activeScheme) => {
    state.revision += 1;
    state.audit.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), action, detail, recordIds, scheme });
    state.audit = state.audit.slice(0, 300);
  };

  const undo = $(() => {
    const raw = history.value.at(-1);
    if (!raw) return;
    future.value = [...future.value, snapshot()];
    history.value = history.value.slice(0, -1);
    restore(raw);
  });

  const redo = $(() => {
    const raw = future.value.at(-1);
    if (!raw) return;
    history.value = [...history.value, snapshot()];
    future.value = future.value.slice(0, -1);
    restore(raw);
  });

  const filteredRecords = useComputed$(() => {
    const term = query.value.trim().toLowerCase();
    return state.records
      .filter((record) => groupFilter.value === 'all' || record.group === groupFilter.value)
      .filter((record) => !term || [record.title, record.date, record.identifier, ...record.people, ...record.places].join(' ').toLowerCase().includes(term))
      .sort((a, b) => a.group.localeCompare(b.group) || a.title.localeCompare(b.title, 'zh-CN'))
      .slice(0, visibleCount.value);
  });

  // 切换口径只重排未作结论的候选；已确认、忽略或合并的结果保持原相对顺序
  const filteredMatches = useComputed$(() => state.matches
    .filter((match) => statusFilter.value === 'all' || match.status === statusFilter.value)
    .sort((a, b) => {
      const aOpen = a.status === 'suggested';
      const bOpen = b.status === 'suggested';
      if (aOpen !== bOpen) return aOpen ? -1 : 1;
      if (aOpen && bOpen) return scoreForScheme(b, state.activeScheme) - scoreForScheme(a, state.activeScheme);
      return (b.reviewedAt ?? '').localeCompare(a.reviewedAt ?? '');
    }));

  const visibleMatches = useComputed$(() => filteredMatches.value.slice(0, 120));
  const activeMatch = useComputed$(() => state.matches.find((match) => match.id === state.activeMatchId) ?? filteredMatches.value[0]);
  // 当前口径下需要处理说明的关键冲突数量
  const keyConflictCount = useComputed$(() => state.matches
    .filter((match) => match.status === 'suggested' && isKeyConflict(match, state.activeScheme)).length);

  // 关键冲突没有处理说明时，确认与合并都会被拦住；忽略不拦截
  const blockedByConflict = $((match: MatchCandidate | undefined) => {
    if (!match || !isKeyConflict(match, state.activeScheme)) return false;
    if (noteDraft.value.trim()) return false;
    notify(`关键冲突（${keyConflictReasons(match, state.activeScheme).join('、')}）：请先填写处理说明，再确认或合并`);
    return true;
  });

  const switchScheme = $((scheme: ReconciliationScheme) => {
    if (scheme === state.activeScheme) return;
    capture();
    const from = schemeLabels[state.activeScheme];
    state.activeScheme = scheme;
    commit('切换核对口径', `${from} → ${schemeLabels[scheme]}：仅重排未作结论候选，已确认 / 忽略 / 合并结果保持原样`);
    notify(`已切换至「${schemeLabels[scheme]}」口径`);
  });

  const saveResolutionNote = $(() => {
    const match = activeMatch.value;
    if (!match || match.status !== 'suggested') return;
    const note = noteDraft.value.trim();
    if (note === (match.resolutionNote ?? '')) { notify('处理说明没有改动'); return; }
    capture();
    match.resolutionNote = note || undefined;
    commit('保存关键冲突处理说明', `${matchLabel(state, match)}：${note || '已清空处理说明'}`, [match.leftId, match.rightId]);
    notify('处理说明已保存，并随结论与当前口径一起记录');
  });

  const updateMatch = $(async (id: string, status: MatchCandidate['status']) => {
    const match = state.matches.find((item) => item.id === id);
    if (!match) return;
    if (status === 'confirmed' && await blockedByConflict(match)) return;
    capture();
    match.status = status;
    match.reviewedAt = new Date().toISOString();
    match.resolvedScheme = state.activeScheme;
    const note = noteDraft.value.trim();
    if (note) match.resolutionNote = note;
    state.records.forEach((record) => {
      if ((record.id === match.leftId || record.id === match.rightId) && status === 'confirmed') record.status = 'confirmed';
    });
    const noteText = match.resolutionNote ? `；处理说明：${match.resolutionNote}` : '';
    commit(
      status === 'confirmed' ? '确认匹配' : '忽略可疑匹配',
      `${matchLabel(state, match)}（${schemeLabels[state.activeScheme]}口径）${noteText}`,
      [match.leftId, match.rightId]
    );
    notify(status === 'confirmed' ? '已按当前口径确认此项匹配' : '已忽略此项匹配');
  });

  const bulkMatch = $((status: MatchCandidate['status']) => {
    const ids = selectedMatchIds.value;
    if (!ids.length) return;
    const targets = ids
      .map((id) => state.matches.find((item) => item.id === id))
      .filter((match): match is MatchCandidate => !!match && match.status === 'suggested');
    // 关键冲突缺处理说明时批量操作跳过，并统计数量
    const skipped = status === 'confirmed'
      ? targets.filter((match) => isKeyConflict(match, state.activeScheme) && !match.resolutionNote?.trim())
      : [];
    const skippedIds = new Set(skipped.map((match) => match.id));
    const applied = targets.filter((match) => !skippedIds.has(match.id));
    if (!applied.length) {
      notify(`批量确认未执行：${skipped.length} 条关键冲突缺少处理说明，已全部跳过`);
      return;
    }
    capture();
    applied.forEach((match) => {
      match.status = status;
      match.reviewedAt = new Date().toISOString();
      match.resolvedScheme = state.activeScheme;
    });
    commit('批量复核', `${applied.length} 条匹配按${schemeLabels[state.activeScheme]}口径标记为${status === 'confirmed' ? '确认' : '忽略'}`
      + (skipped.length ? `；跳过 ${skipped.length} 条缺少处理说明的关键冲突` : ''),
    applied.flatMap((match) => [match.leftId, match.rightId]));
    selectedMatchIds.value = skipped.map((match) => match.id);
    notify(skipped.length
      ? `已处理 ${applied.length} 条，跳过 ${skipped.length} 条缺处理说明的关键冲突`
      : `已批量处理 ${applied.length} 条匹配`);
  });

  const openMerge = $(async () => {
    const match = activeMatch.value;
    if (!match || await blockedByConflict(match)) return;
    state.activeMatchId = match.id;
    fieldLabels.forEach(([field]) => {
      choices[field] = 'A';
    });
    mergeOpen.value = true;
  });

  const choices = useStore<Record<FieldKey, RecordGroup | 'combine'>>({
    title: 'A', date: 'A', people: 'A', places: 'A', identifier: 'A', medium: 'A', extent: 'A', rights: 'A', notes: 'A'
  });

  const mergeCurrent = $(async () => {
    const match = activeMatch.value;
    if (!match) return;
    if (await blockedByConflict(match)) return;
    const left = recordById(state, match.leftId);
    const right = recordById(state, match.rightId);
    if (!left || !right) return;
    capture();
    const note = noteDraft.value.trim();
    if (note) match.resolutionNote = note;
    const values: Partial<Record<FieldKey, string>> = {};
    fieldLabels.forEach(([field]) => {
      const source = choices[field];
      const pick = source === 'combine' ? `${fieldValue(left, field)}；${fieldValue(right, field)}` : fieldValue(source === 'A' ? left : right, field);
      values[field] = pick;
    });
    const merged: ArchiveRecord = {
      ...left,
      ...values,
      people: values.people?.split(/[；、,，]/).map((item) => item.trim()).filter(Boolean) ?? left.people,
      places: values.places?.split(/[；、,，]/).map((item) => item.trim()).filter(Boolean) ?? left.places,
      status: 'merged',
      updatedAt: new Date().toISOString()
    };
    state.records = [...state.records.filter((record) => record.id !== left.id && record.id !== right.id), merged];
    state.matches.forEach((item) => {
      if (item.id === match.id) {
        item.status = 'merged';
        item.reviewedAt = new Date().toISOString();
        item.resolvedScheme = state.activeScheme;
      } else if (item.leftId === left.id || item.rightId === right.id || item.leftId === right.id || item.rightId === left.id) item.status = 'rejected';
    });
    state.merges.unshift({
      id: crypto.randomUUID(),
      matchId: match.id,
      leftId: left.id,
      rightId: right.id,
      chosen: { ...choices },
      values,
      mergedAt: new Date().toISOString(),
      scheme: state.activeScheme,
      resolutionNote: match.resolutionNote
    });
    commit('合并两条记录',
      `按${schemeLabels[state.activeScheme]}口径保留 ${Object.values(choices).filter((choice) => choice === 'A').length} 个 A 来源字段、${Object.values(choices).filter((choice) => choice === 'B').length} 个 B 来源字段`
      + (match.resolutionNote ? `；处理说明：${match.resolutionNote}` : ''),
      [left.id, right.id, merged.id]);
    mergeOpen.value = false;
    notify('记录已合并，口径、处理说明与字段选择均已写入审计记录');
  });

  const parseImport = $(() => {
    const raw = importRaw.value.trim();
    if (!raw) return;
    let rows: Array<Partial<ArchiveRecord>> = [];
    try {
      if (raw.startsWith('[')) rows = JSON.parse(raw) as Array<Partial<ArchiveRecord>>;
      else {
        const lines = raw.split(/\r?\n/).filter(Boolean);
        rows = lines.map((line, index) => {
          const cells = line.split(/\t|\|/).map((cell) => cell.trim());
          return {
            title: cells[0] || `未命名记录 ${index + 1}`,
            date: cells[1] || '',
            people: (cells[2] || '').split(/[，,、]/).filter(Boolean),
            places: (cells[3] || '').split(/[，,、]/).filter(Boolean),
            identifier: cells[4] || '',
            medium: cells[5] || '',
            extent: cells[6] || '',
            rights: cells[7] || '',
            notes: cells[8] || ''
          };
        });
      }
    } catch {
      notify('导入内容格式不正确，请使用 JSON 数组或制表符分隔文本');
      return;
    }
    if (!rows.length) return;
    capture();
    rows.forEach((row) => {
      const record: ArchiveRecord = {
        id: crypto.randomUUID(),
        group: importGroup.value,
        title: row.title || '未命名记录',
        date: row.date || '',
        people: Array.isArray(row.people) ? row.people : String(row.people || '').split(/[，,、]/).filter(Boolean),
        places: Array.isArray(row.places) ? row.places : String(row.places || '').split(/[，,、]/).filter(Boolean),
        identifier: row.identifier || '',
        medium: row.medium || '',
        extent: row.extent || '',
        rights: row.rights || '',
        notes: row.notes || '',
        updatedAt: new Date().toISOString(),
        status: 'unreviewed'
      };
      state.records.push(record);
    });
    // 重新匹配时保留旧结论（状态、口径、处理说明），新候选按当前口径排队
    state.matches = computeMatches(state.records, state.matches);
    commit('导入档案记录', `从 ${importGroup.value} 组导入 ${rows.length} 条记录，沿用 ${schemeLabels[state.activeScheme]} 口径重排未处理候选`, []);
    importRaw.value = '';
    importText.value = '';
    importOpen.value = false;
    notify(`已导入 ${rows.length} 条记录并重新匹配，历史结论保持原样`);
  });

  const importFile = $(async (_event: Event, element: HTMLInputElement) => {
    const file = element.files?.[0];
    if (!file) return;
    importRaw.value = await file.text();
    importText.value = file.name;
  });

  const exportAudit = $(() => {
    const blob = new Blob([JSON.stringify({
      exportedAt: new Date().toISOString(),
      activeScheme: state.activeScheme,
      activeSchemeLabel: schemeLabels[state.activeScheme],
      records: state.records,
      matches: state.matches,
      merges: state.merges,
      audit: state.audit
    }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `档案元数据核对结果-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  });

  const moveReview = $((delta: number) => {
    const list = filteredMatches.value;
    const index = list.findIndex((match) => match.id === activeMatch.value?.id);
    const next = list[Math.max(0, Math.min(list.length - 1, index + delta))];
    if (next) {
      state.activeMatchId = next.id;
      document.querySelector(`[data-match-id="${next.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });

  useVisibleTask$(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        restore(raw);
      } else {
        // 兼容 v1 工作区：重算匹配以补齐两套口径字段，旧结论原样保留
        const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
        if (legacy) {
          const saved = JSON.parse(legacy) as Partial<ArchiveState>;
          restore(JSON.stringify({ ...saved, activeScheme: 'identity' }));
          state.matches = computeMatches(state.records, state.matches);
          state.activeScheme = 'identity';
          localStorage.removeItem(LEGACY_STORAGE_KEY);
        }
      }
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
    state.hydrated = true;
  });

  useVisibleTask$(({ track }) => {
    const payload = track(() => JSON.stringify({
      revision: state.revision, records: state.records, matches: state.matches,
      merges: state.merges, audit: state.audit, activeScheme: state.activeScheme
    }));
    if (state.hydrated) localStorage.setItem(STORAGE_KEY, payload);
  });

  // 切换当前候选时，把已保存的处理说明带入编辑框
  useVisibleTask$(({ track }) => {
    const match = track(() => activeMatch.value);
    noteDraft.value = match?.resolutionNote ?? '';
  });

  useVisibleTask$(({ cleanup }) => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const editing = /INPUT|TEXTAREA|SELECT/.test(target.tagName) || target.isContentEditable;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'i') { event.preventDefault(); importOpen.value = true; return; }
      if (editing) return;
      const key = event.key.toLowerCase();
      if (key === 'j') { event.preventDefault(); moveReview(1); }
      if (key === 'k') { event.preventDefault(); moveReview(-1); }
      if (key === 's') {
        event.preventDefault();
        switchScheme(state.activeScheme === 'identity' ? 'content' : 'identity');
        return;
      }
      if (event.key === 'Enter' && activeMatch.value) { event.preventDefault(); openMerge(); return; }
      if (key === 'c' && activeMatch.value) { event.preventDefault(); updateMatch(activeMatch.value.id, 'confirmed'); }
      if (key === 'r' && activeMatch.value) { event.preventDefault(); updateMatch(activeMatch.value.id, 'rejected'); }
      if (key === '?' || (event.shiftKey && event.key === '/')) { event.preventDefault(); panelTab.value = 2; }
    };
    window.addEventListener('keydown', handler);
    cleanup(() => window.removeEventListener('keydown', handler));
  });

  const statusText: Record<MatchCandidate['status'], string> = {
    suggested: '待复核', confirmed: '已确认', rejected: '已忽略', merged: '已合并'
  };

  return (
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-seal">档</div>
          <div><h1>档案元数据核对台</h1><p>ARCHIVE RECONCILIATION DESK</p></div>
        </div>
        <div class="top-stat"><span class="online-dot" />{state.hydrated ? `离线保存 · r${state.revision} · ${schemeLabels[state.activeScheme]}` : '正在恢复本地工作区'}</div>
        <div class="top-actions">
          <button class="icon-button" disabled={!history.value.length} onClick$={undo}>撤销</button>
          <button class="icon-button" disabled={!future.value.length} onClick$={redo}>重做</button>
          <button class="button ghost" onClick$={() => importOpen.value = true}>导入两组记录</button>
          <button class="button light" onClick$={exportAudit}>导出核对包</button>
        </div>
      </header>

      <div class="overview">
        <div><span class="eyebrow">RECONCILIATION PROJECT</span><h2>口述史与手稿元数据比对</h2><p>核对口径随资料批次调整：切换身份优先或内容优先，只重排未作结论的候选；历史结论连同处理说明与当时口径一并保留。</p></div>
        <div class="metrics">
          <div><strong>{state.records.filter((record) => record.group === 'A').length}</strong><span>A 组记录</span></div>
          <div><strong>{state.records.filter((record) => record.group === 'B').length}</strong><span>B 组记录</span></div>
          <div><strong>{state.matches.filter((match) => match.status === 'suggested').length}</strong><span>待复核匹配</span></div>
          <div class="danger"><strong>{keyConflictCount.value}</strong><span>{schemeLabels[state.activeScheme]}关键冲突</span></div>
        </div>
      </div>

      <main class="desk-grid">
        <section class="panel match-panel">
          <div class="panel-heading">
            <div><span class="eyebrow">01 / MATCH QUEUE</span><h3>匹配核对队列</h3></div>
            <span class="shortcut-hint">J / K 移动 · Enter 合并 · S 切换口径</span>
          </div>
          <div class="scheme-switch" role="group" aria-label="核对口径">
            {(['identity', 'content'] as ReconciliationScheme[]).map((scheme) => (
              <button
                key={scheme}
                class={`scheme-option ${state.activeScheme === scheme ? 'active' : ''}`}
                title={schemeDescriptions[scheme]}
                onClick$={() => switchScheme(scheme)}
              >
                <strong>{schemeLabels[scheme]}</strong>
                <small>{scheme === 'identity' ? '编号 / 人物' : '标题 / 日期 / 地点'}</small>
              </button>
            ))}
          </div>
          <div class="scheme-note">{schemeDescriptions[state.activeScheme]} 切换只影响未作结论候选的排序。</div>
          <div class="toolbar-row">
            <select class="input" value={statusFilter.value} onChange$={(event) => { statusFilter.value = (event.target as HTMLSelectElement).value as typeof statusFilter.value; }}>
              <option value="all">全部匹配</option><option value="suggested">待复核</option><option value="confirmed">已确认</option><option value="rejected">已忽略</option><option value="merged">已合并</option>
            </select>
            <button class="button small" disabled={!selectedMatchIds.value.length} onClick$={() => bulkMatch('confirmed')}>批量确认</button>
            <button class="button small ghost" disabled={!selectedMatchIds.value.length} onClick$={() => bulkMatch('rejected')}>批量忽略</button>
          </div>
          <div class="match-list">
            {visibleMatches.value.map((match) => {
              const left = recordById(state, match.leftId);
              const right = recordById(state, match.rightId);
              const isActive = () => state.activeMatchId === match.id;
              const keyNow = isKeyConflict(match, state.activeScheme);
              const open = match.status === 'suggested';
              return (
                <article
                  key={`${match.id}-${match.status}`}
                  data-match-id={match.id}
                  class={`match-card ${isActive() ? 'active' : ''} ${keyNow && open ? 'key-conflict' : ''}`}
                  onClick$={() => { state.activeMatchId = match.id; }}
                  tabIndex={0}
                >
                  <div class="match-topline">
                    <Checkbox.Root
                      class="qwik-check"
                      aria-label={`选择匹配 ${match.id}`}
                      initialValue={selectedMatchIds.value.includes(match.id)}
                      onClick$={(event: Event) => {
                        event.stopPropagation();
                        selectedMatchIds.value = selectedMatchIds.value.includes(match.id)
                          ? selectedMatchIds.value.filter((id) => id !== match.id)
                          : [...selectedMatchIds.value, match.id];
                      }}
                    ><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Root>
                    <span class={`score ${scoreForScheme(match, state.activeScheme) < .68 ? 'low' : ''}`}>{Math.round(scoreForScheme(match, state.activeScheme) * 100)}%</span>
                    <span class={`status ${match.status}`}>{statusText[match.status]}</span>
                    {keyNow && open && <span class="conflict-badge" title={keyConflictReasons(match, state.activeScheme).join('、')}>关键冲突</span>}
                    {!open && match.resolvedScheme && <span class="scheme-tag">{schemeLabels[match.resolvedScheme]}</span>}
                    <span class="record-id">{left?.identifier}</span>
                  </div>
                  <div class="pair-preview">
                    <div><small>A · {left?.group}</small><strong>{left?.title ?? match.leftId}</strong><span>{parseDate(left?.date ?? '')} · {left?.people.join('、')}</span></div>
                    <i>↔</i>
                    <div><small>B · {right?.group}</small><strong>{right?.title ?? match.rightId}</strong><span>{parseDate(right?.date ?? '')} · {right?.people.join('、')}</span></div>
                  </div>
                  <div class="reason-line">
                    {keyNow ? keyConflictReasons(match, state.activeScheme).join(' · ') : match.reasons.join(' · ')}
                    {!open && match.resolutionNote ? <em class="note-inline">处理说明：{match.resolutionNote}</em> : null}
                  </div>
                </article>
              );
            })}
            {!visibleMatches.value.length && <div class="empty-state">没有符合当前筛选条件的匹配。</div>}
          </div>
        </section>

        <section class="panel records-panel">
          <div class="panel-heading">
            <div><span class="eyebrow">02 / RECORD INDEX</span><h3>档案记录索引</h3></div>
            <span class="shortcut-hint">分页渲染 · 当前 {filteredRecords.value.length} 条</span>
          </div>
          <div class="toolbar-row">
            <input class="input search" placeholder="搜索标题、日期、人物、地点或编号" value={query.value} onInput$={(event) => { query.value = (event.target as HTMLInputElement).value; visibleCount.value = 80; }} />
            <select class="input compact" value={groupFilter.value} onChange$={(event) => { groupFilter.value = (event.target as HTMLSelectElement).value as typeof groupFilter.value; visibleCount.value = 80; }}>
              <option value="all">A + B</option><option value="A">A 组</option><option value="B">B 组</option>
            </select>
          </div>
          <div class="record-table">
            <div class="table-head"><span>来源</span><span>标题</span><span>日期 / 人物 / 地点</span><span>编号</span><span>状态</span></div>
            {filteredRecords.value.map((record) => (
              <div class="table-row" key={record.id}>
                <span class={`group-badge ${record.group.toLowerCase()}`}>{record.group}</span>
                <strong>{record.title}</strong>
                <span>{parseDate(record.date)}<small>{record.people.join('、')} · {record.places.join('、')}</small></span>
                <code>{record.identifier}</code>
                <span class={`record-status ${record.status}`}>{record.status === 'unreviewed' ? '未核对' : record.status === 'confirmed' ? '已确认' : record.status === 'rejected' ? '已忽略' : '已合并'}</span>
              </div>
            ))}
          </div>
          {filteredRecords.value.length >= visibleCount.value && <button class="load-more" onClick$={() => visibleCount.value += 80}>加载下 80 条记录</button>}
        </section>

        <section class="panel review-panel">
          <Tabs.Root bind:selectedIndex={panelTab} class="review-tabs">
            <Tabs.List class="tab-list"><Tabs.Tab>复核详情</Tabs.Tab><Tabs.Tab>合并追溯</Tabs.Tab><Tabs.Tab>键盘帮助</Tabs.Tab></Tabs.List>
            <Tabs.Panel class="tab-panel">
              {activeMatch.value ? (() => {
                const match = activeMatch.value!;
                const left = recordById(state, match.leftId);
                const right = recordById(state, match.rightId);
                const keyNow = isKeyConflict(match, state.activeScheme);
                const open = match.status === 'suggested';
                const needNote = keyNow && open && !noteDraft.value.trim();
                return <>
                  <div class="active-score"><span>{Math.round(scoreForScheme(match, state.activeScheme) * 100)}</span><div><strong>{schemeLabels[state.activeScheme]}口径 · 综合匹配分</strong><small>{match.reasons.join(' · ')}</small></div></div>
                  {keyNow && (
                    <div class={`conflict-alert ${open ? '' : 'resolved'}`}>
                      <strong>⚠ 关键冲突：{keyConflictReasons(match, state.activeScheme).join('、')}</strong>
                      <p>{open
                        ? '按当前口径必须填写处理说明后才能确认或合并；忽略不受限制。批量确认会自动跳过此类候选。'
                        : `此候选已按${schemeLabels[match.resolvedScheme ?? state.activeScheme]}口径作结。`}</p>
                    </div>
                  )}
                  {left && right ? (
                    <div class="field-compare compact"><div class="field-label">字段</div><div>A 来源</div><div>B 来源</div>
                      {fieldLabels.map(([field, label]) => <><div class="field-label">{label}</div><div class={fieldValue(left, field) !== fieldValue(right, field) ? 'different' : ''}>{fieldValue(left, field) || '—'}</div><div class={fieldValue(left, field) !== fieldValue(right, field) ? 'different' : ''}>{fieldValue(right, field) || '—'}</div></>)}
                    </div>
                  ) : <div class="empty-state">原始记录已在合并后移除，字段来源见“合并追溯”。</div>}
                  {open ? (
                    <div class="note-block">
                      <label for="resolution-note">关键冲突处理说明{keyNow ? <em>（必填后才能确认 / 合并）</em> : '（可选）'}</label>
                      <textarea
                        id="resolution-note"
                        class="note-input"
                        value={noteDraft.value}
                        placeholder={keyNow ? '说明为何编号 / 人物等关键证据冲突仍可判为同一条记录…' : '记录复核依据，留空亦可'}
                        onInput$={(event) => { noteDraft.value = (event.target as HTMLTextAreaElement).value; }}
                      />
                      <button class="button small ghost wide" onClick$={saveResolutionNote}>保存处理说明</button>
                    </div>
                  ) : (
                    <div class="resolved-box">
                      <span>结论：{statusText[match.status]} · {schemeLabels[match.resolvedScheme ?? state.activeScheme]}口径{match.reviewedAt ? ` · ${new Date(match.reviewedAt).toLocaleString('zh-CN')}` : ''}</span>
                      {match.resolutionNote ? <p>处理说明：{match.resolutionNote}</p> : <p class="muted">未留处理说明。</p>}
                    </div>
                  )}
                  <div class="action-stack">
                    <button class="button primary wide" disabled={needNote || !left || !right} onClick$={openMerge}>{needNote ? '需先填写处理说明' : '逐字段合并'}</button>
                    <div class="split-actions"><button class="button confirm" disabled={needNote} onClick$={() => updateMatch(match.id, 'confirmed')}>确认匹配</button><button class="button ghost" onClick$={() => updateMatch(match.id, 'rejected')}>忽略</button></div>
                  </div>
                </>;
              })() : <div class="empty-state">从左侧选择一条匹配查看字段来源。</div>}
            </Tabs.Panel>
            <Tabs.Panel class="tab-panel">
              {state.merges.length ? state.merges.map((merge) => {
                const left = recordById(state, merge.leftId);
                const right = recordById(state, merge.rightId);
                return <details class="merge-log" key={merge.id}><summary>{left?.title ?? merge.leftId} ↔ {right?.title ?? merge.rightId}</summary>
                  <p>{new Date(merge.mergedAt).toLocaleString('zh-CN')} · <span class="scheme-tag">{schemeLabels[merge.scheme]}</span></p>
                  {merge.resolutionNote && <p class="merge-note">处理说明：{merge.resolutionNote}</p>}
                  <ul>{Object.entries(merge.chosen).map(([field, choice]) => <li key={field}><strong>{fieldLabels.find(([key]) => key === field)?.[1]}</strong><span>保留 {choice === 'A' ? 'A 来源' : choice === 'B' ? 'B 来源' : '双来源拼接'}：{merge.values[field as FieldKey]}</span></li>)}</ul>
                </details>;
              }) : <div class="empty-state">还没有合并记录。完成一次字段合并后，来源选择、处理说明与当时口径会出现在这里。</div>}
            </Tabs.Panel>
            <Tabs.Panel class="tab-panel shortcut-panel">
              <div><kbd>J / K</kbd><span>下一条 / 上一条可疑匹配</span></div><div><kbd>S</kbd><span>在身份优先 / 内容优先口径间切换（可撤销）</span></div><div><kbd>Enter</kbd><span>打开逐字段合并窗口（关键冲突需先填说明）</span></div><div><kbd>C / R</kbd><span>确认 / 忽略当前匹配</span></div><div><kbd>Ctrl + Z / Y</kbd><span>撤销 / 重做</span></div><div><kbd>Ctrl + I</kbd><span>打开导入窗口</span></div><div><kbd>Ctrl/⌘ + Enter</kbd><span>在导入框中提交记录</span></div>
            </Tabs.Panel>
          </Tabs.Root>
        </section>
      </main>

      <section class="bottom-grid">
        <article class="panel audit-panel">
          <div class="panel-heading"><div><span class="eyebrow">03 / TRACE</span><h3>最新处理记录</h3></div><span>{state.audit.length} 条</span></div>
          <div class="audit-list">
            {state.audit.slice(0, 8).map((entry) => <div class="audit-entry" key={entry.id}><time>{new Date(entry.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time><div><strong>{entry.action}</strong><p>{entry.detail}</p></div><span>{entry.scheme ? schemeLabels[entry.scheme] : entry.recordIds.length ? `${entry.recordIds.length} 条记录` : '系统'}</span></div>)}
          </div>
        </article>
        <article class="panel explanation-panel">
          <div class="panel-heading"><div><span class="eyebrow">METHOD</span><h3>两套核对口径</h3></div></div>
          <p><strong>身份优先</strong>：编号与人物权重最高；编号不同且人物不重合时标记关键冲突。<br /><strong>内容优先</strong>：标题、日期、地点权重最高；标题对不上、日期相差较大或地点不重合时标记关键冲突。</p>
          <div class="rule-row"><span>1</span><p>切换口径只重排未作结论候选；已确认、忽略、合并的结果原样保留，并记录作出结论时的口径。</p></div>
          <div class="rule-row"><span>2</span><p>关键冲突必须先填写处理说明才能确认或合并；批量操作自动跳过并提示跳过数量，忽略不受限制。</p></div>
          <div class="rule-row"><span>3</span><p>处理说明、旧结论与当前口径随撤销 / 重做、本地保存和核对包导出一并保留。</p></div>
        </article>
      </section>

      {toast.value && <div class="toast">{toast.value}</div>}

      <Modal.Root bind:show={importOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel import-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">IMPORT</span><Modal.Title>导入一组档案记录</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          <Modal.Description class="modal-description">支持 JSON 数组或制表符 / 竖线分隔文本。字段顺序：标题、日期、人物、地点、编号、载体、数量、权利、备注。重新匹配不会改动已有结论。</Modal.Description>
          <div class="import-controls">
            <label class="radio-card"><input type="radio" checked={importGroup.value === 'A'} onChange$={() => importGroup.value = 'A'} /><span><strong>A 组</strong><small>口述史 / 主要记录</small></span></label>
            <label class="radio-card"><input type="radio" checked={importGroup.value === 'B'} onChange$={() => importGroup.value = 'B'} /><span><strong>B 组</strong><small>手稿 / 待合并记录</small></span></label>
            <label class="file-button">选择文件<input type="file" accept=".json,.txt,.csv,.tsv" onChange$={(event, element) => importFile(event, element)} /></label>
          </div>
          <textarea class="modal-textarea" value={importRaw.value} onInput$={(event) => importRaw.value = (event.target as HTMLTextAreaElement).value} placeholder="李秀珍口述史访谈 | 2019-04-12 | 李秀珍、周明远 | 临河县 | OH-LXZ-2019-01 | 数字录音 | 02:14:38 | 研究者授权 | ..." />
          {importText.value && <div class="file-name">已读取：{importText.value}</div>}
          <Modal.Footer class="modal-footer"><Modal.Close class="button ghost">取消</Modal.Close><button class="button primary" disabled={!importRaw.value.trim()} onClick$={parseImport}>导入并重新匹配</button></Modal.Footer>
        </Modal.Panel>
      </Modal.Root>

      <Modal.Root bind:show={mergeOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel merge-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">FIELD MERGE · {schemeLabels[state.activeScheme]}</span><Modal.Title>逐字段选择保留来源</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          {activeMatch.value && (() => {
            const match = activeMatch.value!;
            const left = recordById(state, match.leftId);
            const right = recordById(state, match.rightId);
            if (!left || !right) return <Modal.Description class="modal-description">原始记录已移除，无法再次合并。</Modal.Description>;
            const keyNow = isKeyConflict(match, state.activeScheme);
            const needNote = keyNow && !noteDraft.value.trim();
            return <>
              <Modal.Description class="modal-description">每个字段都显示两条记录的原始来源。生成的合并记录会保留原记录编号、字段选择、{schemeLabels[state.activeScheme]}口径{keyNow ? '与关键冲突处理说明' : ''}。</Modal.Description>
              {keyNow && (
                <div class="conflict-alert modal-alert">
                  <strong>⚠ 关键冲突：{keyConflictReasons(match, state.activeScheme).join('、')}</strong>
                  <p>{needNote ? '请先关闭窗口，在复核详情中填写处理说明，再执行合并。' : `处理说明：${noteDraft.value.trim()}`}</p>
                </div>
              )}
              <div class="field-picker-head"><span>字段</span><span>A 组来源</span><span>B 组来源</span></div>
              <div class="field-picker">
                {fieldLabels.map(([field, label]) => {
                  const leftValue = fieldValue(left, field) || '—';
                  const rightValue = fieldValue(right, field) || '—';
                  const same = leftValue === rightValue;
                  return <div class={`field-picker-row ${same ? 'same' : 'conflict'}`} key={field}><div class="picker-label"><strong>{label}</strong>{same ? <small>一致</small> : <small>冲突</small>}</div><label class={`source-option ${choices[field] === 'A' ? 'selected' : ''}`}><input type="radio" name={`field-${field}`} checked={choices[field] === 'A'} onChange$={() => choices[field] = 'A'} /><span><b>A</b>{leftValue}</span></label><label class={`source-option ${choices[field] === 'B' ? 'selected' : ''}`}><input type="radio" name={`field-${field}`} checked={choices[field] === 'B'} onChange$={() => choices[field] = 'B'} /><span><b>B</b>{rightValue}</span></label><button class={`combine-button ${choices[field] === 'combine' ? 'selected' : ''}`} onClick$={() => choices[field] = 'combine'} title="拼接两侧内容">拼接</button></div>;
                })}
              </div>
              <Modal.Footer class="modal-footer"><Modal.Close class="button ghost">取消</Modal.Close><button class="button primary" disabled={needNote} onClick$={mergeCurrent}>{needNote ? '需先填写处理说明' : '生成合并记录'}</button></Modal.Footer>
            </>;
          })()}
        </Modal.Panel>
      </Modal.Root>
    </div>
  );
});
