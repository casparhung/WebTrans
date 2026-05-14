// content.js  - WebTrans content script

const GT_API = 'https://translate.googleapis.com/translate_a/single';
const WT_ATTR = 'data-wt-original';
const MAX_CHARS = 480;       // Google Translate limit per request
const AI_BATCH_SIZE = 20;    // nodes per AI JSON batch
const AI_TIMEOUT_MS = 60000; // 60s per AI batch timeout
const GT_CONCURRENCY = 6;    // parallel Google Translate requests

let currentLang = 'zh-TW';
let selectionEnabled = true;
let isTranslated = false;
let currentAiConfig = null;   // set when translation is active
let isTranslating = false;    // true while translatePage is running
let cancelRequested = false;  // set to true to abort in-progress translation
let tooltip = null;
let tooltipTimeout = null;
let tooltipAutoClose = null;
let skipNextMouseUp = false;
let fab = null;
let mutationObserver = null;
let isBusyTranslating = false; // pause observer while we write to DOM

// helper: skip nodes that have NO translatable letters (only digits/spaces/symbols)
function hasLetter(t) { return /\p{L}/u.test(t); }

// ------------------------------------------------------------------
// Init  (guard against double-injection)
// ------------------------------------------------------------------
if (!window.__wtInitialized) {
  window.__wtInitialized = true;
  (async () => {
    const saved = await storage_get({ 
      targetLang: 'zh-TW', 
      selectionEnabled: true,
      aiEnabled: false,
      aiEndpoint: 'https://api.openai.com/v1',
      aiKey: '',
      aiModel: 'gpt-4o-mini',
      aiSystemPrompt: ''
    });
    currentLang = saved.targetLang;
    selectionEnabled = saved.selectionEnabled;
    createTooltip();
    createFloatingButton();
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('mousedown', hideTooltip);
    
    // Auto-translate if THIS TAB had translation enabled (stored in sessionStorage)
    const isAutoTranslateTab = sessionStorage.getItem('webTrans_autoTranslate') === '1';
    if (isAutoTranslateTab && fab) {
      setTimeout(async () => {
        const aiConfig = saved.aiEnabled ? {
          endpoint: saved.aiEndpoint,
          key: saved.aiKey,
          model: saved.aiModel,
          systemPrompt: saved.aiSystemPrompt
        } : null;
        currentAiConfig = aiConfig;
        fab.textContent = '✕';
        fab.title = '點擊中斷翻譯';
        fab.dataset.state = 'translating';
        isTranslating = true;
        cancelRequested = false;
        const result = await translatePage(saved.targetLang, aiConfig);
        isTranslating = false;
        // only disable auto-translate if user explicitly cancelled
        if (result.cancelled) {
          sessionStorage.removeItem('webTrans_autoTranslate');
        }
        fab.disabled = false;
        updateFloatingButton();
      }, 200);
    }
  })();
}

function storage_get(defaults) {
  return new Promise(resolve => {
    chrome.storage.local.get(defaults, items => resolve(items));
  });
}

// ------------------------------------------------------------------
// Get page background color for popup theming
// ------------------------------------------------------------------
function getPageDominantColor() {
  // Try to get background color from body or html
  let color = window.getComputedStyle(document.body).backgroundColor ||
              window.getComputedStyle(document.documentElement).backgroundColor;
  
  // If transparent or rgba, try to find a non-transparent background from parent elements
  if (!color || color === 'rgba(0, 0, 0, 0)' || color === 'transparent') {
    let el = document.body;
    while (el && (color === 'transparent' || color === 'rgba(0, 0, 0, 0)' || !color)) {
      color = window.getComputedStyle(el).backgroundColor;
      el = el.parentElement;
      if (!el || el === document.documentElement) break;
    }
  }
  
  // Default fallback
  if (!color || color === 'transparent' || color === 'rgba(0, 0, 0, 0)') {
    color = '#ffffff';
  }
  
  return color;
}

// ------------------------------------------------------------------
// Message listener
// ------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'SET_LANG') {
    currentLang = msg.lang;
  } else if (msg.type === 'TOGGLE_SELECTION') {
    selectionEnabled = msg.enabled;
  } else if (msg.type === 'TRANSLATE_PAGE') {
    currentLang = msg.lang;
    currentAiConfig = msg.aiConfig || null;
    translatePage(msg.lang, currentAiConfig).then(sendResponse);
    return true; // async
  } else if (msg.type === 'RESTORE_PAGE') {
    restorePage();
    sendResponse({ ok: true });
  } else if (msg.type === 'GET_PAGE_COLOR') {
    const color = getPageDominantColor();
    sendResponse({ color });
  }
});

// ------------------------------------------------------------------
// Selection tooltip
// ------------------------------------------------------------------
function onMouseUp(e) {
  if (skipNextMouseUp) {
    skipNextMouseUp = false;
    return;
  }
  if (!selectionEnabled) return;
  const sel = window.getSelection();
  const text = sel ? sel.toString().trim() : '';
  if (!text || text.length > 500) return;

  clearTimeout(tooltipTimeout);
  tooltipTimeout = setTimeout(async () => {
    const result = await translateText(text, currentLang);
    if (!result) return;
    showTooltip(e.clientX, e.clientY, text, result);
  }, 300);
}

function createTooltip() {
  tooltip = document.createElement('div');
  tooltip.id = 'wt-tooltip';
  document.documentElement.appendChild(tooltip);
}

function createFloatingButton() {
  if (document.getElementById('wt-fab')) return;
  fab = document.createElement('button');
  fab.id = 'wt-fab';
  fab.type = 'button';
  fab.title = '翻譯整頁';
  fab.textContent = '譯';
  initFabDrag(fab);
  fab.addEventListener('click', onFabClick);
  document.documentElement.appendChild(fab);
  // restore saved position
  chrome.storage.local.get({ fabRight: 16, fabBottom: 16 }, pos => {
    fab.style.right = pos.fabRight + 'px';
    fab.style.bottom = pos.fabBottom + 'px';
  });
  updateFloatingButton();
}

function initFabDrag(el) {
  let startX, startY, origRight, origBottom, moved;
  function onDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    moved = false;
    const vw = window.innerWidth, vh = window.innerHeight;
    const r = el.getBoundingClientRect();
    origRight  = vw - r.right;
    origBottom = vh - r.bottom;
    startX = e.clientX;
    startY = e.clientY;
    el.classList.add('wt-dragging');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  }
  function onMove(e) {
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (!moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    moved = true;
    const vw = window.innerWidth, vh = window.innerHeight;
    let newRight  = origRight  - dx;
    let newBottom = origBottom - dy;  // dy>0 = drag down = bottom decreases
    newRight  = Math.max(4, Math.min(vw  - el.offsetWidth  - 4, newRight));
    newBottom = Math.max(4, Math.min(vh - el.offsetHeight - 4, newBottom));
    el.style.right  = newRight  + 'px';
    el.style.bottom = newBottom + 'px';
  }
  function onUp() {
    el.classList.remove('wt-dragging');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    if (moved) {
      // save position and prevent the click from firing
      const r = parseInt(el.style.right)  || 16;
      const b = parseInt(el.style.bottom) || 16;
      chrome.storage.local.set({ fabRight: r, fabBottom: b });
      el.addEventListener('click', e => e.stopImmediatePropagation(), { once: true, capture: true });
    }
  }
  el.addEventListener('mousedown', onDown);
}

async function onFabClick() {
  // While translating: click = cancel
  if (isTranslating) {
    cancelRequested = true;
    fab.textContent = '...';
    fab.title = '中斷中...';
    return;
  }

  if (isTranslated) {
    restorePage();
    return;
  }

  const settings = await storage_get({
    targetLang: 'zh-TW',
    aiEnabled: false,
    aiEndpoint: 'https://api.openai.com/v1',
    aiKey: '',
    aiModel: 'gpt-4o-mini',
    aiSystemPrompt: ''
  });
  currentLang = settings.targetLang;

  const aiConfig = settings.aiEnabled ? {
    endpoint: settings.aiEndpoint,
    key: settings.aiKey,
    model: settings.aiModel,
    systemPrompt: settings.aiSystemPrompt
  } : null;

  fab.textContent = '✕';
  fab.title = '點擊中斷翻譯';
  fab.dataset.state = 'translating';
  isTranslating = true;
  cancelRequested = false;
  // mark THIS TAB as auto-translate enabled (sessionStorage = tab-local)
  sessionStorage.setItem('webTrans_autoTranslate', '1');
  const result = await translatePage(currentLang, aiConfig);
  isTranslating = false;
  if (!result.ok && !result.cancelled) {
    fab.title = result.error || '翻譯失敗';
  }
  // disable auto-translate on cancel or error
  if (result.cancelled) {
    sessionStorage.removeItem('webTrans_autoTranslate');
  }
  fab.disabled = false;
  updateFloatingButton();
}

function updateFloatingButton() {
  if (!fab) return;
  fab.dataset.state = isTranslated ? 'restore' : 'translate';
  fab.title = isTranslated ? '恢復原文' : '翻譯整頁';
  fab.textContent = isTranslated ? '原' : '譯';
}

function showTooltip(x, y, src, trans) {
  if (!tooltip) return;
  tooltip.innerHTML =
    '<div class="wt-src">' + escapeHtml(src.substring(0, 60)) + (src.length > 60 ? '...' : '') + '</div>' +
    escapeHtml(trans);

  // Detect page brightness and apply contrast theme
  const pageBg = window.getComputedStyle(document.body).backgroundColor ||
                 window.getComputedStyle(document.documentElement).backgroundColor;
  const m = pageBg && pageBg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  const brightness = m ? (Number(m[1]) * 299 + Number(m[2]) * 587 + Number(m[3]) * 114) / 1000 : 255;
  tooltip.classList.toggle('wt-light', brightness < 128);

  tooltip.classList.add('visible');

  // Auto-close after 20 seconds
  clearTimeout(tooltipAutoClose);
  tooltipAutoClose = setTimeout(() => hideTooltip(), 20000);

  const vw = window.innerWidth, vh = window.innerHeight;
  let left = x + 12, top = y + 12;
  tooltip.style.left = '0'; tooltip.style.top = '0';
  const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
  if (left + tw > vw - 8) left = vw - tw - 8;
  if (top + th > vh - 8) top = y - th - 8;
  tooltip.style.left = left + 'px';
  tooltip.style.top = top + 'px';
}

function hideTooltip() {
  clearTimeout(tooltipTimeout);
  clearTimeout(tooltipAutoClose);
  if (tooltip && tooltip.classList.contains('visible')) {
    skipNextMouseUp = true;
  }
  if (tooltip) tooltip.classList.remove('visible');
}

function isLocalEndpoint(endpoint) {
  return /https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(endpoint || '');
}

const SKIP_TAGS = new Set(['SCRIPT','STYLE','NOSCRIPT','TEXTAREA','INPUT','PRE','CODE','KBD','SAMP','VAR','XMP','LISTING']);

// Language-specific font stacks for better rendering
const FONT_STACKS = {
  'zh-TW': "'Segoe UI', 'Noto Sans CJK TC', 'Noto Sans TC', 'Microsoft YaHei', 'Heiti TC', system-ui, -apple-system, sans-serif",
  'zh-CN': "'Segoe UI', 'Noto Sans CJK SC', 'Noto Sans SC', 'Microsoft YaHei', 'SimHei', system-ui, -apple-system, sans-serif",
  'ja':    "'Segoe UI', 'Noto Sans CJK JP', 'Yu Gothic', 'Hiragino Sans', system-ui, -apple-system, sans-serif",
  'ko':    "'Segoe UI', 'Noto Sans CJK KR', 'Segoe UI', 'Malgun Gothic', system-ui, -apple-system, sans-serif",
  'ar':    "'Segoe UI', 'Arial', 'Traditional Arabic', system-ui, -apple-system, sans-serif",
  'th':    "'Segoe UI', 'Tahoma', 'Cordia New', system-ui, -apple-system, sans-serif",
  'vi':    "'Segoe UI', 'Noto Sans', system-ui, -apple-system, sans-serif",
  '_default': "'Segoe UI', 'Noto Sans', system-ui, -apple-system, sans-serif"
};

function applyFallbackFont(node, lang) {
  if (!node || !node.parentElement) return;
  const fontStack = FONT_STACKS[lang] || FONT_STACKS['_default'];
  node.parentElement.style.fontFamily = fontStack;
}

function isInSkipBlock(node) {
  let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (el && el !== document.body) {
    if (SKIP_TAGS.has(el.tagName.toUpperCase())) return true;
    el = el.parentElement;
  }
  return false;
}

// ------------------------------------------------------------------
// Full-page translation  (one node at a time for Google; batched for AI)
// ------------------------------------------------------------------
async function translatePage(lang, aiConfig) {
  if (isTranslated) restorePage();
  let aiFallbackUsed = false;

  // Validate AI config (local endpoints don't need key)
  if (aiConfig) {
    const needsKey = !isLocalEndpoint(aiConfig.endpoint);
    if (!aiConfig.endpoint || !aiConfig.model || (needsKey && !aiConfig.key)) {
      // Auto fallback to Google when AI settings are incomplete.
      aiFallbackUsed = true;
      aiConfig = null;
    }
  }

  isTranslated = true;
  updateFloatingButton();
  startMutationObserver();

  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (isInSkipBlock(node)) return NodeFilter.FILTER_REJECT;
        const text = node.textContent.trim();
        if (!text || text.length < 2) return NodeFilter.FILTER_REJECT;
        if (node.parentElement.hasAttribute(WT_ATTR)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  let translatedCount = 0;
  let lastError = null;

  if (aiConfig) {
    // AI mode: send nodes as JSON array, AI returns JSON array
    const validNodes = nodes.filter(node => hasLetter(node.textContent.trim()));

    const totalBatches = Math.ceil(validNodes.length / AI_BATCH_SIZE);
    for (let bi = 0; bi < totalBatches; bi++) {
      if (!isTranslated || cancelRequested) break;
      const b = validNodes.slice(bi * AI_BATCH_SIZE, (bi + 1) * AI_BATCH_SIZE);
      const texts = b.map(nd => nd.textContent.trim());

      // show progress on FAB
      if (fab) fab.textContent = `${bi + 1}/${totalBatches}`;

      const results = await translateTextAIBatch(texts, lang, aiConfig);
      if (!results) {
        lastError = `第 ${bi + 1}/${totalBatches} 批失敗`;
        aiFallbackUsed = true;
        translatedCount += await translateNodesGoogle(b, lang, () => cancelRequested || !isTranslated);
        if (fab) fab.title = 'AI 連線異常，已自動改用 Google';
        continue;
      }
      b.forEach((node, i) => {
        const orig = node.textContent.trim();
        const translated = typeof results[i] === 'string' ? results[i].trim() : null;
        if (!translated || translated === orig) return;
        isBusyTranslating = true;
        node.parentElement.setAttribute(WT_ATTR, '');
        node[WT_ATTR] = node.textContent;  // store full (untrimmed)
        node.textContent = translated;
        applyFallbackFont(node, lang);
        isBusyTranslating = false;
        translatedCount += 1;
      });
    }
  } else {
    // Google mode: concurrent requests with pool limit
    const gtNodes = nodes.filter(nd => hasLetter(nd.textContent.trim()));
    let gi = 0;
    async function runOneGT() {
      while (gi < gtNodes.length && isTranslated && !cancelRequested) {
        const node = gtNodes[gi++];
        const orig = node.textContent.trim();
        const text = orig.length > MAX_CHARS ? orig.substring(0, MAX_CHARS) : orig;
        const result = await translateText(text, lang);
        if (result && result !== orig) {
          isBusyTranslating = true;
          node.parentElement.setAttribute(WT_ATTR, '');
          node[WT_ATTR] = node.textContent;  // store full (untrimmed)
          node.textContent = result;
          applyFallbackFont(node, lang);
          isBusyTranslating = false;
          translatedCount += 1;
        }
      }
    }
    const workers = Array.from({ length: GT_CONCURRENCY }, runOneGT);
    await Promise.all(workers);
  }

  if (aiFallbackUsed && fab) {
    fab.title = 'AI 連線異常，已自動改用 Google';
  }

  if (translatedCount === 0) {
    isTranslated = false;
    updateFloatingButton();
    return { ok: false, translatedCount: 0, error: lastError || '沒有可翻譯內容' };
  }

  // cancelled mid-way: restore already-translated nodes
  if (cancelRequested) {
    restorePage();
    cancelRequested = false;
    return { ok: false, translatedCount: 0, cancelled: true };
  }

  updateFloatingButton();
  return { ok: true, translatedCount };
}

// ------------------------------------------------------------------
// Translate a set of newly added DOM nodes (used by MutationObserver)
// ------------------------------------------------------------------
async function translateAddedNodes(addedNodes, lang, aiConfig) {
  const nodes = [];
  const skipTags = new Set(['SCRIPT','STYLE','NOSCRIPT','TEXTAREA','CODE','PRE','INPUT']);
  function collect(root) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (isInSkipBlock(node)) return NodeFilter.FILTER_REJECT;
        if (p.hasAttribute(WT_ATTR)) return NodeFilter.FILTER_REJECT;
        const t = node.textContent.trim();
        if (!t || t.length < 2 || !hasLetter(t)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n;
    while ((n = w.nextNode())) nodes.push(n);
  }
  addedNodes.forEach(nd => {
    if (nd.nodeType === Node.TEXT_NODE) {
      if (hasLetter(nd.textContent.trim())) nodes.push(nd);
    } else if (nd.nodeType === Node.ELEMENT_NODE) {
      collect(nd);
    }
  });
  if (!nodes.length) return;

  if (aiConfig) {
    const totalBatches = Math.ceil(nodes.length / AI_BATCH_SIZE);
    for (let bi = 0; bi < totalBatches; bi++) {
      if (!isTranslated) return;
      const b = nodes.slice(bi * AI_BATCH_SIZE, (bi + 1) * AI_BATCH_SIZE);
      const texts = b.map(nd => nd.textContent.trim());
      const results = await translateTextAIBatch(texts, lang, aiConfig);
      if (!results) {
        await translateNodesGoogle(b, lang, () => !isTranslated);
        continue;
      }
      b.forEach((node, i) => {
        const orig = node.textContent.trim();
        const translated = typeof results[i] === 'string' ? results[i].trim() : null;
        if (!translated || translated === orig) return;
        isBusyTranslating = true;
        node.parentElement.setAttribute(WT_ATTR, '');
        node[WT_ATTR] = node.textContent;
        node.textContent = translated;
        applyFallbackFont(node, lang);
        isBusyTranslating = false;
      });
    }
  } else {
    await translateNodesGoogle(nodes, lang, () => !isTranslated);
  }
}

async function translateNodesGoogle(nodeList, lang, shouldStop) {
  const gtNodes = nodeList.filter(nd => hasLetter((nd.textContent || '').trim()));
  let translated = 0;
  let gi = 0;
  async function runOneGT() {
    while (gi < gtNodes.length) {
      if (shouldStop && shouldStop()) break;
      const node = gtNodes[gi++];
      const orig = node.textContent.trim();
      if (!orig) continue;
      const text = orig.length > MAX_CHARS ? orig.substring(0, MAX_CHARS) : orig;
      const result = await translateText(text, lang);
      if (result && result !== orig) {
        isBusyTranslating = true;
        node.parentElement.setAttribute(WT_ATTR, '');
        node[WT_ATTR] = node.textContent;
        node.textContent = result;
        applyFallbackFont(node, lang);
        isBusyTranslating = false;
        translated += 1;
      }
    }
  }
  await Promise.all(Array.from({ length: GT_CONCURRENCY }, runOneGT));
  return translated;
}

// ------------------------------------------------------------------
// MutationObserver: watch for new content while translation is active
// ------------------------------------------------------------------
function startMutationObserver() {
  if (mutationObserver) return;
  let pendingNodes = [];
  let flushTimer = null;
  mutationObserver = new MutationObserver(mutations => {
    if (!isTranslated || isBusyTranslating) return;
    for (const m of mutations) {
      if (m.type === 'childList') {
        m.addedNodes.forEach(nd => pendingNodes.push(nd));
      }
    }
    if (!pendingNodes.length) return;
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      const batch = pendingNodes.splice(0);
      translateAddedNodes(batch, currentLang, currentAiConfig);
    }, 400);
  });
  mutationObserver.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true
  });
}

function stopMutationObserver() {
  if (mutationObserver) {
    mutationObserver.disconnect();
    mutationObserver = null;
  }
}

// SPA route change detection
function onSpaNavigate() {
  if (!isTranslated) return;
  // Page content will be rebuilt; wait briefly then re-translate
  restorePage();
  setTimeout(async () => {
    const settings = await storage_get({
      targetLang: 'zh-TW',
      aiEnabled: false,
      aiEndpoint: 'https://api.openai.com/v1',
      aiKey: '',
      aiModel: 'gpt-4o-mini',
      aiSystemPrompt: ''
    });
    const aiConfig = settings.aiEnabled ? {
      endpoint: settings.aiEndpoint,
      key: settings.aiKey,
      model: settings.aiModel,
      systemPrompt: settings.aiSystemPrompt
    } : null;
    currentAiConfig = aiConfig;
    await translatePage(settings.targetLang, aiConfig);
  }, 800);
}

(function patchHistory() {
  const orig = history.pushState.bind(history);
  history.pushState = function(...args) {
    orig(...args);
    onSpaNavigate();
  };
  window.addEventListener('popstate', onSpaNavigate);
})();

function restorePage() {
  isTranslated = false;
  currentAiConfig = null;
  stopMutationObserver();
  // disable auto-translate for THIS TAB (sessionStorage)
  sessionStorage.removeItem('webTrans_autoTranslate');
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        return (node[WT_ATTR] !== undefined) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    }
  );
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  nodes.forEach(nd => {
    nd.textContent = nd[WT_ATTR];
    delete nd[WT_ATTR];
  });
  document.querySelectorAll('[' + WT_ATTR + ']').forEach(el => el.removeAttribute(WT_ATTR));
  updateFloatingButton();
}

// ------------------------------------------------------------------
// AI translation via background service worker (JSON array batch)
// ------------------------------------------------------------------
async function translateTextAIBatch(texts, targetLang, aiConfig) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), AI_TIMEOUT_MS);
    try {
      chrome.runtime.sendMessage(
        { type: 'AI_TRANSLATE', texts, targetLang, aiConfig },
        res => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) { resolve(null); return; }
          if (!res || !res.ok) { resolve(null); return; }
          resolve(Array.isArray(res.results) ? res.results : null);
        }
      );
    } catch (_e) {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

// ------------------------------------------------------------------
// Translation API  (Google Translate unofficial - no key required)
// Response: [ [ ["translated","original",...], ... ], null, "detected_lang", ...]
// ------------------------------------------------------------------
async function translateText(text, targetLang) {
  const params = new URLSearchParams({
    client: 'gtx',
    sl: 'auto',
    tl: normalizeLang(targetLang),
    dt: 't',
    q: text
  });
  try {
    const res = await fetch(GT_API + '?' + params.toString());
    if (!res.ok) return null;
    const data = await res.json();
    // data[0] is array of translation segments, each [translated, original, ...]
    if (!Array.isArray(data) || !Array.isArray(data[0])) return null;
    return data[0].reduce((acc, seg) => acc + (seg[0] || ''), '');
  } catch {
    return null;
  }
}

function normalizeLang(lang) {
  // Google Translate API language codes
  const map = {
    'zh-TW': 'zh-TW', 'zh-CN': 'zh-CN',
    'en': 'en', 'ja': 'ja', 'ko': 'ko',
    'fr': 'fr', 'de': 'de', 'es': 'es',
    'pt': 'pt', 'ru': 'ru', 'ar': 'ar',
    'it': 'it', 'vi': 'vi', 'th': 'th',
  };
  return map[lang] || lang;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
