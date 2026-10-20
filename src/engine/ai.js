'use strict';

/**
 * AI advisor layer.
 *
 * It works in three layers:
 *
 * 1. Rule engine (always on): produces a confidence score from category risk,
 *    file age and size, and writes insights in the selected interface language.
 * 2. Smart selection: ranks the safest and most effective categories to reach
 *    a target (5 GB, for example).
 * 3. Local LLM (when present): answers questions in natural language through
 *    Ollama or an OpenAI-compatible endpoint. Otherwise the rule engine answers.
 */

const config = require('./config');
const store = require('./store');
const scanner = require('./scanner');
const i18n = require('../i18n');
const { humanSize } = require('./utils');

const RISK_WEIGHT = { safe: 1.0, caution: 0.55, risky: 0.2 };

/* Verdict tokens are also the catalogue keys under "verdict". */

/** Risk label in the selected interface language. */
function riskLabel(risk) {
  return i18n.t(`risk.${risk}`);
}

/** Verdict label ("Can be removed", "Do not touch", …). */
function verdictLabel(verdict) {
  return i18n.t(`verdict.${verdict || 'avoid'}`);
}

const PROVIDER_TTL_MS = 30000;
let providerCache = { at: 0, value: null };

/** Called when settings change; the next query probes again. */
function resetProviderCache() {
  providerCache = { at: 0, value: null };
}

// ------------------------------------------------------------------ provider
async function fetchWithTimeout(url, options = {}, timeoutMs = config.AI_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function ollamaModel() {
  try {
    const res = await fetchWithTimeout(`${config.OLLAMA_URL}/api/tags`, {}, 1500);
    if (!res.ok) return '';
    const data = await res.json();
    const models = (data.models || []).map((m) => m.name).filter(Boolean);
    if (!models.length) return '';
    if (config.OLLAMA_MODEL) {
      const wanted = config.OLLAMA_MODEL.split(':')[0];
      const hit = models.find((name) => name.split(':')[0] === wanted);
      if (hit) return hit;
    }
    return models[0];
  } catch {
    return '';
  }
}

/** Turns HTTP status codes into sentences a user can understand. */
function httpMessage(status, detail) {
  const text = String(detail || '').trim();
  if (status === 401) return i18n.t('http.e401');
  if (status === 403) return i18n.t('http.e403');
  if (status === 404) return i18n.t('http.e404', { detail: text }).trim();
  if (status === 429) return i18n.t('http.e429');
  if (status === 413) return i18n.t('http.e413');
  if (status >= 500) return i18n.t('http.e5xx', { status });
  return text || i18n.t('http.default', { status, detail: '' }).trim();
}

/**
 * Sends a request to an OpenAI-compatible endpoint. It does not throw on
 * network errors; it returns `{ ok, data, error, status, cfg }` so the interface can show the cause.
 */
async function openaiRequest(pathname, { method = 'GET', body, timeoutMs } = {}) {
  const cfg = await store.getAiConfig();
  if (!cfg.has_key) {
    return {
      ok: false,
      status: 0,
      cfg,
      error: i18n.t('ai.noKey'),
    };
  }

  const headers = { Authorization: `Bearer ${cfg.key}` };
  if (body) headers['Content-Type'] = 'application/json';

  try {
    const res = await fetchWithTimeout(
      `${cfg.base}${pathname}`,
      { method, headers, body: body ? JSON.stringify(body) : undefined },
      timeoutMs || config.AI_TIMEOUT_MS
    );

    if (!res.ok) {
      let detail = '';
      try {
        const parsed = await res.json();
        detail = parsed?.error?.message || parsed?.message || '';
      } catch {
        /* the detail stays empty when the body is not JSON */
      }
      return { ok: false, status: res.status, cfg, error: httpMessage(res.status, detail) };
    }

    return { ok: true, status: res.status, cfg, data: await res.json() };
  } catch (error) {
    const aborted = error && error.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      cfg,
      error: aborted
        ? i18n.t('ai.timeout')
        : i18n.t('ai.unreachable', { error: String((error && error.message) || error) }),
    };
  }
}

/** Lists the available chat models (`GET /models`). */
async function listModels() {
  const result = await openaiRequest('/models', { timeoutMs: config.AI_MODELS_TIMEOUT_MS });
  if (!result.ok) {
    return { ok: false, models: [], base: result.cfg?.base || '', error: result.error };
  }

  const rows = Array.isArray(result.data?.data) ? result.data : [];
  const models = rows
    .map((row) => String(row?.id || '').trim())
    .filter(Boolean)
    .filter((id) => !/embed|whisper|tts|dall-e|moderation|audio|realtime|image/i.test(id));

  // Chat models come first; the rest is alphabetical.
  const chatLike = /^(gpt|chatgpt|o\d|claude|gemini|llama|mistral|qwen|deepseek|grok|command)/i;
  models.sort((a, b) => {
    const diff = (chatLike.test(a) ? 0 : 1) - (chatLike.test(b) ? 0 : 1);
    return diff || a.localeCompare(b);
  });

  return { ok: true, models, base: result.cfg.base, count: models.length };
}

/** Runs one real round with the given (or stored) model and measures latency. */
async function testConnection(model) {
  const cfg = await store.getAiConfig();
  const target = String(model || cfg.model || '').trim();
  if (!target) {
    return { ok: false, error: i18n.t('ai.noModel') };
  }

  const started = Date.now();
  const result = await openaiRequest('/chat/completions', {
    method: 'POST',
    timeoutMs: config.AI_TEST_TIMEOUT_MS,
    body: {
      model: target,
      messages: [
        { role: 'system', content: i18n.t('ai.testRequest') },
        { role: 'user', content: i18n.t('ai.testPing') },
      ],
      max_tokens: 8,
      temperature: 0,
    },
  });

  const latency = Date.now() - started;
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      status: result.status,
      model: target,
      base: cfg.base,
      latency_ms: latency,
    };
  }

  const reply = String(result.data?.choices?.[0]?.message?.content || '').trim().slice(0, 120);
  return { ok: true, model: target, base: cfg.base, latency_ms: latency, reply };
}

/** Returns which AI engine is available (cached for 30 seconds). */
async function providerStatus({ refresh = false } = {}) {
  if (!refresh && providerCache.value && Date.now() - providerCache.at < PROVIDER_TTL_MS) {
    return providerCache.value;
  }

  const cfg = await store.getAiConfig();
  const rules = {
    engine: 'local-rules',
    model: i18n.t('engine.rulesTag'),
    available: true,
    configured: cfg.provider,
    note: i18n.t('provider.noteRules'),
  };

  let status = rules;

  if (cfg.provider === 'rules') {
    status = { ...rules, note: i18n.t('provider.noteRulesOnly') };
  } else if (cfg.provider === 'openai') {
    status = cfg.has_key
      ? {
          engine: 'openai',
          model: cfg.model,
          available: true,
          configured: 'openai',
          note: i18n.t('provider.noteOpenAi'),
        }
      : {
          ...rules,
          configured: 'openai',
          note: i18n.t('provider.noteOpenAiNoKey'),
        };
  } else if (cfg.provider === 'ollama') {
    const model = await ollamaModel();
    status = model
      ? {
          engine: 'ollama',
          model,
          available: true,
          configured: 'ollama',
          note: i18n.t('provider.noteOllama'),
        }
      : { ...rules, configured: 'ollama', note: i18n.t('provider.noteOllamaDown') };
  } else {
    // auto: yerel LLM → OpenAI → kural motoru
    const model = await ollamaModel();
    if (model) {
      status = {
        engine: 'ollama',
        model,
        available: true,
        configured: 'auto',
        note: i18n.t('provider.noteOllama'),
      };
    } else if (cfg.has_key) {
      status = {
        engine: 'openai',
        model: cfg.model,
        available: true,
        configured: 'auto',
        note: i18n.t('provider.noteOpenAi'),
      };
    } else {
      status = { ...rules, configured: 'auto', note: i18n.t('provider.noteNoLocal') };
    }
  }

  providerCache = { at: Date.now(), value: status };
  return status;
}

// ------------------------------------------------------------------ skorlama
function confidence(cat, totalSize, diskPercent) {
  const base = { safe: 92, caution: 62, risky: 25 }[cat.risk] ?? 50;
  if (!cat.size) return { confidence: 0, verdict: 'empty', reason: i18n.t('reason.empty') };

  let conf = base;
  const share = totalSize ? cat.size / totalSize : 0;
    conf += Math.min(8, share * 20); // a bigger win gets priority
  if (diskPercent >= 85) conf += 5; // disk doluysa cesaret artar

  const ages = (cat.items || []).slice(0, 50).map((i) => i.age_days || 0);
  if (ages.length) {
    const avgAge = ages.reduce((a, b) => a + b, 0) / ages.length;
    if (avgAge > 60) conf += 4;
        else if (avgAge < 1) conf -= 6; // files created moments ago are risky
  }

  let reason = cat.description || '';
  switch (cat.id) {
    case 'prefetch':
      conf = Math.min(conf, 45);
      reason = i18n.t('reason.prefetch');
      break;
    case 'downloads_old':
      reason = i18n.t('reason.downloads');
      break;
    case 'recycle_bin':
      reason = i18n.t('reason.recycle');
      break;
    case 'duplicates':
      reason = i18n.t('reason.duplicates');
      break;
    case 'browser_cache':
      reason = i18n.t('reason.browser');
      break;
    case 'large_files':
      reason = i18n.t('reason.large');
      break;
    default:
      break;
  }

  conf = Math.max(0, Math.min(99, conf));
  let verdict = 'avoid';
  if (conf >= 80) verdict = 'delete';
  else if (conf >= 50) verdict = 'review';

  return { confidence: Math.round(conf), verdict, reason };
}

/** Adds the AI assessment to a scan result. */
async function analyze(input) {
  const result = scanner.localizeView(input);
  const categories = result.categories || [];
  const totalSize = result.totals.all || 1;
  const disk = result.disk.primary;
  const diskPercent = Number(disk.percent) || 0;

  const evaluations = {};
  for (const cat of categories) {
    const { confidence: conf, verdict, reason } = confidence(cat, totalSize, diskPercent);
    evaluations[cat.id] = {
      confidence: conf,
      verdict,
      verdict_label: verdictLabel(verdict),
      risk_label: riskLabel(cat.risk),
      reason,
      weight: RISK_WEIGHT[cat.risk],
    };
  }

  const recommendedIds = categories
    .filter((cat) => evaluations[cat.id].confidence >= 80 && cat.size > 0)
    .map((cat) => cat.id);

  const recommendedSize = categories
    .filter((cat) => recommendedIds.includes(cat.id))
    .reduce((sum, cat) => sum + cat.size, 0);

  const status = await providerStatus();

  return {
    engine: status.engine,
    model: status.model,
    provider_note: status.note,
    generated_at: Date.now() / 1000,
    insights: insights(result, evaluations),
    categories: evaluations,
    recommended_ids: recommendedIds,
    potential: {
      recommended: recommendedSize,
      recommended_h: humanSize(recommendedSize),
      total: result.totals.all,
      total_h: result.totals.all_h,
      safe: result.totals.safe,
      safe_h: result.totals.safe_h,
    },
    summary: summaryText(result, recommendedIds),
  };
}

function insights(result, evaluations) {
  const out = [];
  const cats = (result.categories || []).filter((c) => c.size > 0);
  const disk = result.disk.primary;
  const total = result.totals.all;

  if (!cats.length) {
    return [
      {
        level: 'info',
        title: i18n.t('insight.cleanTitle'),
        text: i18n.t('insight.cleanText'),
      },
    ];
  }

  const biggest = cats.reduce((a, b) => (b.size > a.size ? b : a));
  const share = total ? Math.round((biggest.size / total) * 100) : 0;
  out.push({
    level: 'win',
    title: i18n.t('insight.biggestTitle', { name: biggest.name }),
    text: i18n.t('insight.biggestText', {
      size: biggest.size_h,
      percent: share,
      confidence: evaluations[biggest.id].confidence,
    }),
  });

  if ((disk.percent || 0) >= 85) {
    out.push({
      level: 'warn',
      title: i18n.t('insight.diskFullTitle'),
      text: i18n.t('insight.diskFullText', {
        drive: disk.drive,
        percent: disk.percent,
        free: disk.free_h,
      }),
    });
  }

  const safeCats = cats.filter((c) => c.risk === 'safe');
  if (safeCats.length) {
    const safeTotal = safeCats.reduce((sum, c) => sum + c.size, 0);
    out.push({
      level: 'ok',
      title: i18n.t('insight.safeTitle'),
      text: i18n.t('insight.safeText', {
        size: humanSize(safeTotal),
        count: safeCats.length,
      }),
    });
  }

  const risky = cats.filter((c) => c.risk === 'risky');
  if (risky.length) {
    const names = risky.slice(0, 3).map((c) => c.name).join(', ');
    out.push({
      level: 'warn',
      title: i18n.t('insight.riskyTitle'),
      text: i18n.t('insight.riskyText', { names }),
    });
  }

  const prefetch = cats.find((c) => c.id === 'prefetch');
  if (prefetch) {
    out.push({
      level: 'info',
      title: i18n.t('insight.prefetchTitle'),
      text: i18n.t('insight.prefetchText', {
        size: prefetch.size_h,
        confidence: evaluations.prefetch.confidence,
      }),
    });
  }

  const dups = cats.find((c) => c.id === 'duplicates');
  if (dups) {
    out.push({
      level: 'win',
      title: i18n.t('insight.dupsTitle'),
      text: i18n.t('insight.dupsText', { size: dups.size_h, count: dups.file_count }),
    });
  }

  const stale = cats.filter((c) => c.items && c.items.length && c.items.every((i) => i.age_days > 365));
  if (stale.length) {
    out.push({
      level: 'info',
      title: i18n.t('insight.staleTitle'),
      text: i18n.t('insight.staleText', { names: stale.map((c) => c.name).join(', ') }),
    });
  }

  return out;
}

function summaryText(result, recommendedIds) {
  const totals = result.totals;
  if (totals.all === 0) return i18n.t('summary.nothing');
  const rec = result.categories
    .filter((c) => recommendedIds.includes(c.id))
    .reduce((sum, c) => sum + c.size, 0);
  return i18n.t('summary.text', {
    size: totals.all_h,
    count: i18n.number(totals.file_count),
    recommended: humanSize(rec),
    rest: humanSize(totals.all - rec),
  });
}

// ------------------------------------------------------------------ smart selection
/** Picks the categories that reach the target free space by the safest route. */
async function smartPick(result, targetBytes) {
  const analysis = await analyze(result);
  const ranked = result.categories
    .filter((cat) => cat.size > 0)
    .map((cat) => ({ cat, confidence: analysis.categories[cat.id].confidence }))
    .sort((a, b) => b.confidence - a.confidence || b.cat.size - a.cat.size);

  const chosen = [];
  let accumulated = 0;
  for (const row of ranked) {
    if (accumulated >= targetBytes) break;
        if (row.confidence < 50) continue; // risky groups are never selected automatically
    chosen.push(row.cat.id);
    accumulated += row.cat.size;
  }

  return {
    category_ids: chosen,
    size: accumulated,
    size_h: humanSize(accumulated),
    target: targetBytes,
    target_h: humanSize(targetBytes),
    reached: accumulated >= targetBytes,
    shortfall_h: accumulated >= targetBytes ? '' : humanSize(targetBytes - accumulated),
  };
}

// ------------------------------------------------------------------ soru-cevap
/**
 * Answers the user's question: the LLM when available, the rule engine otherwise.
 * `intent` comes from the preset question buttons in the interface, so the rule
 * engine can pick the right answer regardless of the language it was written in.
 */
async function ask(question, result, options = {}) {
  const text = String(question || '').trim();
  const intent = String(options.intent || '').trim();
  if (!text && !intent) {
    return { answer: i18n.t('ai.askEmpty'), engine: 'local-rules' };
  }

  const context = contextText(result);
  const status = await providerStatus();

  if (status.engine === 'ollama') {
    const answer = await ollamaGenerate(text || intent, context, status.model);
    if (answer) return { answer, engine: `ollama:${status.model}` };
  } else if (status.engine === 'openai') {
    const cfg = await store.getAiConfig();
    const reply = await openaiGenerate(text || intent, context, cfg);
    if (reply.text) return { answer: reply.text, engine: `openai:${cfg.model}` };
    // Key and endpoint errors are not swallowed: the user sees the cause.
    if (reply.error) return { answer: reply.error, engine: 'openai:error' };
  }

  return { answer: ruleAnswer(text || intent, result, intent), engine: 'local-rules' };
}

/** Scan summary given to the model. It is input data, independent of the interface language. */
function contextText(result) {
  if (!result) return 'No scan has been run yet.';
  const disk = result.disk.primary;
  const lines = [
    `Disk ${disk.drive}: total ${disk.total_h}, free ${disk.free_h}, used ${disk.percent}%.`,
    `Total junk: ${result.totals.all_h} (${result.totals.file_count} files).`,
  ];
  for (const cat of result.categories) {
    if (cat.size > 0) {
      lines.push(`- ${cat.name} (${cat.risk}): ${cat.size_h}, ${cat.file_count} files.`);
    }
  }
  return lines.join('\n');
}

/** System prompt: asks for the answer in the selected interface language. */
function systemPrompt() {
  return `${i18n.t('ai.systemPrompt')} ${i18n.t('ai.languageLine', {
    language: i18n.localeMeta().english,
  })}`;
}

async function ollamaGenerate(question, context, model) {
  try {
    const res = await fetchWithTimeout(`${config.OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: `${systemPrompt()}\n\nScan data:\n${context}\n\nQuestion: ${question}`,
        stream: false,
        options: { temperature: 0.3, num_predict: 220 },
      }),
    });
    if (!res.ok) return '';
    const data = await res.json();
    return String(data.response || '').trim();
  } catch {
    return '';
  }
}

async function openaiGenerate(question, context, cfg) {
  const config_ = cfg || (await store.getAiConfig());
  const result = await openaiRequest('/chat/completions', {
    method: 'POST',
    body: {
      model: config_.model,
      messages: [
        { role: 'system', content: systemPrompt() },
        { role: 'user', content: `Scan data:\n${context}\n\nQuestion: ${question}` },
      ],
      temperature: config_.temperature,
      max_tokens: config_.max_tokens,
    },
  });

  if (!result.ok) return { text: '', error: result.error };

  const text = String(result.data?.choices?.[0]?.message?.content || '').trim();
  if (!text) return { text: '', error: i18n.t('ai.emptyReply') };
  return { text, error: '' };
}

/** Intent patterns for typed questions (keywords in several languages). */
const INTENT_PATTERNS = {
  what: /\b(delete|remove|clean|cleanup|free|junk|what)\b|sil|öner|tavsiye|hangi|temizle|löschen|supprimer|eliminar|eliminare|excluir|удал|削除|삭제|حذف/i,
  disk: /\b(disk|drive|space|storage|full)\b|yer|alan|dolu|espace|espacio|spazio|platz|место|容量|空間|مساحة/i,
  duplicates: /\b(duplicate|duplicates|copies|copy)\b|kopya|doublon|duplicado|duplicat|doppelt|дубликат|重复|重複|중복|مكرر/i,
  risky: /\b(risk|risky|safe|safety|danger|dangerous)\b|güven|risik|risque|riesgo|rischio|риск|リスク|위험|خطر/i,
};

/**
 * Rule engine answer. When `intent` is given the keyword search is skipped, so
 * the preset questions in the interface pick the right branch in every language.
 */
function ruleAnswer(question, result, intent = '') {
  if (!result) return i18n.t('rule.noScan');
  result = scanner.localizeView(result);

  const q = String(question || '').toLowerCase();
  const cats = result.categories || [];
  const totalH = result.totals.all_h;
  const wants = (name) => (intent ? intent === name : INTENT_PATTERNS[name].test(q));

  if (wants('what')) {
    const safe = cats.filter((c) => c.risk === 'safe' && c.size > 0);
    if (safe.length) {
      const names = safe.map((c) => `${c.name} (${c.size_h})`).join(', ');
      const total = safe.reduce((sum, c) => sum + c.size, 0);
      return i18n.t('rule.safeList', { count: safe.length, names, size: humanSize(total) });
    }
    return i18n.t('rule.noSafe', { size: totalH });
  }

  if (wants('disk')) {
    const disk = result.disk.primary;
    return i18n.t('rule.disk', {
      drive: disk.drive,
      percent: disk.percent,
      used: disk.used_h,
      free: disk.free_h,
      junk: totalH,
    });
  }

  // Category names are translated too, so the match works in every language.
  for (const cat of cats) {
    if (cat.size <= 0) continue;
    const words = String(cat.name || '')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 3);
    if (words.some((word) => q.includes(word))) {
      return i18n.t('rule.category', {
        name: cat.name,
        size: cat.size_h,
        count: cat.file_count,
        risk: riskLabel(cat.risk),
        reason: cat.description,
      });
    }
  }

  if (wants('risky')) return i18n.t('rule.trust');

  if (wants('duplicates')) {
    const dup = cats.find((c) => c.id === 'duplicates');
    if (dup && dup.size > 0) {
      return i18n.t('rule.duplicates', { size: dup.size_h, count: dup.file_count });
    }
    return i18n.t('rule.noDuplicates');
  }

  const safeTotal = cats.filter((c) => c.risk === 'safe').reduce((sum, c) => sum + c.size, 0);
  return i18n.t('rule.summary', { junk: totalH, safe: humanSize(safeTotal) });
}

module.exports = {
  providerStatus,
  resetProviderCache,
  listModels,
  testConnection,
  analyze,
  smartPick,
  ask,
  confidence,
  ruleAnswer,
  riskLabel,
  verdictLabel,
  RISK_WEIGHT,
};
