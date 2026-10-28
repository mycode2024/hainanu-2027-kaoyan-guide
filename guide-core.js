(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.HnuGuideCore = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const DAY_MS = 86_400_000;
  const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
  const CHECKLIST_IDS = Object.freeze([
    'program-academic', 'program-computer', 'program-software',
    'stage-baseline', 'stage-directory', 'stage-preapply', 'stage-apply', 'stage-confirm',
    'stage-ticket', 'stage-exam-logistics', 'stage-retest-material', 'stage-retest-plan', 'stage-archive',
    'material-id', 'material-student', 'material-photo', 'material-point', 'material-file', 'material-contact',
    'material-special', 'material-backup'
  ]);
  const checklistIdSet = new Set(CHECKLIST_IDS);
  const optionalChecklistIds = new Set(['stage-preapply', 'material-point', 'material-special']);

  const milestones = [
    { id: 'verify', start: '2026-07-02', end: '2026-09-14', label: '锁定专业基线', action: '按 408 推进一轮复习，并核对 2027 正式目录' },
    { id: 'directory', start: '2026-09-15', end: '2026-09-30', label: '招生目录与报考资格核对', action: '逐字段核对专业、院系、科目、备注与计划' },
    { id: 'consultation', start: '2026-09-26', end: '2026-09-29', label: '研招咨询活动', action: '进入研招网在线咨询，向招生单位核对专业限制、科目和报考要求' },
    { id: 'preapply', start: '2026-10-09', end: '2026-10-12', label: '网上预报名', action: '每日 9:00—22:00；按所在省安排填报并提交核验材料',
      endsAt: '2026-10-12T22:00:00+08:00', deadlineTitle: '网上预报名截止', deadlineCheck: 'stage-preapply',
      deadlineScope: '预报名适用范围按所在省安排；每日 9:00—22:00 开放。',
      deadlineClosedScope: '预报名已截止；尚未报名者请查看正式报名安排，已报名者请核对提交信息。' },
    { id: 'edu-verify', start: '2026-10-09', end: '2026-10-20', label: '学历校验补证', action: '学历（学籍）网上校验未通过者，10 月 20 日前发送证明至 hdyzb@hainanu.edu.cn', reviewScoped: true },
    { id: 'apply', start: '2026-10-15', end: '2026-10-24', label: '全国网上报名', action: '每日 9:00—22:00；填写信息、一并提交核验材料并完成缴费',
      endsAt: '2026-10-24T22:00:00+08:00', deadlineTitle: '全国网上报名截止', deadlineCheck: 'stage-apply',
      deadlineScope: '请在截止前完成报名与缴费；每日 9:00—22:00 开放。',
      deadlineClosedScope: '正式报名已截止；已报名者请继续核对材料与审核结果。' },
    { id: 'review-4603', start: '2026-10-26', end: '2026-10-31', label: '4603 审核补交', action: '海甸 4603 报考点 10 月 26—31 日集中审核，补交截至 10 月 31 日 12:00；其他报考点按当地公告执行', reviewScoped: true,
      deadlineAt: '2026-10-31T12:00:00+08:00', deadlineTitle: '4603 材料补交截止', deadlineCheck: 'stage-confirm',
      deadlineScope: '仅海甸校区 4603 报考点且被要求补交者适用；其他报考点另查公告。',
      closedLabel: '4603 审核（补交已截止）', closedAction: '海甸 4603 报考点仍在集中审核阶段，材料补交已于 10 月 31 日 12:00 截止；请核对审核结果，其他报考点按各自公告执行' },
    // The 2027 process combines registration and confirmation. Local review and
    // supplementary-material deadlines are not a separate national date range.
    { id: 'confirm', start: null, end: null, label: '材料核验与补交', action: '报名时提交材料，补交时限按省级机构和报考点公告执行' },
    { id: 'ticket', start: '2026-12-10', end: '2026-12-18', estimated: true, label: '下载准考证', action: '考前十天左右登录研招网下载打印多份，并完成考点路线踩点' },
    { id: 'exam', start: '2026-12-19', end: '2026-12-20', label: '全国硕士研究生初试', action: '按准考证时间参加政治、英语、数学与 408' },
    { id: 'score', start: '2027-02-20', end: '2027-02-28', estimated: true, label: '初试成绩查询', action: '查分、保存成绩单并决定复试/调剂策略' },
    { id: 'line', start: '2027-03-01', end: '2027-03-20', estimated: true, label: '国家线与复试名单', action: '核对 B 类国家线和学院复试要求' },
    { id: 'retest', start: '2027-03-21', end: '2027-04-15', estimated: true, label: '复试', action: '完成资格审查、专业考核与面试' },
    { id: 'adjust', start: '2027-04-01', end: '2027-04-30', estimated: true, label: '调剂窗口', action: '需要时通过研招网调剂系统填报并确认通知' },
    { id: 'admit', start: '2027-04-15', end: '2027-05-15', estimated: true, label: '拟录取公示', action: '确认拟录取状态并留意体检、政审要求' },
    { id: 'archive', start: '2027-05-01', end: '2027-07-31', estimated: true, label: '调档与通知书', action: '通过档案保管单位寄送材料并确认通知书地址' },
    { id: 'enrol', start: '2027-09-01', end: '2027-09-15', estimated: true, label: '报到入学', action: '按录取通知完成报到与资格复核' }
  ];

  function toUtcDay(value) {
    return Date.parse(`${value}T00:00:00Z`);
  }

  function getTimelineState(items, today) {
    // Date-only callers retain calendar-day semantics; live pages pass an instant.
    const dateOnly = typeof today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(today);
    const instant = new Date(dateOnly ? `${today}T00:00:00+08:00` : today);
    const now = toUtcDay(dateOnly ? today : getBeijingDateString(instant));
    const active = items
      .filter((item) => now >= toUtcDay(item.start) && now <= toUtcDay(item.end)
        && (!item.endsAt || instant.getTime() < Date.parse(item.endsAt)))
      .sort((a, b) => toUtcDay(a.start) - toUtcDay(b.start));
    const next = items
      .filter((item) => toUtcDay(item.start) > now)
      .sort((a, b) => toUtcDay(a.start) - toUtcDay(b.start))[0];

    return {
      activeId: active[0] ? active[0].id : null,
      activeIds: active.map((item) => item.id),
      nextId: next ? next.id : null,
      daysToNext: next ? Math.ceil((toUtcDay(next.start) - now) / DAY_MS) : null
    };
  }

  function calculateProgress(checked, total) {
    if (!Number.isFinite(total) || total <= 0) return 0;
    const percentage = Math.round((checked / total) * 100);
    return Math.min(100, Math.max(0, percentage));
  }

  function filterTimeline(items, category) {
    if (category === 'all') return items.slice();
    return items.filter((item) => item.category === category);
  }

  function readChecks(storage, key, allowedIds) {
    // Access failures must reach the caller; malformed data can be repaired
    // by the next edit without disabling otherwise usable storage.
    const serialized = storage.getItem(key);
    let parsed;
    try {
      parsed = JSON.parse(serialized || '{}');
    } catch {
      return {};
    }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return {};
    const allowedIdSet = allowedIds ? new Set(allowedIds) : null;
    return Object.fromEntries(Object.entries(parsed).filter(([id, value]) => (
      (typeof value === 'boolean' || (value === 'na' && optionalChecklistIds.has(id))) && (!allowedIdSet || allowedIdSet.has(id))
    )));
  }

  function safeReadChecks(storage, key, allowedIds) {
    try {
      return readChecks(storage, key, allowedIds);
    } catch {
      return {};
    }
  }

  function mergeChecklistState(stored, pageValues) {
    const filteredStored = stored && typeof stored === 'object' ? stored : {};
    const filteredPageValues = pageValues && typeof pageValues === 'object' ? pageValues : {};
    return Object.fromEntries(
      Object.entries({ ...filteredStored, ...filteredPageValues }).filter(([id, value]) => (
        checklistIdSet.has(id) && (typeof value === 'boolean' || (value === 'na' && optionalChecklistIds.has(id)))
      ))
    );
  }

  function countChecklistProgress(state) {
    const filteredState = mergeChecklistState(state, {});
    const completed = CHECKLIST_IDS.filter((id) => filteredState[id] === true).length;
    const total = CHECKLIST_IDS.filter((id) => filteredState[id] !== 'na').length;
    return { completed, total, percent: calculateProgress(completed, total) };
  }

  function getBeijingDateString(date) {
    return Number.isFinite(date.getTime())
      ? new Date(date.getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 10)
      : '';
  }

  function getDeadlineNotice(items, date, checks) {
    const today = getBeijingDateString(date);
    // Keep the deadline visible for its calendar phase even after its exact cutoff.
    const milestone = items.filter(item => (item.endsAt || item.deadlineAt)
      && today >= item.start && today <= item.end
      && checks[item.deadlineCheck] !== true && checks[item.deadlineCheck] !== 'na')
      .sort((a, b) => Date.parse(a.endsAt || a.deadlineAt) - Date.parse(b.endsAt || b.deadlineAt))[0];
    if (!milestone) return null;
    const at = milestone.endsAt || milestone.deadlineAt;
    const remainingMs = Date.parse(at) - date.getTime();
    const state = remainingMs <= 0 ? 'closed' : remainingMs <= DAY_MS ? 'urgent' : 'upcoming';
    const minutes = Math.max(0, Math.ceil(remainingMs / 60_000));
    const days = minutes > 1440 ? Math.floor(minutes / 1440) : 0;
    const hours = Math.floor((minutes - days * 1440) / 60);
    const parts = [days && `${days} 天`, hours && `${hours} 小时`, minutes % 60 && `${minutes % 60} 分钟`].filter(Boolean);
    return { milestone, at, state, countdown: state === 'closed' ? '请核对后续审核要求' : `剩余 ${parts.join(' ')}` };
  }

  function isSafeOfficialUpdateUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && (
        url.hostname === 'hainanu.edu.cn' || url.hostname.endsWith('.hainanu.edu.cn') ||
        url.hostname === 'yz.chsi.com.cn'
      );
    } catch {
      return false;
    }
  }

  const SNAPSHOT_STATUSES = new Set(['fresh', 'stale', 'seed']);
  const FRESHNESS_STATES = new Set(['fresh', 'aging', 'overdue', 'never']);
  const MAX_NORMALIZED_UPDATES = 120;

  function isValidIsoString(candidate) {
    return typeof candidate === 'string' && Number.isFinite(Date.parse(candidate));
  }

  function trimmedText(candidate) {
    return typeof candidate === 'string' ? candidate.trim() : '';
  }

  function nonNegativeOrNull(candidate) {
    return Number.isFinite(candidate) && candidate >= 0 ? candidate : null;
  }

  function isValidPublicationDate(candidate) {
    if (!/^20\d{2}-\d{2}-\d{2}$/.test(candidate)) return false;
    const timestamp = toUtcDay(candidate);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === candidate;
  }

  function normalizeSources(list) {
    return (Array.isArray(list) ? list : [])
      .filter((source) => source && typeof source === 'object')
      .map((source) => ({
        id: trimmedText(source.id),
        name: trimmedText(source.name),
        url: trimmedText(source.url),
        ok: source.ok === true ? true : source.ok === false ? false : null,
        checkedAt: isValidIsoString(source.checkedAt) ? source.checkedAt : null,
        lastSuccessAt: isValidIsoString(source.lastSuccessAt) ? source.lastSuccessAt : null,
        attempts: Number.isInteger(source.attempts) && source.attempts >= 0 ? source.attempts : 0,
        error: trimmedText(source.error) || null,
        freshness: FRESHNESS_STATES.has(source.freshness) ? source.freshness : null,
        ageMs: nonNegativeOrNull(source.ageMs),
        isOverdue: source.isOverdue === true || source.freshness === 'overdue' || source.freshness === 'never',
        degraded: source.degraded === true
      }))
      .filter((source) => source.id && source.name && isSafeOfficialUpdateUrl(source.url));
  }

  function normalizeUpdateList(list) {
    return (Array.isArray(list) ? list : [])
      .filter((update) => update && typeof update === 'object')
      .map((update) => ({
        id: trimmedText(update.id),
        title: trimmedText(update.title),
        date: trimmedText(update.date),
        url: trimmedText(update.url),
        source: trimmedText(update.source),
        sourceId: trimmedText(update.sourceId),
        category: trimmedText(update.category) || '招生动态',
        isTarget2027: update.isTarget2027 === true,
        isImportant: update.isImportant === true,
        discoveredAt: isValidIsoString(update.discoveredAt) ? update.discoveredAt : null,
        lastSeenAt: isValidIsoString(update.lastSeenAt) ? update.lastSeenAt : null,
        updatedAt: isValidIsoString(update.updatedAt) ? update.updatedAt : null
      }))
      .filter((update) => (
        update.id && update.title && isValidPublicationDate(update.date) &&
        update.source && update.sourceId && isSafeOfficialUpdateUrl(update.url)
      ))
      .slice(0, MAX_NORMALIZED_UPDATES);
  }

  // Unique string ids from an untrusted list that also appear in knownIds.
  function pickKnownIds(ids, knownIds) {
    return Array.from(new Set(
      (Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && knownIds.has(id))
    ));
  }

  function normalizeFreshness(freshness, lastSuccessAt, sourceIds) {
    const state = FRESHNESS_STATES.has(freshness?.state)
      ? freshness.state
      : (isValidIsoString(lastSuccessAt) ? 'aging' : 'never');
    return {
      state,
      ageMs: nonNegativeOrNull(freshness?.ageMs),
      isOverdue: freshness?.isOverdue === true || state === 'overdue' || state === 'never',
      overdueSourceIds: pickKnownIds(freshness?.overdueSourceIds, sourceIds),
      worstSourceAgeMs: nonNegativeOrNull(freshness?.worstSourceAgeMs)
    };
  }

  function normalizeUpdatesPayload(value) {
    const payload = value && typeof value === 'object' ? value : {};
    const sources = normalizeSources(payload.sources);
    const updates = normalizeUpdateList(payload.updates);
    const updateIds = new Set(updates.map((update) => update.id));
    const newIds = pickKnownIds(payload.change?.newIds, updateIds);
    const updatedIds = pickKnownIds(payload.change?.updatedIds, updateIds);
    const isoOrNull = (candidate) => (isValidIsoString(candidate) ? candidate : null);

    return {
      schemaVersion: payload.schemaVersion === 2 ? 2 : 1,
      status: SNAPSHOT_STATUSES.has(payload.status) ? payload.status : 'seed',
      fetchedAt: isoOrNull(payload.fetchedAt),
      lastAttemptAt: isoOrNull(payload.lastAttemptAt),
      lastAnySuccessAt: isoOrNull(payload.lastAnySuccessAt),
      lastAllSuccessAt: isoOrNull(payload.lastAllSuccessAt),
      lastSuccessAt: isoOrNull(payload.lastSuccessAt),
      nextRefreshAt: isoOrNull(payload.nextRefreshAt),
      refreshIntervalMs: Number.isFinite(payload.refreshIntervalMs) ? payload.refreshIntervalMs : null,
      freshness: normalizeFreshness(payload.freshness, payload.lastSuccessAt, new Set(sources.map((source) => source.id))),
      change: {
        newCount: newIds.length,
        newIds,
        updatedCount: updatedIds.length,
        updatedIds,
        changedAt: isoOrNull(payload.change?.changedAt)
      },
      sources,
      updates,
      error: trimmedText(payload.error) || null
    };
  }

  function getUnseenUpdates(updates, lastSeenAt) {
    if (typeof lastSeenAt !== 'string' || !Number.isFinite(Date.parse(lastSeenAt))) return [];
    const lastSeenTime = Date.parse(lastSeenAt);
    return (Array.isArray(updates) ? updates : []).filter((update) => (
      typeof update?.discoveredAt === 'string' && Number.isFinite(Date.parse(update.discoveredAt)) &&
      Date.parse(update.discoveredAt) > lastSeenTime
    ));
  }

  function getUnseenBaseline(existingBaseline, observedAt) {
    if (typeof existingBaseline === 'string' && Number.isFinite(Date.parse(existingBaseline))) return existingBaseline;
    if (typeof observedAt === 'string' && Number.isFinite(Date.parse(observedAt))) return observedAt;
    return null;
  }

  function createUpdatesSnapshotKey(value) {
    const stableValue = (candidate) => {
      if (Array.isArray(candidate)) return candidate.map(stableValue);
      if (candidate && typeof candidate === 'object') {
        return Object.keys(candidate).sort().reduce((result, key) => {
          result[key] = stableValue(candidate[key]);
          return result;
        }, {});
      }
      return candidate;
    };
    return JSON.stringify(stableValue(value));
  }

  function selectUpdatesForDisplay(updates, newIds, acknowledgedIds, mode, filters = {}) {
    const allUpdates = Array.isArray(updates) ? updates : [];
    const activeNewIds = new Set(
      Array.from(newIds || []).filter((id) => !acknowledgedIds?.has(id))
    );
    const unreadSelection = mode === 'new'
      ? allUpdates.filter((update) => activeNewIds.has(update.id))
      : allUpdates;
    const selectedUpdates = unreadSelection.filter((update) => {
      const years = (update.title || '').match(/(?<!\d)20\d{2}(?=\s*(?:年|级|届))/g) || [];
      const matchesYear = !filters.year || filters.year === 'all' ||
        (filters.year === '2027' && years.includes('2027')) ||
        (filters.year === 'history' && years.length > 0 && years.every(year => Number(year) < 2027)) ||
        (filters.year === 'unknown' && years.length === 0);
      return matchesYear && (!filters.category || filters.category === 'all' || update.category === filters.category);
    });

    return {
      updates: selectedUpdates,
      newIds: selectedUpdates.filter((update) => activeNewIds.has(update.id)).map((update) => update.id)
    };
  }

  function timestampOrNull(value) {
    const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : null;
  }

  function contentTime(update) {
    return timestampOrNull(update.updatedAt) ?? timestampOrNull(update.discoveredAt) ?? Number.NEGATIVE_INFINITY;
  }

  function observationTime(update) {
    return timestampOrNull(update.lastSeenAt) ?? contentTime(update);
  }

  // Groups updates that point at the same page (ignoring #fragments) regardless of source.
  function groupUpdatesByUrl(updates) {
    const groupedByUrl = new Map();
    (Array.isArray(updates) ? updates : []).forEach((update) => {
      if (!update || typeof update !== 'object' || typeof update.url !== 'string') return;
      let normalizedUrl = update.url;
      try {
        const parsedUrl = new URL(update.url);
        parsedUrl.hash = '';
        normalizedUrl = parsedUrl.href;
      } catch { /* normalized payload already rejects unsafe URLs */ }
      if (!groupedByUrl.has(normalizedUrl)) groupedByUrl.set(normalizedUrl, []);
      groupedByUrl.get(normalizedUrl).push(update);
    });
    return groupedByUrl;
  }

  // Keep source/member order stable, but choose content by successful observation.
  // Old caches without observation clocks fall back to revision/discovery time.
  function pickPrimaryUpdate(orderedMembers) {
    return orderedMembers.reduce((current, candidate) => {
      const currentTime = observationTime(current);
      const candidateTime = observationTime(candidate);
      return candidateTime > currentTime ||
        (candidateTime === currentTime && contentTime(candidate) > contentTime(current))
        ? candidate : current;
    });
  }

  function buildAggregateEntry(url, members, newIdSet, acknowledgedIdSet) {
    const orderedMembers = members.slice().sort((left, right) => (
      `${left.sourceId || ''}\u0000${left.id || ''}`.localeCompare(`${right.sourceId || ''}\u0000${right.id || ''}`)
    ));
    const primary = pickPrimaryUpdate(orderedMembers);
    const sourceIds = [];
    const sourceNames = [];
    orderedMembers.forEach((member) => {
      if (member.sourceId && !sourceIds.includes(member.sourceId)) sourceIds.push(member.sourceId);
      if (member.source && !sourceNames.includes(member.source)) sourceNames.push(member.source);
    });
    const discoveredAt = orderedMembers
      .map((member) => member.discoveredAt)
      .filter((value) => typeof value === 'string' && Number.isFinite(Date.parse(value)))
      .sort()
      .at(-1) || null;
    const memberIds = orderedMembers.map((member) => member.id).filter(Boolean);

    return {
      id: `url:${url}`,
      url,
      title: primary.title,
      date: primary.date,
      category: primary.category,
      source: sourceNames.join('、'),
      sourceNames,
      sourceIds,
      memberIds,
      discoveredAt,
      isTarget2027: orderedMembers.some((member) => member.isTarget2027),
      isImportant: orderedMembers.some((member) => member.isImportant),
      isNew: memberIds.some((id) => newIdSet.has(id) && !acknowledgedIdSet.has(id))
    };
  }

  // Newest first, then 2027 notices, then important ones, then by title.
  function compareAggregatedUpdates(a, b) {
    const dateOrder = String(b.date || '').localeCompare(String(a.date || ''), 'zh-CN');
    if (dateOrder !== 0) return dateOrder;
    if (Boolean(a.isTarget2027) !== Boolean(b.isTarget2027)) return a.isTarget2027 ? -1 : 1;
    if (Boolean(a.isImportant) !== Boolean(b.isImportant)) return a.isImportant ? -1 : 1;
    return String(a.title || '').localeCompare(String(b.title || ''), 'zh-CN');
  }

  function aggregateUpdatesForDisplay(updates, newIds = new Set(), acknowledgedIds = new Set()) {
    const newIdSet = newIds instanceof Set ? newIds : new Set(newIds || []);
    const acknowledgedIdSet = acknowledgedIds instanceof Set ? acknowledgedIds : new Set(acknowledgedIds || []);
    return Array.from(groupUpdatesByUrl(updates).entries())
      .map(([url, members]) => buildAggregateEntry(url, members, newIdSet, acknowledgedIdSet))
      .sort(compareAggregatedUpdates);
  }

  function formatFreshness(freshness = {}, refreshIntervalMs) {
    if (freshness.state === 'never') return '尚未成功同步';
    if (freshness.state === 'fresh') return '新鲜 · 少于 1 个刷新周期';
    if (freshness.state === 'aging') return '待补同步 · 1–2 个刷新周期';
    if (!Number.isFinite(freshness.ageMs) || !Number.isFinite(refreshIntervalMs) || refreshIntervalMs <= 0) {
      return '已逾期 · 超过 2 个刷新周期';
    }
    const cycles = Math.max(2, Math.floor(freshness.ageMs / refreshIntervalMs));
    return `已逾期 · ${cycles} 个刷新周期`;
  }

  function formatRefreshInterval(refreshIntervalMs) {
    const minuteMs = 60_000;
    const hourMs = 60 * minuteMs;
    if (!Number.isFinite(refreshIntervalMs) || refreshIntervalMs <= 0) return '按刷新周期';
    if (refreshIntervalMs % hourMs === 0) return `${refreshIntervalMs / hourMs} 小时`;
    if (refreshIntervalMs % minuteMs === 0) return `${refreshIntervalMs / minuteMs} 分钟`;
    return '按刷新周期';
  }

  function formatLiveDate(value) {
    if (!value || !Number.isFinite(Date.parse(value))) return '尚未成功同步';
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(new Date(value));
  }

  function formatSourceHealthTitle(source, refreshIntervalMs) {
    const state = source.degraded
      ? '数据异常，保留旧缓存'
      : source.error || (source.ok === true ? '连接正常' : source.ok === false ? '连接失败' : '等待连接');
    const freshness = source.freshness
      ? formatFreshness({ state: source.freshness, ageMs: source.ageMs }, refreshIntervalMs)
      : source.isOverdue
        ? formatFreshness({ state: 'overdue', ageMs: source.ageMs }, refreshIntervalMs)
        : '未知';
    const lastSuccess = source.lastSuccessAt ? formatLiveDate(source.lastSuccessAt) : '尚无成功记录';
    return `${source.name}：${state}；数据新鲜度：${freshness}；最近成功：${lastSuccess}`;
  }

  // Headline and default detail line of the live console for a normalized updates payload.
  function describeSnapshotStatus(payload) {
    const successfulSources = payload.sources.filter((source) => source.ok).length;
    const overdueSourceIds = new Set(payload.freshness.overdueSourceIds);
    const overdueSourceNames = payload.sources
      .filter((source) => source.isOverdue || overdueSourceIds.has(source.id))
      .map((source) => source.name);
    if (/主缓存(?:缺失|损坏).*已从备份恢复/.test(payload.error || '')) {
      return { title: '已从缓存备份恢复，等待验证', detail: '已恢复最近一次可信缓存；正在等待下一次官方来源验证。' };
    }
    if (overdueSourceNames.length) {
      const names = overdueSourceNames.join('、');
      return { title: `部分来源数据逾期 · ${names}`, detail: `${names} 的数据已超过正常刷新窗口，其余来源仍可查看。` };
    }
    if (payload.freshness.state === 'overdue') {
      return { title: '同步已逾期 · 后台正在重试', detail: '最近成功数据仍可查看，请同时留意下方官方原文入口。' };
    }
    if (payload.status === 'fresh') {
      return { title: '已连接 · 官方数据已同步', detail: `${payload.sources.length} 条官方信息流运行正常。` };
    }
    if (payload.status === 'seed') {
      return { title: '服务已启动 · 等待首次成功同步', detail: '后台正在连接海南大学官方页面。' };
    }
    if (successfulSources === 0) {
      return { title: '缓存保护中 · 官方来源暂不可用', detail: '正在展示最近一次成功数据，请稍后重试。' };
    }
    if (/缓存写入失败/.test(payload.error || '')) {
      return { title: '官方数据已读取 · 本地缓存写入失败', detail: '当前页面可用，但重启服务后可能回到旧缓存。' };
    }
    return { title: '缓存保护中 · 部分来源未连接', detail: '继续展示最近一次成功数据，请结合官方原文确认。' };
  }

  // Admission-year badge for a notice: its label and whether it belongs to a previous cycle.
  function describeUpdateCycle(update) {
    const admissionYears = [...new Set(update.title.match(/(?<!\d)20\d{2}(?=\s*(?:年|级|届))/g) || [])];
    const isPreviousCycle = admissionYears.length > 0 && admissionYears.every((year) => Number(year) < 2027);
    const label = admissionYears.length
      ? `${admissionYears.join(' / ')} 招生${isPreviousCycle ? ' · 往年参考' : ''}`
      : Number(update.date.slice(0, 4)) < 2026 ? '往年发布 · 招生年份未注明' : '招生年份未注明';
    return { label, isPreviousCycle };
  }

  // Active and next milestones for the given checklist state at `now` (Beijing calendar).
  function describeCurrentStage(checks, now) {
    const todayString = getBeijingDateString(now);
    const reviewCompleted = checks['stage-confirm'] === true;
    const scheduledMilestones = reviewCompleted
      ? milestones.filter((milestone) => !milestone.reviewScoped)
      : milestones;
    const state = getTimelineState(scheduledMilestones, now);
    const activeMilestones = state.activeIds
      .map((id) => milestones.find((milestone) => milestone.id === id))
      .filter(Boolean)
      .map(milestone => milestone.deadlineAt && now.getTime() >= Date.parse(milestone.deadlineAt)
        ? { ...milestone, label: milestone.closedLabel, action: milestone.closedAction }
        : milestone);
    // An undated local review deadline must not disappear from the task view.
    // This reminder does not extend any official submission deadline.
    const reviewPending = todayString >= '2026-10-09' && !reviewCompleted;
    if (reviewPending) activeMilestones.push(milestones.find(item => item.id === 'confirm'));
    const nextMilestone = milestones.find((milestone) => milestone.id === state.nextId);
    return { scheduledMilestones, state, activeMilestones, nextMilestone, reviewPending };
  }

  return {
    DAY_MS,
    BEIJING_OFFSET_MS,
    CHECKLIST_IDS,
    checklistIdSet,
    optionalChecklistIds,
    milestones,
    toUtcDay,
    getTimelineState,
    calculateProgress,
    filterTimeline,
    readChecks,
    safeReadChecks,
    mergeChecklistState,
    countChecklistProgress,
    getBeijingDateString,
    getDeadlineNotice,
    isSafeOfficialUpdateUrl,
    normalizeUpdatesPayload,
    getUnseenUpdates,
    getUnseenBaseline,
    createUpdatesSnapshotKey,
    selectUpdatesForDisplay,
    aggregateUpdatesForDisplay,
    formatFreshness,
    formatRefreshInterval,
    formatLiveDate,
    formatSourceHealthTitle,
    describeSnapshotStatus,
    describeUpdateCycle,
    describeCurrentStage
  };
});
