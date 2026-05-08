// popup.js
// popup.js
(() => {
  const AI_DEFAULTS = {
    aiEnabled: false,
    aiEndpoint: 'https://api.openai.com/v1',
    aiKey: '',
    aiModel: 'gpt-4o-mini',
    aiSystemPrompt: ''
  };
  const aiStatusEl = document.getElementById('aiStatus');

  // Load saved settings
  chrome.storage.local.get(
    { targetLang: 'zh-TW', selectionEnabled: true, ...AI_DEFAULTS },
    saved => {
    document.getElementById('targetLang').value = saved.targetLang;
    document.getElementById('selectionToggle').checked = saved.selectionEnabled;
    document.getElementById('aiToggle').checked  = saved.aiEnabled;
    document.getElementById('aiEndpoint').value  = saved.aiEndpoint;
    document.getElementById('aiKey').value       = saved.aiKey;
    document.getElementById('aiModel').value     = saved.aiModel;
    document.getElementById('aiSystemPrompt').value = saved.aiSystemPrompt;
    if (saved.aiEnabled) document.getElementById('aiPanel').classList.add('open');
    setAiStatus(saved.aiEnabled ? '請先測試 AI 連線' : 'AI 模式未啟用', saved.aiEnabled ? 'pending' : '');
  });

  // AI toggle
  document.getElementById('aiToggle').addEventListener('change', e => {
    chrome.storage.local.set({ aiEnabled: e.target.checked });
    document.getElementById('aiPanel').classList.toggle('open', e.target.checked);
    setAiStatus(e.target.checked ? '請先測試 AI 連線' : 'AI 模式未啟用', e.target.checked ? 'pending' : '');
  });

  // AI field autosave + localhost hint
  ['aiEndpoint', 'aiKey', 'aiModel', 'aiSystemPrompt'].forEach(id => {
    document.getElementById(id).addEventListener('change', () => {
      chrome.storage.local.set({ [id]: document.getElementById(id).value });
      if (document.getElementById('aiToggle').checked) {
        setAiStatus('設定已變更，請重新測試 AI 連線', 'pending');
      }
    });
  });
  document.getElementById('aiEndpoint').addEventListener('input', updateOllamaHint);

  // Preset quick-fill buttons
  document.getElementById('presetOllama').addEventListener('click', () => {
    setField('aiEndpoint', 'http://localhost:11434/v1');
    setField('aiKey', '');
    setField('aiModel', 'llama3.2');
    updateOllamaHint();
    setAiStatus('Ollama 已內建內容，請確認已開啟 OLLAMA_ORIGINS=* 再測試', 'pending');
  });
  document.getElementById('presetOpenAI').addEventListener('click', () => {
    setField('aiEndpoint', 'https://api.openai.com/v1');
    setField('aiModel', 'gpt-4o-mini');
    updateOllamaHint();
    setAiStatus('請填入 OpenAI API Key 再測試', 'pending');
  });
  document.getElementById('presetGroq').addEventListener('click', () => {
    setField('aiEndpoint', 'https://api.groq.com/openai/v1');
    setField('aiModel', 'llama-3.3-70b-versatile');
    updateOllamaHint();
    setAiStatus('請填入 Groq API Key 再測試', 'pending');
  });

  document.getElementById('testAiConnection').addEventListener('click', async () => {
    const aiConfig = getAiConfig();
    if (!document.getElementById('aiToggle').checked) {
      setAiStatus('請先開啟 AI 模型翻譯', 'error');
      return;
    }
    if (!aiConfig.key) {
      setAiStatus('請填入 API Key', 'error');
      return;
    }

    setAiStatus('測試連線中...', 'pending');
    const response = await sendToBackground({ type: 'AI_PING', aiConfig });
    if (response && response.ok) {
      setAiStatus('AI 連線成功，可直接使用翻譯', 'success');
    } else {
      setAiStatus(response?.error || 'AI 連線失敗', 'error');
    }
  });

  // Save settings on change
  document.getElementById('targetLang').addEventListener('change', () => {
    const lang = document.getElementById('targetLang').value;
    chrome.storage.local.set({ targetLang: lang });
    sendToContent({ type: 'SET_LANG', lang });
  });

  document.getElementById('selectionToggle').addEventListener('change', (e) => {
    chrome.storage.local.set({ selectionEnabled: e.target.checked });
    sendToContent({ type: 'TOGGLE_SELECTION', enabled: e.target.checked });
  });

  document.getElementById('translatePage').addEventListener('click', async () => {
    setStatus('翻譯中...');
    const lang = document.getElementById('targetLang').value;
    const aiEnabled = document.getElementById('aiToggle').checked;
    const aiConfig = aiEnabled ? getAiConfig() : null;
    const res = await sendToContentEnsured({ type: 'TRANSLATE_PAGE', lang, aiConfig });
    if (res && res.ok) {
      setStatus(res.translatedCount > 0 ? `翻譯完成，共 ${res.translatedCount} 段` : '沒有可翻譯內容');
    } else {
      setStatus(res?.error || '翻譯失敗，請重新整理頁面後再試');
    }
  });

  document.getElementById('restorePage').addEventListener('click', async () => {
    await sendToContent({ type: 'RESTORE_PAGE' });
    setStatus('已還原原文');
  });

  function setField(id, value) {
    const el = document.getElementById(id);
    el.value = value;
    chrome.storage.local.set({ [id]: value });
  }

  function updateOllamaHint() {
    const url = document.getElementById('aiEndpoint').value;
    const isLocal = /localhost|127\.0\.0\.1/i.test(url);
    document.getElementById('ollamaHint').style.display = isLocal ? 'block' : 'none';
  }

  function setStatus(msg) {
    document.getElementById('status').textContent = msg;
    setTimeout(() => { document.getElementById('status').textContent = ''; }, 3000);
  }

  function setAiStatus(msg, kind) {
    aiStatusEl.textContent = msg;
    aiStatusEl.className = 'ai-status' + (kind ? ` ${kind}` : '');
  }

  function getAiConfig() {
    return {
      endpoint: document.getElementById('aiEndpoint').value.trim() || 'https://api.openai.com/v1',
      key: document.getElementById('aiKey').value.trim(),
      model: document.getElementById('aiModel').value.trim() || 'gpt-4o-mini',
      systemPrompt: document.getElementById('aiSystemPrompt').value.trim()
    };
  }

  async function sendToContent(msg) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return null;
      return await chrome.tabs.sendMessage(tab.id, msg);
    } catch (e) {
      return null;
    }
  }

  async function sendToBackground(msg) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (_e) {
      return null;
    }
  }

  // If content script not yet loaded (e.g. page was open before extension install),
  // inject it on demand then retry once.
  async function sendToContentEnsured(msg) {
    const result = await sendToContent(msg);
    if (result !== null) return result;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return null;
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
      // small wait for script to initialize
      await new Promise(r => setTimeout(r, 400));
      return await sendToContent(msg);
    } catch (e) {
      return null;
    }
  }
})();
