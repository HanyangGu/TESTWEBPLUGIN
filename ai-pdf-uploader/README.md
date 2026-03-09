# 🤖 AI PDF Uploader v2 — Visual Browser Agent

No Google API. No OAuth. The AI **looks at the screen**, decides where to click, and navigates like a human.

## How it works

1. You drop a PDF and describe where it should go
2. The agent takes a screenshot of the active browser tab
3. GPT-4o (vision) analyzes the screenshot + page elements
4. It decides the next action: click, type, scroll, or inject the file
5. Repeats until the upload is done (up to 20 steps)

## Setup

1. Get an OpenAI API key from https://platform.openai.com/api-keys  
   (needs GPT-4o access)

2. Load the extension:
   - `chrome://extensions` → Developer Mode ON → Load Unpacked → select this folder

3. Pin the extension, click it, go to ⚙ Config → paste your key → Save

## Usage

1. Open your target site (e.g. Google Drive, Dropbox, any upload page)
2. Click the extension icon
3. Click **Use Tab** to auto-fill the current URL (or type another)
4. Drop your PDF
5. Write instructions: *"Go to the Work/Invoices folder and upload the file"*
6. Click **✦ Start AI Agent**

Watch it navigate in real time — the screenshot preview updates at each step.

## Permissions used

- `activeTab` / `tabs` — read & update the current tab
- `scripting` — inject JS to click elements and inject files
- `storage` — save your API key locally
- `<all_urls>` — work on any website

## Notes

- Works on Google Drive, Dropbox, Notion, SharePoint, or any upload page
- The AI reads both the screenshot AND the DOM element list for precision
- File injection works via `DataTransfer` API (works on most modern upload UIs)
- Falls back to drag-and-drop simulation if no `<input type=file>` is found
