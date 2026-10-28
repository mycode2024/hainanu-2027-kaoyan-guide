(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./guide-core.js'), require('./guide-dom.js'));
  } else {
    root.HnuGuideNotices = factory(root.HnuGuideCore, root.HnuGuideDom);
  }
})(typeof window !== 'undefined' ? window : globalThis, function (core, dom) {
  'use strict';

  const {
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
    describeUpdateCycle
  } = core;
  const {
    createTextElement,
    showSessionStorageWarning
  } = dom;

  const LAST_SEEN_UPDATES_KEY = 'hainanu-2027-kaoyan-last-seen-v1';

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
      this._overdueRetryTimer = null;
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
      if (this._overdueRetryTimer) window.clearTimeout(this._overdueRetryTimer);
      this._overdueRetryTimer = null;
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
      if (wasFirstRender && !this._isCloud && payload.freshness.isOverdue) {
        if (this._overdueRetryTimer) window.clearTimeout(this._overdueRetryTimer);
        this._overdueRetryTimer = window.setTimeout(() => {
          this._overdueRetryTimer = null;
          if (!this._isInactive()) this._loadUpdates(true);
        }, 500);
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

  return {
    initOfficialUpdates
  };
});
