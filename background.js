// background.js - service worker
// Handles install event and proxies AI API calls from content scripts.

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ targetLang: 'zh-TW', selectionEnabled: true, aiEnabled: false });
});

// Map lang code -> human readable name for AI prompts
const LANG_NAMES = {
  'zh-TW': 'Traditional Chinese (繁體中文，台灣用語，絕不使用簡體字)',
  'zh-CN': 'Simplified Chinese (簡體中文)',
  'en':    'English',
  'ja':    'Japanese (日本語)',
  'ko':    'Korean (한국어)',
  'fr':    'French (Français)',
  'de':    'German (Deutsch)',
  'es':    'Spanish (Español)',
  'pt':    'Portuguese (Português)',
  'ru':    'Russian (Русский)',
  'ar':    'Arabic (العربية)',
  'it':    'Italian (Italiano)',
  'vi':    'Vietnamese (Tiếng Việt)',
  'th':    'Thai (ไทย)',
};
function langName(code) { return LANG_NAMES[code] || code; }

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'AI_TRANSLATE') {
    const isArray = Array.isArray(msg.texts);
    const tl = langName(msg.targetLang);
    const systemPrompt = msg.aiConfig?.systemPrompt || (
      isArray
        ? `You are a professional translator. Translate each string in the JSON array to ${tl}. Return ONLY a valid JSON array of the same length and order. No extra text, no markdown fences.`
        : `You are a professional translator. Translate the following text to ${tl}. Return only the translated text, no explanations.`
    );
    const userContent = isArray ? JSON.stringify(msg.texts) : msg.text;

    requestAiCompletion({
      text: userContent,
      targetLang: msg.targetLang,
      aiConfig: msg.aiConfig,
      systemPrompt
    })
      .then(raw => {
        if (isArray) {
          const arr = parseJsonArray(raw);
          if (!arr) throw new Error('AI 回傳的不是有效 JSON 陣列：' + String(raw).substring(0, 120));
          sendResponse({ ok: true, results: arr });
        } else {
          sendResponse({ ok: true, result: raw });
        }
      })
      .catch(err => sendResponse({ ok: false, error: err.message }));

    return true;
  }

  if (msg.type === 'AI_PING') {
    requestAiCompletion({
      text: 'Reply with exactly: OK',
      targetLang: 'en',
      aiConfig: msg.aiConfig,
      systemPrompt: 'Reply with exactly OK. Do not add punctuation or any extra words.'
    })
      .then(result => sendResponse({ ok: true, result }))
      .catch(err => sendResponse({ ok: false, error: err.message }));

    return true;
  }
});

function parseJsonArray(raw) {
  if (!raw) return null;
  let s = raw.trim();
  // strip markdown code fences if model added them
  s = s.replace(/^```[\s\S]*?\n/, '').replace(/\n```$/, '').trim();
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isLocalEndpoint(endpoint) {
  return /https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(endpoint || '');
}

function requestAiCompletion({ text, targetLang, aiConfig, systemPrompt }) {
  if (!aiConfig || !aiConfig.endpoint || !aiConfig.model) {
    return Promise.reject(new Error('AI 設定不完整：請填入 API Base URL 與 Model'));
  }
  const isLocal = isLocalEndpoint(aiConfig.endpoint);
  if (!isLocal && !aiConfig.key) {
    return Promise.reject(new Error('AI 設定不完整：遠端服務需要 API Key'));
  }

  const requestUrl = resolveChatCompletionsUrl(aiConfig.endpoint);
  const headers = { 'Content-Type': 'application/json' };
  if (aiConfig.key) {
    headers['Authorization'] = `Bearer ${aiConfig.key}`;
  }

  return fetch(requestUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: aiConfig.model || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text }
      ],
      temperature: 0.3,
      max_tokens: 4096
    })
  })
  .then(res => {
    if (!res.ok) {
      return res.text().then(body => {
        throw new Error(buildHttpErrorMessage(res.status, body, requestUrl, aiConfig.model));
      });
    }
    return res.json();
  })
  .then(data => {
    const translated = data?.choices?.[0]?.message?.content?.trim() || null;
    if (!translated) {
      throw new Error('AI 沒有回傳內容');
    }
    return translated;
  });
}

function resolveChatCompletionsUrl(endpoint) {
  const trimmed = endpoint.trim().replace(/\/$/, '');
  if (trimmed.endsWith('/chat/completions')) {
    return trimmed;
  }
  return `${trimmed}/chat/completions`;
}

function buildHttpErrorMessage(status, body, requestUrl, model) {
  const apiMessage = extractApiErrorMessage(body);
  const hints = [];

  if (status === 401) {
    hints.push('API Key 無效，或 Authorization 格式錯誤');
  }

  if (status === 403) {
    if (/localhost|127\.0\.0\.1/i.test(requestUrl)) {
      hints.push('Ollama CORS 未開放：請以 OLLAMA_ORIGINS=* ollama serve 重新啟動 Ollama（或設定環境變數 OLLAMA_ORIGINS=*）');
    } else {
      hints.push('API Key 沒有此模型的存取權限');
      hints.push(`模型 "${model}" 可能不可用或名稱錯誤`);
      hints.push('若 URL 已包含 /chat/completions 請勿再補上 /v1');
    }
  }

  if (status === 404) {
    hints.push('API Base URL 可能錯誤，或該服務不是 OpenAI v1 相容路徑');
  }

  const suffix = hints.length ? `；可能原因：${hints.join('、')}` : '';
  const detail = apiMessage ? `：${apiMessage}` : `，請檢查 ${requestUrl}`;
  return `HTTP ${status}${detail}${suffix}`;
}

function extractApiErrorMessage(body) {
  if (!body) return '';
  try {
    const parsed = JSON.parse(body);
    return parsed?.error?.message || parsed?.message || body;
  } catch {
    return body;
  }
}
