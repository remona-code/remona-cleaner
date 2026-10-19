/* ==========================================================================
   reMona (AICleaner) — arayüz mantığı
   Renderer hiçbir dosya sistemine erişemez; tüm işler preload köprüsü
   (window.aicleaner) üzerinden ana süreçte yürütülür.
   ========================================================================== */
'use strict';

const api = window.aicleaner;

/* --------------------------------------------------------------- yardımcı */
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

/** 1536 -> '1.5 KB' (motorun humanSize biçimiyle aynı) */
function human(bytes) {
  let n = Number(bytes) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  for (let i = 0; i < units.length; i += 1) {
    if (Math.abs(n) < 1024 || units[i] === 'TB') {
      return units[i] === 'B' ? `${Math.trunc(n)} ${units[i]}` : `${n.toFixed(1)} ${units[i]}`;
    }
    n /= 1024;
  }
  return `${n.toFixed(1)} TB`;
}

const fmtNum = (value) => String(Math.round(Number(value) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

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

const RISK_LABEL = { safe: 'Güvenli', caution: 'Dikkatli', risky: 'Riskli' };
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
function ask({ title, text, iconName = 'i-alert', danger = false, confirmLabel = 'Onayla', body = null }) {
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
    confirmBtn.textContent = confirmLabel;
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
const VIEW_META = {
  dashboard: ['Panel', 'Diskinizi tarayın, AI güvenli olanı seçsin.'],
  categories: ['Kategoriler', 'Bulunan dosyaları inceleyin ve ne silineceğine karar verin.'],
  quarantine: ['Karantina', 'Temizlenen dosyalar silinmeden burada saklanır.'],
  history: ['Geçmiş', 'Yapılan temizliklerin kaydı.'],
  assistant: ['AI Asistan', 'Hedef belirleyin veya doğal dille sorun.'],
  settings: ['Ayarlar', 'Temizleme davranışı ve uygulama bilgisi.'],
};

function go(view) {
  if (!VIEW_META[view]) return;
  state.view = view;
  $$('.nav__item').forEach((item) => item.classList.toggle('is-active', item.dataset.view === view));
  $$('.view').forEach((section) => section.classList.toggle('is-active', section.dataset.view === view));
  const [title, subtitle] = VIEW_META[view];
  $('#viewTitle').textContent = title;
  $('#viewSubtitle').textContent = subtitle;
  $('#scroller').scrollTop = 0;
}

/* --------------------------------------------------------------- seçim */
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
  $('#dockMeta').textContent = `${fmtNum(files)} dosya · ${state.selectedCategories.size} kategori tamamı`;
  $('#dockClean').disabled = state.cleaning;

  const chips = $('#dockRisk');
  chips.replaceChildren(
    ...['safe', 'caution', 'risky']
      .filter((key) => risk[key] > 0)
      .map((key) => el('span', { class: `pill pill--${key}`, text: `${RISK_LABEL[key]} ${human(risk[key])}` }))
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
  $('#diskPercent').textContent = percent.toFixed(0);
  $('#ringDisk').style.strokeDashoffset = String(CIRC_DISK * (1 - Math.min(1, percent / 100)));

  // İç halka: atığın "boş alana katkısı" — temizlikten sonra boş alan ne kadar büyür?
  const reclaimShare = Math.min(1, total / Math.max(1, disk.free + total));
  $('#ringReclaim').style.strokeDashoffset = String(CIRC_RECLAIM * (1 - reclaimShare));

  const after = disk.free + total;
  $('#diskFree').textContent = `${disk.free_h} boş → ${human(after)}`;
  $('#diskLabel').textContent = total ? 'temizlik sonrası' : 'disk dolu';
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

  $('#statTotalMeta').textContent = scan ? `${scan.duration} sn'de tarandı` : 'tarama bekleniyor';
  $('#statSafeMeta').textContent = totals && totals.safe ? 'veri kaybı yok' : 'veri kaybı yok';
  $('#statCount').textContent = totals ? fmtNum(totals.file_count) : '—';
  $('#statVaultMeta').textContent = state.vaultUsage
    ? `${state.vaultUsage.sessions} oturum · geri alınabilir`
    : 'geri alınabilir';

  // hero metinleri
  if (analysis) {
    $('#heroTitle').textContent = analysis.potential.recommended
      ? `${analysis.potential.recommended_h} güvenle geri kazanılabilir`
      : 'Sistem temiz görünüyor';
    $('#heroSummary').textContent = analysis.summary;
  } else {
    $('#heroTitle').textContent = 'Sistemi tara, kazanç hazır';
    $('#heroSummary').textContent =
      'Başlamak için taramayı çalıştırın. AI; önbellekleri, geçici dosyaları ve kopyaları ' +
      'değerlendirip hangi dosyaların güvenle silinebileceğini söyler.';
  }

  // içgörüler
  const insights = analysis ? analysis.insights : [];
  $('#insightCount').textContent = insights.length ? `${insights.length} bulgu` : '—';
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
            el('p', { text: 'Tarama yapıldığında AI değerlendirmesi burada görünür.' }),
          ]),
        ])
  );

  // kategori dağılımı
  const withSize = scan ? scan.categories.filter((cat) => cat.size > 0).sort((a, b) => b.size - a.size) : [];
  const top = withSize.slice(0, 7);
  const max = top.length ? top[0].size : 1;

  $('#breakdown').replaceChildren(
    ...(top.length
      ? top.map((cat) => {
          const row = el('div', { class: 'break', onclick: () => go('categories') }, [
            el('div', { class: 'break__name' }, [
              el('span', { class: `break__dot break__dot--${cat.risk}` }),
              el('span', { text: cat.name }),
            ]),
            el('span', { class: 'break__size', text: cat.size_h }),
            el('div', { class: 'break__bar' }, [
              el('span', {
                class: `break__fill break__fill--${cat.risk}`,
                style: { width: `${Math.max(3, Math.round((cat.size / max) * 100))}%` },
              }),
            ]),
          ]);
          return row;
        })
      : [el('div', { class: 'empty' }, [icon('i-info'), el('p', { text: 'Henüz veri yok. Taramayı çalıştırın.' })])])
  );

  // AI öneri kartı
  const reclaim = $('#reclaimCard');
  if (analysis && analysis.recommended_ids.length) {
    reclaim.hidden = false;
    $('#reclaimTitle').textContent = `AI ${analysis.potential.recommended_h} için onay istiyor`;
    $('#reclaimText').textContent =
      `${analysis.recommended_ids.length} kategori güvenli eşiği geçti (güven ≥ %80). ` +
      'Riskli gruplar (eski indirilenler, büyük dosyalar, kopyalar) seçime dahil edilmedi.';
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
        el('h4', { text: 'Tarama bekleniyor' }),
        el('p', { text: 'Panelden taramayı başlattığınızda kategoriler burada listelenir.' }),
      ])
    );
    return;
  }

  const needle = state.search.trim().toLowerCase();
  const visible = scan.categories.filter((cat) => {
    if (state.riskFilter !== 'all' && cat.risk !== state.riskFilter) return false;
    if (!needle) return true;
    if (cat.name.toLowerCase().includes(needle)) return true;
    if (cat.description.toLowerCase().includes(needle)) return true;
    return (cat.items || []).some((item) => item.name.toLowerCase().includes(needle));
  });

  if (!visible.length) {
    list.replaceChildren(
      el('div', { class: 'empty empty--lg' }, [
        icon('i-search'),
        el('h4', { text: 'Eşleşen kategori yok' }),
        el('p', { text: 'Filtreyi veya arama terimini değiştirin.' }),
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
    title: selState === 'on' ? 'Seçimi kaldır' : 'Kategoriyi seç',
    'aria-label': 'Seç',
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
        el('strong', { text: cat.name }),
        el('span', { class: `pill pill--${cat.risk}`, text: RISK_LABEL[cat.risk] }),
        analysis && !isEmpty ? el('span', { class: 'pill pill--accent', text: `AI güveni %${confidence} · ${verdict}` }) : null,
        cat.deep_only && !state.deep ? el('span', { class: 'pill pill--ghost', text: 'derin tarama' }) : null,
      ]),
      el('div', { class: 'cat__desc' }, [
        cat.note ? el('span', { class: 'cat__note', text: cat.note }) : cat.description,
      ]),
    ]),
    el('div', { class: 'cat__score' }, [
      scoreSvg,
      el('div', { class: 'cat__size' }, [
        el('strong', { text: cat.size_h }),
        el('span', { text: `${fmtNum(cat.file_count)} dosya` }),
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
        el('div', { class: 'empty' }, [icon('i-info'), el('p', { text: cat.note || 'Bu kategoride dosya yok.' })]),
      ])
    );
  }

  return card;
}

function renderFiles(cat) {
  const head = el('div', { class: 'files__head' }, [
    el('span', { text: '' }),
    el('span', { text: 'Dosya' }),
    el('span', { text: 'Boyut' }),
    el('span', { text: 'Değişim' }),
    el('span', { text: '' }),
  ]);

  const rows = (cat.items || []).map((item) => {
    const catSelected = state.selectedCategories.has(cat.id);
    const isOn = catSelected || state.selectedItems.has(item.id);
    const checkbox = el('button', {
      class: `checkbox${isOn ? ' is-on' : ''}`,
      'aria-label': 'Dosyayı seç',
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
      el('span', { class: 'file__size', text: item.size_h }),
      el('span', { class: 'file__age', text: item.age_days === 0 ? 'bugün' : `${item.age_days} gün` }),
      el('div', { class: 'file__act' }, [
        el('button', {
          title: 'Gezgin\'de göster',
          'aria-label': 'Gezginde göster',
          onclick: (event) => {
            event.stopPropagation();
            api.app.reveal(item.path).then((res) => {
              if (res && !res.ok) toast({ kind: 'warn', title: 'Açılamadı', text: res.error });
            });
          },
        }, [icon('i-external')]),
      ]),
    ]);
  });

  const body = el('div', { class: 'files' }, [head, ...rows]);

  if (cat.items_truncated) {
    body.append(
      el('div', { class: 'files__more', text: `+ ${fmtNum(cat.items_truncated)} dosya daha (yalnızca en büyükleri gösteriliyor)` })
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
    // Kategori tamamen seçiliyken tek bir dosya çıkarılıyor:
    // kalan dosyaları tek tek seçime çevir.
    state.selectedCategories.delete(cat.id);
    for (const other of cat.items || []) {
      if (other.id !== item.id) state.selectedItems.add(other.id);
    }
    if (cat.items_truncated) {
      toast({
        kind: 'warn',
        title: 'Kısmi seçim',
        text: `Bu kategoride gösterilmeyen ${fmtNum(cat.items_truncated)} dosya daha var; ` +
              'tek tek seçim yapıldığında yalnızca listede görünenler işlenir.',
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
  $('#vaultSize').textContent = usage ? usage.size_h : '—';
  $('#vaultSessions').textContent = usage ? fmtNum(usage.sessions) : '—';
  $('#vaultFiles').textContent = usage ? fmtNum(usage.files) : '—';

  const list = $('#vaultList');
  if (!state.vaultSessions.length) {
    list.replaceChildren(
      el('div', { class: 'empty empty--lg' }, [
        icon('i-shield'),
        el('h4', { text: 'Karantina boş' }),
        el('p', { text: 'Karantinaya taşınan dosyalar burada listelenir ve geri yüklenebilir.' }),
      ])
    );
    return;
  }

  list.replaceChildren(
    ...state.vaultSessions.map((session) =>
      el('div', { class: 'vault' }, [
        el('span', { class: 'vault__icon' }, [icon('i-shield')]),
        el('div', { class: 'vault__body' }, [
          el('strong', { text: `${fmtNum(session.file_count)} dosya · ${session.size_h}` }),
          el('div', { class: 'vault__meta', text: `${session.created_h} · ${session.mode === 'delete' ? 'kalıcı silme' : 'karantina'}` }),
          el('div', { class: 'vault__sample' }, session.sample.map((name) => el('span', { text: name }))),
        ]),
        el('div', { class: 'vault__actions' }, [
          el('button', {
            class: 'btn btn--ghost btn--sm',
            onclick: () => restoreSession(session),
          }, [icon('i-restore'), el('span', { text: 'Geri yükle' })]),
          el('button', {
            class: 'btn btn--ghost btn--sm',
            onclick: () => purgeSession(session),
          }, [icon('i-trash'), el('span', { text: 'Kalıcı sil' })]),
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
    title: 'Geri yüklensin mi?',
    text: `${fmtNum(session.file_count)} dosya (${session.size_h}) özgün konumlarına geri taşınacak.`,
    iconName: 'i-restore',
    confirmLabel: 'Geri yükle',
  });
  if (!ok) return;

  const res = await api.quarantine.restore(session.session);
  if (!res || !res.ok) {
    toast({ kind: 'error', title: 'Geri yüklenemedi', text: (res && res.error) || 'Bilinmeyen hata' });
    return;
  }
  const report = res.data;
  toast({
    kind: report.failed.length ? 'warn' : 'success',
    title: report.failed.length ? 'Kısmen geri yüklendi' : 'Geri yüklendi',
    text: `${fmtNum(report.restored)} dosya · ${report.size_h}` +
          (report.failed.length ? ` · ${report.failed.length} dosya başarısız` : ''),
  });
  await refreshVault();
}

async function purgeSession(session) {
  const ok = await ask({
    title: 'Kalıcı olarak silinsin mi?',
    text: `${fmtNum(session.file_count)} dosya (${session.size_h}) karantinadan tamamen kaldırılacak.`,
    iconName: 'i-alert',
    danger: true,
    confirmLabel: 'Kalıcı sil',
    body: el('div', { class: 'warn-box' }, [
      icon('i-alert'),
      el('p', { text: 'Bu işlem geri alınamaz. Dosyalar diskten tamamen silinir, kurtarma aracı gerekir.' }),
    ]),
  });
  if (!ok) return;

  const res = await api.quarantine.purge(session.session);
  if (!res || !res.ok || !res.data.ok) {
    toast({ kind: 'error', title: 'Silinemedi', text: (res && (res.error || (res.data && res.data.error))) || 'Bilinmeyen hata' });
    return;
  }
  toast({ kind: 'success', title: 'Karantina oturumu silindi', text: session.created_h });
  await refreshVault();
}

/* --------------------------------------------------------------- geçmiş */
function renderHistory() {
  const list = $('#historyList');
  if (!state.history.length) {
    list.replaceChildren(
      el('div', { class: 'empty empty--lg' }, [
        icon('i-history'),
        el('h4', { text: 'Henüz temizlik yapılmadı' }),
        el('p', { text: 'Tamamlanan her temizlik burada kayıt altına alınır.' }),
      ])
    );
    return;
  }

  list.replaceChildren(
    ...state.history.map((row) => {
      const names = (row.categories || []).map((id) => state.catNames[id] || id).join(', ');
      return el('div', { class: 'hist' }, [
        el('span', { class: 'hist__date', text: row.at_h || '-' }),
        el('div', { class: 'hist__body' }, [
          el('div', { class: 'hist__title' }, [
            el('strong', { text: `${fmtNum(row.file_count)} dosya temizlendi` }),
            el('span', {
              class: `pill ${row.mode === 'delete' ? 'pill--risky' : 'pill--safe'}`,
              text: row.mode === 'delete' ? 'kalıcı silindi' : 'karantinaya alındı',
            }),
            row.error_count ? el('span', { class: 'pill pill--caution', text: `${row.error_count} hata` }) : null,
          ]),
          el('div', { class: 'hist__cats', text: names || '—' }),
        ]),
        el('div', { class: 'hist__right' }, [
          el('strong', { text: row.bytes_h }),
          el('span', { text: 'geri kazanıldı' }),
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
    chatMessage('ai', (res && res.error) || 'Yanıt alınamadı.');
    return;
  }
  chatMessage('ai', res.data.answer);
  $('#chat').append(el('div', { class: 'chat__msg chat__msg--meta', text: `motor: ${res.data.engine}` }));
  $('#chat').scrollTop = $('#chat').scrollHeight;
}

function renderProvider(provider) {
  if (!provider) return;
  const isLlm = provider.engine === 'ollama' || provider.engine === 'openai';
  const card = $('#engineCard');
  card.classList.toggle('engine--rules', !isLlm);
  card.classList.toggle('engine--off', !provider.available);
  $('#engineName').textContent = isLlm
    ? provider.engine === 'ollama' ? 'Yerel LLM (Ollama)' : 'Uzak LLM'
    : 'Yerel kural motoru';
  $('#engineNote').textContent = provider.note + (isLlm ? ` · ${provider.model}` : '');
  $('#enginePill').textContent = isLlm ? provider.model : 'kural motoru';
  $('#assistantEngine').textContent = isLlm ? provider.model : 'kural motoru';

  const pill = $('#aiStatusPill');
  if (pill) {
    if (isLlm) {
      pill.textContent = `${provider.engine === 'openai' ? 'OpenAI' : 'Ollama'} · ${provider.model}`;
      pill.className = 'pill pill--accent';
    } else if (provider.configured === 'openai') {
      pill.textContent = 'anahtar bekleniyor';
      pill.className = 'pill pill--caution';
    } else {
      pill.textContent = 'kural motoru';
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

  renderDock();
}

async function patchSettings(patch) {
  const res = await api.settings.set(patch);
  if (res && res.ok) applySettings(res.data);
}

/* --------------------------------------------------------------- AI sağlayıcısı */
function markAiProvider(provider) {
  $$('#aiProviderGroup button').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.provider === provider);
  });
  // OpenAI alanları yalnızca bu sağlayıcı seçiliyken (ya da otomatikken) anlamlı.
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
  $('#aiKeyToggle').title = 'Anahtarı göster';

  const hint = $('#aiKeyHint');
  if (cfg.has_key) {
    hint.textContent =
      cfg.key_source === 'env'
        ? 'Anahtar ortam değişkeninden okunuyor. Buradan yeni bir anahtar girerek değiştirebilirsiniz.'
        : 'Anahtar kayıtlı. Değiştirmek için yenisini yazın; kaldırmak için "Anahtarı kaldır" düğmesini kullanın.';
    hint.classList.add('field__hint--ok');
  } else {
    hint.textContent = 'Henüz anahtar eklenmedi. platform.openai.com üzerinden bir anahtar oluşturabilirsiniz.';
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

/** Formdaki değerleri ayara yazar; `silent` ise bildirim göstermez. */
async function saveAiConfig({ silent = false } = {}) {
  const patch = {
    ai_provider: state.aiProvider || 'auto',
    ai_openai_base: $('#aiBase').value.trim(),
    ai_openai_model: $('#aiModel').value.trim(),
  };
  const typedKey = $('#aiKey').value.trim();
  // Boş alan "değiştirme" demektir; anahtar silme ayrı düğmeyle yapılır.
  if (typedKey) patch.ai_openai_key = typedKey;

  if (!silent) setAiStatus('busy', 'Kaydediliyor…');
  const res = await api.settings.set(patch);
  if (!res || !res.ok) {
    const message = (res && res.error) || 'Ayarlar kaydedilemedi.';
    setAiStatus('error', message);
    return false;
  }

  applySettings(res.data);
  await refreshAiConfig();
  await refreshProvider(true);

  if (!silent) {
    setAiStatus('ok', 'Ayarlar kaydedildi.');
    toast({
      kind: 'success',
      title: 'AI ayarları kaydedildi',
      text: 'Yeni sağlayıcı bir sonraki sorudan itibaren kullanılacak.',
      timeout: 4000,
    });
  }
  return true;
}

async function loadAiModels() {
  const btn = $('#aiModelFetch');
  btn.disabled = true;
  setAiStatus('busy', 'Model listesi alınıyor…');

  try {
    // Yazılmış ama kaydedilmemiş anahtar varsa önce onu kaydet.
    if ($('#aiKey').value.trim() && !(await saveAiConfig({ silent: true }))) {
      setAiStatus('error', 'Anahtar kaydedilemedi, model listesi alınamadı.');
      return;
    }

    const res = await api.ai.models();
    const data = res && res.ok ? res.data : null;
    if (!data) {
      setAiStatus('error', (res && res.error) || 'Model listesi alınamadı.');
      return;
    }
    if (!data.ok) {
      setAiStatus('error', data.error || 'Model listesi alınamadı.');
      return;
    }

    const models = data.models || [];
    if (!models.length) {
      setAiStatus('warn', 'Bu anahtar için kullanılabilir sohbet modeli bulunamadı.');
      return;
    }

    $('#aiModelList').replaceChildren(...models.map((id) => el('option', { value: id })));
    if (!$('#aiModel').value.trim()) $('#aiModel').value = models[0];
    setAiStatus('ok', `${models.length} model bulundu — listeden seçebilirsiniz.`);
  } finally {
    btn.disabled = false;
  }
}

async function testAiConnection() {
  const model = $('#aiModel').value.trim();
  if (!model) {
    setAiStatus('warn', 'Önce bir model adı girin.');
    return;
  }

  const btn = $('#aiTest');
  btn.disabled = true;
  setAiStatus('busy', 'Bağlantı deneniyor…');

  try {
    // Test, kayıtlı anahtarla yapılır; yazılmış yeni anahtar varsa önce kaydedilir.
    if ($('#aiKey').value.trim() && !(await saveAiConfig({ silent: true }))) {
      setAiStatus('error', 'Anahtar kaydedilemedi.');
      return;
    }

    const res = await api.ai.test(model);
    const data = res && res.ok ? res.data : null;
    if (!data) {
      setAiStatus('error', (res && res.error) || 'Test çalıştırılamadı.');
      return;
    }
    if (!data.ok) {
      setAiStatus('error', data.error || 'Bağlantı kurulamadı.');
      return;
    }

    const latency = data.latency_ms != null ? ` · ${data.latency_ms} ms` : '';
    setAiStatus('ok', `${data.model} yanıt verdi${latency}`);
    await refreshProvider(true);
    toast({ kind: 'success', title: 'Bağlantı başarılı', text: `${data.model}${latency}`, timeout: 4000 });
  } finally {
    btn.disabled = false;
  }
}

async function clearAiKey() {
  const confirmed = await ask({
    title: 'API anahtarı kaldırılsın mı?',
    text: 'Anahtar diskten silinir ve AI asistanı kural motoruna döner.',
    iconName: 'i-key',
    danger: true,
    confirmLabel: 'Kaldır',
  });
  if (!confirmed) return;

  const res = await api.settings.set({ ai_openai_key: '' });
  if (!res || !res.ok) {
    setAiStatus('error', 'Anahtar kaldırılamadı.');
    return;
  }
  applySettings(res.data);
  await refreshAiConfig();
  await refreshProvider(true);
  setAiStatus('ok', 'Anahtar kaldırıldı.');
}

/* --------------------------------------------------------------- tarama */
function setProgress(percent, stage) {
  $('#scanProgress').hidden = false;
  $('#progressFill').style.width = `${Math.max(0, Math.min(100, percent))}%`;
  $('#progressPercent').textContent = `${Math.round(percent)}%`;
  $('#progressStage').textContent = stage || '';
}

function setScanning(active) {
  state.scanning = active;
  const btn = $('#scanBtn');
  btn.disabled = active;
  $('span', btn).textContent = active ? 'Taranıyor…' : 'Taramayı başlat';
  if (!active) setTimeout(() => { $('#scanProgress').hidden = true; }, 1400);
  renderDock();
}

async function startScan() {
  if (state.scanning) return;
  setScanning(true);
  setProgress(2, 'Başlatılıyor…');
  clearSelection();

  const res = await api.scan.start({ deep: $('#deepToggle').checked });
  setScanning(false);

  if (!res || !res.ok) {
    setProgress(0, 'Tarama başarısız');
    toast({ kind: 'error', title: 'Tarama başarısız', text: (res && res.error) || 'Bilinmeyen hata' });
    return;
  }

  applyScan(res.data.view, res.data.analysis);

  if (state.settings && state.settings.auto_select_safe && state.analysis) {
    selectRecommended(true);
  }

  toast({
    kind: 'success',
    title: 'Tarama tamamlandı',
    text: `${res.data.view.totals.all_h} atık bulundu · ${fmtNum(res.data.view.totals.file_count)} dosya · ${res.data.view.duration} sn`,
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

/* --------------------------------------------------------------- temizlik */
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
    toast({ kind: 'error', title: 'Önizleme alınamadı', text: (previewRes && previewRes.error) || '' });
    return;
  }

  const preview = previewRes.data;
  const rows = [
    el('div', {}, [el('dt', { text: 'Silinecek dosya' }), el('dd', { text: fmtNum(preview.file_count) })]),
    el('div', {}, [el('dt', { text: 'Geri kazanılacak alan' }), el('dd', { text: preview.bytes_h })]),
    el('div', {}, [el('dt', { text: 'Kategori (tamamı)' }), el('dd', { text: fmtNum(payload.categoryIds.length) })]),
    el('div', {}, [el('dt', { text: 'Tek tek seçilen' }), el('dd', { text: fmtNum(payload.itemIds.length) })]),
  ];

  if (preview.error_count) {
    rows.push(el('div', {}, [
      el('dt', { text: 'Güvenlik kapısında atlanan' }),
      el('dd', { text: `${fmtNum(preview.error_count)} dosya` }),
    ]));
  }
  if (auditRes && auditRes.ok && auditRes.data.blocked) {
    rows.push(el('div', {}, [
      el('dt', { text: 'Korunan yollarda engellenen' }),
      el('dd', { text: fmtNum(auditRes.data.blocked) }),
    ]));
  }

  await ask({
    title: 'Temizlik önizlemesi',
    text: 'Hiçbir değişiklik yapılmadı. Bu yalnızca ne olacağını gösterir.',
    iconName: 'i-info',
    confirmLabel: 'Anladım',
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
    el('div', {}, [el('dt', { text: 'Dosya' }), el('dd', { text: fmtNum(totals.files) })]),
    el('div', {}, [el('dt', { text: 'Alan' }), el('dd', { text: human(totals.bytes) })]),
    el('div', {}, [el('dt', { text: 'Yöntem' }), el('dd', { text: isDelete ? 'Kalıcı silme' : 'Karantinaya taşıma' })]),
  ];
  for (const key of ['safe', 'caution', 'risky']) {
    if (totals.risk[key] > 0) {
      rows.push(el('div', {}, [
        el('dt', { text: `${RISK_LABEL[key]} kategoriler` }),
        el('dd', { text: human(totals.risk[key]) }),
      ]));
    }
  }

  const body = [el('dl', { class: 'summary-list' }, rows)];
  if (isDelete) {
    body.push(
      el('div', { class: 'warn-box' }, [
        icon('i-alert'),
        el('p', { text: 'Kalıcı silme seçili. Dosyalar karantinaya alınmayacak ve geri yüklenemeyecek.' }),
      ])
    );
  } else {
    body.push(
      el('div', { class: 'safety' }, [
        icon('i-shield'),
        el('p', { text: 'Dosyalar karantinaya taşınır; istediğiniz an geri yükleyebilirsiniz.' }),
      ])
    );
  }

  const ok = await ask({
    title: 'Temizlik başlatılsın mı?',
    text: 'Seçilen dosyalar güvenlik kapısından geçirilerek işlenecek.',
    iconName: isDelete ? 'i-alert' : 'i-shield',
    danger: isDelete,
    confirmLabel: isDelete ? 'Kalıcı olarak sil' : 'Temizle',
    body,
  });
  if (!ok) return;

  state.cleaning = true;
  setProgress(0, 'Temizlik hazırlanıyor…');
  renderDock();

  const res = await api.clean.run(payload);
  state.cleaning = false;

  if (!res || !res.ok) {
    toast({ kind: 'error', title: 'Temizlik başarısız', text: (res && res.error) || '' });
    renderDock();
    return;
  }

  const report = res.data;
  clearSelection();

  const body2 = [
    el('dl', { class: 'summary-list' }, [
      el('div', {}, [el('dt', { text: 'İşlenen dosya' }), el('dd', { text: fmtNum(report.file_count) })]),
      el('div', {}, [el('dt', { text: 'Kazanılan alan' }), el('dd', { text: report.bytes_h })]),
      el('div', {}, [el('dt', { text: 'Yöntem' }), el('dd', { text: report.mode === 'delete' ? 'Kalıcı silme' : 'Karantina' })]),
    ]),
  ];
  if (report.error_count) {
    body2.push(
      el('div', { class: 'warn-box' }, [
        icon('i-alert'),
        el('p', {
          text: `${fmtNum(report.error_count)} dosya atlandı (kilitli veya korunan yol). ` +
                'Ayrıntı için aşağıdaki listeye bakın.',
        }),
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
        el('p', { text: 'Dosyalar karantinada. Karantina sekmesinden geri yükleyebilirsiniz.' }),
      ])
    );
  }

  await ask({
    title: 'Temizlik tamamlandı',
    text: `${report.bytes_h} geri kazanıldı.`,
    iconName: 'i-check-circle',
    confirmLabel: 'Kapat',
    body: body2,
  });

  await Promise.all([refreshVault(), refreshHistory()]);
  if (state.scan) {
    // Tarama sonucu artık gerçeği yansıtmıyor; kullanıcıyı bilgilendir.
    $('#heroSummary').textContent =
      'Temizlik yapıldı. Güncel durumu görmek için yeniden tarama çalıştırın.';
  }
  toast({ kind: 'success', title: 'Temizlik tamamlandı', text: `${report.bytes_h} geri kazanıldı` });
}

/* --------------------------------------------------------------- akıllı seçim */
function selectRecommended(silent = false) {
  if (!state.analysis || !state.scan) return;
  const ids = state.analysis.recommended_ids || [];
  if (!ids.length) {
    if (!silent) toast({ kind: 'info', title: 'Öneri yok', text: 'AI güvenli eşiği geçen kategori bulamadı.' });
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
    toast({ kind: 'success', title: 'AI önerisi seçildi', text: `${ids.length} kategori · ${human(bytes)}` });
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
    box.textContent = (res && res.error) || 'Önce tarama yapmalısınız.';
    return;
  }

  const pick = res.data;
  if (!pick.category_ids.length) {
    box.className = 'pickresult pickresult--short';
    box.textContent =
      'AI güvenli eşiği geçen kategori bulamadı. Derin taramayı açıp yeniden deneyin veya ' +
      'kategorileri elle inceleyin.';
    return;
  }

  box.className = `pickresult${pick.reached ? '' : ' pickresult--short'}`;
  box.replaceChildren(
    el('p', {}, [
      el('strong', { text: `${pick.size_h} seçildi` }),
      ` (hedef ${pick.target_h}). `,
      pick.reached
        ? 'Hedefe ulaşıldı; seçim yalnızca güvenli kategorilerden oluşuyor.'
        : `Hedefin ${pick.shortfall_h} kadarı karşılanamadı — kalan yer riskli gruplarda.`,
    ]),
    el('div', { class: 'vault__sample' }, pick.category_ids.map((id) => el('span', { text: state.catNames[id] || id })))
  );

  state.selectedCategories = new Set(pick.category_ids);
  state.selectedItems.clear();
  state.expanded = new Set(pick.category_ids);
  renderCategories();
  renderDock();
  toast({ kind: 'success', title: 'AI seçimini yaptı', text: `${pick.category_ids.length} kategori · ${pick.size_h}` });
}

/* --------------------------------------------------------------- başlangıç */
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
    if (btn) btn.title = maximized ? 'Geri al' : 'Büyüt';
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

  // alt çubuk
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
    $('#targetValue').textContent = Number(event.target.value).toFixed(1).replace('.', ',');
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
    if (btn) sendQuestion(btn.dataset.q);
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

  // tarama/temizlik ilerlemesi
  api.on('scan:progress', (progress) => {
    if (progress) setProgress(progress.percent, progress.stage);
  });
  api.on('clean:progress', (progress) => {
    if (progress) setProgress(progress.percent, progress.stage);
  });
  api.on('scan:error', (payload) => {
    toast({ kind: 'error', title: 'Tarama hatası', text: (payload && payload.error) || '' });
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

async function init() {
  bindEvents();

  const infoRes = await api.app.info();
  if (infoRes && infoRes.ok) {
    state.info = infoRes.data;
    const info = infoRes.data;
    $('#versionLabel').textContent = `v${info.version}`;
    $('#dataDirPath').textContent = info.dataDir;
    $('#aboutList').replaceChildren(
      el('div', {}, [el('dt', { text: 'Ürün' }), el('dd', { text: info.fullName || 'reMona · AICleaner' })]),
      el('div', {}, [el('dt', { text: 'Sürüm' }), el('dd', { text: info.version })]),
      el('div', {}, [el('dt', { text: 'Electron' }), el('dd', { text: info.electron })]),
      el('div', {}, [el('dt', { text: 'Chromium' }), el('dd', { text: info.chrome })]),
      el('div', {}, [el('dt', { text: 'Node' }), el('dd', { text: info.node })]),
      el('div', {}, [el('dt', { text: 'Platform' }), el('dd', { text: info.platform })]),
      el('div', {}, [el('dt', { text: 'Sistem sürücüsü' }), el('dd', { text: info.drive })])
    );
  }

  const settingsRes = await api.settings.get();
  if (settingsRes && settingsRes.ok) applySettings(settingsRes.data);

  const countsRes = await api.scan.counts();
  if (countsRes && countsRes.ok) {
    state.safeIds = countsRes.data.safe_ids || [];
    state.catNames = Object.fromEntries((countsRes.data.categories || []).map((c) => [c.id, c.name]));
  }

  // Son taramayı geri getir (uygulama yeniden açıldığında bağlam korunur).
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

  await Promise.all([refreshVault(), refreshHistory(), refreshProvider(), refreshAiConfig()]);

  if (state.info && state.info.isDev) {
    toast({ kind: 'info', title: 'Geliştirme modu', text: 'F12 ile DevTools açılır.', timeout: 4000 });
  }
}

init().catch((error) => {
  toast({ kind: 'error', title: 'Başlatma hatası', text: String(error && error.message) });
});
