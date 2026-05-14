# 🌐 WebTrans - 網頁翻譯 Chrome 擴充功能

一款輕量、無需 API Key 即可使用的 Chrome 翻譯擴充功能，支援整頁翻譯與選取文字懸浮翻譯，亦可選配 AI 模型（OpenAI / Ollama / Groq）進行高品質翻譯。

---

## ✨ 功能特色

### 🖱️ 選取文字懸浮翻譯
- 在網頁上選取任意文字，自動顯示翻譯結果浮動視窗（Tooltip）
- Tooltip 自動偵測頁面背景亮度，深色頁面自動切換為白底高對比主題
- 金色邊框設計，視覺辨識度高
- **20 秒無操作自動關閉**，不干擾閱讀
- 可在設定面板中隨時開關此功能

### 📄 整頁翻譯
- 點擊右下角懸浮按鈕（**譯**）一鍵翻譯整頁
- 翻譯中可點擊按鈕（**✕**）隨時中斷
- 翻譯完成後點擊（**原**）還原原文
- 支援頁面動態載入內容（MutationObserver 自動翻譯新增節點）
- 切換頁面後自動重新翻譯（sessionStorage 記憶狀態）

### 🤖 AI 模型翻譯（選配）
支援任何相容 OpenAI API 格式的服務：

| 服務 | 說明 |
|------|------|
| **OpenAI** | GPT-4o-mini 等，需 API Key |
| **Groq** | llama-3.3-70b 等，需 API Key |
| **Ollama** | 本機模型，無需 Key，需開放 CORS |

- 批次翻譯（每批 20 節點），效率更高
- AI 失敗時自動 fallback 至 Google 翻譯
- 支援自訂 System Prompt

### 🌍 支援語言
繁體中文、簡體中文、英文、日文、韓文、法文、德文、西班牙文等

---

## 📦 安裝方式

1. 下載或 Clone 此專案
   ```bash
   git clone https://github.com/casparhung/WebTrans.git
   ```
2. 開啟 Chrome，前往 `chrome://extensions/`
3. 右上角開啟「**開發人員模式**」
4. 點擊「**載入未封裝項目**」，選擇專案資料夾
5. 擴充功能圖示出現於工具列即完成

---

## 🚀 使用方式

### 選取文字翻譯
直接在網頁上選取文字，稍待片刻即出現翻譯 Tooltip。

### 整頁翻譯
點擊右下角懸浮的 **譯** 按鈕。

### 設定面板
點擊工具列上的擴充功能圖示開啟設定：

| 設定項目 | 說明 |
|----------|------|
| 選取文字懸浮翻譯 | 開關選取翻譯功能 |
| 目標語言 | 選擇翻譯目標語言 |
| AI 模型翻譯 | 啟用並設定 AI 翻譯引擎 |

---

## 🔧 Ollama 本機使用說明

Ollama 需開放 CORS 才能被擴充功能呼叫：

**Windows**
```bat
set OLLAMA_ORIGINS=* && ollama serve
```

**Mac / Linux**
```bash
OLLAMA_ORIGINS=* ollama serve
```

---

## 🗂️ 專案結構

```
webtrans/
├── manifest.json      # 擴充功能設定
├── background.js      # Service Worker：AI API 代理
├── content.js         # Content Script：翻譯邏輯、Tooltip、懸浮按鈕
├── content.css        # Tooltip 與懸浮按鈕樣式
├── popup.html         # 設定面板 UI
├── popup.js           # 設定面板邏輯
└── icons/             # 擴充功能圖示
```

---

## 📋 版本紀錄

### v1.0.1
- 選取文字懸浮翻譯開關移至設定頂部
- Tooltip 新增金色邊框與亮度自適應主題
- Tooltip 20 秒自動關閉
- 修復點選 Tooltip 後立即重開的問題

### v1.0.0
- 整頁翻譯（Google Translate + AI 雙模式）
- 選取文字懸浮翻譯
- AI 模型設定（OpenAI / Ollama / Groq）
- 懸浮翻譯按鈕（可拖曳）

---

## 📄 授權

MIT License
