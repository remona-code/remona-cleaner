/* ==========================================================================
   reMona (AICleaner) — interface logic
   The renderer cannot touch the filesystem; all work runs in the main process
   through the preload bridge (window.aicleaner).

   Text is never hard-coded here: the main process layers the selected language
   over the English catalogue and sends a single dictionary. If a key is missing
   the dictionary holds the English string; if that is missing too the key itself
   appears — an untranslated language never breaks the app, it only shows English.
   ========================================================================== */
'use strict';

const api = window.aicleaner;

/* --------------------------------------------------------------- i18n */
/** Flat dictionary from the main process: { 'nav.dashboard': 'Dashboard', ... } */
let dict = {};
/** Active language code (also used for Intl formats). */
let locale = 'en';
/** Is this a right-to-left language (ar, fa). */
let rtl = false;

/** Translates a key; `{name}` placeholders are filled from `vars`. */
function t(key, vars) {
  const name = String(key || '');
  const text = Object.prototype.hasOwnProperty.call(dict, name) ? dict[name] : name;
  if (vars === undefined || vars === null) return String(text);
  return String(text).replace(/\{(\w+)\}/g, (match, token) =>
    Object.prototype.hasOwnProperty.call(vars, token) ? String(vars[token]) : match
  );
}

/** Language-aware decimal format: tr "1.234,5" · en "1,234.5" */
function intlNumber(value, fractionDigits) {
  const digits = fractionDigits || 0;
  const n = Number(value) || 0;
  try {
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(n);
  } catch {
    return n.toFixed(digits);
  }
}

const fmtNum = (value) => intlNumber(Math.round(Number(value) || 0), 0);
const fmtDec = (value) => intlNumber(Number(value) || 0, 1);

/** 1536 -> '1.5 KB' (same as the engine's humanSize, but language-aware) */
function human(bytes) {
  let n = Number(bytes) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  for (let i = 0; i < units.length; i += 1) {
    if (Math.abs(n) < 1024 || units[i] === 'TB') {
      if (units[i] === 'B') return `${fmtNum(Math.trunc(n))} ${units[i]}`;
      return `${fmtDec(n)} ${units[i]}`;
    }
    n /= 1024;
  }
  return `${fmtDec(n)} TB`;
}

/** Second timestamp -> date-time formatted for the language. */
function fmtDate(seconds) {
  const value = Number(seconds);
  if (!value) return '-';
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) return '-';
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** Fills the data-i18n* attributes in the HTML from the dictionary. */
function applyStaticTranslations(root = document) {
  for (const node of $$('[data-i18n]', root)) node.textContent = t(node.dataset.i18n);
  for (const node of $$('[data-i18n-title]', root)) node.title = t(node.dataset.i18nTitle);
  for (const node of $$('[data-i18n-ph]', root)) node.placeholder = t(node.dataset.i18nPh);
  for (const node of $$('[data-i18n-aria]', root)) node.setAttribute('aria-label', t(node.dataset.i18nAria));
}

/** Applies the dictionary bundle (language code, direction, dictionary). */
function applyBundle(data) {
  if (!data) return;
  dict = data.dict || {};
  locale = data.locale || 'en';
  rtl = Boolean(data.rtl);
  document.documentElement.lang = locale;
  document.documentElement.dir = rtl ? 'rtl' : 'ltr';
}

/* --------------------------------------------------------------- helpers */
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style') Object.assign(node.style, value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function icon(name, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  if (cls) svg.setAttribute('class', cls);
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${name}`);
  svg.append(use);
  return svg;
}

const CAT_ICON = {
  flask: 'i-flask',
  windows: 'i-windows',
  globe: 'i-globe',
  refresh: 'i-refresh',
  image: 'i-image',
  bolt: 'i-bolt',
  burst: 'i-burst',
  scroll: 'i-scroll',
  trash: 'i-trash',
  download: 'i-download',
  elephant: 'i-box',
  copy: 'i-copy',
};

/** Risk key -> translated label. */
const riskLabel = (key) => t(`risk.${key}`);

/**
 * Category text. A scan result is written to disk, so it may carry a name
 * fixed at scan time; when the key is present the text is regenerated in the
 * selected language, otherwise (old records) the stored text is used.
 */
function catName(cat) {
  if (cat.name_key && Object.prototype.hasOwnProperty.call(dict, cat.name_key)) return t(cat.name_key);
  return cat.name;
}

function catDesc(cat) {
  if (cat.desc_key && Object.prototype.hasOwnProperty.call(dict, cat.desc_key)) {
    return t(cat.desc_key, cat.desc_vars);
  }
  return cat.description;
}

const INSIGHT_ICON = { win: 'i-check-circle', warn: 'i-alert', ok: 'i-shield', info: 'i-info' };

/* --------------------------------------------------------------- durum */
const state = {
  view: 'dashboard',
  info: null,
  settings: null,
  scan: null,
  analysis: null,
  scanning: false,
  cleaning: false,
  selectedCategories: new Set(),
  selectedItems: new Set(),
  expanded: new Set(),
  riskFilter: 'all',
  search: '',
  cleanMode: 'quarantine',
  vaultUsage: null,
  vaultSessions: [],
  history: [],
  safeIds: [],
  catNames: {},
  deep: false,
  chatBusy: false,
  aiProvider: 'auto',
  aiConfig: null,
  language: 'auto',
  locales: [],
  systemLocale: '',
};

/* --------------------------------------------------------------- bildirim */
function toast({ kind = 'info', title, text, timeout = 5200 }) {
  const iconName = { success: 'i-check-circle', warn: 'i-alert', error: 'i-alert', info: 'i-info' }[kind];
  const node = el('div', { class: `toast toast--${kind}` }, [
    el('span', { class: 'toast__icon' }, [icon(iconName)]),
    el('div', { class: 'toast__body' }, [
      el('strong', { text: title }),
      text ? el('p', { text }) : null,
    ]),
  ]);
  $('#toasts').append(node);
  const remove = () => {
    node.classList.add('is-out');
    setTimeout(() => node.remove(), 300);
  };
  setTimeout(remove, timeout);
  node.addEventListener('click', remove);
}

/* --------------------------------------------------------------- modal */
function ask({ title, text, iconName = 'i-alert', danger = false, confirmLabel = null, body = null }) {
  return new Promise((resolve) => {
    const modal = $('#modal');
    $('#modalTitle').textContent = title;
    $('#modalText').textContent = text || '';

    const iconWrap = $('#modalIcon');
    iconWrap.className = `modal__icon${danger ? ' modal__icon--danger' : ''}`;
    iconWrap.replaceChildren(icon(iconName));

    const bodyNode = $('#modalBody');
    bodyNode.replaceChildren(...(body ? [].concat(body) : []));

    const confirmBtn = $('#modalConfirm');
    confirmBtn.textContent = confirmLabel || t('btn.confirm');
    confirmBtn.className = danger ? 'btn btn--danger' : 'btn btn--primary';

    const close = (value) => {
      modal.hidden = true;
      $('#modalCancel').removeEventListener('click', onCancel);
      confirmBtn.removeEventListener('click', onConfirm);
      $('.modal__scrim', modal).removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onCancel = () => close(false);
    const onConfirm = () => close(true);
    const onKey = (event) => {
      if (event.key === 'Escape') close(false);
      else if (event.key === 'Enter') close(true);
    };

    $('#modalCancel').addEventListener('click', onCancel);
    confirmBtn.addEventListener('click', onConfirm);
    $('.modal__scrim', modal).addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);

    modal.hidden = false;
    confirmBtn.focus();
  });
}

/* --------------------------------------------------------------- gezinme */
const VIEWS = ['dashboard', 'categories', 'quarantine', 'history', 'assistant', 'settings'];

function go(view) {
  if (!VIEWS.includes(view)) return;
  state.view = view;
  $$('.nav__item').forEach((item) => item.classList.toggle('is-active', item.dataset.view === view));
  $$('.view').forEach((section) => section.classList.toggle('is-active', section.dataset.view === view));
  $('#viewTitle').textContent = t(`view.${view}.title`);
  $('#viewSubtitle').textContent = t(`view.${view}.subtitle`);
  $('#scroller').scrollTop = 0;
}

/* --------------------------------------------------------------- selection */
function selectedTotals() {
  const cats = state.scan ? state.scan.categories : [];
  let bytes = 0;
  let files = 0;
  const risk = { safe: 0, caution: 0, risky: 0 };

  for (const cat of cats) {
    if (state.selectedCategories.has(cat.id)) {
      bytes += cat.size;
      files += cat.file_count;
      risk[cat.risk] += cat.size;
      continue;
    }
    for (const item of cat.items || []) {
      if (state.selectedItems.has(item.id)) {
        bytes += item.size;
        files += 1;
        risk[cat.risk] += item.size;
      }
    }
  }
  return { bytes, files, risk };
}

function categorySelectionState(cat) {
  if (state.selectedCategories.has(cat.id)) return 'on';
  const items = cat.items || [];
  if (!items.length) return 'off';
  const picked = items.filter((item) => state.selectedItems.has(item.id)).length;
  if (picked === 0) return 'off';
  if (picked === items.length) return 'on';
  return 'mixed';
}

function renderDock() {
  const dock = $('#dock');
  const { bytes, files, risk } = selectedTotals();

  if (!bytes && !files) {
    dock.hidden = true;
    return;
  }
  dock.hidden = false;

  $('#dockSize').textContent = human(bytes);
  $('#dockMeta').textContent = t('dock.files', {
    files: fmtNum(files),
    cats: fmtNum(state.selectedCategories.size),
  });
  $('#dockClean').disabled = state.cleaning;

  const chips = $('#dockRisk');
  chips.replaceChildren(
    ...['safe', 'caution', 'risky']
      .filter((key) => risk[key] > 0)
      .map((key) => el('span', { class: `pill pill--${key}`, text: `${riskLabel(key)} ${human(risk[key])}` }))
  );

  $$('#dockMode button').forEach((btn) => btn.classList.toggle('is-active', btn.dataset.mode === state.cleanMode));
  $('#dockClean').classList.toggle('btn--danger', state.cleanMode === 'delete');
  $('#dockClean').classList.toggle('btn--primary', state.cleanMode !== 'delete');

  const hasSel = bytes > 0 || files > 0;
  $('#selectSafeBtn').disabled = !state.scan;
  $('#clearSelBtn').disabled = !hasSel;
  $('#quickSelectBtn').disabled = !state.scan || !state.analysis;
}

function clearSelection() {
  state.selectedCategories.clear();
  state.selectedItems.clear();
  renderDock();
}

/* --------------------------------------------------------------- panel */
function renderRing() {
  const disk = state.scan ? state.scan.disk.primary : null;
  const total = state.scan ? state.scan.totals.all : 0;

  const CIRC_DISK = 603.19;
  const CIRC_RECLAIM = 496.37;

  if (!disk || !disk.total) {
    $('#diskPercent').textContent = '—';
    $('#diskFree').textContent = '—';
    $('#ringDisk').style.strokeDashoffset = CIRC_DISK;
    $('#ringReclaim').style.strokeDashoffset = CIRC_RECLAIM;
    return;
  }

  const percent = Number(disk.percent) || 0;
  $('#diskPercent').textContent = fmtNum(percent);
  $('#ringDisk').style.strokeDashoffset = String(CIRC_DISK * (1 - Math.min(1, percent / 100)));

  // Inner ring: the trash's "contribution to free space" — how far free space grows after cleanup?
  const reclaimShare = Math.min(1, total / Math.max(1, disk.free + total));
  $('#ringReclaim').style.strokeDashoffset = String(CIRC_RECLAIM * (1 - reclaimShare));

  const after = disk.free + total;
  $('#diskFree').textContent = t('disk.freeAfter', { free: human(disk.free), after: human(after) });
  $('#diskLabel').textContent = total ? t('disk.after') : t('disk.used');
}

function animateValue(node, toBytes) {
  const from = Number(node.dataset.bytes || 0);
  if (from === toBytes) {
    node.textContent = human(toBytes);
    return;
  }
  node.dataset.bytes = String(toBytes);
  const steps = 24;
  let step = 0;
  const timer = setInterval(() => {
    step += 1;
    const eased = 1 - (1 - step / steps) ** 3;
    node.textContent = human(from + (toBytes - from) * eased);
    if (step >= steps) {
      clearInterval(timer);
      node.textContent = human(toBytes);
    }
  }, 24);
}

function renderDashboard() {
  const scan = state.scan;
  const analysis = state.analysis;

  renderRing();

  const totals = scan ? scan.totals : null;
  animateValue($('#statTotal'), totals ? totals.all : 0);
  animateValue($('#statSafe'), totals ? totals.safe : 0);
  animateValue($('#statVault'), state.vaultUsage ? state.vaultUsage.size : 0);

  $('#statTotalMeta').textContent = scan
    ? t('stat.totalScanned', { sec: fmtNum(scan.duration) })
    : t('stat.totalWaiting');
  $('#statCount').textContent = totals ? fmtNum(totals.file_count) : '—';
  $('#statVaultMeta').textContent = state.vaultUsage
    ? t('stat.vaultSessions', { count: fmtNum(state.vaultUsage.sessions) })
    : t('stat.vaultMeta');

  // hero metinleri
  if (analysis) {
    $('#heroTitle').textContent = analysis.potential.recommended
      ? t('dash.doneTitle', { size: human(analysis.potential.recommended) })
      : t('dash.cleanTitle');
    $('#heroSummary').textContent = analysis.summary;
  } else {
    $('#heroTitle').textContent = t('dash.readyTitle');
    $('#heroSummary').textContent = t('dash.readyText');
  }

  // insights
  const insights = analysis ? analysis.insights : [];
  $('#insightCount').textContent = insights.length
    ? t('dash.insightCount', { count: fmtNum(insights.length) })
    : '—';
  $('#insights').replaceChildren(
    ...(insights.length
      ? insights.map((item, index) =>
          el('div', { class: `insight insight--${item.level}`, style: { animationDelay: `${index * 45}ms` } }, [
            el('span', { class: 'insight__icon' }, [icon(INSIGHT_ICON[item.level] || 'i-info')]),
            el('div', { class: 'insight__body' }, [
              el('strong', { text: item.title }),
              el('p', { text: item.text }),
            ]),
          ])
        )
      : [
          el('div', { class: 'empty' }, [
            icon('i-info'),
            el('p', { text: t('empty.insights') }),
          ]),
        ])
  );

  // category distribution
  const withSize = scan ? scan.categories.filter((cat) => cat.size > 0).sort((a, b) => b.size - a.size) : [];
  const top = withSize.slice(0, 7);
  const max = top.length ? top[0].size : 1;

  $('#breakdown').replaceChildren(
    ...(top.length
      ? top.map((cat) => {
          const row = el('div', { class: 'break', onclick: () => go('categories') }, [
            el('div', { class: 'break__name' }, [
              el('span', { class: `break__dot break__dot--${cat.risk}` }),
              el('span', { text: catName(cat) }),
            ]),
            el('span', { class: 'break__size', text: human(cat.size) }),
            el('div', { class: 'break__bar' }, [
              el('span', {
                class: `break__fill break__fill--${cat.risk}`,
                style: { width: `${Math.max(3, Math.round((cat.size / max) * 100))}%` },
              }),
            ]),
          ]);
          return row;
        })
      : [el('div', { class: 'empty' }, [icon('i-info'), el('p', { text: t('empty.noData') })])])
  );

  // AI suggestion card
  const reclaim = $('#reclaimCard');
  if (analysis && analysis.recommended_ids.length) {
    reclaim.hidden = false;
    $('#reclaimTitle').textContent = t('dash.reclaimTitleFor', { size: human(analysis.potential.recommended) });
    $('#reclaimText').textContent = t('dash.reclaimText', {
      count: fmtNum(analysis.recommended_ids.length),
    });
  } else {
    reclaim.hidden = true;
  }

  renderDock();
}

/* --------------------------------------------------------------- kategoriler */
function renderCategories() {
  const list = $('#catList');
  const scan = state.scan;

  if (!scan) {
    list.replaceChildren(
      el('div', { class: 'empty empty--lg' }, [
        icon('i-layers'),
        el('h4', { text: t('empty.catWaitingTitle') }),
        el('p', { text: t('empty.catWaitingText') }),
      ])
    );
    return;
  }

  const needle = state.search.trim().toLowerCase();
  const visible = scan.categories.filter((cat) => {
    if (state.riskFilter !== 'all' && cat.risk !== state.riskFilter) return false;
    if (!needle) return true;
    if (catName(cat).toLowerCase().includes(needle)) return true;
    if (catDesc(cat).toLowerCase().includes(needle)) return true;
    return (cat.items || []).some((item) => item.name.toLowerCase().includes(needle));
  });

  if (!visible.length) {
    list.replaceChildren(
      el('div', { class: 'empty empty--lg' }, [
        icon('i-search'),
        el('h4', { text: t('empty.noMatchTitle') }),
        el('p', { text: t('empty.noMatchText') }),
      ])
    );
    return;
  }

  list.replaceChildren(...visible.map((cat) => renderCategoryCard(cat)));
  renderDock();
}

function renderCategoryCard(cat) {
  const analysis = state.analysis ? state.analysis.categories[cat.id] : null;
  const confidence = analysis ? analysis.confidence : 0;
  const verdict = analysis ? analysis.verdict_label : '—';
  const scoreLevel = confidence >= 80 ? 'safe' : confidence >= 50 ? 'caution' : 'risky';
  const isOpen = state.expanded.has(cat.id);
  const isEmpty = cat.size === 0;
  const selState = categorySelectionState(cat);

  const checkbox = el('button', {
    class: `checkbox${selState === 'on' ? ' is-on' : selState === 'mixed' ? ' is-mixed' : ''}`,
    title: selState === 'on' ? t('cat.deselectCategory') : t('cat.selectCategory'),
    'aria-label': t('cat.select'),
    onclick: (event) => {
      event.stopPropagation();
      toggleCategory(cat);
    },
  }, [icon(selState === 'mixed' ? 'i-minus' : 'i-check')]);

  const scoreSvg = (() => {
    const wrap = el('div', { class: `score score--${scoreLevel}` });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 46 46');
    const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    track.setAttribute('class', 'score__track');
    track.setAttribute('cx', '23');
    track.setAttribute('cy', '23');
    track.setAttribute('r', '19');
    const fill = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    fill.setAttribute('class', 'score__fill');
    fill.setAttribute('cx', '23');
    fill.setAttribute('cy', '23');
    fill.setAttribute('r', '19');
    fill.style.strokeDashoffset = String(119.4 * (1 - confidence / 100));
    svg.append(track, fill);
    wrap.append(svg, el('span', { class: 'score__num', text: String(confidence) }));
    return wrap;
  })();

  const head = el('button', { class: 'cat__head', onclick: () => toggleExpand(cat.id) }, [
    el('span', { class: 'cat__check' }, [checkbox]),
    el('span', { class: 'cat__icon' }, [icon(CAT_ICON[cat.icon] || 'i-layers')]),
    el('div', { class: 'cat__info' }, [
      el('div', { class: 'cat__title' }, [
        el('strong', { text: catName(cat) }),
        el('span', { class: `pill pill--${cat.risk}`, text: riskLabel(cat.risk) }),
        analysis && !isEmpty
          ? el('span', {
              class: 'pill pill--accent',
              text: t('cat.confidence', { percent: fmtNum(confidence), verdict }),
            })
          : null,
        cat.deep_only && !state.deep ? el('span', { class: 'pill pill--ghost', text: t('cat.deepOnly') }) : null,
      ]),
      el('div', { class: 'cat__desc' }, [
        cat.note ? el('span', { class: 'cat__note', text: cat.note }) : catDesc(cat),
      ]),
    ]),
    el('div', { class: 'cat__score' }, [
      scoreSvg,
      el('div', { class: 'cat__size' }, [
        el('strong', { text: human(cat.size) }),
        el('span', { text: t('cat.files', { count: fmtNum(cat.file_count) }) }),
      ]),
    ]),
    icon('i-chevron', 'cat__chevron'),
  ]);

  const card = el('article', {
    class: `cat cat--${cat.risk}${isOpen ? ' is-open' : ''}${isEmpty ? ' is-empty' : ''}` +
           `${selState !== 'off' ? ' is-selected' : ''}`,
    dataset: { cat: cat.id },
  }, [head]);

  if (isOpen && cat.items && cat.items.length) {
    card.append(renderFiles(cat));
  } else if (isOpen) {
    card.append(
      el('div', { class: 'cat__body' }, [
        el('div', { class: 'empty' }, [icon('i-info'), el('p', { text: cat.note || t('cat.noFiles') })]),
      ])
    );
  }

  return card;
}

function renderFiles(cat) {
  const head = el('div', { class: 'files__head' }, [
    el('span', { text: '' }),
    el('span', { text: t('cat.file') }),
    el('span', { text: t('cat.size') }),
    el('span', { text: t('cat.modified') }),
    el('span', { text: '' }),
  ]);

  const rows = (cat.items || []).map((item) => {
    const catSelected = state.selectedCategories.has(cat.id);
    const isOn = catSelected || state.selectedItems.has(item.id);
    const checkbox = el('button', {
      class: `checkbox${isOn ? ' is-on' : ''}`,
      'aria-label': t('cat.selectFile'),
      onclick: (event) => {
        event.stopPropagation();
        toggleItem(cat, item);
      },
    }, [icon('i-check')]);

    return el('div', { class: `file${isOn ? ' is-on' : ''}` }, [
      checkbox,
      el('div', { class: 'file__name', title: item.path }, [
        el('strong', { text: item.name }),
        el('span', { text: item.path }),
      ]),
      el('span', { class: 'file__size', text: human(item.size) }),
      el('span', {
        class: 'file__age',
        text: item.age_days === 0 ? t('cat.today') : t('cat.daysAgo', { count: fmtNum(item.age_days) }),
      }),
      el('div', { class: 'file__act' }, [
        el('button', {
          title: t('cat.reveal'),
          'aria-label': t('cat.revealAria'),
          onclick: (event) => {
            event.stopPropagation();
            api.app.reveal(item.path).then((res) => {
              if (res && !res.ok) toast({ kind: 'warn', title: t('toast.revealFailed'), text: res.error });
            });
          },
        }, [icon('i-external')]),
      ]),
    ]);
  });

  const body = el('div', { class: 'files' }, [head, ...rows]);

  if (cat.items_truncated) {
    body.append(
      el('div', {
        class: 'files__more',
        text: t('cat.moreFiles', { count: fmtNum(cat.items_truncated) }),
      })
    );
  }

  return el('div', { class: 'cat__body' }, [body]);
}

function toggleExpand(catId) {
  if (state.expanded.has(catId)) state.expanded.delete(catId);
  else state.expanded.add(catId);
  renderCategories();
}

function toggleCategory(cat) {
  const selState = categorySelectionState(cat);
  if (selState === 'on') {
    state.selectedCategories.delete(cat.id);
    for (const item of cat.items || []) state.selectedItems.delete(item.id);
  } else {
    if (cat.size > 0) state.selectedCategories.add(cat.id);
    for (const item of cat.items || []) state.selectedItems.delete(item.id);
  }
  renderCategories();
}

function toggleItem(cat, item) {
  if (state.selectedCategories.has(cat.id)) {
    // The whole category was selected and one file is removed:
    // turn the remaining files into individual selections.
    state.selectedCategories.delete(cat.id);
    for (const other of cat.items || []) {
      if (other.id !== item.id) state.selectedItems.add(other.id);
    }
    if (cat.items_truncated) {
      toast({
        kind: 'warn',
        title: t('toast.partialTitle'),
        text: t('toast.partialText', { count: fmtNum(cat.items_truncated) }),
      });
    }
  } else if (state.selectedItems.has(item.id)) {
    state.selectedItems.delete(item.id);
  } else {
    state.selectedItems.add(item.id);
  }
  renderCategories();
}

/* --------------------------------------------------------------- karantina */
function renderVault() {
  const usage = state.vaultUsage;
  $('#vaultSize').textContent = usage ? human(usage.size) : '—';
  $('#vaultSessions').textContent = usage ? fmtNum(usage.sessions) : '—';
  $('#vaultFiles').textContent = usage ? fmtNum(usage.files) : '—';

  const list = $('#vaultList');
  if (!state.vaultSessions.length) {
    list.replaceChildren(
      el('div', { class: 'empty empty--lg' }, [
        icon('i-shield'),
        el('h4', { text: t('empty.vaultTitle') }),
        el('p', { text: t('empty.vaultText') }),
      ])
    );
    return;
  }

  list.replaceChildren(
    ...state.vaultSessions.map((session) =>
      el('div', { class: 'vault' }, [
        el('span', { class: 'vault__icon' }, [icon('i-shield')]),
        el('div', { class: 'vault__body' }, [
          el('strong', { text: t('vault.sessionLine', { count: fmtNum(session.file_count), size: human(session.size) }) }),
          el('div', {
            class: 'vault__meta',
            text: `${session.created ? fmtDate(session.created) : session.created_h} · ` +
                  (session.mode === 'delete' ? t('mode.permanentDelete') : t('mode.quarantine')),
          }),
          el('div', { class: 'vault__sample' }, session.sample.map((name) => el('span', { text: name }))),
        ]),
        el('div', { class: 'vault__actions' }, [
          el('button', {
            class: 'btn btn--ghost btn--sm',
            onclick: () => restoreSession(session),
          }, [icon('i-restore'), el('span', { text: t('btn.restore') })]),
          el('button', {
            class: 'btn btn--ghost btn--sm',
            onclick: () => purgeSession(session),
          }, [icon('i-trash'), el('span', { text: t('btn.deletePermanent') })]),
        ]),
      ])
    )
  );
}

async function refreshVault() {
  const [usage, sessions] = await Promise.all([api.quarantine.usage(), api.quarantine.list()]);
  if (usage && usage.ok) state.vaultUsage = usage.data;
  if (sessions && sessions.ok) state.vaultSessions = sessions.data || [];

  const badge = $('#navQuarantineBadge');
  const count = state.vaultSessions.length;
  badge.hidden = count === 0;
  badge.textContent = String(count);
  badge.classList.toggle('nav__badge--accent', count > 0);

  renderVault();
  renderDashboard();
}

async function restoreSession(session) {
  const ok = await ask({
    title: t('vault.restoreTitle'),
    text: t('vault.restoreText', { count: fmtNum(session.file_count), size: human(session.size) }),
    iconName: 'i-restore',
    confirmLabel: t('btn.restore'),
  });
  if (!ok) return;

  const res = await api.quarantine.restore(session.session);
  if (!res || !res.ok) {
    toast({ kind: 'error', title: t('toast.restoreFailed'), text: (res && res.error) || t('err.unknown') });
    return;
  }
  const report = res.data;
  toast({
    kind: report.failed.length ? 'warn' : 'success',
    title: report.failed.length ? t('toast.restoredPartialTitle') : t('toast.restoredTitle'),
    text: t('toast.restoreText', { count: fmtNum(report.restored), size: human(report.size) }) +
          (report.failed.length ? t('toast.restoreFailedText', { count: fmtNum(report.failed.length) }) : ''),
  });
  await refreshVault();
}

async function purgeSession(session) {
  const ok = await ask({
    title: t('vault.purgeTitle'),
    text: t('vault.purgeText', { count: fmtNum(session.file_count), size: human(session.size) }),
    iconName: 'i-alert',
    danger: true,
    confirmLabel: t('btn.deletePermanent'),
    body: el('div', { class: 'warn-box' }, [
      icon('i-alert'),
      el('p', { text: t('vault.purgeWarn') }),
    ]),
  });
  if (!ok) return;

  const res = await api.quarantine.purge(session.session);
  if (!res || !res.ok || !res.data.ok) {
    toast({
      kind: 'error',
      title: t('toast.purgeFailed'),
      text: (res && (res.error || (res.data && res.data.error))) || t('err.unknown'),
    });
    return;
  }
  toast({
    kind: 'success',
    title: t('toast.purgeOk'),
    text: session.created ? fmtDate(session.created) : session.created_h,
  });
  await refreshVault();
}

/* --------------------------------------------------------------- history */
function renderHistory() {
  const list = $('#historyList');
  if (!state.history.length) {
    list.replaceChildren(
      el('div', { class: 'empty empty--lg' }, [
        icon('i-history'),
        el('h4', { text: t('empty.historyTitle') }),
        el('p', { text: t('empty.historyText') }),
      ])
    );
    return;
  }

  list.replaceChildren(
    ...state.history.map((row) => {
      const names = (row.categories || []).map((id) => state.catNames[id] || id).join(', ');
      return el('div', { class: 'hist' }, [
        el('span', { class: 'hist__date', text: row.at ? fmtDate(row.at) : row.at_h || '-' }),
        el('div', { class: 'hist__body' }, [
          el('div', { class: 'hist__title' }, [
            el('strong', { text: t('hist.filesCleaned', { count: fmtNum(row.file_count) }) }),
            el('span', {
              class: `pill ${row.mode === 'delete' ? 'pill--risky' : 'pill--safe'}`,
              text: row.mode === 'delete' ? t('hist.permanent') : t('hist.quarantined'),
            }),
            row.error_count
              ? el('span', { class: 'pill pill--caution', text: t('hist.errors', { count: fmtNum(row.error_count) }) })
              : null,
          ]),
          el('div', { class: 'hist__cats', text: names || '—' }),
        ]),
        el('div', { class: 'hist__right' }, [
          el('strong', { text: human(row.bytes) }),
          el('span', { text: t('hist.reclaimed') }),
        ]),
      ]);
    })
  );
}

async function refreshHistory() {
  const res = await api.history.list();
  if (res && res.ok) state.history = res.data || [];
  renderHistory();
}

/* --------------------------------------------------------------- asistan */
function chatMessage(kind, text) {
  const bubble = el('div', { class: `chat__msg chat__msg--${kind}` });
  if (kind === 'ai') bubble.append(el('p', { text }));
  else bubble.textContent = text;
  $('#chat').append(bubble);
  $('#chat').scrollTop = $('#chat').scrollHeight;
  return bubble;
}

function chatTyping() {
  const bubble = el('div', { class: 'chat__msg chat__msg--ai' }, [
    el('span', { class: 'chat__typing' }, [el('i'), el('i'), el('i')]),
  ]);
  $('#chat').append(bubble);
  $('#chat').scrollTop = $('#chat').scrollHeight;
  return bubble;
}

async function sendQuestion(question) {
  if (state.chatBusy) return;
  const text = String(question || '').trim();
  if (!text) return;

  state.chatBusy = true;
  chatMessage('me', text);
  const typing = chatTyping();

  const res = await api.ai.ask(text);
  typing.remove();
  state.chatBusy = false;

  if (!res || !res.ok) {
    chatMessage('ai', (res && res.error) || t('asst.noAnswer'));
    return;
  }
  chatMessage('ai', res.data.answer);
  $('#chat').append(el('div', { class: 'chat__msg chat__msg--meta', text: t('asst.engineMeta', { engine: res.data.engine }) }));
  $('#chat').scrollTop = $('#chat').scrollHeight;
}

function renderProvider(provider) {
  if (!provider) return;
  const isLlm = provider.engine === 'ollama' || provider.engine === 'openai';
  const card = $('#engineCard');
  card.classList.toggle('engine--rules', !isLlm);
  card.classList.toggle('engine--off', !provider.available);
  $('#engineName').textContent = isLlm
    ? provider.engine === 'ollama' ? t('engine.ollama') : t('engine.remote')
    : t('engine.rulesName');
  $('#engineNote').textContent = provider.note + (isLlm ? ` · ${provider.model}` : '');
  $('#enginePill').textContent = isLlm ? provider.model : t('engine.rulesTag');
  $('#assistantEngine').textContent = isLlm ? provider.model : t('engine.rulesTag');

  const pill = $('#aiStatusPill');
  if (pill) {
    if (isLlm) {
      pill.textContent = `${provider.engine === 'openai' ? 'OpenAI' : 'Ollama'} · ${provider.model}`;
      pill.className = 'pill pill--accent';
    } else if (provider.configured === 'openai') {
      pill.textContent = t('set.ai.waitingKey');
      pill.className = 'pill pill--caution';
    } else {
      pill.textContent = t('engine.rulesTag');
      pill.className = 'pill pill--ghost';
    }
  }
}

async function refreshProvider(refresh = false) {
  const res = await api.ai.provider({ refresh });
  if (res && res.ok) renderProvider(res.data);
}

/* --------------------------------------------------------------- ayarlar */
function applySettings(settings) {
  state.settings = settings;
  state.cleanMode = settings.clean_mode;
  state.deep = settings.deep_scan;
  state.language = settings.language || 'auto';

  $('#deepToggle').checked = settings.deep_scan;
  $('#setDeep').checked = settings.deep_scan;
  $('#setAuto').checked = settings.auto_select_safe;
  $('#setMotion').checked = settings.reduce_motion;
  $('#modeQuarantine').checked = settings.clean_mode !== 'delete';
  $('#modeDelete').checked = settings.clean_mode === 'delete';
  document.body.classList.toggle('reduce-motion', Boolean(settings.reduce_motion));

  if (settings.ai_provider) {
    state.aiProvider = settings.ai_provider;
    markAiProvider(settings.ai_provider);
  }

  renderLanguage();
  renderDock();
}

async function patchSettings(patch) {
  const res = await api.settings.set(patch);
  if (res && res.ok) applySettings(res.data);
}

/* --------------------------------------------------------------- language picker */
/** Native name of the Windows language: 'tr-TR' -> 'Türkçe'. */
function systemLanguageLabel() {
  const raw = String(state.systemLocale || '').toLowerCase().replace(/_/g, '-');
  if (!raw) return localeMetaLabel(locale);
  const short = raw.split('-')[0];
  const exact = state.locales.find((meta) => meta.code === raw);
  if (exact) return exact.native;
  const base = state.locales.find((meta) => meta.code === short);
  return base ? base.native : raw.toUpperCase();
}

function localeMetaLabel(code) {
  const meta = state.locales.find((item) => item.code === code);
  return meta ? meta.native : code;
}

function renderLanguage() {
  const select = $('#langSelect');
  if (!select) return;

  const saved = state.language || 'auto';
  const options = [el('option', { value: 'auto', text: t('set.lang.system') })];
  for (const meta of state.locales) {
    // Two names are shown, such as "Türkçe · Turkish", so users can find their own language.
    const label = meta.english && meta.english !== meta.native
      ? `${meta.native} · ${meta.english}`
      : meta.native;
    options.push(el('option', { value: meta.code, text: label }));
  }
  select.replaceChildren(...options);

  const known = saved === 'auto' || state.locales.some((meta) => meta.code === saved);
  select.value = known ? (saved === 'auto' ? 'auto' : saved) : locale;

  const hint = $('#langHint');
  if (hint) hint.textContent = t('set.lang.detected', { language: systemLanguageLabel() });
}

/**
 * Applies a language change. Engine text (category names, insights, summary)
 * is produced at scan time and lives outside the dictionary, so it is
 * requested again from the main process — not a single line stays in the old language.
 */
async function changeLanguage(code) {
  const res = await api.i18n.set(code || 'auto');
  if (!res || !res.ok) return;

  applyBundle(res.data);
  state.language = code || 'auto';
  if (res.data.settings) applySettings(res.data.settings);

  // Static text first, then the dynamic view: otherwise the static translation
  // would turn computed labels such as scan counts into "waiting for a scan".
  applyStaticTranslations();
  await reloadAll();

  renderLanguage();
  go(state.view);
}

/* --------------------------------------------------------------- AI provider */
function markAiProvider(provider) {
  $$('#aiProviderGroup button').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.provider === provider);
  });
  // The OpenAI fields only matter when this provider (or automatic) is selected.
  const panel = $('#aiOpenaiPanel');
  if (panel) panel.hidden = !(provider === 'openai' || provider === 'auto');
}

function setAiStatus(kind, text) {
  const node = $('#aiTestStatus');
  if (!node) return;
  if (!text) {
    node.hidden = true;
    node.textContent = '';
    return;
  }
  node.hidden = false;
  node.className = `status status--${kind}`;
  node.textContent = text;
}

function applyAiConfig(cfg) {
  if (!cfg) return;
  state.aiConfig = cfg;
  if (cfg.provider) state.aiProvider = cfg.provider;
  markAiProvider(state.aiProvider);

  $('#aiBase').value = cfg.base || '';
  $('#aiBase').placeholder = (cfg.defaults && cfg.defaults.base) || 'https://api.openai.com/v1';
  $('#aiModel').value = cfg.model || '';
  $('#aiModel').placeholder = (cfg.defaults && cfg.defaults.model) || 'gpt-4o-mini';
  $('#aiKey').value = '';
  $('#aiKey').type = 'password';
  $('#aiKeyToggle').replaceChildren(icon('i-eye'));
  $('#aiKeyToggle').title = t('set.ai.showKey');
  $('#aiKeyToggle').setAttribute('aria-label', t('set.ai.showKey'));

  const hint = $('#aiKeyHint');
  if (cfg.has_key) {
    hint.textContent = cfg.key_source === 'env' ? t('set.ai.keyEnv') : t('set.ai.keySaved');
    hint.classList.add('field__hint--ok');
  } else {
    hint.textContent = t('set.ai.keyCreate');
    hint.classList.remove('field__hint--ok');
  }

  const clearBtn = $('#aiKeyClear');
  if (clearBtn) clearBtn.hidden = !cfg.has_key;
  setAiStatus('', '');
}

async function refreshAiConfig() {
  const res = await api.ai.config();
  if (res && res.ok) applyAiConfig(res.data);
}

/** Writes the form values into settings; `silent` suppresses the notification. */
async function saveAiConfig({ silent = false } = {}) {
  const patch = {
    ai_provider: state.aiProvider || 'auto',
    ai_openai_base: $('#aiBase').value.trim(),
    ai_openai_model: $('#aiModel').value.trim(),
  };
  const typedKey = $('#aiKey').value.trim();
  // An empty field means "leave unchanged"; the key is cleared by a separate button.
  if (typedKey) patch.ai_openai_key = typedKey;

  if (!silent) setAiStatus('busy', t('status.saving'));
  const res = await api.settings.set(patch);
  if (!res || !res.ok) {
    const message = (res && res.error) || t('status.saveFailed');
    setAiStatus('error', message);
    return false;
  }

  applySettings(res.data);
  await refreshAiConfig();
  await refreshProvider(true);

  if (!silent) {
    setAiStatus('ok', t('status.saved'));
    toast({
      kind: 'success',
      title: t('toast.aiSavedTitle'),
      text: t('toast.aiSavedText'),
      timeout: 4000,
    });
  }
  return true;
}

async function loadAiModels() {
  const btn = $('#aiModelFetch');
  btn.disabled = true;
  setAiStatus('busy', t('status.fetching'));

  try {
    // If a key was typed but not saved, save it first.
    if ($('#aiKey').value.trim() && !(await saveAiConfig({ silent: true }))) {
      setAiStatus('error', t('status.keyNotSaved'));
      return;
    }

    const res = await api.ai.models();
    const data = res && res.ok ? res.data : null;
    if (!data) {
      setAiStatus('error', (res && res.error) || t('status.modelsFailed'));
      return;
    }
    if (!data.ok) {
      setAiStatus('error', data.error || t('status.modelsFailed'));
      return;
    }

    const models = data.models || [];
    if (!models.length) {
      setAiStatus('warn', t('status.noModels'));
      return;
    }

    $('#aiModelList').replaceChildren(...models.map((id) => el('option', { value: id })));
    if (!$('#aiModel').value.trim()) $('#aiModel').value = models[0];
    setAiStatus('ok', t('status.modelsFound', { count: fmtNum(models.length) }));
  } finally {
    btn.disabled = false;
  }
}

async function testAiConnection() {
  const model = $('#aiModel').value.trim();
  if (!model) {
    setAiStatus('warn', t('status.enterModel'));
    return;
  }

  const btn = $('#aiTest');
  btn.disabled = true;
  setAiStatus('busy', t('status.testing'));

  try {
    // The test uses the stored key; a newly typed key is saved first.
    if ($('#aiKey').value.trim() && !(await saveAiConfig({ silent: true }))) {
      setAiStatus('error', t('status.keyNotSavedShort'));
      return;
    }

    const res = await api.ai.test(model);
    const data = res && res.ok ? res.data : null;
    if (!data) {
      setAiStatus('error', (res && res.error) || t('status.testFailed'));
      return;
    }
    if (!data.ok) {
      setAiStatus('error', data.error || t('status.connectFailed'));
      return;
    }

    const latency = data.latency_ms != null
      ? t('status.latency', { ms: fmtNum(data.latency_ms) })
      : '';
    setAiStatus('ok', t('status.replied', { model: data.model, latency }));
    await refreshProvider(true);
    toast({
      kind: 'success',
      title: t('toast.connectedTitle'),
      text: `${data.model}${latency}`,
      timeout: 4000,
    });
  } finally {
    btn.disabled = false;
  }
}

async function clearAiKey() {
  const confirmed = await ask({
    title: t('set.ai.removeTitle'),
    text: t('set.ai.removeText'),
    iconName: 'i-key',
    danger: true,
    confirmLabel: t('btn.remove'),
  });
  if (!confirmed) return;

  const res = await api.settings.set({ ai_openai_key: '' });
  if (!res || !res.ok) {
    setAiStatus('error', t('status.keyRemoveFailed'));
    return;
  }
  applySettings(res.data);
  await refreshAiConfig();
  await refreshProvider(true);
  setAiStatus('ok', t('status.keyRemoved'));
}

/* --------------------------------------------------------------- scanning */
function setProgress(percent, stage) {
  $('#scanProgress').hidden = false;
  $('#progressFill').style.width = `${Math.max(0, Math.min(100, percent))}%`;
  $('#progressPercent').textContent = `${fmtNum(percent)}%`;
  $('#progressStage').textContent = stage || '';
}

function setScanning(active) {
  state.scanning = active;
  const btn = $('#scanBtn');
  btn.disabled = active;
  $('span', btn).textContent = active ? t('btn.scanning') : t('btn.scan');
  if (!active) setTimeout(() => { $('#scanProgress').hidden = true; }, 1400);
  renderDock();
}

async function startScan() {
  if (state.scanning) return;
  setScanning(true);
  setProgress(2, t('progress.starting'));
  clearSelection();

  const res = await api.scan.start({ deep: $('#deepToggle').checked });
  setScanning(false);

  if (!res || !res.ok) {
    setProgress(0, t('progress.failed'));
    toast({ kind: 'error', title: t('toast.scanFailed'), text: (res && res.error) || t('err.unknown') });
    return;
  }

  applyScan(res.data.view, res.data.analysis);

  if (state.settings && state.settings.auto_select_safe && state.analysis) {
    selectRecommended(true);
  }

  toast({
    kind: 'success',
    title: t('toast.scanDoneTitle'),
    text: t('toast.scanDoneText', {
      size: human(res.data.view.totals.all),
      count: fmtNum(res.data.view.totals.file_count),
      sec: fmtNum(res.data.view.duration),
    }),
  });
}

function applyScan(view, analysis) {
  state.scan = view;
  state.analysis = analysis;

  if (!state.expanded.size && view.categories.length) {
    const biggest = [...view.categories].sort((a, b) => b.size - a.size)[0];
    if (biggest && biggest.size > 0) state.expanded.add(biggest.id);
  }

  const badge = $('#navCategoriesBadge');
  const count = view.categories.filter((cat) => cat.size > 0).length;
  badge.hidden = count === 0;
  badge.textContent = String(count);

  $('#quickSelectBtn').disabled = !analysis;
  renderDashboard();
  renderCategories();
  renderDock();
}

/* --------------------------------------------------------------- cleaning */
function selectionPayload() {
  return {
    categoryIds: [...state.selectedCategories],
    itemIds: [...state.selectedItems],
    mode: state.cleanMode,
  };
}

async function previewSelection() {
  const payload = selectionPayload();
  if (!payload.categoryIds.length && !payload.itemIds.length) return;

  const [previewRes, auditRes] = await Promise.all([
    api.clean.preview(payload),
    api.clean.audit(payload.categoryIds),
  ]);

  if (!previewRes || !previewRes.ok) {
    toast({
      kind: 'error',
      title: t('toast.previewFailed'),
      text: (previewRes && previewRes.error) || t('err.unknown'),
    });
    return;
  }

  const preview = previewRes.data;
  const rows = [
    el('div', {}, [el('dt', { text: t('prev.files') }), el('dd', { text: fmtNum(preview.file_count) })]),
    el('div', {}, [el('dt', { text: t('prev.size') }), el('dd', { text: human(preview.bytes) })]),
    el('div', {}, [el('dt', { text: t('prev.cats') }), el('dd', { text: fmtNum(payload.categoryIds.length) })]),
    el('div', {}, [el('dt', { text: t('prev.items') }), el('dd', { text: fmtNum(payload.itemIds.length) })]),
  ];

  if (preview.error_count) {
    rows.push(el('div', {}, [
      el('dt', { text: t('prev.skipped') }),
      el('dd', { text: t('cat.files', { count: fmtNum(preview.error_count) }) }),
    ]));
  }
  if (auditRes && auditRes.ok && auditRes.data.blocked) {
    rows.push(el('div', {}, [
      el('dt', { text: t('prev.blocked') }),
      el('dd', { text: fmtNum(auditRes.data.blocked) }),
    ]));
  }

  await ask({
    title: t('prev.title'),
    text: t('prev.text'),
    iconName: 'i-info',
    confirmLabel: t('btn.gotIt'),
    body: el('dl', { class: 'summary-list' }, rows),
  });
}

async function runClean() {
  const payload = selectionPayload();
  if (!payload.categoryIds.length && !payload.itemIds.length) return;
  if (state.cleaning) return;

  const totals = selectedTotals();
  const isDelete = state.cleanMode === 'delete';

  const rows = [
    el('div', {}, [el('dt', { text: t('common.file') }), el('dd', { text: fmtNum(totals.files) })]),
    el('div', {}, [el('dt', { text: t('prev.size') }), el('dd', { text: human(totals.bytes) })]),
    el('div', {}, [
      el('dt', { text: t('clean.method') }),
      el('dd', { text: isDelete ? t('clean.permanent') : t('clean.quarantine') }),
    ]),
  ];
  for (const key of ['safe', 'caution', 'risky']) {
    if (totals.risk[key] > 0) {
      rows.push(el('div', {}, [
        el('dt', { text: t('clean.riskCats', { risk: riskLabel(key) }) }),
        el('dd', { text: human(totals.risk[key]) }),
      ]));
    }
  }

  const body = [el('dl', { class: 'summary-list' }, rows)];
  if (isDelete) {
    body.push(
      el('div', { class: 'warn-box' }, [
        icon('i-alert'),
        el('p', { text: t('clean.warnDelete') }),
      ])
    );
  } else {
    body.push(
      el('div', { class: 'safety' }, [
        icon('i-shield'),
        el('p', { text: t('clean.safeNote') }),
      ])
    );
  }

  const ok = await ask({
    title: t('clean.title'),
    text: t('clean.text'),
    iconName: isDelete ? 'i-alert' : 'i-shield',
    danger: isDelete,
    confirmLabel: isDelete ? t('btn.deletePermanent') : t('btn.clean'),
    body,
  });
  if (!ok) return;

  state.cleaning = true;
  setProgress(0, t('progress.cleanPreparing'));
  renderDock();

  const res = await api.clean.run(payload);
  state.cleaning = false;

  if (!res || !res.ok) {
    toast({ kind: 'error', title: t('toast.cleanFailed'), text: (res && res.error) || t('err.unknown') });
    renderDock();
    return;
  }

  const report = res.data;
  clearSelection();

  const body2 = [
    el('dl', { class: 'summary-list' }, [
      el('div', {}, [el('dt', { text: t('clean.processed') }), el('dd', { text: fmtNum(report.file_count) })]),
      el('div', {}, [el('dt', { text: t('clean.reclaimed') }), el('dd', { text: human(report.bytes) })]),
      el('div', {}, [
        el('dt', { text: t('clean.method') }),
        el('dd', { text: report.mode === 'delete' ? t('clean.permanent') : t('mode.quarantineShort') }),
      ]),
    ]),
  ];
  if (report.error_count) {
    body2.push(
      el('div', { class: 'warn-box' }, [
        icon('i-alert'),
        el('p', { text: t('clean.skipped', { count: fmtNum(report.error_count) }) }),
      ]),
      el('div', { class: 'report-list' },
        report.errors.slice(0, 60).map((row) =>
          el('div', {}, [el('span', { text: row.path, title: row.path }), el('span', { text: row.error })]))),
    );
  }
  if (report.restorable) {
    body2.push(
      el('div', { class: 'safety' }, [
        icon('i-shield'),
        el('p', { text: t('clean.restorable') }),
      ])
    );
  }

  await ask({
    title: t('clean.doneTitle'),
    text: t('clean.doneText', { size: human(report.bytes) }),
    iconName: 'i-check-circle',
    confirmLabel: t('btn.close'),
    body: body2,
  });

  await Promise.all([refreshVault(), refreshHistory()]);
  if (state.scan) {
    // The scan result no longer reflects reality; tell the user.
    $('#heroSummary').textContent = t('dash.afterClean');
  }
  toast({
    kind: 'success',
    title: t('toast.finishedTitle'),
    text: t('toast.finishedText', { size: human(report.bytes) }),
  });
}

/* --------------------------------------------------------------- smart selection */
function selectRecommended(silent = false) {
  if (!state.analysis || !state.scan) return;
  const ids = state.analysis.recommended_ids || [];
  if (!ids.length) {
    if (!silent) {
      toast({ kind: 'info', title: t('toast.noSuggestionTitle'), text: t('toast.noSuggestionText') });
    }
    return;
  }
  state.selectedCategories = new Set(ids);
  state.selectedItems.clear();
  state.expanded = new Set(ids);

  const bytes = state.scan.categories
    .filter((cat) => ids.includes(cat.id))
    .reduce((sum, cat) => sum + cat.size, 0);

  renderCategories();
  renderDock();
  if (!silent) {
    toast({
      kind: 'success',
      title: t('toast.aiSelectedTitle'),
      text: t('toast.aiSelectedText', { count: fmtNum(ids.length), size: human(bytes) }),
    });
  }
}

async function runSmartPick() {
  const gb = Number($('#targetRange').value);
  const targetBytes = Math.round(gb * 1024 * 1024 * 1024);

  const res = await api.ai.pick(targetBytes);
  const box = $('#pickResult');
  box.hidden = false;

  if (!res || !res.ok) {
    box.className = 'pickresult pickresult--short';
    box.textContent = (res && res.error) || t('pick.needScan');
    return;
  }

  const pick = res.data;
  if (!pick.category_ids.length) {
    box.className = 'pickresult pickresult--short';
    box.textContent = t('pick.nothing');
    return;
  }

  box.className = `pickresult${pick.reached ? '' : ' pickresult--short'}`;
  box.replaceChildren(
    el('p', {}, [
      el('strong', { text: t('pick.selected', { size: human(pick.size) }) }),
      t('pick.targetNote', { size: human(pick.target) }),
      pick.reached
        ? t('pick.reached')
        : t('pick.shortfall', { size: human(pick.shortfall) }),
    ]),
    el('div', { class: 'vault__sample' }, pick.category_ids.map((id) => el('span', { text: state.catNames[id] || id })))
  );

  state.selectedCategories = new Set(pick.category_ids);
  state.selectedItems.clear();
  state.expanded = new Set(pick.category_ids);
  renderCategories();
  renderDock();
  toast({
    kind: 'success',
    title: t('toast.aiPickedTitle'),
    text: t('toast.aiPickedText', { size: human(pick.size), count: fmtNum(pick.category_ids.length) }),
  });
}

/* --------------------------------------------------------------- startup */
function bindEvents() {
  // pencere denetimleri
  $$('.wbtn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.win;
      if (action === 'minimize') api.window.minimize();
      else if (action === 'maximize') api.window.toggleMaximize();
      else api.window.close();
    });
  });
  api.on('window:maximized', (maximized) => {
    const btn = $('.wbtn[data-win="maximize"]');
    if (btn) btn.title = maximized ? t('win.restore') : t('win.maximize');
  });

  // gezinme
  $('#nav').addEventListener('click', (event) => {
    const btn = event.target.closest('.nav__item');
    if (btn) go(btn.dataset.view);
  });
  document.addEventListener('click', (event) => {
    const link = event.target.closest('[data-goto]');
    if (link) go(link.dataset.goto);
  });

  // panel
  $('#scanBtn').addEventListener('click', startScan);
  $('#quickSelectBtn').addEventListener('click', () => selectRecommended(false));
  $('#applyRecommended').addEventListener('click', () => selectRecommended(true));
  $('#deepToggle').addEventListener('change', (event) => patchSettings({ deep_scan: event.target.checked }));

  // kategoriler
  $('#catSearch').addEventListener('input', (event) => {
    state.search = event.target.value;
    renderCategories();
  });
  $('#riskFilter').addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    state.riskFilter = chip.dataset.risk;
    $$('#riskFilter .chip').forEach((item) => item.classList.toggle('is-active', item === chip));
    renderCategories();
  });
  $('#selectSafeBtn').addEventListener('click', () => {
    if (!state.scan) return;
    state.selectedCategories = new Set(state.safeIds);
    state.selectedItems.clear();
    renderCategories();
    renderDock();
  });
  $('#clearSelBtn').addEventListener('click', () => {
    clearSelection();
    renderCategories();
  });

  // bottom bar
  $('#dockMode').addEventListener('click', (event) => {
    const btn = event.target.closest('button');
    if (!btn) return;
    state.cleanMode = btn.dataset.mode;
    patchSettings({ clean_mode: state.cleanMode });
    renderDock();
  });
  $('#dockPreview').addEventListener('click', previewSelection);
  $('#dockClean').addEventListener('click', runClean);

  // asistan
  $('#targetRange').addEventListener('input', (event) => {
    $('#targetValue').textContent = fmtDec(Number(event.target.value));
  });
  $('#pickBtn').addEventListener('click', runSmartPick);
  $('#chatForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('#chatInput');
    const value = input.value;
    input.value = '';
    sendQuestion(value);
  });
  $('#chatSuggest').addEventListener('click', (event) => {
    const btn = event.target.closest('button');
    if (btn) sendQuestion(t(btn.dataset.q));
  });

  // ayarlar
  $('#setDeep').addEventListener('change', (event) => patchSettings({ deep_scan: event.target.checked }));
  $('#setAuto').addEventListener('change', (event) => patchSettings({ auto_select_safe: event.target.checked }));
  $('#setMotion').addEventListener('change', (event) => patchSettings({ reduce_motion: event.target.checked }));
  $$('input[name="cleanMode"]').forEach((radio) => {
    radio.addEventListener('change', () => patchSettings({ clean_mode: radio.value }));
  });
  $('#openDataDir').addEventListener('click', () => api.app.openDataDir());
  $('#openDataDir2').addEventListener('click', () => api.app.openDataDir());

  // dil
  $('#langSelect').addEventListener('change', (event) => changeLanguage(event.target.value));

  // AI provider
  $('#aiProviderGroup').addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-provider]');
    if (!btn) return;
    state.aiProvider = btn.dataset.provider;
    markAiProvider(state.aiProvider);
    saveAiConfig({ silent: true });
  });
  $('#aiKeyToggle').addEventListener('click', () => {
    const input = $('#aiKey');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    const btn = $('#aiKeyToggle');
    btn.classList.toggle('is-active', show);
    btn.title = t(show ? 'set.ai.hideKey' : 'set.ai.showKey');
    btn.setAttribute('aria-label', btn.title);
  });
  $('#aiSave').addEventListener('click', () => saveAiConfig());
  $('#aiTest').addEventListener('click', testAiConnection);
  $('#aiModelFetch').addEventListener('click', loadAiModels);
  $('#aiKeyClear').addEventListener('click', clearAiKey);
  $('#aiBase').addEventListener('change', () => saveAiConfig({ silent: true }));
  $('#aiModel').addEventListener('change', () => saveAiConfig({ silent: true }));

  // scanning/cleaning progress
  api.on('scan:progress', (progress) => {
    if (progress) setProgress(progress.percent, progress.stage);
  });
  api.on('clean:progress', (progress) => {
    if (progress) setProgress(progress.percent, progress.stage);
  });
  api.on('scan:error', (payload) => {
    toast({ kind: 'error', title: t('toast.scanError'), text: (payload && payload.error) || '' });
  });

  // klavye
  document.addEventListener('keydown', (event) => {
    if (event.key === 'F5') event.preventDefault();
    if (event.ctrlKey && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      go('categories');
      $('#catSearch').focus();
    }
  });
}

/**
 * Refreshes the whole view after a language change. Engine text (category
 * names, insights, summary, provider note) is produced in the main process, so
 * it is requested again — no line stays in the old language when switching.
 */
async function reloadAll() {
  const [lastRes, countsRes] = await Promise.all([api.scan.last(), api.scan.counts()]);

  if (countsRes && countsRes.ok) {
    state.safeIds = countsRes.data.safe_ids || [];
    state.catNames = Object.fromEntries((countsRes.data.categories || []).map((c) => [c.id, c.name]));
  }
  if (lastRes && lastRes.ok && lastRes.data) {
    state.scan = lastRes.data;
    const analysisRes = await api.ai.analyze();
    state.analysis = analysisRes && analysisRes.ok ? analysisRes.data : null;
  } else {
    state.scan = null;
    state.analysis = null;
  }

  renderDashboard();
  renderCategories();
  renderDock();
  await Promise.all([refreshVault(), refreshHistory(), refreshProvider(true), refreshAiConfig()]);
}

async function init() {
  // Language first: every string comes from the dictionary, so it loads before anything else.
  const bundleRes = await api.i18n.bundle();
  if (bundleRes && bundleRes.ok) applyBundle(bundleRes.data);

  bindEvents();
  applyStaticTranslations();

  const infoRes = await api.app.info();
  if (infoRes && infoRes.ok) {
    state.info = infoRes.data;
    const info = infoRes.data;
    state.locales = info.locales || [];
    state.systemLocale = info.systemLocale || '';
    $('#versionLabel').textContent = `v${info.version}`;
    $('#dataDirPath').textContent = info.dataDir;
    $('#aboutList').replaceChildren(
      el('div', {}, [el('dt', { text: t('set.about.product') }), el('dd', { text: info.fullName || 'reMona · AICleaner' })]),
      el('div', {}, [el('dt', { text: t('set.about.version') }), el('dd', { text: info.version })]),
      el('div', {}, [el('dt', { text: t('set.about.electron') }), el('dd', { text: info.electron })]),
      el('div', {}, [el('dt', { text: t('set.about.chromium') }), el('dd', { text: info.chrome })]),
      el('div', {}, [el('dt', { text: t('set.about.node') }), el('dd', { text: info.node })]),
      el('div', {}, [el('dt', { text: t('set.about.platform') }), el('dd', { text: info.platform })]),
      el('div', {}, [el('dt', { text: t('set.about.drive') }), el('dd', { text: info.drive })])
    );
  }

  const settingsRes = await api.settings.get();
  if (settingsRes && settingsRes.ok) applySettings(settingsRes.data);

  const countsRes = await api.scan.counts();
  if (countsRes && countsRes.ok) {
    state.safeIds = countsRes.data.safe_ids || [];
    state.catNames = Object.fromEntries((countsRes.data.categories || []).map((c) => [c.id, c.name]));
  }

  // Restore the last scan (context survives an application restart).
  const lastRes = await api.scan.last();
  if (lastRes && lastRes.ok && lastRes.data) {
    state.scan = lastRes.data;
    const analysisRes = await api.ai.analyze();
    state.analysis = analysisRes && analysisRes.ok ? analysisRes.data : null;
    applyScan(state.scan, state.analysis);
  } else {
    renderDashboard();
    renderCategories();
  }

  go(state.view);
  await Promise.all([refreshVault(), refreshHistory(), refreshProvider(), refreshAiConfig()]);

  if (state.info && state.info.isDev) {
    toast({ kind: 'info', title: t('toast.devTitle'), text: t('toast.devText'), timeout: 4000 });
  }
}

init().catch((error) => {
  toast({ kind: 'error', title: t('toast.startupTitle'), text: String(error && error.message) });
});
