(function () {
  'use strict';

  const core = typeof module !== 'undefined' && module.exports ? require('./guide-core.js') : window.HnuGuideCore;
  const {
    DAY_MS,
    BEIJING_OFFSET_MS,
    CHECKLIST_IDS,
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
    formatSourceHealthTitle
  } = core;

  const STORAGE_KEY = 'hainanu-2027-kaoyan-progress-v1';
  const LAST_SEEN_UPDATES_KEY = 'hainanu-2027-kaoyan-last-seen-v1';
  const kCardExitAnimationFallbackMs = 200;
  // The exit duration is authored in CSS so the keyframe and the close timer stay in sync.
  function readCardExitAnimationMs() {
    if (typeof document === 'undefined' || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
      return kCardExitAnimationFallbackMs;
    }
    const raw = window.getComputedStyle(document.documentElement).getPropertyValue('--dialog-exit-ms').trim();
    const match = raw.match(/^(-?\d*\.?\d+)(ms|s)?$/);
    if (!match) return kCardExitAnimationFallbackMs;
    const value = parseFloat(match[1]);
    if (!Number.isFinite(value)) return kCardExitAnimationFallbackMs;
    return match[2] === 's' ? value * 1000 : value;
  }
  let sessionChecklistState = {};
  let sessionProgressOnly = false;
  function showSessionStorageWarning(root = document) {
    const warning = root.querySelector('#storage-session-warning');
    if (warning) warning.hidden = false;
  }

  function createTextElement(tagName, className, content) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (content !== undefined) element.textContent = content;
    return element;
  }

  function enhanceNoticeSelects(selects, scope = document) {
    const widgets = [];
    selects.filter((select) => select?.options?.length).forEach((select) => {
      const options = Array.from(select.options);
      const label = scope.querySelector(`label[for="${select.id}"]`);
      const root = createTextElement('div', 'filter-select');
      const trigger = createTextElement('button', 'filter-select-trigger');
      trigger.type = 'button';
      trigger.id = `${select.id}-trigger`;
      trigger.setAttribute('role', 'combobox');
      trigger.setAttribute('aria-haspopup', 'listbox');
      trigger.setAttribute('aria-expanded', 'false');
      const value = createTextElement('span', 'filter-select-value');
      value.id = `${select.id}-value`;
      const arrow = createTextElement('span', 'filter-select-arrow');
      arrow.setAttribute('aria-hidden', 'true');
      trigger.append(value, arrow);
      const menu = createTextElement('div', 'filter-select-menu');
      menu.id = `${select.id}-listbox`;
      menu.setAttribute('role', 'listbox');
      menu.setAttribute('aria-hidden', 'true');
      trigger.setAttribute('aria-controls', menu.id);
      if (label) {
        label.id ||= `${select.id}-label`;
        label.htmlFor = trigger.id;
        trigger.setAttribute('aria-labelledby', `${label.id} ${value.id}`);
        menu.setAttribute('aria-labelledby', label.id);
      }
      root.append(trigger);
      select.after(root);
      (scope === document ? document.body : scope).append(menu);
      select.hidden = true;
      let open = false;
      let activeIndex = Math.max(0, select.selectedIndex);
      let search = '';
      let lastKeyAt = 0;

      const rows = options.map((option, index) => {
        const row = createTextElement('div', 'filter-select-option');
        row.id = `${select.id}-option-${index}`;
        row.setAttribute('role', 'option');
        const check = createTextElement('span', 'filter-select-check', '✓');
        check.setAttribute('aria-hidden', 'true');
        row.append(createTextElement('span', '', option.textContent), check);
        row.addEventListener('pointerdown', (event) => event.preventDefault());
        row.addEventListener('click', () => { activeIndex = index; commit(); trigger.focus(); });
        row.addEventListener('pointermove', () => { activeIndex = index; renderActive(); });
        menu.append(row);
        return row;
      });

      function renderActive() {
        rows.forEach((row, index) => { row.dataset.active = String(index === activeIndex); });
        if (open) trigger.setAttribute('aria-activedescendant', rows[activeIndex].id);
      }
      function sync() {
        value.textContent = options[select.selectedIndex]?.textContent || '';
        activeIndex = Math.max(0, select.selectedIndex);
        rows.forEach((row, index) => row.setAttribute('aria-selected', String(index === select.selectedIndex)));
        renderActive();
      }
      let frame = 0;
      function close() {
        open = false;
        if (frame && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frame);
        frame = 0;
        root.dataset.open = menu.dataset.open = 'false';
        trigger.setAttribute('aria-expanded', 'false');
        trigger.removeAttribute('aria-activedescendant');
        menu.setAttribute('aria-hidden', 'true');
        search = '';
      }
      function revealActive() {
        const row = rows[activeIndex];
        if (row.offsetTop < menu.scrollTop) menu.scrollTop = row.offsetTop;
        else if (row.offsetTop + row.offsetHeight > menu.scrollTop + menu.clientHeight) {
          menu.scrollTop = row.offsetTop + row.offsetHeight - menu.clientHeight;
        }
      }
      function positionMenu() {
        const rect = trigger.getBoundingClientRect();
        const desired = Math.min(options.length * 44 + 16, 296);
        const below = window.innerHeight - rect.bottom - 16;
        const above = rect.top - 16;
        const upward = below < desired && above > below;
        const width = Math.min(rect.width, window.innerWidth - 24);
        const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
        const maxHeight = Math.min(desired, Math.max(0, upward ? above : below));
        const dialog = scope !== document ? scope.closest('dialog') : null;
        const transformed = Boolean(dialog && typeof window.getComputedStyle === 'function' && window.getComputedStyle(dialog).transform !== 'none');
        const dialogRect = transformed ? dialog.getBoundingClientRect() : null;
        const scaleX = transformed && dialog.offsetWidth ? dialogRect.width / dialog.offsetWidth : 1;
        const scaleY = transformed && dialog.offsetHeight ? dialogRect.height / dialog.offsetHeight : 1;
        const originX = transformed ? dialogRect.left + (dialog.clientLeft || 0) * scaleX : 0;
        const originY = transformed ? dialogRect.top + (dialog.clientTop || 0) * scaleY : 0;
        menu.style.width = `${width / scaleX}px`;
        menu.style.left = `${(left - originX) / scaleX}px`;
        menu.style.maxHeight = `${maxHeight / scaleY}px`;
        const top = upward ? rect.top - menu.offsetHeight * scaleY - 8 : rect.bottom + 8;
        menu.style.top = `${(top - originY) / scaleY}px`;
        menu.dataset.direction = upward ? 'up' : 'down';
        return transformed;
      }
      function reposition() {
        if (!open) return false;
        const rect = trigger.getBoundingClientRect();
        const scrollBox = scope !== document ? scope.closest('.guide-dialog-body') : null;
        const bounds = scrollBox ? scrollBox.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
        if (rect.bottom <= Math.max(0, bounds.top) || rect.top >= Math.min(window.innerHeight, bounds.bottom)) {
          close();
          return false;
        }
        return positionMenu();
      }
      function trackTransform() {
        frame = 0;
        if (reposition() && typeof window.requestAnimationFrame === 'function') {
          frame = window.requestAnimationFrame(trackTransform);
        }
      }
      function expand() {
        widgets.forEach((widget) => widget.close());
        sync();
        const transformed = positionMenu();
        open = true;
        root.dataset.open = menu.dataset.open = 'true';
        trigger.setAttribute('aria-expanded', 'true');
        menu.setAttribute('aria-hidden', 'false');
        renderActive();
        revealActive();
        if (transformed && !frame && typeof window.requestAnimationFrame === 'function') {
          frame = window.requestAnimationFrame(trackTransform);
        }
      }
      function commit() {
        const changed = select.value !== options[activeIndex].value;
        select.value = options[activeIndex].value;
        sync();
        close();
        if (changed) select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      trigger.addEventListener('click', () => open ? close() : expand());
      trigger.addEventListener('keydown', (event) => {
        if (event.key === 'Tab') { if (open) commit(); return; }
        if (event.key === 'Escape') { if (open) { event.preventDefault(); event.stopPropagation(); close(); } return; }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (open) commit(); else expand();
          return;
        }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const wasOpen = open;
          if (!open) expand();
          if (event.key === 'Home') activeIndex = 0;
          else if (event.key === 'End') activeIndex = options.length - 1;
          else if (wasOpen) activeIndex = Math.max(0, Math.min(options.length - 1, activeIndex + (event.key === 'ArrowDown' ? 1 : -1)));
          renderActive();
          revealActive();
        } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing) {
          event.preventDefault();
          if (!open) expand();
          const now = Date.now();
          search = (now - lastKeyAt < 600 ? search : '') + event.key.toLocaleLowerCase();
          lastKeyAt = now;
          const match = options.findIndex((option) => option.textContent.trim().toLocaleLowerCase().startsWith(search));
          if (match >= 0) { activeIndex = match; renderActive(); revealActive(); }
        }
      });
      select.addEventListener('change', sync);
      widgets.push({ root, menu, close, reposition });
      sync();
    });
    if (!widgets.length) return;
    const dismissOutside = (event) => widgets.forEach((widget) => {
      if (!widget.root.contains(event.target) && !widget.menu.contains(event.target)) widget.close();
    });
    document.addEventListener('pointerdown', dismissOutside);
    document.addEventListener('focusin', dismissOutside);
    document.addEventListener('guide-panel-change', () => widgets.forEach((widget) => widget.close()));
    window.addEventListener('resize', () => widgets.forEach((widget) => widget.close()));
    document.addEventListener('scroll', (event) => {
      if (!widgets.some((widget) => widget.menu.contains(event.target))) widgets.forEach((widget) => widget.reposition());
    }, true);
    // A card's entrance transform temporarily changes the fixed menus' coordinate space.
    document.addEventListener('animationend', (event) => {
      if (scope !== document && event.target.contains(scope)) widgets.forEach((widget) => widget.reposition());
    });
  }

  function initOfficialUpdates(root = document) {
    const isInactive = () => {
      if (document.visibilityState === 'hidden') return true;
      if (root === document) return false;
      const dialog = root.closest('dialog');
      return !root.isConnected || !dialog?.open || dialog.classList.contains('guide-closing');
    };
    const isCloud = document.body?.dataset?.hosting === 'vercel';
    const consoleElement = root.querySelector('#live-updates-console');
    const refreshButton = root.querySelector('#refresh-official-updates');
    if (!consoleElement || !refreshButton) return;

    const statusTitle = root.querySelector('#live-status-title');
    const statusDetail = root.querySelector('#live-status-detail');
    const lastSuccess = root.querySelector('#live-last-success');
    const freshness = root.querySelector('#live-freshness');
    const nextRefresh = root.querySelector('#live-next-refresh');
    const sourceCount = root.querySelector('#live-source-count');
    const newCount = root.querySelector('#live-new-count');
    const sourceHealth = root.querySelector('#live-source-health');
    const updatesList = root.querySelector('#official-updates-list');
    const previousPageButton = root.querySelector('#updates-previous');
    const nextPageButton = root.querySelector('#updates-next');
    const pageStatus = root.querySelector('#updates-page-status');
    let updatesPage = 1;
    let updatesPageCount = 1;
    const updateFilterButtons = Array.from(root.querySelectorAll('[data-updates-filter]'));
    const yearFilter = root.querySelector('#updates-year');
    const categoryFilter = root.querySelector('#updates-category');
    const noticeFilters = root.querySelector('.notice-filters');
    if (noticeFilters) noticeFilters.hidden = false;
    enhanceNoticeSelects([yearFilter, categoryFilter], root);
    const acknowledgeUpdatesButton = root.querySelector('#acknowledge-official-updates');
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
    function syncUnseenBaseline(observedAt = null, acknowledge = false) {
      let storage = null;
      let storedAt = null;
      const advance = (candidate) => {
        if (typeof candidate === 'string' && Number.isFinite(Date.parse(candidate)) &&
            (!unseenBaselineAt || Date.parse(candidate) > Date.parse(unseenBaselineAt))) {
          unseenBaselineAt = candidate;
        }
      };
      try {
        storage = window.localStorage;
        storedAt = getUnseenBaseline(storage.getItem(LAST_SEEN_UPDATES_KEY), null);
        advance(storedAt);
      } catch {
        storage = null;
        showSessionStorageWarning(root);
      }
      // Polling preserves the baseline; only an explicit acknowledgement advances it.
      if (!unseenBaselineAt || acknowledge) advance(observedAt);
      if (storage && unseenBaselineAt && (!storedAt || acknowledge) && storedAt !== unseenBaselineAt) {
        try {
          storage.setItem(LAST_SEEN_UPDATES_KEY, unseenBaselineAt);
        } catch {
          showSessionStorageWarning(root);
        }
      }
    }
    syncUnseenBaseline();

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

    function renderUpdates(displayUpdates) {
      if (!updatesList) return;
      const displayNewIds = new Set(displayUpdates.filter((update) => update.isNew).map((update) => update.id));
      const filters = { year: yearFilter?.value || 'all', category: categoryFilter?.value || 'all' };
      const selection = selectUpdatesForDisplay(displayUpdates, displayNewIds, new Set(), updateView, filters);
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
        filters,
        updates: renderedUpdates,
        newIds: renderedNewIds
      });
      if (listRenderKey === renderedUpdatesKey) return;
      renderedUpdatesKey = listRenderKey;
      updatesList.replaceChildren();

      if (!renderedUpdates.length) {
        const empty = createTextElement('li', 'official-update-empty');
        empty.append(
          createTextElement('strong', '', filters.year !== 'all' || filters.category !== 'all' ? '没有符合筛选条件的通知' : updateView === 'new' ? '暂时没有未读通知' : '暂未读到相关通知'),
          createTextElement('span', '', filters.year !== 'all' || filters.category !== 'all'
            ? '可选择“全部年份”和“全部类别”，或切换到“全部”查看其他通知。'
            : updateView === 'new'
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
      syncUnseenBaseline(observedAt);
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
        nextRefresh.textContent = isCloud ? '访问时检查 · 可手动同步' : payload.nextRefreshAt
          ? formatLiveDate(payload.nextRefreshAt)
          : refreshInterval === '按刷新周期' ? refreshInterval : `每 ${refreshInterval}`;
      }
      if (sourceCount) sourceCount.textContent = `${successfulSources} / ${payload.sources.length || 4} 正常`;
      renderSources(payload.sources, payload.refreshIntervalMs);
      renderCurrentUpdates();
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
      if (lastSuccess) lastSuccess.textContent = '—';
      if (freshness) freshness.textContent = '服务未连接';
      if (nextRefresh) nextRefresh.textContent = isCloud ? '连接恢复后启用' : '启动服务后启用';
      if (sourceCount) sourceCount.textContent = '0 / 4 连接';
      if (newCount) newCount.hidden = true;
      if (sourceHealth) sourceHealth.replaceChildren();
      if (updatesList) {
        const empty = createTextElement('li', 'official-update-empty');
        empty.append(
          createTextElement('strong', '', '静态导航仍可正常使用'),
          createTextElement('span', '', isCloud ? '在线通知服务暂不可用，请稍后重试或进入官方信源页查看原文。' : '启动本地服务后，这里会显示自动获取的海南大学官方通知。')
        );
        updatesList.replaceChildren(empty);
      }
    }

    function scheduleNextPoll() {
      if (pollTimer) window.clearTimeout(pollTimer);
      pollTimer = null;
      if (isInactive()) return;
      pollTimer = window.setTimeout(() => loadUpdates(false), 60 * 1000);
    }

    async function loadUpdates(manual = false) {
      if (requestInFlight || (!manual && isInactive())) return;
      requestInFlight = true;
      const controller = new AbortController();
      activeRequestController = controller;
      // Local sync can use two 12s attempts plus up to 10s of Retry-After.
      // Snapshot reads stay short; cloud attempts have a smaller server budget.
      const timeoutMs = isCloud ? 30_000 : manual ? 40_000 : 8_000;
      const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
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
        if (!isInactive()) {
          renderDisconnected(hasRenderedSnapshot
            ? '本次同步失败，已保留当前页面中的最近数据。'
            : isCloud ? '在线通知服务暂未响应，请稍后重试；各导航页面仍可使用。'
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
        if (resumePending && !isInactive()) {
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
      const displayUpdates = aggregateUpdatesForDisplay(latestPayload.updates, unseenIds, acknowledgedUpdateIds);
      if (newCount) {
        const unacknowledgedCount = displayUpdates.filter((update) => update.isNew).length;
        newCount.hidden = unacknowledgedCount === 0;
        newCount.textContent = unacknowledgedCount ? `${unacknowledgedCount} 条新收录` : '';
      }
      // Local read-state changes must not overwrite the latest connection status.
      renderUpdates(displayUpdates);
    }
    function changeUpdatesPage(offset) {
      if (!latestPayload) return;
      updatesPage = Math.max(1, Math.min(updatesPageCount, updatesPage + offset));
      renderCurrentUpdates();
      updatesList?.focus();
    }
    previousPageButton?.addEventListener('click', () => changeUpdatesPage(-1));
    nextPageButton?.addEventListener('click', () => changeUpdatesPage(1));
    [yearFilter, categoryFilter].forEach((select) => select?.addEventListener('change', () => {
      updatesPage = 1;
      renderCurrentUpdates();
    }));
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
      syncUnseenBaseline(observedAt, true);
      renderedUpdatesKey = null;
      renderCurrentUpdates();
    });

    if (window.location.protocol === 'file:') {
      renderDisconnected('当前是静态文件模式；运行 start-guide.cmd 后即可自动读取官网通知。');
      refreshButton.disabled = true;
      refreshButton.title = '请先启动本地 Node.js 服务';
      return;
    }

    document.addEventListener('visibilitychange', () => {
      if (isInactive()) {
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
        if (event.key === LAST_SEEN_UPDATES_KEY) {
          try {
            if (event.storageArea !== window.localStorage) return;
          } catch {
            showSessionStorageWarning(root);
            return;
          }
          // Read current storage: a queued event may describe an older write.
          syncUnseenBaseline();
          renderCurrentUpdates();
        }
      });
    }
    document.addEventListener('guide-panel-change', () => {
      if (isInactive()) {
        if (pollTimer) window.clearTimeout(pollTimer);
        pollTimer = null;
        activeRequestController?.abort();
      } else if (requestInFlight) resumePending = true;
      else loadUpdates(false);
    });
    loadUpdates(false);
  }

  function initHomeReadingOrder() {
    const shell = document.querySelector('body[data-page="home"] .hero-shell');
    const copy = shell?.querySelector('.hero-copy');
    const panel = shell?.querySelector('.status-panel');
    const narrow = window.matchMedia?.('(max-width: 640px)');
    if (!copy || !panel || !narrow) return;

    function syncOrder() {
      const first = narrow.matches ? panel : copy;
      const second = narrow.matches ? copy : panel;
      if (first.nextElementSibling === second) return;
      // Move the unfocused group so resizing never detaches the active control.
      if (first.contains(document.activeElement)) shell.insertBefore(second, first.nextSibling);
      else shell.insertBefore(first, second);
    }
    syncOrder();
    narrow.addEventListener('change', syncOrder);
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

  // Keep content changes immediate while the surrounding layout catches up.
  function createContentTransition(container) {
    let animation = null;
    let targetHeight = 0;
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    // CSS pixels exclude the dialog's entrance scale, unlike a bounding rect.
    const height = () => container.getClientRects().length ? parseFloat(window.getComputedStyle(container).height) || 0 : 0;
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
      if (!animation) return;
      const before = height();
      // Read the new natural height without resetting the animation's clock.
      // Nested steps and expanded notes can change it during a tab transition.
      const effect = animation.effect;
      const frames = effect.getKeyframes();
      effect.setKeyframes([]);
      const after = height();
      effect.setKeyframes(frames);
      if (Math.abs(after - targetHeight) >= 1) resize(before, after);
    }) : null;
    function resize(before, after) {
      if (animation) { animation.onfinish = null; animation.cancel(); }
      targetHeight = after;
      animation = container.animate([{ height: `${before}px` }, { height: `${after}px` }], {
        duration: 240, easing: 'cubic-bezier(.2, 0, 0, 1)'
      });
      container.classList.add('content-resizing');
      animation.onfinish = finish;
    }
    function finish() {
      const previous = animation;
      animation = null;
      observer?.disconnect();
      if (previous) { previous.onfinish = null; previous.cancel(); }
      container.classList.remove('content-resizing');
    }
    window.addEventListener('beforeprint', finish);
    window.addEventListener('resize', finish);
    reducedMotion?.addEventListener?.('change', finish);
    document.addEventListener('guide-panel-change', () => { if (!container.isConnected) finish(); });
    return (update, direction = 1, enabled = true) => {
      // Measure before cancelling so an interrupted transition never snaps back.
      const before = height();
      finish();
      container.dataset.motionDirection = direction < 0 ? 'backward' : 'forward';
      update();
      if (!enabled || !container.animate || reducedMotion?.matches ||
          window.matchMedia?.('print').matches || !container.isConnected || before === 0) return;
      const after = height();
      if (after === 0 || Math.abs(after - before) < 1) return;
      resize(before, after);
      Array.from(container.children).forEach(child => observer?.observe(child));
    };
  }

  // Group existing source content, so the full-page and card views stay in sync.
  function initReadingGroups(root, page) {
    const configurations = {
      programs: [
        ['学硕 · 081200', '.program-card:nth-child(1)'],
        ['计技 · 085404', '.program-card:nth-child(2)'],
        ['软工 · 085405', '.program-card:nth-child(3)'],
        ['目录说明', '.data-note, .baseline-note']
      ],
      scores: [
        ['分数概览', '.score-overview, .baseline-note, .score-section > .score-table-wrap'],
        ['分数分布', '.score-distributions'],
        ['专项与复试', '.score-details'],
        ['统计说明', '.score-method, .score-sources']
      ],
      preparation: [
        ['408 初试', '.exam-card-dark'], ['复试参考', '.exam-card:not(.exam-card-dark)'],
        ['备考节奏', '.prep-calendar'], ['风险提醒', '#risks']
      ],
      application: [
        ['报名前须知', '.critical-difference, #apply-guide > .baseline-note'],
        ['八步填报', '.apply-steps'], ['审核期限', '#review-deadlines']
      ],
      materials: [
        ['八项材料', '.checklist-grid'], ['材料期限', '.review-deadlines'],
        ['报考资格', 'details.special-note']
      ],
      sources: [['官方入口', '.source-list'], ['咨询电话', '.contact-card']]
    };
    const configuration = configurations[page];
    const groups = configuration?.map(([label, selector]) => ({ label, nodes: Array.from(root.querySelectorAll(selector)) }))
      .filter(group => group.nodes.length) || [];
    groups.forEach(group => {
      group.sectionIds = new Set(group.nodes.map(node => node.closest('section')?.id).filter(Boolean));
    });
    let activate = null;
    if (groups.length > 1) {
      const tabs = createTextElement('div', 'reading-tabs');
      tabs.setAttribute('role', 'tablist');
      tabs.setAttribute('aria-label', '选择查看内容');
      const panes = createTextElement('div', 'reading-panes');
      const unique = `reading-${page}-${root.classList.contains('guide-panel') ? 'card' : 'page'}`;
      const buttons = groups.map((group, index) => {
        const button = createTextElement('button', '', group.label);
        button.type = 'button';
        button.id = `${unique}-tab-${index}`;
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-controls', `${unique}-pane-${index}`);
        const pane = createTextElement('div', 'reading-pane');
        pane.id = `${unique}-pane-${index}`;
        pane.setAttribute('role', 'tabpanel');
        pane.setAttribute('aria-labelledby', button.id);
        pane.tabIndex = 0;
        group.nodes.forEach(node => pane.append(node));
        // A tab already supplies the reveal control for these short notes.
        pane.querySelectorAll('details.special-note, details.score-details').forEach(node => { node.open = true; });
        group.pane = pane;
        tabs.append(button);
        panes.append(pane);
        return button;
      });
      const transition = createContentTransition(panes);
      let currentIndex = -1;
      activate = (index, focus = false) => {
        if (index !== currentIndex) {
          transition(() => {
            groups.forEach((group, i) => {
              group.pane.hidden = i !== index;
              buttons[i].setAttribute('aria-selected', String(i === index));
              buttons[i].tabIndex = i === index ? 0 : -1;
            });
          }, index - currentIndex, currentIndex >= 0);
          currentIndex = index;
        }
        if (focus) buttons[index].focus({ preventScroll: true });
      };
      buttons.forEach((button, index) => {
        button.addEventListener('click', () => activate(index));
        button.addEventListener('keydown', event => {
          const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
          if (!offset && event.key !== 'Home' && event.key !== 'End') return;
          event.preventDefault();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + offset + buttons.length) % buttons.length;
          activate(next, true);
        });
      });
      root.append(tabs, panes);
      activate(0);
      root.classList.add('reading-grouped');
    }
    root.querySelectorAll('.section-heading > p').forEach(description => {
      const note = createTextElement('details', 'reading-context');
      note.append(createTextElement('summary', '', '阅读说明与核对依据'));
      description.before(note);
      note.append(description);
    });
    initTimelineCards(root);
    initApplicationSteps(root);
    root.guideReveal = hash => {
      if (!hash) { root.resetTimeline?.(); return; }
      let id;
      try { id = decodeURIComponent(hash.replace(/^#/, '')); } catch { return; }
      const target = Array.from(root.querySelectorAll('[id]')).find(node => node.id === id);
      if (!target) return;
      let index = groups.findIndex(group => group.pane.contains(target));
      if (index < 0 && target.tagName === 'SECTION') index = groups.findIndex(group => group.sectionIds.has(id));
      if (index >= 0) activate(index);
      if (id === 'timeline') root.resetTimeline?.();
      for (let node = target.parentElement; node && node !== root; node = node.parentElement) {
        if (node.tagName === 'DETAILS') node.open = true;
      }
    };
  }

  function initTimelineCards(root) {
    const list = root.querySelector('.timeline-list');
    if (!list) return;
    const transition = createContentTransition(list.parentElement);
    list.classList.add('timeline-compact');
    const toolbar = root.querySelector('.timeline-toolbar');
    const detail = createTextElement('div', 'timeline-detail');
    detail.hidden = true;
    const back = createTextElement('button', 'text-button', '← 返回节点');
    back.type = 'button';
    back.dataset.timelineBack = '';
    const content = createTextElement('div', 'timeline-detail-content');
    detail.append(back, content);
    list.after(detail);
    let selected = null;
    let printState = null;
    root.resetTimeline = () => {
      if (!selected) return;
      selected.item.append(selected.body);
      detail.hidden = true;
      list.hidden = false;
      if (toolbar) toolbar.hidden = false;
      selected = null;
    };
    window.addEventListener('beforeprint', () => {
      if (printState || !root.isConnected) return;
      printState = { hidden: Array.from(list.children).filter(item => item.hidden) };
      printState.hidden.forEach(item => { item.hidden = false; });
      if (selected) {
        selected.item.append(selected.body);
        list.hidden = false;
        detail.hidden = true;
      }
    });
    window.addEventListener('afterprint', () => {
      if (!printState) return;
      printState.hidden.forEach(item => { item.hidden = true; });
      if (selected) {
        content.replaceChildren(selected.item.querySelector('.timeline-date').cloneNode(true), selected.body);
        list.hidden = true;
        detail.hidden = false;
      }
      printState = null;
    });
    back.addEventListener('click', () => {
      if (!selected) return;
      transition(() => {
        selected.item.append(selected.body);
        detail.hidden = true;
        list.hidden = false;
        if (toolbar) toolbar.hidden = false;
      }, -1);
      selected.button.focus({ preventScroll: true });
      selected = null;
    });
    list.querySelectorAll('.timeline-item').forEach(item => {
      const body = item.querySelector('.timeline-body');
      const button = createTextElement('button', 'timeline-launch');
      button.type = 'button';
      button.append(createTextElement('strong', '', item.dataset.label || body.querySelector('h3').textContent),
        createTextElement('span', '', '查看任务 ↗'));
      item.append(button);
      button.addEventListener('click', () => {
        selected = { item, body, button };
        transition(() => {
          content.replaceChildren(item.querySelector('.timeline-date').cloneNode(true), body);
          list.hidden = true;
          if (toolbar) toolbar.hidden = true;
          detail.hidden = false;
        });
        back.focus({ preventScroll: true });
      });
    });
  }

  function initApplicationSteps(root) {
    const list = root.querySelector('.apply-steps');
    if (!list) return;
    const transition = createContentTransition(list);
    const steps = Array.from(list.children);
    const picker = createTextElement('div', 'step-picker');
    picker.setAttribute('role', 'group');
    picker.setAttribute('aria-label', '选择填报步骤');
    const controls = createTextElement('div', 'step-controls');
    const previous = createTextElement('button', 'button button-outline', '← 上一步');
    const next = createTextElement('button', 'button button-outline', '下一步 →');
    const status = createTextElement('span');
    status.setAttribute('aria-live', 'polite');
    previous.type = next.type = 'button';
    controls.append(previous, status, next);
    let current = -1;
    const buttons = steps.map((step, index) => {
      const button = createTextElement('button', '', String(index + 1).padStart(2, '0'));
      button.type = 'button';
      button.setAttribute('aria-label', `第 ${index + 1} 步：${step.querySelector('h3').textContent}`);
      button.addEventListener('click', () => select(index));
      picker.append(button);
      return button;
    });
    function select(index) {
      if (index === current) return;
      transition(() => {
        steps.forEach((step, i) => {
          step.hidden = i !== index;
          buttons[i].setAttribute('aria-pressed', String(i === index));
        });
      }, index - current, current >= 0);
      current = index;
      status.textContent = `${index + 1} / ${steps.length}`;
      previous.disabled = index === 0;
      next.disabled = index === steps.length - 1;
    }
    previous.addEventListener('click', () => select(Math.max(0, current - 1)));
    next.addEventListener('click', () => select(Math.min(steps.length - 1, current + 1)));
    list.classList.add('step-reader');
    list.before(picker);
    list.after(controls);
    select(0);
  }

  function initGuideCards() {
    if (typeof HTMLDialogElement === 'undefined' || !HTMLDialogElement.prototype.showModal) return;
    const main = document.querySelector('main');
    if (!main) return;
    const pageNames = {
      programs: '专业选择', scores: '2026 届分数', preparation: '初复试备考',
      timeline: '全年时间轴', application: '报名流程', materials: '材料清单',
      updates: '官方动态', sources: '官方信源'
    };
    initReadingGroups(main, document.body.dataset.page);
    main.guideReveal(window.location.hash);
    window.addEventListener('hashchange', () => main.guideReveal(window.location.hash));
    let closedPrintDetails = null;
    window.addEventListener('beforeprint', () => {
      if (closedPrintDetails) return;
      closedPrintDetails = Array.from(document.querySelectorAll('details:not([open])'));
      closedPrintDetails.forEach(details => { details.open = true; });
    });
    window.addEventListener('afterprint', () => {
      if (!closedPrintDetails) return;
      closedPrintDetails.forEach(details => { details.open = false; });
      closedPrintDetails = null;
    });
    document.body.classList.add('guide-cards-ready');
    const dialog = createTextElement('dialog', 'guide-dialog');
    dialog.setAttribute('aria-labelledby', 'guide-dialog-title');
    const header = createTextElement('div', 'guide-dialog-header');
    const heading = createTextElement('div', 'guide-dialog-heading');
    const back = createTextElement('button', 'guide-back', '←');
    back.type = 'button'; back.setAttribute('aria-label', '返回上一张卡片'); back.hidden = true;
    const titleBlock = createTextElement('div');
    titleBlock.append(createTextElement('p', 'guide-dialog-kicker', 'HNU 2027 / 随看随收'));
    const title = createTextElement('h2'); title.id = 'guide-dialog-title';
    titleBlock.append(title); heading.append(back, titleBlock);
    const close = createTextElement('button', 'guide-close', '×');
    close.type = 'button'; close.dataset.guideClose = ''; close.setAttribute('aria-label', '关闭卡片');
    header.append(heading, close);
    const viewport = createTextElement('div', 'guide-dialog-body');
    const footer = createTextElement('div', 'guide-dialog-footer');
    footer.append(createTextElement('span', '', '关闭卡片，继续当前页面'));
    const print = createTextElement('button', 'text-button', '打印此卡片');
    print.type = 'button'; print.addEventListener('click', () => window.print()); footer.append(print);
    dialog.append(header, viewport, footer);
    document.body.append(dialog);
    const panels = new Map();
    let opener = null, active = null, trail = [], controller = null, revision = 0;
    function announceChange() { document.dispatchEvent(new Event('guide-panel-change')); }
    function cleanup() {
      revision += 1; controller?.abort();
      ['enter', 'exit'].forEach(phase => {
        dialog.style.removeProperty(`--dialog-${phase}-opacity`);
        dialog.style.removeProperty(`--dialog-${phase}-transform`);
        dialog.style.removeProperty(`--backdrop-${phase}-opacity`);
      });
      document.documentElement.classList.remove('guide-dialog-open');
      viewport.replaceChildren();
      active = null; trail = [];
      announceChange();
      opener?.focus({ preventScroll: true });
    }
    let closeTimer = null;
    function cancelPendingClose() {
      if (closeTimer === null) return;
      const style = window.getComputedStyle(dialog);
      dialog.style.setProperty('--dialog-enter-opacity', style.opacity);
      dialog.style.setProperty('--dialog-enter-transform', style.transform);
      dialog.style.setProperty('--backdrop-enter-opacity', window.getComputedStyle(dialog, '::backdrop').opacity);
      window.clearTimeout(closeTimer);
      closeTimer = null;
      dialog.classList.remove('guide-closing');
    }
    function dismiss() {
      if (closeTimer !== null) return;
      const reducedMotion = typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reducedMotion || !dialog.open) { dialog.close(); cleanup(); return; }
      const style = window.getComputedStyle(dialog);
      dialog.style.setProperty('--dialog-exit-opacity', style.opacity);
      dialog.style.setProperty('--dialog-exit-transform', style.transform);
      dialog.style.setProperty('--backdrop-exit-opacity', window.getComputedStyle(dialog, '::backdrop').opacity);
      dialog.classList.add('guide-closing');
      announceChange();
      closeTimer = window.setTimeout(() => {
        closeTimer = null;
        dialog.classList.remove('guide-closing');
        // Same synchronous close+cleanup as the instant path, so focus and scroll restore right away.
        dialog.close();
        cleanup();
      }, readCardExitAnimationMs());
    }
    close.addEventListener('click', dismiss);
    let backdropPress = false;
    dialog.addEventListener('pointerdown', event => { backdropPress = event.target === dialog; });
    dialog.addEventListener('click', event => { if (event.target === dialog && backdropPress) dismiss(); });
    dialog.addEventListener('close', () => {
      // A queued native close event must not clear a newly reopened card.
      if (!dialog.open && active) cleanup();
    });
    dialog.addEventListener('cancel', event => {
      // An open filter handles its own Escape before the dialog closes.
      event.preventDefault();
      if (!dialog.querySelector('.filter-select-menu[data-open="true"]')) dismiss();
    });
    back.addEventListener('click', () => { const previous = trail.pop(); if (previous) show(previous, false); });
    async function show(destination, remember = true) {
      cancelPendingClose();
      const request = ++revision;
      controller?.abort(); controller = new AbortController();
      const requestController = controller;
      if (remember && active && active.key !== destination.key) trail.push(active);
      active = destination;
      back.hidden = trail.length === 0;
      title.textContent = destination.title;
      viewport.replaceChildren(createTextElement('p', 'guide-loading', '正在打开卡片…'));
      viewport.setAttribute('aria-busy', 'true');
      if (!dialog.open) {
        document.documentElement.classList.add('guide-dialog-open');
        dialog.showModal();
      }
      close.focus({ preventScroll: true });
      announceChange();
      let timeout;
      try {
        let panel = panels.get(destination.key);
        if (!panel) {
          panel = createTextElement('div', 'guide-panel');
          panel.dataset.page = destination.page || 'home';
          if (destination.template) {
            panel.append(destination.template.content.cloneNode(true));
          } else {
            timeout = window.setTimeout(() => requestController.abort(), 10_000);
            const response = await fetch(destination.path, { signal: requestController.signal });
            if (!response.ok) throw new Error('Unable to load guide');
            const parsed = new DOMParser().parseFromString(await response.text(), 'text/html');
            const source = parsed.querySelector('main');
            if (!source || !parsed.documentElement.matches('[data-product="hainanu-2027-kaoyan-guide"]')) throw new Error('Invalid guide');
            panel.append(...Array.from(source.childNodes).map(node => document.importNode(node, true)));
          }
          if (request !== revision || !dialog.open) return;
          // Original page IDs are retained for source links; only one fetched panel is mounted.
          panel.querySelectorAll('script').forEach(node => node.remove());
          const updateList = panel.querySelector('[data-update-page-size]');
          if (updateList) updateList.dataset.updatePageSize = '4';
          viewport.replaceChildren(panel);
          initReadingGroups(panel, destination.page);
          initPage(panel);
          panels.set(destination.key, panel);
        } else {
          viewport.replaceChildren(panel);
        }
        panel.guideReveal?.(destination.hash);
        viewport.scrollTop = 0;
        viewport.removeAttribute('aria-busy');
        announceChange();
      } catch {
        if (request !== revision || !dialog.open) return;
        const error = createTextElement('div', 'guide-error');
        error.setAttribute('role', 'status');
        error.append(createTextElement('h3', '', '这张卡片暂时未能打开'),
          createTextElement('p', '', '请检查连接后重试，当前页面仍会保留。'));
        const retry = createTextElement('button', 'button button-primary', '重新加载');
        retry.type = 'button'; retry.addEventListener('click', () => show(destination, false)); error.append(retry);
        if (destination.path) {
          const link = createTextElement('a', 'text-link', '打开完整页面');
          link.href = destination.path + (destination.hash || ''); link.dataset.guideBypass = ''; error.append(link);
        }
        viewport.replaceChildren(error); viewport.removeAttribute('aria-busy');
      } finally { window.clearTimeout(timeout); }
    }
    document.addEventListener('click', event => {
      if (event.defaultPrevented || event.button > 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const local = event.target.closest('[data-guide-local]');
      if (local) {
        const template = document.getElementById(local.dataset.guideLocal);
        if (!template) return;
        event.preventDefault(); if (!dialog.open) opener = local;
        show({ key: template.id, title: template.dataset.title, template }); return;
      }
      const link = event.target.closest('a[href]');
      if (!link || link.target || link.hasAttribute('download') || link.hasAttribute('data-guide-bypass')) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      const page = url.pathname.split('/').pop().replace(/\.html$/, '');
      if (!pageNames[page]) {
        if (url.pathname === window.location.pathname && url.hash) main.guideReveal(url.hash);
        return;
      }
      if (!dialog.open && page === document.body.dataset.page) {
        main.guideReveal(url.hash); return;
      }
      event.preventDefault();
      if (!dialog.open) opener = link;
      show({ key: page, page, path: `/${page}.html`, hash: url.hash, title: pageNames[page] });
    });
    document.querySelectorAll('a[href]').forEach(link => {
      const url = new URL(link.href, window.location.href);
      const page = url.pathname.split('/').pop().replace(/\.html$/, '');
      if (url.origin === window.location.origin && pageNames[page] && page !== document.body.dataset.page) link.setAttribute('aria-haspopup', 'dialog');
    });
  }

  function initPage(root = document) {
    const legacyDestination = root === document && getLegacyPageDestination(window.location.pathname, window.location.hash);
    if (legacyDestination) {
      window.location.replace(legacyDestination);
      return;
    }
    if (root === document) {
      initSiteNavigation();
      initHomeReadingOrder();
    }
    const timelineElements = Array.from(root.querySelectorAll('[data-milestone-id]'));
    const deadlinePanel = root.querySelector('#current-deadline');
    function renderCurrentStage(checks) {
      const now = new Date();
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

      timelineElements.forEach((element) => {
        const isActive = activeMilestones.some(item => item.id === element.dataset.milestoneId);
        element.classList.toggle('is-current', isActive);
        if (isActive) element.setAttribute('aria-current', 'step');
        else element.removeAttribute('aria-current');
      });

      const stageName = root.querySelector('#current-stage-name');
      const stageDetail = root.querySelector('#current-stage-detail');
      const nextName = root.querySelector('#next-stage-name');
      const nextDays = root.querySelector('#next-stage-days');

      if (stageName) stageName.textContent = activeMilestones.map((milestone) => milestone.label).join(' / ') || '等待下一节点';
      if (stageDetail) {
        stageDetail.textContent = activeMilestones.length
          ? activeMilestones.map((milestone) => milestone.action || '按时间轴完成当前行动').join('；')
          : '查看时间轴确认最近的官方节点';
        if (reviewPending) stageDetail.textContent += '；审核通过后在时间轴勾选完成，补交不得超过报考点公布的期限';
      }
      if (nextName) {
        nextName.textContent = nextMilestone
          ? `${nextMilestone.label}${nextMilestone.estimated ? '（预计）' : ''}`
          : '本周期已无后续节点';
      }
      if (nextDays) {
        nextDays.textContent = Number.isFinite(state.daysToNext)
          ? `${nextMilestone?.estimated ? '约 ' : ''}${state.daysToNext} 天`
          : '—';
      }
      if (deadlinePanel) {
        const notice = getDeadlineNotice(scheduledMilestones, now, checks);
        deadlinePanel.hidden = !notice;
        if (notice) {
          deadlinePanel.dataset.state = notice.state;
          const status = root.querySelector('#current-deadline-status');
          const statusText = { upcoming: '截止提醒', urgent: '即将截止', closed: '已截止' }[notice.state];
          // Only announce a status change, not each countdown tick.
          if (status.textContent !== statusText) status.textContent = statusText;
          root.querySelector('#current-deadline-title').textContent = notice.milestone.deadlineTitle;
          const time = root.querySelector('#current-deadline-time');
          time.setAttribute('datetime', notice.at);
          const [year, month, day] = notice.at.slice(0, 10).split('-');
          time.textContent = `${year} 年 ${Number(month)} 月 ${Number(day)} 日 ${notice.at.slice(11, 16)}（北京时间）`;
          root.querySelector('#current-deadline-countdown').textContent = notice.countdown;
          root.querySelector('#current-deadline-scope').textContent = notice.state === 'closed'
            ? notice.milestone.deadlineClosedScope || notice.milestone.deadlineScope
            : notice.milestone.deadlineScope;
        }
      }
    }
    const checkboxes = Array.from(root.querySelectorAll('.task-check[data-check-id]'));
    const skipButtons = Array.from(root.querySelectorAll('[data-skip-check]'));
    let progressStorage = null;
    let checklistState = {};
    try {
      if (sessionProgressOnly) {
        checklistState = mergeChecklistState(sessionChecklistState, {});
        showSessionStorageWarning(root);
      } else {
        progressStorage = window.localStorage;
        checklistState = readChecks(progressStorage, STORAGE_KEY, CHECKLIST_IDS);
      }
    } catch {
      // Some restricted or file origins block access at the property getter.
      progressStorage = null;
      sessionProgressOnly = true;
      checklistState = mergeChecklistState(sessionChecklistState, {});
      showSessionStorageWarning(root);
    }

    function renderProgress() {
      sessionChecklistState = checklistState;
      if (sessionProgressOnly) showSessionStorageWarning(root);
      const { completed, total, percent } = countChecklistProgress(checklistState);
      renderCurrentStage(checklistState);
      const bar = root.querySelector('#progress-bar');
      const text = root.querySelector('#progress-text');
      const count = root.querySelector('#progress-count');

      if (bar) {
        bar.style.width = `${percent}%`;
        bar.parentElement?.setAttribute('aria-valuenow', String(percent));
      }
      if (text) text.textContent = `${percent}%`;
      const skipped = CHECKLIST_IDS.length - total;
      if (count) count.textContent = `${completed} / ${total} 项${skipped ? `（${skipped} 项不适用）` : ''}`;
      checkboxes.forEach((checkbox) => {
        const value = checklistState[checkbox.dataset.checkId];
        checkbox.checked = value === true;
        checkbox.disabled = value === 'na';
        checkbox.closest('label')?.setAttribute('data-print-state', value === 'na' ? '不适用' : checkbox.checked ? '已完成' : '未完成');
      });
      skipButtons.forEach((button) => {
        const skipped = checklistState[button.dataset.skipCheck] === 'na';
        button.hidden = false;
        button.setAttribute('aria-pressed', String(skipped));
        button.textContent = skipped ? '已设为不适用 · 恢复此项' : '此项不适用';
      });
    }

    function persistChecks(pageValues = Object.fromEntries(
        checkboxes.map((checkbox) => [checkbox.dataset.checkId, checkbox.checked])
      )) {
      if (sessionProgressOnly) progressStorage = null;
      if (!progressStorage) {
        checklistState = mergeChecklistState(checklistState, pageValues);
      } else {
        try {
          checklistState = mergeChecklistState(
            readChecks(progressStorage, STORAGE_KEY, CHECKLIST_IDS),
            pageValues
          );
          progressStorage.setItem(STORAGE_KEY, JSON.stringify(checklistState));
        } catch {
          checklistState = mergeChecklistState(checklistState, pageValues);
          progressStorage = null;
          sessionProgressOnly = true;
          // Storage may be disabled in private or hardened browser modes.
          showSessionStorageWarning(root);
        }
      }
      renderProgress();
      scheduleStageRefresh();
      if (typeof document.dispatchEvent === 'function') {
        document.dispatchEvent(new CustomEvent('guide-progress-change', { detail: checklistState }));
      }
    }

    checkboxes.forEach((checkbox) => checkbox.addEventListener('change', () => persistChecks({
      [checkbox.dataset.checkId]: checkbox.checked
    })));
    skipButtons.forEach((button) => button.addEventListener('click', () => {
      const id = button.dataset.skipCheck;
      if (optionalChecklistIds.has(id)) persistChecks({ [id]: checklistState[id] === 'na' ? false : 'na' });
    }));
    renderProgress();
    document.addEventListener('guide-progress-change', (event) => {
      checklistState = mergeChecklistState(event.detail, {});
      renderProgress();
      scheduleStageRefresh();
    });
    function refreshChecklist() {
      if (sessionProgressOnly) {
        progressStorage = null;
        checklistState = mergeChecklistState(sessionChecklistState, {});
      }
      if (progressStorage) {
        try {
          checklistState = readChecks(progressStorage, STORAGE_KEY, CHECKLIST_IDS);
        } catch {
          // Keep the last usable state when storage becomes inaccessible.
          progressStorage = null;
          sessionProgressOnly = true;
          showSessionStorageWarning(root);
        }
      }
      renderProgress();
    }
    let stageRefreshTimer = null;
    function stopStageRefresh() {
      if (stageRefreshTimer !== null) window.clearTimeout(stageRefreshTimer);
      stageRefreshTimer = null;
    }
    function scheduleStageRefresh() {
      stopStageRefresh();
      if (document.visibilityState === 'hidden') return;
      const now = new Date();
      const timestamp = now.getTime();
      const nextMidnight = toUtcDay(getBeijingDateString(now)) + DAY_MS - BEIJING_OFFSET_MS;
      const upcomingCutoffs = milestones.map(item => Date.parse(item.endsAt || item.deadlineAt))
        .filter(at => at > timestamp);
      const countdownTick = deadlinePanel && !deadlinePanel.hidden && deadlinePanel.dataset.state !== 'closed'
        ? timestamp + 60_000 - timestamp % 60_000 : Infinity;
      const nextRefresh = Math.min(nextMidnight, countdownTick, ...upcomingCutoffs);
      stageRefreshTimer = window.setTimeout(() => {
        stageRefreshTimer = null;
        refreshChecklist();
        scheduleStageRefresh();
      }, Math.max(1, nextRefresh - timestamp));
    }
    scheduleStageRefresh();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') stopStageRefresh();
      else {
        refreshChecklist();
        scheduleStageRefresh();
      }
    });

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('pageshow', () => {
        refreshChecklist();
        scheduleStageRefresh();
      });
      window.addEventListener('pagehide', stopStageRefresh);
      window.addEventListener('storage', (event) => {
        if (progressStorage && event.storageArea === progressStorage &&
            (event.key === STORAGE_KEY || event.key === null)) {
          refreshChecklist();
          scheduleStageRefresh();
        }
      });
    }

    const resetButton = root.querySelector('#reset-progress');
    resetButton?.addEventListener('click', () => {
      const resetAll = resetButton.dataset.resetScope === 'all';
      const confirmation = resetAll
        ? '确定清空全部 21 项任务状态（含不适用状态）吗？此操作无法撤销。'
        : '确定清空本页所有已勾选进度吗？此操作无法撤销。';
      if (!window.confirm(confirmation)) return;
      checkboxes.forEach((checkbox) => { checkbox.checked = false; });
      if (resetAll) {
        persistChecks(Object.fromEntries(CHECKLIST_IDS.map((id) => [id, false])));
        return;
      }
      persistChecks();
    });

    const filterButtons = Array.from(root.querySelectorAll('[data-filter]'));
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

    root.querySelectorAll('[data-print]').forEach((button) => {
      button.addEventListener('click', () => window.print());
    });

    const navLinks = Array.from(root.querySelectorAll('.page-toc a[href^="#"]'));
    if (root === document && 'IntersectionObserver' in window) {
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
      root.querySelectorAll('main section[id]').forEach((section) => observer.observe(section));
    }

    initOfficialUpdates(root);
    if (root === document) initGuideCards();
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
      document.addEventListener('DOMContentLoaded', () => initPage(), { once: true });
    } else {
      initPage();
    }
  }
})();
