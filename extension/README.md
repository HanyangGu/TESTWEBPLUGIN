# 🤖 AI PDF Uploader v3.1 — Visual Browser Agent

No Google API. No OAuth. The AI **looks at the screen**, decides where to click, and navigates like a human.

## How it works

1. You drop a PDF and describe where it should go
2. The agent takes a screenshot of the active browser tab
3. GPT-4o (vision) analyzes the screenshot + page elements
4. It decides the next action: click, type, scroll, or inject the file
5. Repeats until the upload is done (up to 30 steps)

## Setup

1. Get an OpenAI API key from https://platform.openai.com/api-keys  
   (needs GPT-4o access)

2. Load the extension:
   - `chrome://extensions` → Developer Mode ON → Load Unpacked → select this folder

3. Pin the extension, click it, go to ⚙ Config → paste your key → Save

## Usage

1. Open your target site (e.g. Google Drive, Dropbox, Canvas, any upload page)
2. Click the extension icon
3. Click **Use Tab** to auto-fill the current URL (or type another)
4. Drop your PDF
5. Write instructions: *"Go to the Week 3 Assignment in MATH101 and submit."*
6. Click **✦ Start AI Agent**

## Folder structure

```
extension/
├── background.js
├── manifest.json
├── popup/
│   ├── popup.html
│   └── popup.js
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── libs/
    ├── pdf.min.js          ← Bundled PDF.js (local — required for MV3)
    └── pdf.worker.min.js   ← Bundled PDF.js worker
```

## Permissions used

- `tabs` — read & update the current tab
- `scripting` — inject JS to click elements and inject files
- `storage` — save your API key locally
- `alarms` — keep service worker alive during long tasks
- `<all_urls>` — work on any website

## Changelog

### v3.1.0 — Bug fixes
- **Fix:** PDF.js is now bundled locally in `libs/` — remote `importScripts()` are blocked
  in MV3 service workers and caused text extraction to silently fail every time
- **Fix:** `GlobalWorkerOptions.workerSrc` now points to the local worker file instead
  of `''` which caused PDF.js to hang silently
- **Fix:** PDF line-grouping Y-threshold increased 2px → 8px — stops words being split
  across lines due to sub-pixel coordinate differences in PDF content streams
- **Fix:** When assignment has both File Upload + Text Entry tabs, agent now defaults to
  File Upload (correct) instead of Text Entry (wrong)
