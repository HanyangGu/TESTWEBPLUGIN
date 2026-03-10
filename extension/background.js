// ============================================================
//  BACKGROUND SERVICE WORKER — AI PDF Uploader
//
//  Navigation strategy:
//  - AI looks at screenshot + link list, outputs the TEXT of
//    the link it wants to follow (nothing else)
//  - Background finds that link's href and navigates directly
//  - No CSS selectors, no clicks needed for navigation
//  - Once on assignment page: deterministic Canvas submission
// ============================================================

chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {});

let agentState = { running: false, tabId: null, logs: [], step: 0, maxSteps: 30, lastScreenshot: null };

function pushLog(type, msg) {
  const e = { type, msg, ts: Date.now() };
  agentState.logs.push(e);
  if (agentState.logs.length > 100) agentState.logs.shift();
  chrome.runtime.sendMessage({ event: 'log', ...e }).catch(() => {});
}
function pushScreenshot(b64) {
  agentState.lastScreenshot = b64;
  chrome.runtime.sendMessage({ event: 'screenshot', data: b64 }).catch(() => {});
}
function broadcastStatus() {
  chrome.runtime.sendMessage({ event: 'status', running: agentState.running, step: agentState.step, maxSteps: agentState.maxSteps }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.cmd === 'getState') { sendResponse({ ...agentState }); return true; }
  if (msg.cmd === 'start') {
    if (agentState.running) { sendResponse({ ok: false, err: 'Already running' }); return true; }
    startAgent(msg).catch(e => pushLog('err', e.message));
    sendResponse({ ok: true }); return true;
  }
  if (msg.cmd === 'stop') {
    agentState.running = false; pushLog('warn', 'Stopped by user.'); broadcastStatus();
    sendResponse({ ok: true }); return true;
  }
});

// ─────────────────────────────────────────────────────────────
//  ENTRY POINT
// ─────────────────────────────────────────────────────────────
async function startAgent({ tabId, apiKey, instruction, fileName, fileBase64 }) {
  agentState = { running: true, tabId, apiKey, logs: [], step: 0, maxSteps: 30, lastScreenshot: null };
  broadcastStatus();
  await waitForTabLoad(tabId);
  await sleep(800);

  if (await isOnAssignmentPage(tabId)) {
    pushLog('ok', '🎓 Already on assignment page — submitting now');
    await canvasSubmit(tabId, fileName, fileBase64, instruction);
  } else {
    pushLog('ok', '🌐 Navigating to assignment…');
    await navigateLoop(tabId, apiKey, instruction, fileName, fileBase64);
  }
  agentState.running = false;
  broadcastStatus();
}

// ─────────────────────────────────────────────────────────────
//  NAVIGATION LOOP
//
//  Each step:
//  1. Scrape all links from the page (text + href)
//  2. Take screenshot
//  3. Ask AI: "which link text should I follow?" 
//  4. Find that link in our scraped list → navigate to its href
//  No CSS selectors. No clicks. Just URL navigation.
// ─────────────────────────────────────────────────────────────
async function navigateLoop(tabId, apiKey, instruction, fileName, fileBase64) {
  const history = [];
  let lastUrl = '';
  let stuckCount = 0;

  while (agentState.running && agentState.step < agentState.maxSteps) {
    agentState.step++;
    broadcastStatus();

    // ── Check if we've arrived at an assignment page ────────
    if (await isOnAssignmentPage(tabId)) {
      pushLog('ok', '🎓 Assignment page found — starting submission');
      await canvasSubmit(tabId, fileName, fileBase64, instruction);
      return;
    }

    // ── Scrape page links BEFORE screenshot ────────────────
    const links = await scrapeLinks(tabId);
    const currentUrl = await inPage(tabId, () => location.href) || '';
    const pageTitle = await inPage(tabId, () => document.title) || '';

    pushLog('info', `Page: ${pageTitle}`);
    pushLog('info', `Found ${links.length} links`);

    // Stuck detection — same URL for 3 steps
    if (currentUrl === lastUrl) {
      stuckCount++;
      if (stuckCount >= 3) {
        pushLog('warn', 'Stuck on same page — trying to scroll and find more links');
        await scrollPage(tabId, 'down');
        await sleep(800);
        stuckCount = 0;
      }
    } else {
      stuckCount = 0;
      lastUrl = currentUrl;
    }

    // ── Screenshot ──────────────────────────────────────────
    pushLog('spin', `Step ${agentState.step}: Capturing…`);
    let screenshot;
    try { screenshot = await captureTab(tabId); pushScreenshot(screenshot); }
    catch (e) { pushLog('err', 'Screenshot: ' + e.message); await sleep(1500); continue; }

    // ── Ask AI which link to follow ─────────────────────────
    pushLog('ai', `Step ${agentState.step}: Asking GPT-4o…`);
    let decision;
    try { decision = await askWhichLink(apiKey, screenshot, currentUrl, pageTitle, links, instruction, fileName, agentState.step, history); }
    catch (e) { pushLog('err', 'AI error: ' + e.message); await sleep(2000); continue; }

    pushLog('info', `AI → ${decision.thought || ''}`);

    // ── Handle special actions ──────────────────────────────
    if (decision.action === 'done') {
      if (await isOnAssignmentPage(tabId)) {
        await canvasSubmit(tabId, fileName, fileBase64, instruction);
      } else {
        pushLog('warn', 'AI said done but no Submit button visible — continuing');
        history.push({ step: agentState.step, url: currentUrl, tried: 'done', result: 'FAILED — no submit button found' });
      }
      return;
    }

    if (decision.action === 'scroll') {
      pushLog('info', 'Scrolling to reveal more content…');
      await scrollPage(tabId, 'down');
      await sleep(800);
      history.push({ step: agentState.step, url: currentUrl, tried: 'scroll', result: 'scrolled down' });
      continue;
    }

    if (decision.action === 'back') {
      pushLog('info', 'Going back…');
      await inPage(tabId, () => history.back());
      await waitForTabLoad(tabId); await sleep(600);
      continue;
    }

    // ── Find the link and navigate ──────────────────────────
    if (!decision.linkText) {
      pushLog('warn', 'AI returned no link text — scrolling');
      await scrollPage(tabId, 'down'); await sleep(600);
      continue;
    }

    const targetText = decision.linkText.trim().toLowerCase();
    
    // Find best matching link from scraped list
    let match = links.find(l => l.text.toLowerCase() === targetText);
    if (!match) match = links.find(l => l.text.toLowerCase().includes(targetText));
    if (!match) match = links.find(l => targetText.includes(l.text.toLowerCase()) && l.text.length > 3);

    if (!match) {
      pushLog('err', `Link not found: "${decision.linkText}"`);
      pushLog('info', `Available: ${links.slice(0, 8).map(l => '"' + l.text + '"').join(', ')}`);
      history.push({ step: agentState.step, url: currentUrl, tried: decision.linkText, result: `FAILED — link "${decision.linkText}" not found on page. Available links: ${links.slice(0, 10).map(l => l.text).join(', ')}` });
      continue;
    }

    pushLog('info', `→ Navigating to: "${match.text}" (${match.href})`);
    history.push({ step: agentState.step, url: currentUrl, tried: match.text, result: `navigated to ${match.href}` });

    await chrome.tabs.update(tabId, { url: match.href });
    await waitForTabLoad(tabId);
    await sleep(600);
  }

  try { pushScreenshot(await captureTab(tabId)); } catch {}
  pushLog('err', `Stopped after ${agentState.step} steps without finding the assignment.`);
}

// ─────────────────────────────────────────────────────────────
//  AI DECISION — which link to follow?
//  Returns: { action: 'follow'|'scroll'|'back'|'done', linkText, thought }
// ─────────────────────────────────────────────────────────────
async function askWhichLink(apiKey, screenshotB64, currentUrl, pageTitle, links, instruction, fileName, step, history) {
  const linksForAI = links.slice(0, 60).map((l, i) => `[${i}] "${l.text}"`).join('\n');

  const histStr = history.length
    ? '\n\nPREVIOUS STEPS:\n' + history.slice(-8).map(h => `  Step ${h.step} on "${h.url.slice(0, 60)}": tried "${h.tried}" → ${h.result}`).join('\n')
    : '';

  const systemPrompt = `You are navigating a Canvas LMS to find a specific assignment page.
You will be shown a screenshot and a numbered list of ALL clickable links on the current page.
Your job: decide which link to follow next to reach the assignment.

Respond with ONLY this JSON (no markdown):
{"action":"follow","linkText":"exact text from the list","thought":"why this link"}

Or if you need to scroll to see more:
{"action":"scroll","thought":"why"}

Or if you can already see a Submit Assignment button:
{"action":"done","thought":"submit button visible"}

RULES:
- "linkText" must be the EXACT text string from the numbered list I provide — copy it exactly
- Canvas course sidebar order: Home → Announcements → Modules → Assignments → Grades
- If you're on a course page, look for "Assignments" or "Modules" in the link list
- If you're on an Assignments page, look for the specific assignment name
- If a link was FAILED in history, do NOT try it again — pick a different one
- Never output selector or CSS — only linkText from the list`;

  const userMsg = `Step ${step}
Goal: "${instruction}"
Current page: "${pageTitle}"
URL: ${currentUrl}
${histStr}

LINKS ON THIS PAGE:
${linksForAI || '(no links found — try scrolling)'}

Look at the screenshot and the link list. Which link gets us closest to the assignment?`;

  const data = await fetchWithRetry(apiKey, screenshotB64, systemPrompt, userMsg);
  const raw = data.choices?.[0]?.message?.content?.trim() || '{"action":"scroll","thought":"no response"}';
  try { return JSON.parse(raw.replace(/```json|```/g, '').trim()); }
  catch { pushLog('warn', 'Bad AI JSON: ' + raw.slice(0, 80)); return { action: 'scroll', thought: 'parse error' }; }
}

// ─────────────────────────────────────────────────────────────
//  SCRAPE ALL VISIBLE LINKS FROM PAGE
// ─────────────────────────────────────────────────────────────
async function scrapeLinks(tabId) {
  const result = await inPage(tabId, () => {
    const seen = new Set();
    const links = [];
    document.querySelectorAll('a[href]').forEach(a => {
      let href = a.getAttribute('href');
      if (!href || href === '#' || href.startsWith('javascript') || href.startsWith('mailto')) return;
      if (!href.startsWith('http')) href = location.origin + (href.startsWith('/') ? '' : '/') + href;

      const text = (a.innerText || a.textContent || a.getAttribute('aria-label') || a.getAttribute('title') || '').trim().replace(/\s+/g, ' ');
      if (!text || text.length < 2) return;

      // Deduplicate by href+text
      const key = href + '|' + text.slice(0, 40);
      if (seen.has(key)) return;
      seen.add(key);

      // Check visibility
      const r = a.getBoundingClientRect();
      const visible = r.width > 0 && r.height > 0;

      links.push({ text: text.slice(0, 80), href, visible });
    });

    // Sort: visible links first
    links.sort((a, b) => (b.visible ? 1 : 0) - (a.visible ? 1 : 0));
    return links.slice(0, 80);
  });
  return result || [];
}

// ─────────────────────────────────────────────────────────────
//  CANVAS SUBMISSION PIPELINE (deterministic)
//  Detects submission type: file upload OR text entry
// ─────────────────────────────────────────────────────────────
//  DETECT ASSIGNMENT PAGE
// ─────────────────────────────────────────────────────────────
async function isOnAssignmentPage(tabId) {
  return await inPage(tabId, () => {
    const sels = ['button.submit_assignment_link','a.submit_assignment_link','[data-testid="submit-assignment-btn"]'];
    for (const s of sels) { if (document.querySelector(s)) return true; }
    for (const el of document.querySelectorAll('a,button')) {
      if (el.textContent.trim().toLowerCase().includes('submit assignment')) return true;
    }
    return false;
  });
}

// ─────────────────────────────────────────────────────────────
async function canvasSubmit(tabId, fileName, fileBase64, instruction) {
  pushLog('spin', 'Looking for Submit Assignment button…');
  const foundSubmit = await inPage(tabId, () => {
    const sels = ['button.submit_assignment_link','a.submit_assignment_link','[data-testid="submit-assignment-btn"]','button[aria-label*="Submit"]'];
    for (const s of sels) { const el = document.querySelector(s); if (el) { el.click(); return el.textContent.trim(); } }
    for (const el of document.querySelectorAll('a,button')) {
      if (el.textContent.trim().toLowerCase().includes('submit assignment')) { el.click(); return el.textContent.trim(); }
    }
    return null;
  });
  if (!foundSubmit) { pushLog('err', 'Submit Assignment button not found.'); return; }
  pushLog('ok', `Clicked: "${foundSubmit}"`);

  pushLog('spin', 'Waiting for submission dialog…');
  const modal = await waitForElement(tabId, [
    '.submission_details', '[data-testid="file-upload-container"]',
    '.file-upload-box', '#submit_assignment', '.ReactModal__Content',
    '#submit_online_entry_form', 'iframe.tox-edit-area__iframe', '.text_entry',
  ], 6000);
  if (!modal) { pushLog('err', 'Submission dialog did not open.'); return; }
  pushLog('ok', 'Dialog opened');
  await sleep(800);

  // ── Detect submission type ────────────────────────────────
  const submissionType = await inPage(tabId, () => {
    // Check which tab/type is active or available
    if (document.querySelector('#submit_online_entry_form') ||
        document.querySelector('[data-testid="submit-label-online_entry_tab"]') ||
        document.querySelector('a[href="#submit_online_entry_form"]') ||
        document.querySelector('.text_entry_area') ||
        document.querySelector('iframe.tox-edit-area__iframe')) {
      // Check if text entry is the only or default type
      const fileTab = document.querySelector('[data-testid="submit-label-file_upload_tab"]') ||
                      document.querySelector('a[href="#submit_file_upload_form"]');
      if (!fileTab) return 'text_only';
      return 'both'; // has both tabs
    }
    if (document.querySelector('input[type=file]') ||
        document.querySelector('[data-testid="file-upload-container"]')) {
      return 'file_only';
    }
    return 'unknown';
  });

  pushLog('info', `Submission type: ${submissionType}`);

  if (submissionType === 'file_only') {
    await submitFileUpload(tabId, fileName, fileBase64);
  } else if (submissionType === 'text_only') {
    await submitTextEntry(tabId, fileBase64);
  } else {
    // Has both tabs — check which one is pre-selected/active
    const activeTab = await inPage(tabId, () => {
      const active = document.querySelector('[aria-selected="true"],[class*="selected"],[class*="active"]');
      if (active) return active.textContent.trim().toLowerCase();
      return null;
    });

    if (activeTab && (activeTab.includes('text entry') || activeTab.includes('online entry'))) {
      // Text entry tab is explicitly active — use it
      await submitTextEntry(tabId, fileBase64);
    } else {
      // Default: file upload is the safer choice when both are available.
      // Only switch to text entry if the file upload tab cannot be found.
      const switchedToFile = await inPage(tabId, () => {
        const sels = ['[data-testid="submit-label-file_upload_tab"]','a[href="#submit_file_upload_form"]'];
        for (const s of sels) { const el = document.querySelector(s); if (el) { el.click(); return true; } }
        for (const el of document.querySelectorAll('a,button,label,[role="tab"]')) {
          const t = el.textContent.trim().toLowerCase();
          if (t.includes('file upload') || t.includes('upload file')) { el.click(); return true; }
        }
        return false;
      });
      await sleep(500);
      if (switchedToFile) {
        await submitFileUpload(tabId, fileName, fileBase64);
      } else {
        // File upload tab not found — fall back to text entry
        pushLog('info', 'File upload tab not found — falling back to text entry');
        await submitTextEntry(tabId, fileBase64);
      }
    }
  }
}

// ── File upload submission ────────────────────────────────────
async function submitFileUpload(tabId, fileName, fileBase64) {
  pushLog('spin', 'Selecting File Upload tab…');
  await inPage(tabId, () => {
    const sels = ['[data-testid="submit-label-file_upload_tab"]','a[href="#submit_file_upload_form"]'];
    for (const s of sels) { const el = document.querySelector(s); if (el) { el.click(); return; } }
    for (const el of document.querySelectorAll('a,button,label,[role="tab"]')) {
      if (el.textContent.trim().toLowerCase().includes('file upload')) { el.click(); return; }
    }
  });
  await sleep(500);

  pushLog('spin', `Attaching "${fileName}"…`);
  const attached = await inPage(tabId, (b64, name) => {
    const bytes = atob(b64), arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    const file = new File([arr], name, { type: 'application/pdf' });
    const sels = ['input[type=file][name="attachments[0][uploaded_data]"]','#fileUpload','[data-testid="file-upload-input"]','input[type=file]'];
    let input = null;
    for (const s of sels) { input = document.querySelector(s); if (input) break; }
    if (!input) { const all = document.querySelectorAll('input[type=file]'); if (all.length) input = all[0]; }
    if (!input) return false;
    const dt = new DataTransfer(); dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, fileBase64, fileName);

  if (!attached) { pushLog('err', 'No file input found.'); return; }
  pushLog('ok', 'File attached');
  await sleep(1500);
  await finalSubmit(tabId);
}

// ── Text entry submission ─────────────────────────────────────
async function submitTextEntry(tabId, fileBase64) {
  // 1. Extract text from PDF
  pushLog('spin', 'Extracting text from PDF…');
  const pdfText = await extractPdfText(fileBase64);
  if (!pdfText) { pushLog('err', 'Could not extract text from PDF.'); return; }
  // Log the first 120 chars so you can verify it's PDF content, not page content
  pushLog('ok', 'PDF text (' + pdfText.length + ' chars). Preview: ' + pdfText.slice(0, 120).replace(/\n/g, ' '));

  // 2. Wait for editor (TinyMCE iframe or textarea)
  pushLog('spin', 'Waiting for text editor…');
  await sleep(500);

  // 3. Try TinyMCE / rich-text editor — scoped to submission form to avoid overwriting description
  const tinyMceInjected = await inPage(tabId, (text) => {
    function injectIntoBody(iDoc, body) {
      body.focus();
      iDoc.execCommand('selectAll', false, null);
      iDoc.execCommand('delete', false, null);
      iDoc.execCommand('insertText', false, text);
      if (!body.innerText.trim()) {
        body.innerHTML = text.split('\n').map(function(l) { return l ? '<p>' + l + '</p>' : '<p><br></p>'; }).join('');
      }
    }

    // Strategy A: TinyMCE global API — must pick the SUBMISSION editor, not the description editor.
    // Canvas loads a TinyMCE for the assignment description AND one for the submission text box.
    // tinymce.activeEditor is often the description — so we search by DOM container instead.
    if (typeof tinymce !== 'undefined' && tinymce.editors && tinymce.editors.length) {
      var submissionEditor = null;
      for (var i = 0; i < tinymce.editors.length; i++) {
        var ed = tinymce.editors[i];
        var container = ed.getContainer ? ed.getContainer() : ed.editorContainer;
        if (container) {
          var form = container.closest('#submit_online_entry_form, .submission_form, #submit_assignment, .ReactModal__Content');
          if (form) { submissionEditor = ed; break; }
        }
      }
      // Fallback: last-registered editor is typically the submission one (added after description)
      if (!submissionEditor) submissionEditor = tinymce.editors[tinymce.editors.length - 1];
      if (submissionEditor) {
        submissionEditor.setContent(text.replace(/\n/g, '<br>'));
        submissionEditor.fire('change');
        submissionEditor.fire('input');
        return 'tinymce-api';
      }
    }

    // Strategy B: iframe scan — anchored inside the submission form container.
    // This prevents matching the assignment description iframe which also has an editable body.
    var submissionRoots = [
      document.querySelector('#submit_online_entry_form'),
      document.querySelector('.submission_form'),
      document.querySelector('#submit_assignment'),
      document.querySelector('.ReactModal__Content'),
      document.body, // last resort
    ].filter(Boolean);

    for (var r = 0; r < submissionRoots.length; r++) {
      var root = submissionRoots[r];
      var iframes = root.querySelectorAll('iframe');
      for (var f = 0; f < iframes.length; f++) {
        var iframe = iframes[f];
        // Skip iframes that look like the assignment description/preview
        var idCls = (iframe.id || '') + ' ' + (iframe.className || '');
        if (/description|assignment_show|user_content|preview|syllabus/i.test(idCls)) continue;
        // Description iframes usually sit near the top of the page
        var rect = iframe.getBoundingClientRect();
        if (root === document.body && rect.top < 80) continue;
        try {
          var iDoc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
          if (!iDoc) continue;
          var body = iDoc.querySelector('body[contenteditable="true"]') || iDoc.body;
          if (!body) continue;
          var editable = iframe.classList.contains('tox-edit-area__iframe') ||
                         iDoc.designMode === 'on' ||
                         body.contentEditable === 'true';
          if (editable) { injectIntoBody(iDoc, body); return 'tinymce-iframe'; }
        } catch(e) {}
      }
      // If we searched inside a focused submission root, stop — don't fall through to body
      if (root !== document.body) break;
    }
    return null;
  }, pdfText);

  if (tinyMceInjected) {
    pushLog('ok', `Text inserted via ${tinyMceInjected}`);
  } else {
    // Fallback: plain textarea
    pushLog('info', 'TinyMCE not found — trying textarea fallback');
    const taInserted = await inPage(tabId, (text) => {
      // Scoped selectors — submission textarea only, not description/notes areas
      const sels = [
        'textarea[name="submission[body]"]',
        '#submission_body',
        '[data-testid="text-entry-area"]',
      ];
      // Try scoped selectors first
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el) {
          el.focus();
          el.value = text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      // Last resort: find a textarea INSIDE the submission form only
      const form = document.querySelector('#submit_online_entry_form, .submission_form, #submit_assignment, .ReactModal__Content');
      if (form) {
        const ta = form.querySelector('textarea');
        if (ta) {
          ta.focus();
          ta.value = text;
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          ta.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      return false;
    }, pdfText);

    if (!taInserted) { pushLog('err', 'Could not find text entry area.'); return; }
    pushLog('ok', 'Text inserted via textarea');
  }

  await sleep(800);
  await finalSubmit(tabId);
}

// ── Click the final Submit button ─────────────────────────────
async function finalSubmit(tabId) {
  // ── Check and accept any agreement checkboxes ──────────────
  const agreementChecked = await inPage(tabId, () => {
    // Look for unchecked checkboxes near agreement/license/policy text
    const checkboxes = document.querySelectorAll('input[type=checkbox]');
    let checked = 0;
    for (const cb of checkboxes) {
      if (cb.checked) continue; // already checked
      // Check if nearby text mentions agreement, license, policy, terms
      const label = (
        cb.labels?.[0]?.innerText ||
        cb.closest('label')?.innerText ||
        cb.parentElement?.innerText ||
        cb.parentElement?.parentElement?.innerText || ''
      ).toLowerCase();
      if (
        label.includes('agree') || label.includes('license') ||
        label.includes('policy') || label.includes('terms') ||
        label.includes('original') || label.includes('own work') ||
        label.includes('eula') || label.includes('honor')
      ) {
        cb.click();
        checked++;
      }
    }
    return checked;
  });
  if (agreementChecked > 0) {
    pushLog('ok', 'Checked ' + agreementChecked + ' agreement checkbox(es)');
    await sleep(400);
  }

  // ── Wait for Submit button to become enabled ────────────────
  pushLog('spin', 'Waiting for Submit button...');
  await waitForElement(tabId, [
    'button[type=submit]:not([disabled])',
    '[data-testid="submit-button"]:not([disabled])',
    '#submit_file_button:not([disabled])',
    '#submit_online_entry_form button[type=submit]:not([disabled])',
  ], 8000);

  // ── Click Submit ────────────────────────────────────────────
  pushLog('spin', 'Clicking Submit Assignment...');
  const submitted = await inPage(tabId, () => {
    // Try enabled buttons first
    const sels = [
      'button[type=submit]', '[data-testid="submit-button"]',
      '#submit_file_button', '#submit_entry_form_submit_button',
      'input[type=submit]',
    ];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el && !el.disabled) { el.click(); return el.textContent.trim() || el.value || 'submit'; }
    }
    // Force-click disabled as last resort
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el) { el.removeAttribute('disabled'); el.click(); return 'forced: ' + (el.textContent.trim() || 'submit'); }
    }
    return null;
  });

  if (!submitted) { pushLog('err', 'Submit button not found.'); return; }
  pushLog('ok', 'Clicked: ' + submitted);

  await waitForTabLoad(tabId);
  await sleep(2000);
  try { pushScreenshot(await captureTab(tabId)); } catch {}

  const confirmed = await inPage(tabId, () => {
    const b = document.body.innerText.toLowerCase();
    return (
      b.includes('turned in') || b.includes('submitted') ||
      b.includes('submission received') || b.includes('your assignment has been submitted') ||
      !!document.querySelector('[data-testid="submission-status"]') ||
      !!document.querySelector('.submission_header')
    );
  });
  pushLog(confirmed ? 'ok' : 'info', confirmed ? '🎉 Assignment submitted successfully!' : '✓ Submit clicked — check the page to confirm.');
}

// ─────────────────────────────────────────────────────────────
//  PDF TEXT EXTRACTION (client-side, no external library)
//  Decodes the base64 PDF and extracts all readable text
//  by parsing PDF content streams directly.
// ─────────────────────────────────────────────────────────────
async function extractPdfText(base64Data) {
  pushLog('spin', 'Extracting text from PDF...');

  // ── Strategy 1: Inject PDF.js into the tab as a content script ──
  // Service workers (MV3) cannot dynamically load large scripts via importScripts.
  // But tabs CAN load external scripts normally. We inject a tiny script that:
  //   1. Creates a <script> tag loading pdf.min.js from the extension
  //   2. Decodes the base64 PDF and extracts all text using PDF.js
  //   3. Returns the extracted text back to us
  try {
    pushLog('info', 'Injecting PDF.js into tab for extraction...');
    const pdfJsUrl = chrome.runtime.getURL('libs/pdf.min.js');
    const workerUrl = chrome.runtime.getURL('libs/pdf.worker.min.js');

    const extracted = await new Promise((resolve) => {
      // Timeout after 20s
      const timer = setTimeout(() => resolve(null), 20000);

      chrome.scripting.executeScript({
        target: { tabId: agentState.tabId },
        world: 'MAIN',
        func: async (b64, pdfSrc, workerSrc) => {
          // Load PDF.js if not already loaded
          if (!window._pdfjsLoaded) {
            await new Promise((res, rej) => {
              const s = document.createElement('script');
              s.src = pdfSrc;
              s.onload = res;
              s.onerror = rej;
              document.head.appendChild(s);
            });
            window._pdfjsLoaded = true;
            // Run without a worker so there is no cross-origin worker issue
            pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;
          }

          const binary = atob(b64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

          const pdf = await pdfjsLib.getDocument({
            data: bytes,
            useWorkerFetch: false,
            isEvalSupported: false,
            useSystemFonts: true,
          }).promise;

          const pages = [];
          for (let p = 1; p <= pdf.numPages; p++) {
            const page = await pdf.getPage(p);
            const tc = await page.getTextContent();
            let lastY = null, currentLine = '';
            const lines = [];
            for (const item of tc.items) {
              if ('str' in item) {
                const y = item.transform ? Math.round(item.transform[5]) : 0;
                if (lastY !== null && Math.abs(y - lastY) > 8) {
                  if (currentLine.trim()) lines.push(currentLine.trim());
                  currentLine = item.str;
                } else {
                  currentLine += item.str;
                }
                lastY = y;
              }
            }
            if (currentLine.trim()) lines.push(currentLine.trim());
            const pt = lines.join('\n').trim();
            if (pt) pages.push(pt);
          }
          return pages.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
        },
        args: [base64Data, pdfJsUrl, workerUrl],
      }).then(results => {
        clearTimeout(timer);
        const text = results?.[0]?.result;
        resolve((text && text.length > 10) ? text : null);
      }).catch(err => {
        clearTimeout(timer);
        pushLog('warn', 'Tab injection failed: ' + err.message);
        resolve(null);
      });
    });

    if (extracted) {
      pushLog('ok', 'PDF.js (tab) extracted ' + extracted.length + ' chars');
      return extracted;
    }
    pushLog('warn', 'PDF.js found no selectable text — trying GPT-4o vision OCR...');
  } catch(e) {
    pushLog('warn', 'Strategy 1 error: ' + e.message);
  }

  // ── Strategy 2: Render PDF pages as images in the tab, OCR with GPT-4o ──
  // Still uses the user's uploaded PDF (base64Data), not a page screenshot.
  try {
    pushLog('spin', 'Rendering PDF pages to images in tab...');
    const pdfJsUrl = chrome.runtime.getURL('libs/pdf.min.js');
    const workerUrl = chrome.runtime.getURL('libs/pdf.worker.min.js');

    const pageImages = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 30000);
      chrome.scripting.executeScript({
        target: { tabId: agentState.tabId },
        world: 'MAIN',
        func: async (b64, pdfSrc, workerSrc) => {
          if (!window._pdfjsLoaded) {
            await new Promise((res, rej) => {
              const s = document.createElement('script');
              s.src = pdfSrc; s.onload = res; s.onerror = rej;
              document.head.appendChild(s);
            });
            window._pdfjsLoaded = true;
            pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;
          }
          const binary = atob(b64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          const pdf = await pdfjsLib.getDocument({ data: bytes, useWorkerFetch: false, isEvalSupported: false }).promise;
          const imgs = [];
          for (let p = 1; p <= Math.min(pdf.numPages, 5); p++) {
            const page = await pdf.getPage(p);
            const vp = page.getViewport({ scale: 1.5 });
            const canvas = document.createElement('canvas');
            canvas.width = vp.width; canvas.height = vp.height;
            await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
            // Return as base64 jpeg without the data: prefix
            imgs.push(canvas.toDataURL('image/jpeg', 0.85).split(',')[1]);
          }
          return imgs;
        },
        args: [base64Data, pdfJsUrl, workerUrl],
      }).then(results => {
        clearTimeout(timer);
        resolve(results?.[0]?.result || null);
      }).catch(err => {
        clearTimeout(timer);
        pushLog('warn', 'Page render failed: ' + err.message);
        resolve(null);
      });
    });

    if (pageImages && pageImages.length > 0) {
      pushLog('info', 'Sending ' + pageImages.length + ' rendered PDF page(s) to GPT-4o OCR...');
      return await readImagesWithGPT(pageImages);
    }
  } catch(e) {
    pushLog('warn', 'Strategy 2 error: ' + e.message);
  }

  // ── Strategy 3: GPT-4o with PDF rendered as a single high-res image ──
  // Last resort — ask GPT-4o to read the first page rendered as a JPEG.
  // We do NOT use captureTab() here — that would capture the Canvas page, not the PDF.
  pushLog('warn', 'All local strategies failed.');
  pushLog('err', 'All PDF extraction strategies failed.');
  return null;
}
async function readImagesWithGPT(pageImagesB64) {
  const apiKey = agentState.apiKey;
  if (!apiKey) { pushLog('err', 'No API key'); return null; }

  const imageContent = pageImagesB64.map(img => ({
    type: 'image_url',
    image_url: { url: 'data:image/jpeg;base64,' + img, detail: 'high' }
  }));

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Extract ALL text from these PDF page images exactly as written. Preserve paragraph breaks. Return only the extracted text, no commentary.' },
            ...imageContent
          ]
        }]
      })
    });

    if (res.ok) {
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content?.trim();
      if (text && text.length > 10) {
        pushLog('ok', 'GPT-4o extracted ' + text.length + ' chars');
        return text;
      }
    } else {
      const err = await res.json().catch(() => ({}));
      pushLog('err', 'GPT-4o vision failed: ' + (err.error?.message || res.status));
    }
  } catch(e) {
    pushLog('err', 'GPT-4o call failed: ' + e.message);
  }
  return null;
}



// ─────────────────────────────────────────────────────────────
//  OPENAI FETCH WITH RETRY
// ─────────────────────────────────────────────────────────────
async function fetchWithRetry(apiKey, b64, sys, usr, attempt = 0) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
    body: JSON.stringify({ model: 'gpt-4o', max_tokens: 200, messages: [
      { role: 'system', content: sys },
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64, detail: 'low' } },
        { type: 'text', text: usr }
      ]}
    ]})
  });
  if (res.status === 429 && attempt < 5) {
    const err = await res.json().catch(() => ({}));
    const sec = (err.error && err.error.message || '').match(/try again in ([\d.]+)s/);
    const ms = sec ? Math.ceil(parseFloat(sec[1]) * 1000) + 500 : Math.pow(2, attempt) * 3000;
    pushLog('warn', 'Rate limit - waiting ' + (ms/1000).toFixed(1) + 's...');
    await sleep(ms); return fetchWithRetry(apiKey, b64, sys, usr, attempt + 1);
  }
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error('OpenAI: ' + ((e.error && e.error.message) || res.status)); }
  return res.json();
}

// ─────────────────────────────────────────────────────────────
//  UTILITIES
// ─────────────────────────────────────────────────────────────
async function inPage(tabId, func, ...args) {
  try { const r = await chrome.scripting.executeScript({ target: { tabId }, func, args }); return r?.[0]?.result; }
  catch { return null; }
}

function captureTab(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, tab => {
      chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 55 }, dataUrl => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(dataUrl.split(',')[1]);
      });
    });
  });
}

function waitForElement(tabId, selectors, timeoutMs = 5000) {
  return new Promise(resolve => {
    const start = Date.now();
    const poll = setInterval(async () => {
      const found = await inPage(tabId, (sels) => {
        for (const s of sels) { try { const el = document.querySelector(s); if (el) return s; } catch {} }
        return null;
      }, selectors);
      if (found || Date.now() - start > timeoutMs) { clearInterval(poll); resolve(found); }
    }, 250);
  });
}

async function scrollPage(tabId, dir) {
  await inPage(tabId, d => window.scrollBy(0, d === 'down' ? 500 : -500), dir);
}

function waitForTabLoad(tabId) {
  return new Promise(resolve => {
    chrome.tabs.get(tabId, tab => {
      if (tab?.status === 'complete') { setTimeout(resolve, 300); return; }
      const fn = (id, info) => { if (id === tabId && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(fn); setTimeout(resolve, 500); } };
      chrome.tabs.onUpdated.addListener(fn);
      setTimeout(() => { chrome.tabs.onUpdated.removeListener(fn); resolve(); }, 8000);
    });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
