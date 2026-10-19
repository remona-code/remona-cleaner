'use strict';

/**
 * AI danışman katmanı.
 *
 * Üç katmanlı çalışır:
 *
 * 1. Kural motoru (her zaman açık): kategori riski, dosya yaşı ve boyut
 *    ağırlığından güven skoru üretir, Türkçe içgörüler çıkarır.
 * 2. Akıllı seçim: hedefe (ör. 5 GB) ulaşmak için en güvenli/en verimli
 *    kategorileri sıralar.
 * 3. Yerel LLM (varsa): Ollama ya da OpenAI uyumlu uç nokta üzerinden
 *    doğal dilde soruları yanıtlar. Yoksa kural motoru yanıtlar.
 */

const config = require('./config');
const store = require('./store');
const { humanSize } = require('./utils');

const RISK_WEIGHT = { safe: 1.0, caution: 0.55, risky: 0.2 };
const RISK_LABEL = { safe: 'Güvenli', caution: 'Dikkatli', risky: 'Riskli' };
const VERDICT_LABEL = {
  sil: 'Silinebilir',
  dikkatli: 'Gözden geçir',
  dokunma: 'Dokunma',
  boş: 'Boş',
};

const PROVIDER_TTL_MS = 30000;
let providerCache = { at: 0, value: null };

/** Ayarlar değiştiğinde çağrılır; bir sonraki sorgu yeniden yoklar. */
function resetProviderCache() {
  providerCache = { at: 0, value: null };
}

// ------------------------------------------------------------------ sağlayıcı
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

/** HTTP durum kodlarını kullanıcının anlayacağı Türkçe cümlelere çevirir. */
function httpMessage(status, detail) {
  const text = String(detail || '').trim();
  if (status === 401) return 'API anahtarı reddedildi (401). Anahtarı kontrol edin.';
  if (status === 403) return 'Bu anahtarın istenen modele erişim yetkisi yok (403).';
  if (status === 404) return `Uç nokta veya model bulunamadı (404).${text ? ` ${text}` : ''}`;
  if (status === 429) return 'İstek sınırı ya da kota aşıldı (429). Bir süre sonra deneyin.';
  if (status === 413) return 'İstek gövdesi çok büyük (413).';
  if (status >= 500) return `Sağlayıcı tarafında hata (${status}). Sonra tekrar deneyin.`;
  return text || `İstek başarısız oldu (HTTP ${status}).`;
}

/**
 * OpenAI uyumlu uç noktaya istek atar. Ağ hatalarında fırlatmaz;
 * `{ ok, data, error, status, cfg }` döndürür ki arayüz nedeni gösterebilsin.
 */
async function openaiRequest(pathname, { method = 'GET', body, timeoutMs } = {}) {
  const cfg = await store.getAiConfig();
  if (!cfg.has_key) {
    return {
      ok: false,
      status: 0,
      cfg,
      error: 'OpenAI API anahtarı girilmemiş. Ayarlar → AI sağlayıcısı bölümünden ekleyin.',
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
        /* gövde JSON değilse ayrıntı boş kalır */
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
        ? 'İstek zaman aşımına uğradı. Uç nokta adresini ve bağlantıyı kontrol edin.'
        : `Sunucuya ulaşılamadı: ${String((error && error.message) || error)}`,
    };
  }
}

/** Kullanılabilir sohbet modellerini listeler (`GET /models`). */
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

  // Sohbet modelleri listenin başında dursun; gerisi alfabetik.
  const chatLike = /^(gpt|chatgpt|o\d|claude|gemini|llama|mistral|qwen|deepseek|grok|command)/i;
  models.sort((a, b) => {
    const diff = (chatLike.test(a) ? 0 : 1) - (chatLike.test(b) ? 0 : 1);
    return diff || a.localeCompare(b);
  });

  return { ok: true, models, base: result.cfg.base, count: models.length };
}

/** Verilen (ya da kayıtlı) modelle gerçek bir tur atıp gecikmeyi ölçer. */
async function testConnection(model) {
  const cfg = await store.getAiConfig();
  const target = String(model || cfg.model || '').trim();
  if (!target) {
    return { ok: false, error: 'Model adı boş. Önce bir model seçin.' };
  }

  const started = Date.now();
  const result = await openaiRequest('/chat/completions', {
    method: 'POST',
    timeoutMs: config.AI_TEST_TIMEOUT_MS,
    body: {
      model: target,
      messages: [
        { role: 'system', content: 'Yalnızca "hazır" sözcüğünü yaz.' },
        { role: 'user', content: 'Bağlantı testi.' },
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

/** Hangi AI motorunun kullanılabilir olduğunu döndürür (30 sn önbellekli). */
async function providerStatus({ refresh = false } = {}) {
  if (!refresh && providerCache.value && Date.now() - providerCache.at < PROVIDER_TTL_MS) {
    return providerCache.value;
  }

  const cfg = await store.getAiConfig();
  const rules = {
    engine: 'local-rules',
    model: 'kural motoru',
    available: true,
    configured: cfg.provider,
    note: 'Kural motoru kullanılıyor',
  };

  let status = rules;

  if (cfg.provider === 'rules') {
    status = { ...rules, note: 'Ayarlarda yalnızca kural motoru seçildi' };
  } else if (cfg.provider === 'openai') {
    status = cfg.has_key
      ? {
          engine: 'openai',
          model: cfg.model,
          available: true,
          configured: 'openai',
          note: 'OpenAI bağlı',
        }
      : {
          ...rules,
          configured: 'openai',
          note: 'OpenAI seçildi ancak API anahtarı girilmemiş',
        };
  } else if (cfg.provider === 'ollama') {
    const model = await ollamaModel();
    status = model
      ? { engine: 'ollama', model, available: true, configured: 'ollama', note: 'Yerel LLM bağlı' }
      : { ...rules, configured: 'ollama', note: 'Yerel Ollama çalışmıyor' };
  } else {
    // auto: yerel LLM → OpenAI → kural motoru
    const model = await ollamaModel();
    if (model) {
      status = { engine: 'ollama', model, available: true, configured: 'auto', note: 'Yerel LLM bağlı' };
    } else if (cfg.has_key) {
      status = { engine: 'openai', model: cfg.model, available: true, configured: 'auto', note: 'OpenAI bağlı' };
    } else {
      status = { ...rules, configured: 'auto', note: 'Yerel LLM bulunamadı, kural motoru kullanılıyor' };
    }
  }

  providerCache = { at: Date.now(), value: status };
  return status;
}

// ------------------------------------------------------------------ skorlama
function confidence(cat, totalSize, diskPercent) {
  const base = { safe: 92, caution: 62, risky: 25 }[cat.risk] ?? 50;
  if (!cat.size) return { confidence: 0, verdict: 'boş', reason: 'Silinecek bir şey yok' };

  let conf = base;
  const share = totalSize ? cat.size / totalSize : 0;
  conf += Math.min(8, share * 20); // büyük kazanç daha öncelikli
  if (diskPercent >= 85) conf += 5; // disk doluysa cesaret artar

  const ages = (cat.items || []).slice(0, 50).map((i) => i.age_days || 0);
  if (ages.length) {
    const avgAge = ages.reduce((a, b) => a + b, 0) / ages.length;
    if (avgAge > 60) conf += 4;
    else if (avgAge < 1) conf -= 6; // az önce oluşan dosyalar risklidir
  }

  let reason = cat.description || '';
  switch (cat.id) {
    case 'prefetch':
      conf = Math.min(conf, 45);
      reason = 'Kazancı küçük (genelde <200 MB) ve uygulama açılışlarını yavaşlatır.';
      break;
    case 'downloads_old':
      reason = 'İçeriği size ait olabilir. AI yalnızca öneri verir, dosyayı siz seçin.';
      break;
    case 'recycle_bin':
      reason = 'Zaten silmeyi seçtiğiniz dosyalar; boşaltmak geri alınamaz.';
      break;
    case 'duplicates':
      reason = 'Her gruptan aslı korunur, yalnızca fazla kopyalar işaretlenir.';
      break;
    case 'browser_cache':
      reason = 'Oturum bilgileri ve şifreler etkilenmez, yalnızca önbellek temizlenir.';
      break;
    case 'large_files':
      reason = 'Boyut tek başına silme gerekçesi değil. Dosyanın ne olduğuna bakın.';
      break;
    default:
      break;
  }

  conf = Math.max(0, Math.min(99, conf));
  let verdict = 'dokunma';
  if (conf >= 80) verdict = 'sil';
  else if (conf >= 50) verdict = 'dikkatli';

  return { confidence: Math.round(conf), verdict, reason };
}

/** Tarama sonucuna AI değerlendirmesi ekler. */
async function analyze(result) {
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
      verdict_label: VERDICT_LABEL[verdict],
      risk_label: RISK_LABEL[cat.risk],
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
        title: 'Temiz görünüyor',
        text: 'Taranan konumlarda temizlenecek kayda değer dosya bulunmadı.',
      },
    ];
  }

  const biggest = cats.reduce((a, b) => (b.size > a.size ? b : a));
  const share = total ? Math.round((biggest.size / total) * 100) : 0;
  out.push({
    level: 'win',
    title: `En büyük kazanç: ${biggest.name}`,
    text: `${biggest.size_h} geri kazanılabilir — toplam atığın %${share}'i. AI güveni %${evaluations[biggest.id].confidence}.`,
  });

  if ((disk.percent || 0) >= 85) {
    out.push({
      level: 'warn',
      title: 'Disk doluluğu kritik',
      text: `${disk.drive} sürücüsü %${disk.percent} dolu, yalnızca ${disk.free_h} boş yer var. Önerilen temizliği önceliklendirin.`,
    });
  }

  const safeCats = cats.filter((c) => c.risk === 'safe');
  if (safeCats.length) {
    const safeTotal = safeCats.reduce((sum, c) => sum + c.size, 0);
    out.push({
      level: 'ok',
      title: 'Risksiz kazanç hazır',
      text: `${humanSize(safeTotal)} tutarında önbellek ve geçici dosya var; bunları silmek veri kaybı yaratmaz (${safeCats.length} kategori).`,
    });
  }

  const risky = cats.filter((c) => c.risk === 'risky');
  if (risky.length) {
    const names = risky.slice(0, 3).map((c) => c.name).join(', ');
    out.push({
      level: 'warn',
      title: 'Elle onay gereken grup',
      text: `${names} kişisel dosyalarınızı içerebilir. AI bunları varsayılan seçime eklemez; yalnızca incelediklerinizi silin.`,
    });
  }

  const prefetch = cats.find((c) => c.id === 'prefetch');
  if (prefetch) {
    out.push({
      level: 'info',
      title: 'Prefetch: düşük kazanç',
      text: `${prefetch.size_h} yer açar ama sonraki açılışları yavaşlatır. AI bu kategoriyi düşük puanlıyor (%${evaluations.prefetch.confidence}).`,
    });
  }

  const dups = cats.find((c) => c.id === 'duplicates');
  if (dups) {
    out.push({
      level: 'win',
      title: 'Kopya dosyalar bulundu',
      text: `${dups.size_h} aynı içeriğin tekrarı. Asıllar korunacak şekilde ${dups.file_count} fazla kopya işaretlendi.`,
    });
  }

  const stale = cats.filter((c) => c.items && c.items.length && c.items.every((i) => i.age_days > 365));
  if (stale.length) {
    out.push({
      level: 'info',
      title: 'Yıllardır dokunulmamış dosyalar',
      text: `${stale.map((c) => c.name).join(', ')} içindeki her dosya bir yıldan uzun süredir değişmemiş; silinmesi büyük olasılıkla güvenli.`,
    });
  }

  return out;
}

function summaryText(result, recommendedIds) {
  const totals = result.totals;
  if (totals.all === 0) return 'Sisteminizde temizlenecek dosya bulunmadı.';
  const rec = result.categories
    .filter((c) => recommendedIds.includes(c.id))
    .reduce((sum, c) => sum + c.size, 0);
  return (
    `Toplam ${totals.all_h} atık bulundu (${totals.file_count.toLocaleString('tr-TR')} dosya). ` +
    `AI'nın güvenle önerdiği kısım ${humanSize(rec)}. ` +
    `Kalan ${humanSize(totals.all - rec)} için sizin onayınız gerekiyor.`
  );
}

// ------------------------------------------------------------------ akıllı seçim
/** Hedeflenen boş alana en güvenli yoldan ulaşan kategori seçimini yapar. */
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
    if (row.confidence < 50) continue; // riskli gruplar asla otomatik seçilmez
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
/** Kullanıcının sorusunu yanıtlar: LLM varsa LLM, yoksa kural motoru. */
async function ask(question, result) {
  const text = String(question || '').trim();
  if (!text) {
    return { answer: 'Bir soru yazın; örneğin "ne silebilirim?"', engine: 'local-rules' };
  }

  const context = contextText(result);
  const status = await providerStatus();

  if (status.engine === 'ollama') {
    const answer = await ollamaGenerate(text, context, status.model);
    if (answer) return { answer, engine: `ollama:${status.model}` };
  } else if (status.engine === 'openai') {
    const answer = await openaiGenerate(text, context);
    if (answer) return { answer, engine: `openai:${config.OPENAI_MODEL}` };
  }

  return { answer: ruleAnswer(text, result), engine: 'local-rules' };
}

function contextText(result) {
  if (!result) return 'Henüz tarama yapılmadı.';
  const disk = result.disk.primary;
  const lines = [
    `Disk ${disk.drive}: toplam ${disk.total_h}, boş ${disk.free_h}, dolu %${disk.percent}.`,
    `Toplam atık: ${result.totals.all_h} (${result.totals.file_count} dosya).`,
  ];
  for (const cat of result.categories) {
    if (cat.size > 0) {
      lines.push(`- ${cat.name} (${cat.risk}): ${cat.size_h}, ${cat.file_count} dosya.`);
    }
  }
  return lines.join('\n');
}

const SYSTEM_PROMPT =
  'Sen reMona (AICleaner) adlı Windows disk temizleyicisinin danışmanısın. ' +
  'Kısa, net ve Türkçe yanıt ver. En fazla 4 cümle. ' +
  'Sistem dosyalarını silmeyi asla önerme; riskli kategorilerde kullanıcıya seçim bırak. ' +
  'Yalnızca verilen tarama verisine dayan.';

async function ollamaGenerate(question, context, model) {
  try {
    const res = await fetchWithTimeout(`${config.OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: `${SYSTEM_PROMPT}\n\nTarama verisi:\n${context}\n\nSoru: ${question}`,
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
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Tarama verisi:\n${context}\n\nSoru: ${question}` },
      ],
      temperature: config_.temperature,
      max_tokens: config_.max_tokens,
    },
  });

  if (!result.ok) return { text: '', error: result.error };

  const text = String(result.data?.choices?.[0]?.message?.content || '').trim();
  if (!text) return { text: '', error: 'Model boş yanıt döndürdü.' };
  return { text, error: '' };
}

function ruleAnswer(question, result) {
  if (!result) {
    return 'Önce bir tarama çalıştırın; sonra hangi dosyaların silinebileceğini değerlendirebilirim.';
  }

  const q = question.toLowerCase();
  const cats = result.categories;
  const totalH = result.totals.all_h;

  if (/(ne sil|nereden|öner|tavsiye|başla|hangi)/.test(q)) {
    const safe = cats.filter((c) => c.risk === 'safe' && c.size > 0);
    if (safe.length) {
      const names = safe.map((c) => `${c.name} (${c.size_h})`).join(', ');
      const total = safe.reduce((sum, c) => sum + c.size, 0);
      return (
        `Güvenle temizleyebileceğiniz ${safe.length} kategori var: ${names}. ` +
        `Toplam ${humanSize(total)} kazanç ve veri kaybı riski yok. ` +
        'Kalan gruplar kişisel dosyalarınızı içerebilir, onları seçerek silin.'
      );
    }
    return `Risksiz kategori kalmadı. Toplam atık ${totalH}; kalanı inceledikten sonra silebilirsiniz.`;
  }

  if (/(disk|yer|alan|dolu)/.test(q)) {
    const disk = result.disk.primary;
    return (
      `${disk.drive} sürücüsü %${disk.percent} dolu: ${disk.used_h} kullanımda, ${disk.free_h} boş. ` +
      `Tarama ${totalH} atık buldu; risksiz kısmı temizlemek boş alanı artırır.`
    );
  }

  for (const cat of cats) {
    const key = cat.name.toLowerCase().split(/\s+/)[0];
    if (key && key.length > 3 && q.includes(key) && cat.size > 0) {
      return `${cat.name}: ${cat.size_h}, ${cat.file_count} dosya. Risk seviyesi ${RISK_LABEL[cat.risk]} — gerekçe: ${cat.description}`;
    }
  }

  if (/(güven|risk)/.test(q)) {
    return (
      'Güvenli kategoriler: tarayıcı önbellekleri, küçük resim önbelleği, geçici dosyalar ' +
      've çökme dökümleri. Riski olanlar: eski indirilenler, büyük dosyalar ve kopyalar — ' +
      'bunları tek tek gözden geçirmeniz gerekir.'
    );
  }

  if (/(kopya|duplicate)/.test(q)) {
    const dup = cats.find((c) => c.id === 'duplicates');
    if (dup && dup.size > 0) {
      return `${dup.size_h} tutarında kopya bulundu. Asıllar korunur, ${dup.file_count} fazla kopya silinebilir.`;
    }
    return 'Kopya dosya bulunmadı (derin tarama kapalıysa açıp tekrar deneyin).';
  }

  const safeTotal = cats.filter((c) => c.risk === 'safe').reduce((sum, c) => sum + c.size, 0);
  return (
    `Özet: ${totalH} atık bulundu, bunun ${humanSize(safeTotal)} kadarı risksiz. ` +
    '"Ne silebilirim?" diye sorarsanız kategori kategori önerebilirim.'
  );
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
  RISK_LABEL,
  RISK_WEIGHT,
};
