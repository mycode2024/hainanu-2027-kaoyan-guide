(function () {
  'use strict';

  const DAY_MS = 86_400_000;
  const STORAGE_KEY = 'hainanu-2027-kaoyan-progress-v1';
  const LAST_SEEN_UPDATES_KEY = 'hainanu-2027-kaoyan-last-seen-v1';
  const CHECKLIST_IDS = Object.freeze([
    'program-academic', 'program-computer', 'program-software',
    'stage-baseline', 'stage-directory', 'stage-preapply', 'stage-apply', 'stage-confirm',
    'stage-ticket', 'stage-exam-logistics', 'stage-retest-material', 'stage-retest-plan', 'stage-archive',
    'material-id', 'material-student', 'material-photo', 'material-point', 'material-file', 'material-contact',
    'material-special', 'material-backup'
  ]);
  const checklistIdSet = new Set(CHECKLIST_IDS);

  const milestones = [
    { id: 'verify', start: '2026-07-02', end: '2026-09-14', label: '锁定专业基线', action: '按 408 推进一轮复习，等待 2027 正式目录' },
    { id: 'directory', start: '2026-09-15', end: '2026-09-30', label: '招生章程与目录观察窗', action: '逐字段核对专业、院系、科目、备注与计划' },
    { id: 'preapply', start: '2026-10-10', end: '2026-10-13', label: '网上预报名', action: '完成一次全流程填报并下载报名信息表' },
    { id: 'apply', start: '2026-10-16', end: '2026-10-27', label: '全国网上报名', action: '确认唯一有效报名信息并完成缴费' },
    { id: 'confirm', start: '2026-10-28', end: '2026-11-15', label: '网上确认', action: '上传材料并看到审核通过结果' },
    { id: 'ticket', start: '2026-12-10', end: '2026-12-18', label: '下载准考证', action: '打印多份并完成考点路线踩点' },
    { id: 'exam', start: '2026-12-19', end: '2026-12-20', label: '全国硕士研究生初试', action: '按准考证时间参加政治、英语、数学与 408' },
    { id: 'score', start: '2027-02-20', end: '2027-02-28', label: '初试成绩查询', action: '查分、保存成绩单并决定复试/调剂策略' },
    { id: 'line', start: '2027-03-01', end: '2027-03-20', label: '国家线与复试名单', action: '核对 B 类国家线和学院复试要求' },
    { id: 'retest', start: '2027-03-21', end: '2027-04-15', label: '复试', action: '完成资格审查、专业考核与面试' },
    { id: 'adjust', start: '2027-04-01', end: '2027-04-30', label: '调剂窗口', action: '需要时通过研招网调剂系统填报并确认通知' },
    { id: 'admit', start: '2027-04-15', end: '2027-05-15', label: '拟录取公示', action: '确认拟录取状态并留意体检、政审要求' },
    { id: 'archive', start: '2027-05-01', end: '2027-07-31', label: '调档与通知书', action: '通过档案保管单位寄送材料并确认通知书地址' },
    { id: 'enrol', start: '2027-09-01', end: '2027-09-15', label: '报到入学', action: '按录取通知完成报到与资格复核' }
  ];

  function toUtcDay(value) {
    return Date.parse(`${value}T00:00:00Z`);
  }

  function getTimelineState(items, today) {
    const now = toUtcDay(today);
    const active = items
      .filter((item) => now >= toUtcDay(item.start) && now <= toUtcDay(item.end))
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

  function safeReadChecks(storage, key, allowedIds) {
    try {
      const parsed = JSON.parse(storage.getItem(key) || '{}');
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return {};
      const allowedIdSet = allowedIds ? new Set(allowedIds) : null;
      return Object.fromEntries(Object.entries(parsed).filter(([id, value]) => (
        typeof value === 'boolean' && (!allowedIdSet || allowedIdSet.has(id))
      )));
    } catch {
      return {};
    }
  }

  function mergeChecklistState(stored, pageValues) {
    const filteredStored = stored && typeof stored === 'object' ? stored : {};
    const filteredPageValues = pageValues && typeof pageValues === 'object' ? pageValues : {};
    return Object.fromEntries(
      Object.entries({ ...filteredStored, ...filteredPageValues }).filter(([id, value]) => (
        checklistIdSet.has(id) && typeof value === 'boolean'
      ))
    );
  }

  function countChecklistProgress(state) {
    const filteredState = mergeChecklistState(state, {});
    const completed = CHECKLIST_IDS.filter((id) => filteredState[id] === true).length;
    return { completed, total: CHECKLIST_IDS.length, percent: calculateProgress(completed, CHECKLIST_IDS.length) };
  }

  function getLocalDateString(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
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

  function normalizeUpdatesPayload(value) {
    const payload = value && typeof value === 'object' ? value : {};
    const allowedStatuses = new Set(['fresh', 'stale', 'seed']);
    const validIso = (candidate) => typeof candidate === 'string' && Number.isFinite(Date.parse(candidate));
    const text = (candidate) => typeof candidate === 'string' ? candidate.trim() : '';
    const freshnessStates = new Set(['fresh', 'aging', 'overdue', 'never']);

    const sources = (Array.isArray(payload.sources) ? payload.sources : [])
      .filter((source) => source && typeof source === 'object')
      .map((source) => ({
        id: text(source.id),
        name: text(source.name),
        url: text(source.url),
        ok: source.ok === true ? true : source.ok === false ? false : null,
        checkedAt: validIso(source.checkedAt) ? source.checkedAt : null,
        lastSuccessAt: validIso(source.lastSuccessAt) ? source.lastSuccessAt : null,
        attempts: Number.isInteger(source.attempts) && source.attempts >= 0 ? source.attempts : 0,
        error: text(source.error) || null,
        freshness: freshnessStates.has(source.freshness) ? source.freshness : null,
        ageMs: Number.isFinite(source.ageMs) && source.ageMs >= 0 ? source.ageMs : null,
        isOverdue: source.isOverdue === true || source.freshness === 'overdue' || source.freshness === 'never',
        degraded: source.degraded === true
      }))
      .filter((source) => source.id && source.name && isSafeOfficialUpdateUrl(source.url));

    const updates = (Array.isArray(payload.updates) ? payload.updates : [])
      .filter((update) => update && typeof update === 'object')
      .map((update) => ({
        id: text(update.id),
        title: text(update.title),
        date: text(update.date),
        url: text(update.url),
        source: text(update.source),
        sourceId: text(update.sourceId),
        category: text(update.category) || '招生动态',
        isTarget2027: update.isTarget2027 === true,
        isImportant: update.isImportant === true,
        discoveredAt: validIso(update.discoveredAt) ? update.discoveredAt : null
      }))
      .filter((update) => (
        update.id && update.title && /^20\d{2}-\d{2}-\d{2}$/.test(update.date) &&
        update.source && update.sourceId && isSafeOfficialUpdateUrl(update.url)
      ))
      .slice(0, 120);

    const updateIds = new Set(updates.map((update) => update.id));
    const sourceIds = new Set(sources.map((source) => source.id));
    const newIds = Array.from(new Set(
      (Array.isArray(payload.change?.newIds) ? payload.change.newIds : [])
        .filter((id) => typeof id === 'string' && updateIds.has(id))
    ));
    const updatedIds = Array.from(new Set(
      (Array.isArray(payload.change?.updatedIds) ? payload.change.updatedIds : [])
        .filter((id) => typeof id === 'string' && updateIds.has(id))
    ));
    const overdueSourceIds = Array.from(new Set(
      (Array.isArray(payload.freshness?.overdueSourceIds) ? payload.freshness.overdueSourceIds : [])
        .filter((id) => typeof id === 'string' && sourceIds.has(id))
    ));
    const freshnessState = freshnessStates.has(payload.freshness?.state)
      ? payload.freshness.state
      : (validIso(payload.lastSuccessAt) ? 'aging' : 'never');

    return {
      schemaVersion: payload.schemaVersion === 2 ? 2 : 1,
      status: allowedStatuses.has(payload.status) ? payload.status : 'seed',
      fetchedAt: validIso(payload.fetchedAt) ? payload.fetchedAt : null,
      lastAttemptAt: validIso(payload.lastAttemptAt) ? payload.lastAttemptAt : null,
      lastAnySuccessAt: validIso(payload.lastAnySuccessAt) ? payload.lastAnySuccessAt : null,
      lastAllSuccessAt: validIso(payload.lastAllSuccessAt) ? payload.lastAllSuccessAt : null,
      lastSuccessAt: validIso(payload.lastSuccessAt) ? payload.lastSuccessAt : null,
      nextRefreshAt: validIso(payload.nextRefreshAt) ? payload.nextRefreshAt : null,
      refreshIntervalMs: Number.isFinite(payload.refreshIntervalMs) ? payload.refreshIntervalMs : null,
      freshness: {
        state: freshnessState,
        ageMs: Number.isFinite(payload.freshness?.ageMs) && payload.freshness.ageMs >= 0
          ? payload.freshness.ageMs
          : null,
        isOverdue: payload.freshness?.isOverdue === true || freshnessState === 'overdue' || freshnessState === 'never',
        overdueSourceIds,
        worstSourceAgeMs: Number.isFinite(payload.freshness?.worstSourceAgeMs) && payload.freshness.worstSourceAgeMs >= 0
          ? payload.freshness.worstSourceAgeMs
          : null
      },
      change: {
        newCount: newIds.length,
        newIds,
        updatedCount: updatedIds.length,
        updatedIds,
        changedAt: validIso(payload.change?.changedAt) ? payload.change.changedAt : null
      },
      sources,
      updates,
      error: text(payload.error) || null
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

  function selectUpdatesForDisplay(updates, newIds, acknowledgedIds, mode) {
    const allUpdates = Array.isArray(updates) ? updates : [];
    const activeNewIds = new Set(
      Array.from(newIds || []).filter((id) => !acknowledgedIds?.has(id))
    );
    const selectedUpdates = mode === 'new'
      ? allUpdates.filter((update) => activeNewIds.has(update.id))
      : allUpdates;

    return {
      updates: selectedUpdates,
      newIds: selectedUpdates.filter((update) => activeNewIds.has(update.id)).map((update) => update.id)
    };
  }

  function aggregateUpdatesForDisplay(updates, newIds = new Set(), acknowledgedIds = new Set()) {
    const newIdSet = newIds instanceof Set ? newIds : new Set(newIds || []);
    const acknowledgedIdSet = acknowledgedIds instanceof Set ? acknowledgedIds : new Set(acknowledgedIds || []);
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

    return Array.from(groupedByUrl.entries()).map(([url, members]) => {
      const orderedMembers = members.slice().sort((left, right) => (
        `${left.sourceId || ''}\u0000${left.id || ''}`.localeCompare(`${right.sourceId || ''}\u0000${right.id || ''}`)
      ));
      const primary = orderedMembers[0];
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
    }).sort((a, b) => {
      const dateOrder = String(b.date || '').localeCompare(String(a.date || ''), 'zh-CN');
      if (dateOrder !== 0) return dateOrder;
      if (Boolean(a.isTarget2027) !== Boolean(b.isTarget2027)) return a.isTarget2027 ? -1 : 1;
      if (Boolean(a.isImportant) !== Boolean(b.isImportant)) return a.isImportant ? -1 : 1;
      return String(a.title || '').localeCompare(String(b.title || ''), 'zh-CN');
    });
  }

  function showSessionStorageWarning() {
    const warning = document.querySelector('#storage-session-warning');
    if (warning) warning.hidden = false;
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

  function createTextElement(tagName, className, content) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (content !== undefined) element.textContent = content;
    return element;
  }

  function initOfficialUpdates() {
    const consoleElement = document.querySelector('#live-updates-console');
    const refreshButton = document.querySelector('#refresh-official-updates');
    if (!consoleElement || !refreshButton) return;

    const statusTitle = document.querySelector('#live-status-title');
    const statusDetail = document.querySelector('#live-status-detail');
    const lastSuccess = document.querySelector('#live-last-success');
    const freshness = document.querySelector('#live-freshness');
    const nextRefresh = document.querySelector('#live-next-refresh');
    const sourceCount = document.querySelector('#live-source-count');
    const newCount = document.querySelector('#live-new-count');
    const sourceHealth = document.querySelector('#live-source-health');
    const updatesList = document.querySelector('#official-updates-list');
    const previousPageButton = document.querySelector('#updates-previous');
    const nextPageButton = document.querySelector('#updates-next');
    const pageStatus = document.querySelector('#updates-page-status');
    let updatesPage = 1;
    let updatesPageCount = 1;
    const updateFilterButtons = Array.from(document.querySelectorAll('[data-updates-filter]'));
    const acknowledgeUpdatesButton = document.querySelector('#acknowledge-official-updates');
    let hasRenderedSnapshot = false;
    let unseenBaselineAt = null;
    let latestPayload = null;
    let updateView = 'all';
    let renderedUpdatesKey = null;
    const acknowledgedUpdateIds = new Set();
    let pollTimer = null;
    let activeRequestController = null;
    let requestInFlight = false;
    let resumePending = false;
    try {
      const storedLastSeenAt = window.localStorage.getItem(LAST_SEEN_UPDATES_KEY);
      if (storedLastSeenAt && Number.isFinite(Date.parse(storedLastSeenAt))) unseenBaselineAt = storedLastSeenAt;
    } catch {
      unseenBaselineAt = null;
      showSessionStorageWarning();
    }

    function renderSources(sources, refreshIntervalMs) {
      if (!sourceHealth) return;
      sourceHealth.replaceChildren();
      sources.forEach((source) => {
        const classes = [
          'source-health-chip',
          `is-${source.ok === true ? 'ok' : source.ok === false ? 'error' : 'waiting'}`,
          source.freshness ? `is-freshness-${source.freshness}` : '',
          source.isOverdue ? 'is-overdue' : '',
          source.degraded ? 'is-degraded' : ''
        ].filter(Boolean).join(' ');
        const link = createTextElement('a', classes);
        link.href = source.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        const healthTitle = formatSourceHealthTitle(source, refreshIntervalMs);
        link.title = healthTitle;
        link.setAttribute('aria-label', healthTitle);
        const dot = createTextElement('span', 'source-health-dot');
        dot.setAttribute('aria-hidden', 'true');
        link.append(dot, document.createTextNode(source.name));
        sourceHealth.append(link);
      });
    }

    function renderUpdates(updates, unseenIds = new Set()) {
      if (!updatesList) return;
      const displayUpdates = aggregateUpdatesForDisplay(updates, unseenIds, acknowledgedUpdateIds);
      const displayNewIds = new Set(displayUpdates.filter((update) => update.isNew).map((update) => update.id));
      const selection = selectUpdatesForDisplay(displayUpdates, displayNewIds, new Set(), updateView);
      const updateLimit = /^[1-9]\d*$/.test(updatesList.dataset.updateLimit || '')
        ? Number(updatesList.dataset.updateLimit)
        : null;
      const pageSize = /^[1-9]\d*$/.test(updatesList.dataset.updatePageSize || '')
        ? Number(updatesList.dataset.updatePageSize)
        : null;
      updatesPageCount = pageSize ? Math.max(1, Math.ceil(selection.updates.length / pageSize)) : 1;
      updatesPage = Math.min(updatesPage, updatesPageCount);
      const pageStart = pageSize ? (updatesPage - 1) * pageSize : 0;
      const renderedUpdates = pageSize
        ? selection.updates.slice(pageStart, pageStart + pageSize)
        : updateLimit ? selection.updates.slice(0, updateLimit) : selection.updates;
      if (previousPageButton) previousPageButton.disabled = updatesPage <= 1;
      if (nextPageButton) nextPageButton.disabled = updatesPage >= updatesPageCount;
      if (pageStatus) pageStatus.textContent = `第 ${updatesPage} / ${updatesPageCount} 页 · 共 ${selection.updates.length} 条`;
      const renderedNewIds = selection.newIds.filter((id) => renderedUpdates.some((update) => update.id === id));
      const listRenderKey = createUpdatesSnapshotKey({
        updateView,
        updates: renderedUpdates,
        newIds: renderedNewIds
      });
      if (listRenderKey === renderedUpdatesKey) return;
      renderedUpdatesKey = listRenderKey;
      updatesList.replaceChildren();

      if (!renderedUpdates.length) {
        const empty = createTextElement('li', 'official-update-empty');
        empty.append(
          createTextElement('strong', '', updateView === 'new' ? '暂时没有未读通知' : '暂未读到相关通知'),
          createTextElement('span', '', updateView === 'new'
            ? '全部标为已读后，新收录通知会从此处移除；可切换到“全部”查看完整列表。'
            : '这不等于学校没有公告；可稍后手动同步或前往官方信源页查看。')
        );
        updatesList.append(empty);
        return;
      }

      const selectedNewIds = new Set(renderedNewIds);
      renderedUpdates.forEach((update) => {
        const item = document.createElement('li');
        const link = createTextElement('a', 'official-update-link');
        link.href = update.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';

        const dateLabel = update.date.replace(/-/g, '.');
        const date = createTextElement('time', 'official-update-date', dateLabel);
        date.dateTime = update.date;
        date.setAttribute('aria-label', `发布日期：${update.date}`);
        const copy = createTextElement('div', 'official-update-copy');
        const meta = createTextElement('div', 'official-update-meta');
        meta.append(createTextElement('span', 'official-update-category', update.category));
        if (selectedNewIds.has(update.id)) meta.append(createTextElement('span', 'official-update-new', '新收录'));
        const admissionYears = [...new Set(update.title.match(/20\d{2}(?=\s*(?:年|级))/g) || [])];
        const previousCycle = admissionYears.length > 0 && admissionYears.every((year) => Number(year) < 2027);
        const cycleLabel = admissionYears.length
          ? `${admissionYears.join(' / ')} 招生${previousCycle ? ' · 往年参考' : ''}`
          : Number(update.date.slice(0, 4)) < 2026 ? '往年发布 · 招生年份未注明' : '招生年份未注明';
        meta.append(createTextElement('span', previousCycle ? 'official-update-history' : 'official-update-target', cycleLabel));
        if (update.isImportant) meta.append(createTextElement('span', 'official-update-important', '重要'));
        copy.append(
          meta,
          createTextElement('h3', '', update.title),
          createTextElement('p', '', update.source)
        );
        const arrow = createTextElement('span', 'official-update-arrow', '↗');
        arrow.setAttribute('aria-hidden', 'true');
        link.append(date, copy, arrow);
        item.append(link);
        updatesList.append(item);
      });
    }

    function renderSnapshot(rawPayload) {
      const payload = normalizeUpdatesPayload(rawPayload);
      const observedAt = payload.fetchedAt || payload.lastSuccessAt;
      unseenBaselineAt = getUnseenBaseline(unseenBaselineAt, observedAt);
      const unseenUpdates = getUnseenUpdates(payload.updates, unseenBaselineAt);
      const unseenIds = new Set(unseenUpdates.map((update) => update.id));
      const displayUpdates = aggregateUpdatesForDisplay(payload.updates, unseenIds, acknowledgedUpdateIds);
      const wasFirstRender = !hasRenderedSnapshot;
      latestPayload = payload;
      hasRenderedSnapshot = true;
      consoleElement.dataset.state = payload.status;
      consoleElement.dataset.freshness = payload.freshness.state;

      const successfulSources = payload.sources.filter((source) => source.ok).length;
      const overdueSourceIds = new Set(payload.freshness.overdueSourceIds);
      const overdueSourceNames = payload.sources
        .filter((source) => source.isOverdue || overdueSourceIds.has(source.id))
        .map((source) => source.name);
      const recoveredFromCacheBackup = /主缓存(?:缺失|损坏).*已从备份恢复/.test(payload.error || '');
      let title;
      let defaultDetail;
      if (recoveredFromCacheBackup) {
        [title, defaultDetail] = ['已从缓存备份恢复，等待验证', '已恢复最近一次可信缓存；正在等待下一次官方来源验证。'];
      } else if (overdueSourceNames.length) {
        const names = overdueSourceNames.join('、');
        [title, defaultDetail] = [`部分来源数据逾期 · ${names}`, `${names} 的数据已超过正常刷新窗口，其余来源仍可查看。`];
      } else if (payload.freshness.state === 'overdue') {
        [title, defaultDetail] = ['同步已逾期 · 后台正在重试', '最近成功数据仍可查看，请同时留意下方官方原文入口。'];
      } else if (payload.status === 'fresh') {
        [title, defaultDetail] = ['已连接 · 官方数据已同步', `${payload.sources.length} 条官方信息流运行正常。`];
      } else if (payload.status === 'seed') {
        [title, defaultDetail] = ['服务已启动 · 等待首次成功同步', '后台正在连接海南大学官方页面。'];
      } else if (successfulSources === 0) {
        [title, defaultDetail] = ['缓存保护中 · 官方来源暂不可用', '正在展示最近一次成功数据，请稍后重试。'];
      } else if (/缓存写入失败/.test(payload.error || '')) {
        [title, defaultDetail] = ['官方数据已读取 · 本地缓存写入失败', '当前页面可用，但重启服务后可能回到旧缓存。'];
      } else {
        [title, defaultDetail] = ['缓存保护中 · 部分来源未连接', '继续展示最近一次成功数据，请结合官方原文确认。'];
      }
      if (statusTitle) statusTitle.textContent = title;
      if (statusDetail) statusDetail.textContent = payload.error || defaultDetail;
      if (lastSuccess) lastSuccess.textContent = formatLiveDate(payload.lastSuccessAt);
      if (freshness) freshness.textContent = formatFreshness(payload.freshness, payload.refreshIntervalMs);
      if (nextRefresh) {
        const refreshInterval = formatRefreshInterval(payload.refreshIntervalMs);
        nextRefresh.textContent = payload.nextRefreshAt
          ? formatLiveDate(payload.nextRefreshAt)
          : refreshInterval === '按刷新周期' ? refreshInterval : `每 ${refreshInterval}`;
      }
      if (sourceCount) sourceCount.textContent = `${successfulSources} / ${payload.sources.length || 4} 正常`;
      if (newCount) {
        const unacknowledgedCount = displayUpdates.filter((update) => update.isNew).length;
        newCount.hidden = unacknowledgedCount === 0;
        newCount.textContent = unacknowledgedCount ? `${unacknowledgedCount} 条新收录` : '';
      }
      renderSources(payload.sources, payload.refreshIntervalMs);
      renderUpdates(payload.updates, unseenIds);
      if (wasFirstRender && payload.freshness.isOverdue && !requestInFlight) {
        window.setTimeout(() => loadUpdates(true), 500);
      }
    }

    function renderDisconnected(message) {
      if (hasRenderedSnapshot) {
        consoleElement.dataset.state = 'offline';
        if (statusTitle) statusTitle.textContent = '本次同步失败 · 显示最近数据';
        if (statusDetail) statusDetail.textContent = message;
        if (freshness) freshness.textContent = '连接中断 · 新鲜度未验证';
        if (sourceCount) sourceCount.textContent = '连接中断 · 待验证';
        if (nextRefresh) nextRefresh.textContent = '恢复连接后自动重试';
        return;
      }
      consoleElement.dataset.state = 'offline';
      if (statusTitle) statusTitle.textContent = '自动更新未连接';
      if (statusDetail) statusDetail.textContent = message;
      if (!hasRenderedSnapshot) {
        if (lastSuccess) lastSuccess.textContent = '—';
        if (freshness) freshness.textContent = '服务未连接';
        if (nextRefresh) nextRefresh.textContent = '启动服务后启用';
        if (sourceCount) sourceCount.textContent = '0 / 4 连接';
        if (newCount) newCount.hidden = true;
        if (sourceHealth) sourceHealth.replaceChildren();
        if (updatesList) {
          const empty = createTextElement('li', 'official-update-empty');
          empty.append(
            createTextElement('strong', '', '静态导航仍可正常使用'),
            createTextElement('span', '', '启动本地服务后，这里会显示自动获取的海南大学官方通知。')
          );
          updatesList.replaceChildren(empty);
        }
      }
    }

    function scheduleNextPoll() {
      if (pollTimer) window.clearTimeout(pollTimer);
      pollTimer = null;
      if (document.visibilityState === 'hidden') return;
      pollTimer = window.setTimeout(() => loadUpdates(false), 60 * 1000);
    }

    async function loadUpdates(manual = false) {
      if (requestInFlight || (!manual && document.visibilityState === 'hidden')) return;
      requestInFlight = true;
      const controller = new AbortController();
      activeRequestController = controller;
      const timeout = window.setTimeout(() => controller.abort(), 8_000);
      const showBusy = manual || !hasRenderedSnapshot;
      if (showBusy) {
        refreshButton.disabled = true;
        refreshButton.setAttribute('aria-busy', 'true');
        refreshButton.textContent = manual ? '正在同步…' : '正在连接…';
      }

      try {
        const response = await window.fetch(manual ? '/api/refresh' : '/api/updates', {
          method: manual ? 'POST' : 'GET',
          headers: {
            accept: 'application/json',
            ...(manual ? { 'x-hnu-guide-request': '1' } : {})
          },
          cache: 'no-store',
          signal: controller.signal
        });
        if (response.status === 429) {
          if (!hasRenderedSnapshot || consoleElement.dataset.state === 'offline') {
            consoleElement.dataset.state = hasRenderedSnapshot ? 'stale' : 'seed';
            if (statusTitle) statusTitle.textContent = '服务已连接 · 等待再次同步';
          }
          if (statusDetail) statusDetail.textContent = '同步请求过于频繁，请稍后再试；当前通知已保留。';
          return;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        renderSnapshot(await response.json());
      } catch {
        if (document.visibilityState !== 'hidden') {
          renderDisconnected(hasRenderedSnapshot
            ? '本次同步失败，已保留当前页面中的最近数据。'
            : '请运行 start-guide.cmd 或 npm start，再通过 http://127.0.0.1:4173 打开本页。');
        }
      } finally {
        window.clearTimeout(timeout);
        if (activeRequestController === controller) activeRequestController = null;
        requestInFlight = false;
        if (showBusy) {
          refreshButton.disabled = window.location.protocol === 'file:';
          refreshButton.removeAttribute('aria-busy');
          refreshButton.textContent = '立即同步';
        }
        if (resumePending && document.visibilityState !== 'hidden') {
          resumePending = false;
          loadUpdates(false);
          return;
        }
        scheduleNextPoll();
      }
    }

    refreshButton.addEventListener('click', () => loadUpdates(true));
    function renderCurrentUpdates() {
      if (!latestPayload) return;
      const unseenIds = new Set(getUnseenUpdates(latestPayload.updates, unseenBaselineAt).map((update) => update.id));
      renderUpdates(latestPayload.updates, unseenIds);
    }
    function changeUpdatesPage(offset) {
      if (!latestPayload) return;
      updatesPage = Math.max(1, Math.min(updatesPageCount, updatesPage + offset));
      renderCurrentUpdates();
      updatesList?.focus();
    }
    previousPageButton?.addEventListener('click', () => changeUpdatesPage(-1));
    nextPageButton?.addEventListener('click', () => changeUpdatesPage(1));
    updateFilterButtons.forEach((button) => {
      button.addEventListener('click', () => {
        updateView = button.dataset.updatesFilter === 'new' ? 'new' : 'all';
        updatesPage = 1;
        updateFilterButtons.forEach((candidate) => {
          candidate.setAttribute('aria-pressed', String(candidate === button));
        });
        renderCurrentUpdates();
      });
    });
    acknowledgeUpdatesButton?.addEventListener('click', () => {
      if (!latestPayload) return;
      const unseenUpdates = getUnseenUpdates(latestPayload.updates, unseenBaselineAt);
      unseenUpdates.forEach((update) => acknowledgedUpdateIds.add(update.id));
      const observedAt = latestPayload.fetchedAt || latestPayload.lastSuccessAt;
      if (observedAt) {
        try {
          window.localStorage.setItem(LAST_SEEN_UPDATES_KEY, observedAt);
        } catch {
          showSessionStorageWarning();
        }
      }
      renderedUpdatesKey = null;
      renderSnapshot(latestPayload);
    });

    if (window.location.protocol === 'file:') {
      renderDisconnected('当前是静态文件模式；运行 start-guide.cmd 后即可自动读取官网通知。');
      refreshButton.disabled = true;
      refreshButton.title = '请先启动本地 Node.js 服务';
      return;
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        if (pollTimer) window.clearTimeout(pollTimer);
        pollTimer = null;
        activeRequestController?.abort();
        return;
      }
      if (requestInFlight) {
        resumePending = true;
        return;
      }
      resumePending = false;
      loadUpdates(false);
    });
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('storage', (event) => {
        if (event.key === LAST_SEEN_UPDATES_KEY && latestPayload) {
          unseenBaselineAt = event.newValue || null;
          renderedUpdatesKey = null;
          renderSnapshot(latestPayload);
        }
      });
    }
    loadUpdates(false);
  }

  function initSiteNavigation() {
    const toggle = document.querySelector('[data-site-nav-toggle]');
    const menu = document.querySelector('[data-site-nav-menu]');
    if (!toggle || !menu) return;

    function setExpanded(expanded) {
      toggle.setAttribute('aria-expanded', String(expanded));
      menu.classList.toggle('is-open', expanded);
    }

    toggle.addEventListener('click', () => {
      setExpanded(toggle.getAttribute('aria-expanded') !== 'true');
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || toggle.getAttribute('aria-expanded') !== 'true') return;
      setExpanded(false);
      toggle.focus();
    });
  }

  function getLegacyPageDestination(pathname, hash) {
    const page = (pathname || '').split('/').pop().replace(/\.html$/, '');
    const destinations = {
      'programs#scores': 'scores.html#scores',
      'programs#exam': 'preparation.html#exam',
      'programs#risks': 'preparation.html#risks',
      'application#materials': 'materials.html#materials',
      'updates#sources': 'sources.html#sources'
    };
    return destinations[`${page}${hash}`] || null;
  }

  function initPage() {
    const legacyDestination = getLegacyPageDestination(window.location.pathname, window.location.hash);
    if (legacyDestination) {
      window.location.replace(legacyDestination);
      return;
    }
    initSiteNavigation();
    const todayString = getLocalDateString(new Date());
    const timelineElements = Array.from(document.querySelectorAll('[data-milestone-id]'));
    const state = getTimelineState(milestones, todayString);
    const activeMilestones = state.activeIds
      .map((id) => milestones.find((milestone) => milestone.id === id))
      .filter(Boolean);
    const nextMilestone = milestones.find((milestone) => milestone.id === state.nextId);

    timelineElements.forEach((element) => {
      const isActive = state.activeIds.includes(element.dataset.milestoneId);
      element.classList.toggle('is-current', isActive);
      if (isActive) element.setAttribute('aria-current', 'step');
      else element.removeAttribute('aria-current');
    });

    const stageName = document.querySelector('#current-stage-name');
    const stageDetail = document.querySelector('#current-stage-detail');
    const nextName = document.querySelector('#next-stage-name');
    const nextDays = document.querySelector('#next-stage-days');

    if (stageName) stageName.textContent = activeMilestones.map((milestone) => milestone.label).join(' / ') || '等待下一节点';
    if (stageDetail) {
      stageDetail.textContent = activeMilestones.length
        ? activeMilestones.map((milestone) => milestone.action || '按时间轴完成当前行动').join('；')
        : '查看时间轴确认最近的官方节点';
    }
    if (nextName) nextName.textContent = nextMilestone?.label || '本周期已无后续节点';
    if (nextDays) {
      nextDays.textContent = Number.isFinite(state.daysToNext)
        ? `${state.daysToNext} 天`
        : '—';
    }

    const checkboxes = Array.from(document.querySelectorAll('.task-check[data-check-id]'));
    let progressStorage = null;
    try {
      progressStorage = window.localStorage;
      progressStorage.getItem(STORAGE_KEY);
    } catch {
      // Some restricted or file origins block access at the property getter.
      progressStorage = null;
      showSessionStorageWarning();
    }
    let checklistState = safeReadChecks(progressStorage, STORAGE_KEY, CHECKLIST_IDS);
    checkboxes.forEach((checkbox) => {
      checkbox.checked = checklistState[checkbox.dataset.checkId] === true;
    });

    function renderProgress() {
      const { completed, total, percent } = countChecklistProgress(checklistState);
      const bar = document.querySelector('#progress-bar');
      const text = document.querySelector('#progress-text');
      const count = document.querySelector('#progress-count');

      if (bar) {
        bar.style.width = `${percent}%`;
        bar.parentElement?.setAttribute('aria-valuenow', String(percent));
      }
      if (text) text.textContent = `${percent}%`;
      if (count) count.textContent = `${completed} / ${total} 项`;
      checkboxes.forEach((checkbox) => {
        checkbox.closest('label')?.setAttribute('data-print-state', checkbox.checked ? '已完成' : '未完成');
      });
    }

    function persistChecks(pageValues = Object.fromEntries(
        checkboxes.map((checkbox) => [checkbox.dataset.checkId, checkbox.checked])
      )) {
      if (!progressStorage) {
        checklistState = mergeChecklistState(checklistState, pageValues);
      } else {
        try {
          progressStorage.getItem(STORAGE_KEY);
          checklistState = mergeChecklistState(
            safeReadChecks(progressStorage, STORAGE_KEY, CHECKLIST_IDS),
            pageValues
          );
          progressStorage.setItem(STORAGE_KEY, JSON.stringify(checklistState));
        } catch {
          checklistState = mergeChecklistState(checklistState, pageValues);
          progressStorage = null;
          // Storage may be disabled in private or hardened browser modes.
          showSessionStorageWarning();
        }
      }
      renderProgress();
    }

    checkboxes.forEach((checkbox) => checkbox.addEventListener('change', () => persistChecks()));
    renderProgress();

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('storage', (event) => {
        if (event.key === STORAGE_KEY && progressStorage) {
          checklistState = safeReadChecks(progressStorage, STORAGE_KEY, CHECKLIST_IDS);
          checkboxes.forEach((checkbox) => {
            checkbox.checked = checklistState[checkbox.dataset.checkId] === true;
          });
          renderProgress();
        }
      });
    }

    const resetButton = document.querySelector('#reset-progress');
    resetButton?.addEventListener('click', () => {
      const resetAll = resetButton.dataset.resetScope === 'all';
      const confirmation = resetAll
        ? '确定清空全部 21 项已勾选进度吗？此操作无法撤销。'
        : '确定清空本页所有已勾选进度吗？此操作无法撤销。';
      if (!window.confirm(confirmation)) return;
      checkboxes.forEach((checkbox) => { checkbox.checked = false; });
      if (resetAll) {
        persistChecks(Object.fromEntries(CHECKLIST_IDS.map((id) => [id, false])));
        return;
      }
      persistChecks();
    });

    const filterButtons = Array.from(document.querySelectorAll('[data-filter]'));
    const categoryItems = timelineElements.map((element) => ({
      id: element.dataset.milestoneId,
      category: element.dataset.category,
      element
    }));

    filterButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const category = button.dataset.filter;
        const visibleIds = new Set(filterTimeline(categoryItems, category).map((item) => item.id));
        let lastVisible = null;
        categoryItems.forEach((item) => {
          const visible = visibleIds.has(item.id);
          item.element.hidden = !visible;
          item.element.classList.remove('is-last-visible');
          if (visible) lastVisible = item.element;
        });
        if (lastVisible) lastVisible.classList.add('is-last-visible');
        filterButtons.forEach((candidate) => {
          candidate.setAttribute('aria-pressed', String(candidate === button));
        });
      });
    });

    document.querySelectorAll('[data-print]').forEach((button) => {
      button.addEventListener('click', () => window.print());
    });

    const navLinks = Array.from(document.querySelectorAll('.section-nav a[href^="#"], .page-toc a[href^="#"]'));
    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          navLinks.forEach((link) => {
            const active = link.getAttribute('href') === `#${entry.target.id}`;
            link.classList.toggle('is-active', active);
            if (active) link.setAttribute('aria-current', 'location');
            else link.removeAttribute('aria-current');
          });
        });
      }, { rootMargin: '-20% 0px -68% 0px' });
      document.querySelectorAll('main section[id]').forEach((section) => observer.observe(section));
    }

    initOfficialUpdates();
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      calculateProgress,
      countChecklistProgress,
      mergeChecklistState,
      aggregateUpdatesForDisplay,
      filterTimeline,
      formatFreshness,
      formatRefreshInterval,
      formatSourceHealthTitle,
      createUpdatesSnapshotKey,
      getTimelineState,
      getLegacyPageDestination,
      getUnseenBaseline,
      getUnseenUpdates,
      isSafeOfficialUpdateUrl,
      normalizeUpdatesPayload,
      safeReadChecks,
      selectUpdatesForDisplay
    };
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initPage, { once: true });
    } else {
      initPage();
    }
  }
})();
