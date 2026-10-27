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
    formatSourceHealthTitle,
    describeSnapshotStatus,
    describeUpdateCycle,
    describeCurrentStage
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

  /**
   * Accessible combobox that replaces a native <select> in the notice filters.
   *
   * Owns one trigger button and one floating listbox menu, keeps them in sync with the
   * hidden native select, and positions the menu relative to the viewport (or to a
   * transformed dialog card). Instances are created by enhanceNoticeSelects, which
   * shares the sibling list so opening one menu closes the others.
   */
  class NoticeSelect {
    /**
     * @param {HTMLSelectElement} select Native select that stays as the source of truth.
     * @param {Document|HTMLElement} scope Document or dialog root that contains the select.
     * @param {NoticeSelect[]} siblings Shared list of widgets created for the same scope.
     */
    constructor(select, scope, siblings) {
      this._select = select;
      this._scope = scope;
      this._siblings = siblings;
      this._options = Array.from(select.options);
      this._open = false;
      this._activeIndex = Math.max(0, select.selectedIndex);
      this._search = '';
      this._lastKeyAt = 0;
      this._frame = 0;
      this._buildShell();
      this._buildRows();
      this._bindEvents();
      this._sync();
    }

    /** Wrapper element placed after the native select. */
    get root() { return this._root; }

    /** Floating listbox element appended to the document body or dialog. */
    get menu() { return this._menu; }

    _buildShell() {
      const select = this._select;
      const label = this._scope.querySelector(`label[for="${select.id}"]`);
      this._root = createTextElement('div', 'filter-select');
      this._trigger = createTextElement('button', 'filter-select-trigger');
      const trigger = this._trigger;
      trigger.type = 'button';
      trigger.id = `${select.id}-trigger`;
      trigger.setAttribute('role', 'combobox');
      trigger.setAttribute('aria-haspopup', 'listbox');
      trigger.setAttribute('aria-expanded', 'false');
      this._value = createTextElement('span', 'filter-select-value');
      this._value.id = `${select.id}-value`;
      const arrow = createTextElement('span', 'filter-select-arrow');
      arrow.setAttribute('aria-hidden', 'true');
      trigger.append(this._value, arrow);
      this._menu = createTextElement('div', 'filter-select-menu');
      this._menu.id = `${select.id}-listbox`;
      this._menu.setAttribute('role', 'listbox');
      this._menu.setAttribute('aria-hidden', 'true');
      trigger.setAttribute('aria-controls', this._menu.id);
      if (label) {
        label.id ||= `${select.id}-label`;
        label.htmlFor = trigger.id;
        trigger.setAttribute('aria-labelledby', `${label.id} ${this._value.id}`);
        this._menu.setAttribute('aria-labelledby', label.id);
      }
      this._root.append(trigger);
      select.after(this._root);
      (this._scope === document ? document.body : this._scope).append(this._menu);
      select.hidden = true;
    }

    _buildRows() {
      this._rows = this._options.map((option, index) => {
        const row = createTextElement('div', 'filter-select-option');
        row.id = `${this._select.id}-option-${index}`;
        row.setAttribute('role', 'option');
        const check = createTextElement('span', 'filter-select-check', '✓');
        check.setAttribute('aria-hidden', 'true');
        row.append(createTextElement('span', '', option.textContent), check);
        row.addEventListener('pointerdown', (event) => event.preventDefault());
        row.addEventListener('click', () => { this._activeIndex = index; this._commit(); this._trigger.focus(); });
        row.addEventListener('pointermove', () => { this._activeIndex = index; this._renderActive(); });
        this._menu.append(row);
        return row;
      });
    }

    _bindEvents() {
      this._trigger.addEventListener('click', () => (this._open ? this.close() : this._expand()));
      this._trigger.addEventListener('keydown', (event) => this._onKeydown(event));
      this._select.addEventListener('change', () => this._sync());
    }

    _renderActive() {
      this._rows.forEach((row, index) => { row.dataset.active = String(index === this._activeIndex); });
      if (this._open) this._trigger.setAttribute('aria-activedescendant', this._rows[this._activeIndex].id);
    }

    _sync() {
      const select = this._select;
      this._value.textContent = this._options[select.selectedIndex]?.textContent || '';
      this._activeIndex = Math.max(0, select.selectedIndex);
      this._rows.forEach((row, index) => row.setAttribute('aria-selected', String(index === select.selectedIndex)));
      this._renderActive();
    }

    /** Closes the menu and cancels any transform-tracking animation frame. */
    close() {
      this._open = false;
      if (this._frame && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(this._frame);
      this._frame = 0;
      this._root.dataset.open = this._menu.dataset.open = 'false';
      this._trigger.setAttribute('aria-expanded', 'false');
      this._trigger.removeAttribute('aria-activedescendant');
      this._menu.setAttribute('aria-hidden', 'true');
      this._search = '';
    }

    _revealActive() {
      const row = this._rows[this._activeIndex];
      const menu = this._menu;
      if (row.offsetTop < menu.scrollTop) menu.scrollTop = row.offsetTop;
      else if (row.offsetTop + row.offsetHeight > menu.scrollTop + menu.clientHeight) {
        menu.scrollTop = row.offsetTop + row.offsetHeight - menu.clientHeight;
      }
    }

    // Maps viewport coordinates into a transformed dialog's local space; identity otherwise.
    _readDialogTransform() {
      const dialog = this._scope !== document ? this._scope.closest('dialog') : null;
      const transformed = Boolean(dialog && typeof window.getComputedStyle === 'function' && window.getComputedStyle(dialog).transform !== 'none');
      if (!transformed) return { transformed, scaleX: 1, scaleY: 1, originX: 0, originY: 0 };
      const dialogRect = dialog.getBoundingClientRect();
      const scaleX = dialog.offsetWidth ? dialogRect.width / dialog.offsetWidth : 1;
      const scaleY = dialog.offsetHeight ? dialogRect.height / dialog.offsetHeight : 1;
      return {
        transformed,
        scaleX,
        scaleY,
        originX: dialogRect.left + (dialog.clientLeft || 0) * scaleX,
        originY: dialogRect.top + (dialog.clientTop || 0) * scaleY
      };
    }

    // Places the menu below or above the trigger; returns whether the scope is transformed.
    _positionMenu() {
      const menu = this._menu;
      const rect = this._trigger.getBoundingClientRect();
      const desired = Math.min(this._options.length * 44 + 16, 296);
      const below = window.innerHeight - rect.bottom - 16;
      const above = rect.top - 16;
      const upward = below < desired && above > below;
      const width = Math.min(rect.width, window.innerWidth - 24);
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
      const maxHeight = Math.min(desired, Math.max(0, upward ? above : below));
      const { transformed, scaleX, scaleY, originX, originY } = this._readDialogTransform();
      menu.style.width = `${width / scaleX}px`;
      menu.style.left = `${(left - originX) / scaleX}px`;
      menu.style.maxHeight = `${maxHeight / scaleY}px`;
      const top = upward ? rect.top - menu.offsetHeight * scaleY - 8 : rect.bottom + 8;
      menu.style.top = `${(top - originY) / scaleY}px`;
      menu.dataset.direction = upward ? 'up' : 'down';
      return transformed;
    }

    /**
     * Re-anchors an open menu, or closes it once the trigger scrolls out of view.
     * @returns {boolean} True while the menu is open inside a transformed dialog.
     */
    reposition() {
      if (!this._open) return false;
      const rect = this._trigger.getBoundingClientRect();
      const scrollBox = this._scope !== document ? this._scope.closest('.guide-dialog-body') : null;
      const bounds = scrollBox ? scrollBox.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
      if (rect.bottom <= Math.max(0, bounds.top) || rect.top >= Math.min(window.innerHeight, bounds.bottom)) {
        this.close();
        return false;
      }
      return this._positionMenu();
    }

    _trackTransform() {
      this._frame = 0;
      if (this.reposition() && typeof window.requestAnimationFrame === 'function') {
        this._frame = window.requestAnimationFrame(() => this._trackTransform());
      }
    }

    _expand() {
      this._siblings.forEach((widget) => widget.close());
      this._sync();
      const transformed = this._positionMenu();
      this._open = true;
      this._root.dataset.open = this._menu.dataset.open = 'true';
      this._trigger.setAttribute('aria-expanded', 'true');
      this._menu.setAttribute('aria-hidden', 'false');
      this._renderActive();
      this._revealActive();
      if (transformed && !this._frame && typeof window.requestAnimationFrame === 'function') {
        this._frame = window.requestAnimationFrame(() => this._trackTransform());
      }
    }

    _commit() {
      const select = this._select;
      const changed = select.value !== this._options[this._activeIndex].value;
      select.value = this._options[this._activeIndex].value;
      this._sync();
      this.close();
      if (changed) select.dispatchEvent(new Event('change', { bubbles: true }));
    }

    _moveActive(key) {
      const wasOpen = this._open;
      if (!this._open) this._expand();
      if (key === 'Home') this._activeIndex = 0;
      else if (key === 'End') this._activeIndex = this._options.length - 1;
      else if (wasOpen) this._activeIndex = Math.max(0, Math.min(this._options.length - 1, this._activeIndex + (key === 'ArrowDown' ? 1 : -1)));
      this._renderActive();
      this._revealActive();
    }

    // Type-ahead: consecutive keystrokes within 600ms extend the search prefix.
    _typeAhead(key) {
      if (!this._open) this._expand();
      const now = Date.now();
      this._search = (now - this._lastKeyAt < 600 ? this._search : '') + key.toLocaleLowerCase();
      this._lastKeyAt = now;
      const match = this._options.findIndex((option) => option.textContent.trim().toLocaleLowerCase().startsWith(this._search));
      if (match >= 0) { this._activeIndex = match; this._renderActive(); this._revealActive(); }
    }

    _onKeydown(event) {
      if (event.key === 'Tab') { if (this._open) this._commit(); return; }
      if (event.key === 'Escape') {
        if (this._open) { event.preventDefault(); event.stopPropagation(); this.close(); }
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (this._open) this._commit(); else this._expand();
        return;
      }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        this._moveActive(event.key);
      } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing) {
        event.preventDefault();
        this._typeAhead(event.key);
      }
    }
  }

  // Document-level listeners shared by every widget of one enhanced scope.
  function bindNoticeSelectGlobalListeners(widgets, scope) {
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

  function enhanceNoticeSelects(selects, scope = document) {
    const widgets = [];
    selects.filter((select) => select?.options?.length).forEach((select) => {
      widgets.push(new NoticeSelect(select, scope, widgets));
    });
    if (widgets.length) bindNoticeSelectGlobalListeners(widgets, scope);
  }

  /**
   * Live official-notice console of the home and updates cards.
   *
   * Polls the update API, renders connection status, source health chips, the paged and
   * filtered notice list and the unread ("new") tracking backed by localStorage. One
   * instance owns one rendered root (the document or an open guide dialog) and pauses
   * itself whenever that root is hidden or closed. Created by initOfficialUpdates.
   */
  class OfficialUpdatesPanel {
    /**
     * @param {Document|HTMLElement} root Document or dialog root that contains the console markup.
     * @param {HTMLElement} consoleElement The #live-updates-console element.
     * @param {HTMLButtonElement} refreshButton The manual sync button.
     */
    constructor(root, consoleElement, refreshButton) {
      this._root = root;
      this._console = consoleElement;
      this._refreshButton = refreshButton;
      this._isCloud = document.body?.dataset?.hosting === 'vercel';
      this._collectElements();
      this._updatesPage = 1;
      this._updatesPageCount = 1;
      this._hasRenderedSnapshot = false;
      this._unseenBaselineAt = null;
      this._latestPayload = null;
      this._updateView = 'all';
      this._renderedUpdatesKey = null;
      this._acknowledgedIds = new Set();
      this._pollTimer = null;
      this._activeController = null;
      this._requestInFlight = false;
      this._resumePending = false;
      if (this._noticeFilters) this._noticeFilters.hidden = false;
      enhanceNoticeSelects([this._yearFilter, this._categoryFilter], root);
      this._syncUnseenBaseline();
    }

    _collectElements() {
      const root = this._root;
      this._statusTitle = root.querySelector('#live-status-title');
      this._statusDetail = root.querySelector('#live-status-detail');
      this._lastSuccess = root.querySelector('#live-last-success');
      this._freshness = root.querySelector('#live-freshness');
      this._nextRefresh = root.querySelector('#live-next-refresh');
      this._sourceCount = root.querySelector('#live-source-count');
      this._newCount = root.querySelector('#live-new-count');
      this._sourceHealth = root.querySelector('#live-source-health');
      this._updatesList = root.querySelector('#official-updates-list');
      this._previousPageButton = root.querySelector('#updates-previous');
      this._nextPageButton = root.querySelector('#updates-next');
      this._pageStatus = root.querySelector('#updates-page-status');
      this._filterButtons = Array.from(root.querySelectorAll('[data-updates-filter]'));
      this._yearFilter = root.querySelector('#updates-year');
      this._categoryFilter = root.querySelector('#updates-category');
      this._noticeFilters = root.querySelector('.notice-filters');
      this._acknowledgeButton = root.querySelector('#acknowledge-official-updates');
    }

    /** Wires the controls, then starts polling unless the page runs from file://. */
    start() {
      this._bindControls();
      if (window.location.protocol === 'file:') {
        this._renderDisconnected('当前是静态文件模式；运行 start-guide.cmd 后即可自动读取官网通知。');
        this._refreshButton.disabled = true;
        this._refreshButton.title = '请先启动本地 Node.js 服务';
        return;
      }
      this._bindLifecycle();
      this._loadUpdates(false);
    }

    // True while polling should pause: hidden tab, or a root whose dialog is closed/closing.
    _isInactive() {
      if (document.visibilityState === 'hidden') return true;
      if (this._root === document) return false;
      const dialog = this._root.closest('dialog');
      return !this._root.isConnected || !dialog?.open || dialog.classList.contains('guide-closing');
    }

    _stopPolling() {
      if (this._pollTimer) window.clearTimeout(this._pollTimer);
      this._pollTimer = null;
      this._activeController?.abort();
    }

    _syncUnseenBaseline(observedAt = null, acknowledge = false) {
      let storage = null;
      let storedAt = null;
      const advance = (candidate) => {
        if (typeof candidate === 'string' && Number.isFinite(Date.parse(candidate)) &&
            (!this._unseenBaselineAt || Date.parse(candidate) > Date.parse(this._unseenBaselineAt))) {
          this._unseenBaselineAt = candidate;
        }
      };
      try {
        storage = window.localStorage;
        storedAt = getUnseenBaseline(storage.getItem(LAST_SEEN_UPDATES_KEY), null);
        advance(storedAt);
      } catch {
        storage = null;
        showSessionStorageWarning(this._root);
      }
      // Polling preserves the baseline; only an explicit acknowledgement advances it.
      if (!this._unseenBaselineAt || acknowledge) advance(observedAt);
      if (storage && this._unseenBaselineAt && (!storedAt || acknowledge) && storedAt !== this._unseenBaselineAt) {
        try {
          storage.setItem(LAST_SEEN_UPDATES_KEY, this._unseenBaselineAt);
        } catch {
          showSessionStorageWarning(this._root);
        }
      }
    }

    _renderSources(sources, refreshIntervalMs) {
      if (!this._sourceHealth) return;
      this._sourceHealth.replaceChildren();
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
        this._sourceHealth.append(link);
      });
    }

    _buildEmptyItem(title, detail) {
      const empty = createTextElement('li', 'official-update-empty');
      empty.append(createTextElement('strong', '', title), createTextElement('span', '', detail));
      return empty;
    }

    _renderEmptyList(filters) {
      const filtered = filters.year !== 'all' || filters.category !== 'all';
      const title = filtered ? '没有符合筛选条件的通知' : this._updateView === 'new' ? '暂时没有未读通知' : '暂未读到相关通知';
      const detail = filtered
        ? '可选择“全部年份”和“全部类别”，或切换到“全部”查看其他通知。'
        : this._updateView === 'new'
          ? '全部标为已读后，新收录通知会从此处移除；可切换到“全部”查看完整列表。'
          : '这不等于学校没有公告；可稍后手动同步或前往官方信源页查看。';
      this._updatesList.append(this._buildEmptyItem(title, detail));
    }

    _buildUpdateItem(update, isNew) {
      const item = document.createElement('li');
      const link = createTextElement('a', 'official-update-link');
      link.href = update.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';

      const date = createTextElement('time', 'official-update-date', update.date.replace(/-/g, '.'));
      date.dateTime = update.date;
      date.setAttribute('aria-label', `发布日期：${update.date}`);
      const copy = createTextElement('div', 'official-update-copy');
      const meta = createTextElement('div', 'official-update-meta');
      meta.append(createTextElement('span', 'official-update-category', update.category));
      if (isNew) meta.append(createTextElement('span', 'official-update-new', '新收录'));
      const cycle = describeUpdateCycle(update);
      meta.append(createTextElement('span', cycle.isPreviousCycle ? 'official-update-history' : 'official-update-target', cycle.label));
      if (update.isImportant) meta.append(createTextElement('span', 'official-update-important', '重要'));
      copy.append(meta, createTextElement('h3', '', update.title), createTextElement('p', '', update.source));
      const arrow = createTextElement('span', 'official-update-arrow', '↗');
      arrow.setAttribute('aria-hidden', 'true');
      link.append(date, copy, arrow);
      item.append(link);
      return item;
    }

    // Selects the visible slice (limit or page) and refreshes the pager controls.
    _selectPage(selection) {
      const dataset = this._updatesList.dataset;
      const updateLimit = /^[1-9]\d*$/.test(dataset.updateLimit || '') ? Number(dataset.updateLimit) : null;
      const pageSize = /^[1-9]\d*$/.test(dataset.updatePageSize || '') ? Number(dataset.updatePageSize) : null;
      this._updatesPageCount = pageSize ? Math.max(1, Math.ceil(selection.updates.length / pageSize)) : 1;
      this._updatesPage = Math.min(this._updatesPage, this._updatesPageCount);
      const pageStart = pageSize ? (this._updatesPage - 1) * pageSize : 0;
      const rendered = pageSize
        ? selection.updates.slice(pageStart, pageStart + pageSize)
        : updateLimit ? selection.updates.slice(0, updateLimit) : selection.updates;
      if (this._previousPageButton) this._previousPageButton.disabled = this._updatesPage <= 1;
      if (this._nextPageButton) this._nextPageButton.disabled = this._updatesPage >= this._updatesPageCount;
      if (this._pageStatus) this._pageStatus.textContent = `第 ${this._updatesPage} / ${this._updatesPageCount} 页 · 共 ${selection.updates.length} 条`;
      return rendered;
    }

    _renderUpdates(displayUpdates) {
      if (!this._updatesList) return;
      const displayNewIds = new Set(displayUpdates.filter((update) => update.isNew).map((update) => update.id));
      const filters = { year: this._yearFilter?.value || 'all', category: this._categoryFilter?.value || 'all' };
      const selection = selectUpdatesForDisplay(displayUpdates, displayNewIds, new Set(), this._updateView, filters);
      const renderedUpdates = this._selectPage(selection);
      const renderedNewIds = selection.newIds.filter((id) => renderedUpdates.some((update) => update.id === id));
      const listRenderKey = createUpdatesSnapshotKey({
        updateView: this._updateView,
        filters,
        updates: renderedUpdates,
        newIds: renderedNewIds
      });
      if (listRenderKey === this._renderedUpdatesKey) return;
      this._renderedUpdatesKey = listRenderKey;
      this._updatesList.replaceChildren();
      if (!renderedUpdates.length) {
        this._renderEmptyList(filters);
        return;
      }
      const selectedNewIds = new Set(renderedNewIds);
      renderedUpdates.forEach((update) => {
        this._updatesList.append(this._buildUpdateItem(update, selectedNewIds.has(update.id)));
      });
    }

    _renderStatusLines(payload, successfulSources) {
      const status = describeSnapshotStatus(payload);
      if (this._statusTitle) this._statusTitle.textContent = status.title;
      if (this._statusDetail) this._statusDetail.textContent = payload.error || status.detail;
      if (this._lastSuccess) this._lastSuccess.textContent = formatLiveDate(payload.lastSuccessAt);
      if (this._freshness) this._freshness.textContent = formatFreshness(payload.freshness, payload.refreshIntervalMs);
      if (this._nextRefresh) {
        const refreshInterval = formatRefreshInterval(payload.refreshIntervalMs);
        this._nextRefresh.textContent = this._isCloud ? '访问时检查 · 可手动同步' : payload.nextRefreshAt
          ? formatLiveDate(payload.nextRefreshAt)
          : refreshInterval === '按刷新周期' ? refreshInterval : `每 ${refreshInterval}`;
      }
      if (this._sourceCount) this._sourceCount.textContent = `${successfulSources} / ${payload.sources.length || 4} 正常`;
    }

    _renderSnapshot(rawPayload) {
      const payload = normalizeUpdatesPayload(rawPayload);
      this._syncUnseenBaseline(payload.fetchedAt || payload.lastSuccessAt);
      const wasFirstRender = !this._hasRenderedSnapshot;
      this._latestPayload = payload;
      this._hasRenderedSnapshot = true;
      this._console.dataset.state = payload.status;
      this._console.dataset.freshness = payload.freshness.state;
      this._renderStatusLines(payload, payload.sources.filter((source) => source.ok).length);
      this._renderSources(payload.sources, payload.refreshIntervalMs);
      this._renderCurrentUpdates();
      if (wasFirstRender && payload.freshness.isOverdue && !this._requestInFlight) {
        window.setTimeout(() => this._loadUpdates(true), 500);
      }
    }

    _renderDisconnected(message) {
      this._console.dataset.state = 'offline';
      if (this._hasRenderedSnapshot) {
        if (this._statusTitle) this._statusTitle.textContent = '本次同步失败 · 显示最近数据';
        if (this._statusDetail) this._statusDetail.textContent = message;
        if (this._freshness) this._freshness.textContent = '连接中断 · 新鲜度未验证';
        if (this._sourceCount) this._sourceCount.textContent = '连接中断 · 待验证';
        if (this._nextRefresh) this._nextRefresh.textContent = '恢复连接后自动重试';
        return;
      }
      if (this._statusTitle) this._statusTitle.textContent = '自动更新未连接';
      if (this._statusDetail) this._statusDetail.textContent = message;
      if (this._lastSuccess) this._lastSuccess.textContent = '—';
      if (this._freshness) this._freshness.textContent = '服务未连接';
      if (this._nextRefresh) this._nextRefresh.textContent = this._isCloud ? '连接恢复后启用' : '启动服务后启用';
      if (this._sourceCount) this._sourceCount.textContent = '0 / 4 连接';
      if (this._newCount) this._newCount.hidden = true;
      if (this._sourceHealth) this._sourceHealth.replaceChildren();
      if (this._updatesList) {
        this._updatesList.replaceChildren(this._buildEmptyItem(
          '静态导航仍可正常使用',
          this._isCloud ? '在线通知服务暂不可用，请稍后重试或进入官方信源页查看原文。' : '启动本地服务后，这里会显示自动获取的海南大学官方通知。'
        ));
      }
    }

    _scheduleNextPoll() {
      if (this._pollTimer) window.clearTimeout(this._pollTimer);
      this._pollTimer = null;
      if (this._isInactive()) return;
      this._pollTimer = window.setTimeout(() => this._loadUpdates(false), 60 * 1000);
    }

    _setRefreshBusy(manual) {
      this._refreshButton.disabled = true;
      this._refreshButton.setAttribute('aria-busy', 'true');
      this._refreshButton.textContent = manual ? '正在同步…' : '正在连接…';
    }

    _clearRefreshBusy() {
      this._refreshButton.disabled = window.location.protocol === 'file:';
      this._refreshButton.removeAttribute('aria-busy');
      this._refreshButton.textContent = '立即同步';
    }

    _renderRateLimited() {
      if (!this._hasRenderedSnapshot || this._console.dataset.state === 'offline') {
        this._console.dataset.state = this._hasRenderedSnapshot ? 'stale' : 'seed';
        if (this._statusTitle) this._statusTitle.textContent = '服务已连接 · 等待再次同步';
      }
      if (this._statusDetail) this._statusDetail.textContent = '同步请求过于频繁，请稍后再试；当前通知已保留。';
    }

    _failureMessage() {
      if (this._hasRenderedSnapshot) return '本次同步失败，已保留当前页面中的最近数据。';
      return this._isCloud
        ? '在线通知服务暂未响应，请稍后重试；各导航页面仍可使用。'
        : '请运行 start-guide.cmd 或 npm start，再通过 http://127.0.0.1:4173 打开本页。';
    }

    async _loadUpdates(manual = false) {
      if (this._requestInFlight || (!manual && this._isInactive())) return;
      this._requestInFlight = true;
      const controller = new AbortController();
      this._activeController = controller;
      // Local sync can use two 12s attempts plus up to 10s of Retry-After.
      // Snapshot reads stay short; cloud attempts have a smaller server budget.
      const timeoutMs = this._isCloud ? 30_000 : manual ? 40_000 : 8_000;
      const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
      const showBusy = manual || !this._hasRenderedSnapshot;
      if (showBusy) this._setRefreshBusy(manual);

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
          this._renderRateLimited();
          return;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        this._renderSnapshot(await response.json());
      } catch {
        if (!this._isInactive()) this._renderDisconnected(this._failureMessage());
      } finally {
        window.clearTimeout(timeout);
        if (this._activeController === controller) this._activeController = null;
        this._requestInFlight = false;
        if (showBusy) this._clearRefreshBusy();
        if (this._resumePending && !this._isInactive()) {
          this._resumePending = false;
          this._loadUpdates(false);
        } else {
          this._scheduleNextPoll();
        }
      }
    }

    _renderCurrentUpdates() {
      if (!this._latestPayload) return;
      const unseenIds = new Set(getUnseenUpdates(this._latestPayload.updates, this._unseenBaselineAt).map((update) => update.id));
      const displayUpdates = aggregateUpdatesForDisplay(this._latestPayload.updates, unseenIds, this._acknowledgedIds);
      if (this._newCount) {
        const unacknowledgedCount = displayUpdates.filter((update) => update.isNew).length;
        this._newCount.hidden = unacknowledgedCount === 0;
        this._newCount.textContent = unacknowledgedCount ? `${unacknowledgedCount} 条新收录` : '';
      }
      // Local read-state changes must not overwrite the latest connection status.
      this._renderUpdates(displayUpdates);
    }

    _changePage(offset) {
      if (!this._latestPayload) return;
      this._updatesPage = Math.max(1, Math.min(this._updatesPageCount, this._updatesPage + offset));
      this._renderCurrentUpdates();
      this._updatesList?.focus();
    }

    _acknowledgeAll() {
      if (!this._latestPayload) return;
      getUnseenUpdates(this._latestPayload.updates, this._unseenBaselineAt)
        .forEach((update) => this._acknowledgedIds.add(update.id));
      this._syncUnseenBaseline(this._latestPayload.fetchedAt || this._latestPayload.lastSuccessAt, true);
      this._renderedUpdatesKey = null;
      this._renderCurrentUpdates();
    }

    _bindControls() {
      this._refreshButton.addEventListener('click', () => this._loadUpdates(true));
      this._previousPageButton?.addEventListener('click', () => this._changePage(-1));
      this._nextPageButton?.addEventListener('click', () => this._changePage(1));
      [this._yearFilter, this._categoryFilter].forEach((select) => select?.addEventListener('change', () => {
        this._updatesPage = 1;
        this._renderCurrentUpdates();
      }));
      this._filterButtons.forEach((button) => {
        button.addEventListener('click', () => {
          this._updateView = button.dataset.updatesFilter === 'new' ? 'new' : 'all';
          this._updatesPage = 1;
          this._filterButtons.forEach((candidate) => {
            candidate.setAttribute('aria-pressed', String(candidate === button));
          });
          this._renderCurrentUpdates();
        });
      });
      this._acknowledgeButton?.addEventListener('click', () => this._acknowledgeAll());
    }

    // Pauses polling while inactive and resumes it when the tab or card becomes visible again.
    _onVisibilityOrPanelChange(keepResumeFlag) {
      if (this._isInactive()) {
        this._stopPolling();
        return;
      }
      if (this._requestInFlight) {
        this._resumePending = true;
        return;
      }
      if (!keepResumeFlag) this._resumePending = false;
      this._loadUpdates(false);
    }

    _bindLifecycle() {
      document.addEventListener('visibilitychange', () => this._onVisibilityOrPanelChange(false));
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('storage', (event) => this._onStorageEvent(event));
      }
      document.addEventListener('guide-panel-change', () => this._onVisibilityOrPanelChange(true));
    }

    _onStorageEvent(event) {
      if (event.key !== LAST_SEEN_UPDATES_KEY) return;
      try {
        if (event.storageArea !== window.localStorage) return;
      } catch {
        showSessionStorageWarning(this._root);
        return;
      }
      // Read current storage: a queued event may describe an older write.
      this._syncUnseenBaseline();
      this._renderCurrentUpdates();
    }
  }

  function initOfficialUpdates(root = document) {
    const consoleElement = root.querySelector('#live-updates-console');
    const refreshButton = root.querySelector('#refresh-official-updates');
    if (!consoleElement || !refreshButton) return;
    new OfficialUpdatesPanel(root, consoleElement, refreshButton).start();
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
  /**
   * Animates a container's height between two content states.
   *
   * Measures before and after a DOM update, plays a short height animation, follows
   * late content changes with a ResizeObserver, and cancels itself on print, resize,
   * reduced-motion changes or when the container leaves the document. Used by reading
   * tabs and timeline cards through createContentTransition.
   */
  class ContentTransition {
    /**
     * @param {HTMLElement} container Element whose height is animated.
     */
    constructor(container) {
      this._container = container;
      this._animation = null;
      this._targetHeight = 0;
      this._reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
      this._observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this._onContentResize()) : null;
      window.addEventListener('beforeprint', () => this._finish());
      window.addEventListener('resize', () => this._finish());
      this._reducedMotion?.addEventListener?.('change', () => this._finish());
      document.addEventListener('guide-panel-change', () => { if (!container.isConnected) this._finish(); });
    }

    // CSS pixels exclude the dialog's entrance scale, unlike a bounding rect.
    _height() {
      const container = this._container;
      return container.getClientRects().length ? parseFloat(window.getComputedStyle(container).height) || 0 : 0;
    }

    _onContentResize() {
      if (!this._animation) return;
      const before = this._height();
      // Read the new natural height without resetting the animation's clock.
      // Nested steps and expanded notes can change it during a tab transition.
      const effect = this._animation.effect;
      const frames = effect.getKeyframes();
      effect.setKeyframes([]);
      const after = this._height();
      effect.setKeyframes(frames);
      if (Math.abs(after - this._targetHeight) >= 1) this._resize(before, after);
    }

    _resize(before, after) {
      if (this._animation) { this._animation.onfinish = null; this._animation.cancel(); }
      this._targetHeight = after;
      this._animation = this._container.animate([{ height: `${before}px` }, { height: `${after}px` }], {
        duration: 240, easing: 'cubic-bezier(.2, 0, 0, 1)'
      });
      this._container.classList.add('content-resizing');
      this._animation.onfinish = () => this._finish();
    }

    _finish() {
      const previous = this._animation;
      this._animation = null;
      this._observer?.disconnect();
      if (previous) { previous.onfinish = null; previous.cancel(); }
      this._container.classList.remove('content-resizing');
    }

    /**
     * Applies `update` and animates the resulting height change.
     * @param {Function} update Mutates the container's content synchronously.
     * @param {number} direction Negative for backward navigation, otherwise forward.
     * @param {boolean} enabled False to apply the update without animation.
     */
    run(update, direction = 1, enabled = true) {
      const container = this._container;
      // Measure before cancelling so an interrupted transition never snaps back.
      const before = this._height();
      this._finish();
      container.dataset.motionDirection = direction < 0 ? 'backward' : 'forward';
      update();
      if (!enabled || !container.animate || this._reducedMotion?.matches ||
          window.matchMedia?.('print').matches || !container.isConnected || before === 0) return;
      const after = this._height();
      if (after === 0 || Math.abs(after - before) < 1) return;
      this._resize(before, after);
      Array.from(container.children).forEach(child => this._observer?.observe(child));
    }
  }

  function createContentTransition(container) {
    const transition = new ContentTransition(container);
    return (update, direction = 1, enabled = true) => transition.run(update, direction, enabled);
  }

  // Tab groups per page: [label, selector of the source content that belongs to the tab].
  const READING_GROUP_CONFIGURATIONS = Object.freeze({
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
  });

  // Existing source nodes per tab, plus the ids of the sections they came from.
  function collectReadingGroups(root, page) {
    const groups = READING_GROUP_CONFIGURATIONS[page]
      ?.map(([label, selector]) => ({ label, nodes: Array.from(root.querySelectorAll(selector)) }))
      .filter(group => group.nodes.length) || [];
    groups.forEach(group => {
      group.sectionIds = new Set(group.nodes.map(node => node.closest('section')?.id).filter(Boolean));
    });
    return groups;
  }

  // Click selects a tab; arrow keys wrap around and Home/End jump to the first/last tab.
  function bindReadingTabEvents(buttons, activate) {
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
  }

  // Builds the tablist and panes for the groups, moves the nodes into them and returns activate(index, focus).
  function buildReadingTabs(root, page, groups) {
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
    const activate = (index, focus = false) => {
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
    bindReadingTabEvents(buttons, activate);
    root.append(tabs, panes);
    activate(0);
    root.classList.add('reading-grouped');
    return activate;
  }

  // Folds each section's intro paragraph into a collapsed "reading notes" disclosure.
  function foldSectionDescriptions(root) {
    root.querySelectorAll('.section-heading > p').forEach(description => {
      const note = createTextElement('details', 'reading-context');
      note.append(createTextElement('summary', '', '阅读说明与核对依据'));
      description.before(note);
      note.append(description);
    });
  }

  // Exposes root.guideReveal(hash): opens the tab and any <details> that contain the target id.
  function installGuideReveal(root, groups, activate) {
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

  // Group existing source content, so the full-page and card views stay in sync.
  function initReadingGroups(root, page) {
    const groups = collectReadingGroups(root, page);
    const activate = groups.length > 1 ? buildReadingTabs(root, page, groups) : null;
    foldSectionDescriptions(root);
    initTimelineCards(root);
    initApplicationSteps(root);
    installGuideReveal(root, groups, activate);
  }

  /**
   * Compact timeline with a single-node detail view.
   *
   * Replaces the long timeline list with launch buttons, shows one node's task body in a
   * detail pane (animated), and temporarily restores the full list while printing. Exposes
   * root.resetTimeline so deep links and card reopening can return to the list.
   */
  class TimelineCards {
    /**
     * @param {HTMLElement|Document} root Page or card panel that contains the timeline list.
     * @param {HTMLElement} list The .timeline-list element.
     */
    constructor(root, list) {
      this._root = root;
      this._list = list;
      this._transition = createContentTransition(list.parentElement);
      this._toolbar = root.querySelector('.timeline-toolbar');
      this._selected = null;
      this._printState = null;
      this._buildDetail();
      list.classList.add('timeline-compact');
      list.after(this._detail);
      root.resetTimeline = () => this._reset();
      this._bindPrint();
      this._bindBack();
      this._buildLaunchButtons();
    }

    _buildDetail() {
      this._detail = createTextElement('div', 'timeline-detail');
      this._detail.hidden = true;
      this._back = createTextElement('button', 'text-button', '← 返回节点');
      this._back.type = 'button';
      this._back.dataset.timelineBack = '';
      this._content = createTextElement('div', 'timeline-detail-content');
      this._detail.append(this._back, this._content);
    }

    _showList() {
      this._selected.item.append(this._selected.body);
      this._detail.hidden = true;
      this._list.hidden = false;
      if (this._toolbar) this._toolbar.hidden = false;
    }

    _reset() {
      if (!this._selected) return;
      this._showList();
      this._selected = null;
    }

    // Printing shows every node in the list; the detail view returns afterwards.
    _bindPrint() {
      window.addEventListener('beforeprint', () => {
        if (this._printState || !this._root.isConnected) return;
        this._printState = { hidden: Array.from(this._list.children).filter(item => item.hidden) };
        this._printState.hidden.forEach(item => { item.hidden = false; });
        if (this._selected) {
          this._selected.item.append(this._selected.body);
          this._list.hidden = false;
          this._detail.hidden = true;
        }
      });
      window.addEventListener('afterprint', () => {
        if (!this._printState) return;
        this._printState.hidden.forEach(item => { item.hidden = true; });
        if (this._selected) {
          this._content.replaceChildren(this._selected.item.querySelector('.timeline-date').cloneNode(true), this._selected.body);
          this._list.hidden = true;
          this._detail.hidden = false;
        }
        this._printState = null;
      });
    }

    _bindBack() {
      this._back.addEventListener('click', () => {
        if (!this._selected) return;
        this._transition(() => this._showList(), -1);
        this._selected.button.focus({ preventScroll: true });
        this._selected = null;
      });
    }

    _buildLaunchButtons() {
      this._list.querySelectorAll('.timeline-item').forEach(item => {
        const body = item.querySelector('.timeline-body');
        const button = createTextElement('button', 'timeline-launch');
        button.type = 'button';
        button.append(createTextElement('strong', '', item.dataset.label || body.querySelector('h3').textContent),
          createTextElement('span', '', '查看任务 ↗'));
        item.append(button);
        button.addEventListener('click', () => {
          this._selected = { item, body, button };
          this._transition(() => {
            this._content.replaceChildren(item.querySelector('.timeline-date').cloneNode(true), body);
            this._list.hidden = true;
            if (this._toolbar) this._toolbar.hidden = true;
            this._detail.hidden = false;
          });
          this._back.focus({ preventScroll: true });
        });
      });
    }
  }

  function initTimelineCards(root) {
    const list = root.querySelector('.timeline-list');
    if (list) new TimelineCards(root, list);
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

  const GUIDE_PAGE_NAMES = Object.freeze({
    programs: '专业选择', scores: '2026 届分数', preparation: '初复试备考',
    timeline: '全年时间轴', application: '报名流程', materials: '材料清单',
    updates: '官方动态', sources: '官方信源'
  });

  /**
   * Modal dialog that opens guide pages and inline templates as in-place cards.
   *
   * Builds one shared <dialog>, loads (and caches) each card's content, keeps a back
   * trail between cards, animates open/close, restores focus to the opener and tells
   * the rest of the page about visibility changes through guide-panel-change. Created
   * once by initGuideCards for the home and sub pages.
   */
  class GuideCardDialog {
    /**
     * @param {HTMLElement} main The page's <main>, used to reveal in-page anchors.
     */
    constructor(main) {
      this._main = main;
      this._panels = new Map();
      this._opener = null;
      this._active = null;
      this._trail = [];
      this._controller = null;
      this._revision = 0;
      this._closeTimer = null;
      this._backdropPress = false;
      this._buildDialog();
      this._bindDialogEvents();
      document.addEventListener('click', (event) => this._onDocumentClick(event));
      this._markPopupLinks();
    }

    _buildDialog() {
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
      Object.assign(this, { _dialog: dialog, _back: back, _title: title, _close: close, _viewport: viewport });
    }

    _bindDialogEvents() {
      const dialog = this._dialog;
      this._close.addEventListener('click', () => this._dismiss());
      dialog.addEventListener('pointerdown', event => { this._backdropPress = event.target === dialog; });
      dialog.addEventListener('click', event => { if (event.target === dialog && this._backdropPress) this._dismiss(); });
      dialog.addEventListener('close', () => {
        // A queued native close event must not clear a newly reopened card.
        if (!dialog.open && this._active) this._cleanup();
      });
      dialog.addEventListener('cancel', event => {
        // An open filter handles its own Escape before the dialog closes.
        event.preventDefault();
        if (!dialog.querySelector('.filter-select-menu[data-open="true"]')) this._dismiss();
      });
      this._back.addEventListener('click', () => { const previous = this._trail.pop(); if (previous) this._show(previous, false); });
    }

    _announceChange() { document.dispatchEvent(new Event('guide-panel-change')); }

    _cleanup() {
      this._revision += 1; this._controller?.abort();
      ['enter', 'exit'].forEach(phase => {
        this._dialog.style.removeProperty(`--dialog-${phase}-opacity`);
        this._dialog.style.removeProperty(`--dialog-${phase}-transform`);
        this._dialog.style.removeProperty(`--backdrop-${phase}-opacity`);
      });
      document.documentElement.classList.remove('guide-dialog-open');
      this._viewport.replaceChildren();
      this._active = null; this._trail = [];
      this._announceChange();
      this._opener?.focus({ preventScroll: true });
    }

    // Reopening during the exit animation resumes from the animation's current frame.
    _cancelPendingClose() {
      if (this._closeTimer === null) return;
      const dialog = this._dialog;
      const style = window.getComputedStyle(dialog);
      dialog.style.setProperty('--dialog-enter-opacity', style.opacity);
      dialog.style.setProperty('--dialog-enter-transform', style.transform);
      dialog.style.setProperty('--backdrop-enter-opacity', window.getComputedStyle(dialog, '::backdrop').opacity);
      window.clearTimeout(this._closeTimer);
      this._closeTimer = null;
      dialog.classList.remove('guide-closing');
    }

    _dismiss() {
      if (this._closeTimer !== null) return;
      const dialog = this._dialog;
      const reducedMotion = typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reducedMotion || !dialog.open) { dialog.close(); this._cleanup(); return; }
      const style = window.getComputedStyle(dialog);
      dialog.style.setProperty('--dialog-exit-opacity', style.opacity);
      dialog.style.setProperty('--dialog-exit-transform', style.transform);
      dialog.style.setProperty('--backdrop-exit-opacity', window.getComputedStyle(dialog, '::backdrop').opacity);
      dialog.classList.add('guide-closing');
      this._announceChange();
      this._closeTimer = window.setTimeout(() => {
        this._closeTimer = null;
        dialog.classList.remove('guide-closing');
        // Same synchronous close+cleanup as the instant path, so focus and scroll restore right away.
        dialog.close();
        this._cleanup();
      }, readCardExitAnimationMs());
    }

    // Shows the loading state and opens the dialog before the card content is ready.
    _beginShow(destination, remember) {
      if (remember && this._active && this._active.key !== destination.key) this._trail.push(this._active);
      this._active = destination;
      this._back.hidden = this._trail.length === 0;
      this._title.textContent = destination.title;
      this._viewport.replaceChildren(createTextElement('p', 'guide-loading', '正在打开卡片…'));
      this._viewport.setAttribute('aria-busy', 'true');
      if (!this._dialog.open) {
        document.documentElement.classList.add('guide-dialog-open');
        this._dialog.showModal();
      }
      this._close.focus({ preventScroll: true });
      this._announceChange();
    }

    // Fills a new panel from an inline template or by fetching the full page's <main>.
    async _populatePanel(panel, destination, requestController) {
      if (destination.template) {
        panel.append(destination.template.content.cloneNode(true));
        return;
      }
      const timeout = window.setTimeout(() => requestController.abort(), 10_000);
      try {
        const response = await fetch(destination.path, { signal: requestController.signal });
        if (!response.ok) throw new Error('Unable to load guide');
        const parsed = new DOMParser().parseFromString(await response.text(), 'text/html');
        const source = parsed.querySelector('main');
        if (!source || !parsed.documentElement.matches('[data-product="hainanu-2027-kaoyan-guide"]')) throw new Error('Invalid guide');
        panel.append(...Array.from(source.childNodes).map(node => document.importNode(node, true)));
      } finally {
        window.clearTimeout(timeout);
      }
    }

    // Builds, mounts and caches a panel; returns null when the request became stale.
    async _createPanel(destination, request, requestController) {
      const panel = createTextElement('div', 'guide-panel');
      panel.dataset.page = destination.page || 'home';
      await this._populatePanel(panel, destination, requestController);
      if (request !== this._revision || !this._dialog.open) return null;
      // Original page IDs are retained for source links; only one fetched panel is mounted.
      panel.querySelectorAll('script').forEach(node => node.remove());
      const updateList = panel.querySelector('[data-update-page-size]');
      if (updateList) updateList.dataset.updatePageSize = '4';
      this._viewport.replaceChildren(panel);
      initReadingGroups(panel, destination.page);
      initPage(panel);
      this._panels.set(destination.key, panel);
      return panel;
    }

    _renderLoadError(destination) {
      const error = createTextElement('div', 'guide-error');
      error.setAttribute('role', 'status');
      error.append(createTextElement('h3', '', '这张卡片暂时未能打开'),
        createTextElement('p', '', '请检查连接后重试，当前页面仍会保留。'));
      const retry = createTextElement('button', 'button button-primary', '重新加载');
      retry.type = 'button'; retry.addEventListener('click', () => this._show(destination, false)); error.append(retry);
      if (destination.path) {
        const link = createTextElement('a', 'text-link', '打开完整页面');
        link.href = destination.path + (destination.hash || ''); link.dataset.guideBypass = ''; error.append(link);
      }
      this._viewport.replaceChildren(error); this._viewport.removeAttribute('aria-busy');
    }

    async _show(destination, remember = true) {
      this._cancelPendingClose();
      const request = ++this._revision;
      this._controller?.abort(); this._controller = new AbortController();
      const requestController = this._controller;
      this._beginShow(destination, remember);
      try {
        let panel = this._panels.get(destination.key);
        if (panel) {
          this._viewport.replaceChildren(panel);
        } else {
          panel = await this._createPanel(destination, request, requestController);
          if (!panel) return;
        }
        panel.guideReveal?.(destination.hash);
        this._viewport.scrollTop = 0;
        this._viewport.removeAttribute('aria-busy');
        this._announceChange();
      } catch {
        if (request !== this._revision || !this._dialog.open) return;
        this._renderLoadError(destination);
      }
    }

    // Opens a same-site guide page or inline template as a card; ignores everything else.
    _onDocumentClick(event) {
      if (event.defaultPrevented || event.button > 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const local = event.target.closest('[data-guide-local]');
      if (local) {
        const template = document.getElementById(local.dataset.guideLocal);
        if (!template) return;
        event.preventDefault(); if (!this._dialog.open) this._opener = local;
        this._show({ key: template.id, title: template.dataset.title, template }); return;
      }
      const link = event.target.closest('a[href]');
      if (!link || link.target || link.hasAttribute('download') || link.hasAttribute('data-guide-bypass')) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      const page = url.pathname.split('/').pop().replace(/\.html$/, '');
      if (!GUIDE_PAGE_NAMES[page]) {
        if (url.pathname === window.location.pathname && url.hash) this._main.guideReveal(url.hash);
        return;
      }
      if (!this._dialog.open && page === document.body.dataset.page) {
        this._main.guideReveal(url.hash); return;
      }
      event.preventDefault();
      if (!this._dialog.open) this._opener = link;
      this._show({ key: page, page, path: `/${page}.html`, hash: url.hash, title: GUIDE_PAGE_NAMES[page] });
    }

    // Marks links that will open as a dialog so assistive tech announces the popup.
    _markPopupLinks() {
      document.querySelectorAll('a[href]').forEach(link => {
        const url = new URL(link.href, window.location.href);
        const page = url.pathname.split('/').pop().replace(/\.html$/, '');
        if (url.origin === window.location.origin && GUIDE_PAGE_NAMES[page] && page !== document.body.dataset.page) link.setAttribute('aria-haspopup', 'dialog');
      });
    }
  }

  // Expands collapsed <details> for printing and restores them afterwards.
  function initPrintExpansion() {
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
  }

  function initGuideCards() {
    if (typeof HTMLDialogElement === 'undefined' || !HTMLDialogElement.prototype.showModal) return;
    const main = document.querySelector('main');
    if (!main) return;
    initReadingGroups(main, document.body.dataset.page);
    main.guideReveal(window.location.hash);
    window.addEventListener('hashchange', () => main.guideReveal(window.location.hash));
    initPrintExpansion();
    document.body.classList.add('guide-cards-ready');
    new GuideCardDialog(main);
  }

  /**
   * Checklist progress, current-stage summary and deadline reminder of one rendered root.
   *
   * Reads and persists task checkboxes in localStorage (falling back to a per-session
   * state when storage is blocked), keeps several rendered roots in sync through the
   * guide-progress-change event, and re-renders the stage summary at every date or
   * deadline boundary. Created by initPage for the document and for each opened card.
   */
  class PageProgress {
    /**
     * @param {Document|HTMLElement} root Document or card panel that contains the progress markup.
     */
    constructor(root) {
      this._root = root;
      this._timelineElements = Array.from(root.querySelectorAll('[data-milestone-id]'));
      this._deadlinePanel = root.querySelector('#current-deadline');
      this._checkboxes = Array.from(root.querySelectorAll('.task-check[data-check-id]'));
      this._skipButtons = Array.from(root.querySelectorAll('[data-skip-check]'));
      this._progressStorage = null;
      this._checklistState = {};
      this._stageRefreshTimer = null;
      this._loadInitialState();
    }

    _loadInitialState() {
      try {
        if (sessionProgressOnly) {
          this._checklistState = mergeChecklistState(sessionChecklistState, {});
          showSessionStorageWarning(this._root);
        } else {
          this._progressStorage = window.localStorage;
          this._checklistState = readChecks(this._progressStorage, STORAGE_KEY, CHECKLIST_IDS);
        }
      } catch {
        // Some restricted or file origins block access at the property getter.
        this._useSessionState();
      }
    }

    // Switches to the in-memory state after storage became unavailable.
    _useSessionState() {
      this._progressStorage = null;
      sessionProgressOnly = true;
      this._checklistState = mergeChecklistState(sessionChecklistState, {});
      showSessionStorageWarning(this._root);
    }

    /** Binds the controls and listeners, renders once and schedules the next stage refresh. */
    start() {
      this._checkboxes.forEach((checkbox) => checkbox.addEventListener('change', () => this._persistChecks({
        [checkbox.dataset.checkId]: checkbox.checked
      })));
      this._skipButtons.forEach((button) => button.addEventListener('click', () => {
        const id = button.dataset.skipCheck;
        if (optionalChecklistIds.has(id)) this._persistChecks({ [id]: this._checklistState[id] === 'na' ? false : 'na' });
      }));
      this._renderProgress();
      document.addEventListener('guide-progress-change', (event) => {
        this._checklistState = mergeChecklistState(event.detail, {});
        this._renderProgress();
        this._scheduleStageRefresh();
      });
      this._scheduleStageRefresh();
      this._bindLifecycle();
      this._bindResetButton();
    }

    _bindLifecycle() {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this._stopStageRefresh();
        else this._refreshAndReschedule();
      });
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('pageshow', () => this._refreshAndReschedule());
        window.addEventListener('pagehide', () => this._stopStageRefresh());
        window.addEventListener('storage', (event) => {
          if (this._progressStorage && event.storageArea === this._progressStorage &&
              (event.key === STORAGE_KEY || event.key === null)) {
            this._refreshAndReschedule();
          }
        });
      }
    }

    _bindResetButton() {
      const resetButton = this._root.querySelector('#reset-progress');
      resetButton?.addEventListener('click', () => {
        const resetAll = resetButton.dataset.resetScope === 'all';
        const confirmation = resetAll
          ? '确定清空全部 21 项任务状态（含不适用状态）吗？此操作无法撤销。'
          : '确定清空本页所有已勾选进度吗？此操作无法撤销。';
        if (!window.confirm(confirmation)) return;
        this._checkboxes.forEach((checkbox) => { checkbox.checked = false; });
        if (resetAll) {
          this._persistChecks(Object.fromEntries(CHECKLIST_IDS.map((id) => [id, false])));
          return;
        }
        this._persistChecks();
      });
    }

    _renderTimelineMarks(activeMilestones) {
      this._timelineElements.forEach((element) => {
        const isActive = activeMilestones.some(item => item.id === element.dataset.milestoneId);
        element.classList.toggle('is-current', isActive);
        if (isActive) element.setAttribute('aria-current', 'step');
        else element.removeAttribute('aria-current');
      });
    }

    _renderStageSummary(stage) {
      const { activeMilestones, nextMilestone, reviewPending, state } = stage;
      const stageName = this._root.querySelector('#current-stage-name');
      const stageDetail = this._root.querySelector('#current-stage-detail');
      const nextName = this._root.querySelector('#next-stage-name');
      const nextDays = this._root.querySelector('#next-stage-days');
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
    }

    _renderDeadlinePanel(scheduledMilestones, now, checks) {
      const panel = this._deadlinePanel;
      if (!panel) return;
      const root = this._root;
      const notice = getDeadlineNotice(scheduledMilestones, now, checks);
      panel.hidden = !notice;
      if (!notice) return;
      panel.dataset.state = notice.state;
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

    _renderCurrentStage(checks) {
      const now = new Date();
      const stage = describeCurrentStage(checks, now);
      this._renderTimelineMarks(stage.activeMilestones);
      this._renderStageSummary(stage);
      this._renderDeadlinePanel(stage.scheduledMilestones, now, checks);
    }

    _renderChecklistControls() {
      const state = this._checklistState;
      this._checkboxes.forEach((checkbox) => {
        const value = state[checkbox.dataset.checkId];
        checkbox.checked = value === true;
        checkbox.disabled = value === 'na';
        checkbox.closest('label')?.setAttribute('data-print-state', value === 'na' ? '不适用' : checkbox.checked ? '已完成' : '未完成');
      });
      this._skipButtons.forEach((button) => {
        const skipped = state[button.dataset.skipCheck] === 'na';
        button.hidden = false;
        button.setAttribute('aria-pressed', String(skipped));
        button.textContent = skipped ? '已设为不适用 · 恢复此项' : '此项不适用';
      });
    }

    _renderProgress() {
      sessionChecklistState = this._checklistState;
      if (sessionProgressOnly) showSessionStorageWarning(this._root);
      const { completed, total, percent } = countChecklistProgress(this._checklistState);
      this._renderCurrentStage(this._checklistState);
      const bar = this._root.querySelector('#progress-bar');
      const text = this._root.querySelector('#progress-text');
      const count = this._root.querySelector('#progress-count');
      if (bar) {
        bar.style.width = `${percent}%`;
        bar.parentElement?.setAttribute('aria-valuenow', String(percent));
      }
      if (text) text.textContent = `${percent}%`;
      const skipped = CHECKLIST_IDS.length - total;
      if (count) count.textContent = `${completed} / ${total} 项${skipped ? `（${skipped} 项不适用）` : ''}`;
      this._renderChecklistControls();
    }

    _readCheckboxValues() {
      return Object.fromEntries(this._checkboxes.map((checkbox) => [checkbox.dataset.checkId, checkbox.checked]));
    }

    _persistChecks(pageValues = this._readCheckboxValues()) {
      if (sessionProgressOnly) this._progressStorage = null;
      if (!this._progressStorage) {
        this._checklistState = mergeChecklistState(this._checklistState, pageValues);
      } else {
        try {
          this._checklistState = mergeChecklistState(
            readChecks(this._progressStorage, STORAGE_KEY, CHECKLIST_IDS),
            pageValues
          );
          this._progressStorage.setItem(STORAGE_KEY, JSON.stringify(this._checklistState));
        } catch {
          this._checklistState = mergeChecklistState(this._checklistState, pageValues);
          this._progressStorage = null;
          sessionProgressOnly = true;
          // Storage may be disabled in private or hardened browser modes.
          showSessionStorageWarning(this._root);
        }
      }
      this._renderProgress();
      this._scheduleStageRefresh();
      if (typeof document.dispatchEvent === 'function') {
        document.dispatchEvent(new CustomEvent('guide-progress-change', { detail: this._checklistState }));
      }
    }

    _refreshChecklist() {
      if (sessionProgressOnly) {
        this._progressStorage = null;
        this._checklistState = mergeChecklistState(sessionChecklistState, {});
      }
      if (this._progressStorage) {
        try {
          this._checklistState = readChecks(this._progressStorage, STORAGE_KEY, CHECKLIST_IDS);
        } catch {
          // Keep the last usable state when storage becomes inaccessible.
          this._progressStorage = null;
          sessionProgressOnly = true;
          showSessionStorageWarning(this._root);
        }
      }
      this._renderProgress();
    }

    _refreshAndReschedule() {
      this._refreshChecklist();
      this._scheduleStageRefresh();
    }

    _stopStageRefresh() {
      if (this._stageRefreshTimer !== null) window.clearTimeout(this._stageRefreshTimer);
      this._stageRefreshTimer = null;
    }

    // Wakes at the next Beijing midnight, milestone cutoff or countdown minute.
    _scheduleStageRefresh() {
      this._stopStageRefresh();
      if (document.visibilityState === 'hidden') return;
      const now = new Date();
      const timestamp = now.getTime();
      const nextMidnight = toUtcDay(getBeijingDateString(now)) + DAY_MS - BEIJING_OFFSET_MS;
      const upcomingCutoffs = milestones.map(item => Date.parse(item.endsAt || item.deadlineAt))
        .filter(at => at > timestamp);
      const panel = this._deadlinePanel;
      const countdownTick = panel && !panel.hidden && panel.dataset.state !== 'closed'
        ? timestamp + 60_000 - timestamp % 60_000 : Infinity;
      const nextRefresh = Math.min(nextMidnight, countdownTick, ...upcomingCutoffs);
      this._stageRefreshTimer = window.setTimeout(() => {
        this._stageRefreshTimer = null;
        this._refreshAndReschedule();
      }, Math.max(1, nextRefresh - timestamp));
    }
  }

  function initTimelineFilters(root) {
    const filterButtons = Array.from(root.querySelectorAll('[data-filter]'));
    const categoryItems = Array.from(root.querySelectorAll('[data-milestone-id]')).map((element) => ({
      id: element.dataset.milestoneId,
      category: element.dataset.category,
      element
    }));
    filterButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const visibleIds = new Set(filterTimeline(categoryItems, button.dataset.filter).map((item) => item.id));
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
  }

  function initPrintButtons(root) {
    root.querySelectorAll('[data-print]').forEach((button) => {
      button.addEventListener('click', () => window.print());
    });
  }

  // Highlights the table-of-contents link of the section currently in view (document only).
  function initTocHighlight(root) {
    if (root !== document || !('IntersectionObserver' in window)) return;
    const navLinks = Array.from(root.querySelectorAll('.page-toc a[href^="#"]'));
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
    new PageProgress(root).start();
    initTimelineFilters(root);
    initPrintButtons(root);
    initTocHighlight(root);
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
