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
    formatSourceHealthTitle,
    describeCurrentStage
  } = core;
  const dom = typeof module !== 'undefined' && module.exports ? require('./guide-dom.js') : window.HnuGuideDom;
  const {
    createTextElement,
    showSessionStorageWarning
  } = dom;
  const notices = typeof module !== 'undefined' && module.exports ? require('./guide-notices.js') : window.HnuGuideNotices;
  const { initOfficialUpdates } = notices;

  const STORAGE_KEY = 'hainanu-2027-kaoyan-progress-v1';
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
    menu.addEventListener('click', (event) => {
      if (event.target?.closest?.('a, button') && toggle.getAttribute('aria-expanded') === 'true') {
        setExpanded(false);
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented || toggle.getAttribute('aria-expanded') !== 'true' || document.querySelector('dialog[open]')) return;
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
      const focusTarget = this._opener && typeof this._opener.getClientRects === 'function'
        && !this._opener.getClientRects().length && this._opener.closest?.('[data-site-nav-menu]')
        ? document.querySelector('[data-site-nav-toggle]') || this._opener
        : this._opener;
      focusTarget?.focus({ preventScroll: true });
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
      const url = this._parseLinkUrl(link);
      if (!url || url.protocol !== window.location.protocol || url.origin !== window.location.origin) return;
      const page = url.pathname.split('/').pop().replace(/\.html$/, '');
      if (!GUIDE_PAGE_NAMES[page]) {
        if (url.pathname === window.location.pathname && url.hash) this._main.guideReveal(url.hash);
        return;
      }
      if (!this._dialog.open && page === document.body.dataset.page) {
        this._main.guideReveal(url.hash); return;
      }
      if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') return;
      event.preventDefault();
      if (!this._dialog.open) this._opener = link;
      this._show({ key: page, page, path: `/${page}.html`, hash: url.hash, title: GUIDE_PAGE_NAMES[page] });
    }

    _parseLinkUrl(link) {
      try {
        return new URL(link.href, window.location.href);
      } catch {
        return null;
      }
    }

    // Marks links that will open as a dialog so assistive tech announces the popup.
    _markPopupLinks() {
      if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') return;
      document.querySelectorAll('a[href]').forEach(link => {
        const url = this._parseLinkUrl(link);
        if (!url || url.origin !== window.location.origin) return;
        const page = url.pathname.split('/').pop().replace(/\.html$/, '');
        if (GUIDE_PAGE_NAMES[page] && page !== document.body.dataset.page) link.setAttribute('aria-haspopup', 'dialog');
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
