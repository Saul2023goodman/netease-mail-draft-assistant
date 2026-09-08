(() => {
  'use strict';

  if (window.top !== window) return;

  const APP = 'NetEase Mail Draft Assistant';
  const STORAGE_KEY = 'nmda.form.v2';
  const DEFAULT_TIMEOUT = 10000;
  const Importer = globalThis.NMDAImporter;
  const MailRecognizer = globalThis.NMDAMailRecognizer;
  const Contacts = globalThis.NMDAContacts;
  const Scheduler = globalThis.NMDAScheduler;
  const Roster = globalThis.NMDARoster;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function visible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  }

  async function waitFor(fn, timeout = DEFAULT_TIMEOUT, interval = 120, message = '等待页面元素超时') {
    const start = Date.now();
    let lastError;
    while (Date.now() - start < timeout) {
      try {
        const value = fn();
        if (value) return value;
      } catch (error) { lastError = error; }
      await sleep(interval);
    }
    if (lastError) throw lastError;
    throw new Error(message || '等待页面状态超时');
  }

  function nativeSetValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor?.set) descriptor.set.call(el, value);
    else el.value = value;
  }

  function fire(el, type, options = {}) {
    let event;
    if (type.startsWith('key')) event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...options });
    else event = new Event(type, { bubbles: true, cancelable: true });
    el.dispatchEvent(event);
  }

  function textOf(el) {
    return (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function compactText(valueOrEl) {
    const value = typeof valueOrEl === 'string' ? valueOrEl : textOf(valueOrEl);
    return String(value || '').replace(/[\s\u00a0\u200b\u200c\u200d\ufeff]+/g, '');
  }

  function hasUiText(el, text) {
    const target = compactText(text);
    const actual = compactText(el);
    return !!target && (actual === target || actual.includes(target));
  }

  function findComposeRoot() {
    const semantic = [...document.querySelectorAll('[role="main"]')]
      .find(el => visible(el) && compactText(el.getAttribute('aria-label') || '').includes('写信'));
    if (semantic) return semantic;
    const moduleRoot = [...document.querySelectorAll('[id^="_dvModuleContainer_compose.ComposeModule_"]')].find(visible);
    if (moduleRoot) return moduleRoot;
    const subject = [...document.querySelectorAll('input[id$="_subjectInput"]')].find(visible);
    const recipient = [...document.querySelectorAll('input[aria-label^="收件人地址输入框"]')].find(visible);
    const anchor = subject || recipient;
    return anchor
      ? anchor.closest('[role="main"]') || anchor.closest('[id^="_dvModuleContainer_compose.ComposeModule_"]') || document
      : null;
  }

  function composeFingerprint(root = findComposeRoot()) {
    if (!root) return '';
    const subject = root.querySelector?.('input[id$="_subjectInput"]');
    const recipient = root.querySelector?.('input[aria-label^="收件人地址输入框"]');
    return subject?.id || recipient?.parentElement?.id || root.id || decodeURIComponent(location.hash || '');
  }

  async function tryOpenComposeViaPageApi() {
    try {
      return await chrome.runtime.sendMessage({ type: 'NMDA_OPEN_COMPOSE' }) || { ok: false, reason: 'empty-response' };
    } catch (error) {
      return { ok: false, reason: error?.message || String(error) };
    }
  }

  function findWriteButton() {
    const navRoot = document.querySelector('#dvNavTop') || document.querySelector('#dvNavContainer') || document;
    const selectors = 'li[role="button"],button,[role="button"],a[role="button"]';
    let button = [...navRoot.querySelectorAll(selectors)].filter(visible).find(el => {
      const aria = el.getAttribute('aria-label') || '';
      const title = el.getAttribute('title') || '';
      return hasUiText(el, '写信') || compactText(aria).includes('写信') || compactText(title).includes('写信');
    }) || null;
    if (button) return button;
    button = document.querySelector('#_mail_component_98_98');
    if (button && visible(button)) return button;
    return [...document.querySelectorAll(selectors)].filter(visible).find(el => hasUiText(el, '写信')) || null;
  }

  function navButtonDiagnostics() {
    const navRoot = document.querySelector('#dvNavTop') || document.querySelector('#dvNavContainer') || document;
    return [...navRoot.querySelectorAll('[role="button"],li,button')].filter(visible).slice(0, 12)
      .map(el => `${el.id || el.tagName}:${JSON.stringify(textOf(el))}`).join(' | ');
  }

  async function openCompose() {
    let root = findComposeRoot();
    if (root) return root;
    const apiResult = await tryOpenComposeViaPageApi();
    if (apiResult.ok) {
      try {
        root = await waitFor(findComposeRoot, 9000, 120, '');
        if (root) return root;
      } catch (_) {}
    }
    const writeButton = findWriteButton();
    if (!writeButton) throw new Error(`没有找到“写信”入口。页面接口：${apiResult.reason || '不可用'}。可见导航：${navButtonDiagnostics() || '无'}`);
    writeButton.click();
    return waitFor(findComposeRoot, 12000, 120, '点击“写信”后未检测到写信页面。');
  }

  async function openFreshCompose() {
    const beforeRoot = findComposeRoot();
    const before = composeFingerprint(beforeRoot);
    const isFresh = () => {
      const root = findComposeRoot();
      if (!root) return null;
      const now = composeFingerprint(root);
      if (!beforeRoot || !before || (now && now !== before)) return root;
      return null;
    };

    const apiResult = await tryOpenComposeViaPageApi();
    if (apiResult.ok) {
      try { return await waitFor(isFresh, 10000, 120, ''); }
      catch (_) {}
    }

    const writeButton = findWriteButton();
    if (!writeButton) throw new Error(`无法新建下一封写信。页面接口：${apiResult.reason || '不可用'}。`);
    writeButton.click();
    return waitFor(isFresh, 12000, 120, '已触发“写信”，但没有检测到新的 Compose 实例；为避免覆盖上一封草稿，批处理已停止。');
  }

  function findRecipientInput(root) {
    return root.querySelector('input[aria-label^="收件人地址输入框"]')
      || [...root.querySelectorAll('input[type="text"]')].find(el => (el.getAttribute('aria-label') || '').includes('收件人'))
      || null;
  }

  async function setRecipients(root, raw) {
    const addresses = String(raw || '').split(/[;,，；\n]+/).map(s => s.trim()).filter(Boolean);
    if (!addresses.length) return;
    const input = await waitFor(() => findRecipientInput(root), 8000, 100, '未找到收件人输入框。');
    input.focus();
    nativeSetValue(input, `${addresses.join(';')};`);
    fire(input, 'input');
    fire(input, 'change');
    await sleep(100);
    fire(input, 'blur');
    await sleep(350);
  }

  function splitRecipientAddresses(raw) {
    return String(raw || '').split(/[;,，；\n]+/).map(s => s.trim()).filter(Boolean);
  }

  function findAuxRecipientInput(root, label) {
    const target = compactText(label);
    const candidates = [...root.querySelectorAll('input,textarea,[contenteditable="true"]')];
    return candidates.find(el => {
      const aria = compactText(el.getAttribute?.('aria-label') || '');
      const title = compactText(el.getAttribute?.('title') || '');
      return visible(el) && (aria.includes(target) || title.includes(target));
    }) || null;
  }

  function findComposeLink(root, label) {
    const target = compactText(label);
    return [...root.querySelectorAll('a,[role="button"],button,.nui-txt-link')]
      .filter(visible)
      .find(el => compactText(el) === target || compactText(el.getAttribute('title') || '') === target) || null;
  }

  async function setAuxRecipients(root, raw, label) {
    const addresses = splitRecipientAddresses(raw);
    if (!addresses.length) return;
    let input = findAuxRecipientInput(root, label);
    if (!input) {
      const link = findComposeLink(root, label);
      if (!link) throw new Error(`原草稿含${label}，但当前网易写信页没有找到“${label}”入口。为避免丢失收件信息，已停止。`);
      link.click();
      input = await waitFor(() => findAuxRecipientInput(root, label), 5000, 100, `已点击“${label}”，但没有出现${label}输入框。`);
    }
    input.focus();
    nativeSetValue(input, `${addresses.join(';')};`);
    fire(input, 'input');
    fire(input, 'change');
    await sleep(100);
    fire(input, 'blur');
    await sleep(250);
  }

  function findSubjectInput(root) {
    return root.querySelector('input[id$="_subjectInput"]')
      || [...root.querySelectorAll('input')].find(el => compactText(el.getAttribute('aria-label') || '').includes('主题'))
      || null;
  }

  async function setSubject(root, subject) {
    const input = await waitFor(() => findSubjectInput(root), 8000, 100, '未找到主题输入框。');
    input.focus();
    nativeSetValue(input, subject || '');
    fire(input, 'input'); fire(input, 'change'); fire(input, 'blur');
  }

  function findEditorIframe(root) {
    const editorFrame = [...root.querySelectorAll('div[id^="_mail_editor_"] iframe')].find(visible);
    if (editorFrame) return editorFrame;
    return [...root.querySelectorAll('iframe')].filter(visible).sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return (rb.width * rb.height) - (ra.width * ra.height);
    })[0] || null;
  }

  function plainTextToHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML.replace(/\n/g, '<br>');
  }

  async function setBody(root, bodyText, bodyHtml = '', bodyIsHtml = false) {
    const iframe = await waitFor(() => findEditorIframe(root), 8000, 120, '未找到正文编辑器 iframe。');
    const body = await waitFor(() => {
      try { return iframe.contentDocument?.body || null; } catch (_) { return null; }
    }, 8000, 120, '无法访问正文编辑器内容。');
    body.focus();
    // Drafts imported from the mailbox already contain NetEase-sanitized HTML.
    // Preserve that representation unless the user edited the plain-text body in
    // the workbench; ordinary file imports continue through the plain-text path.
    if (bodyIsHtml && String(bodyHtml || '').trim()) body.innerHTML = String(bodyHtml);
    else body.innerHTML = plainTextToHtml(bodyText || '');
    fire(body, 'input'); fire(body, 'change'); fire(body, 'blur');
  }

  function comparableText(value) {
    return String(value || '').replace(/\u00a0/g, ' ').replace(/[\s\u200b\u200c\u200d\ufeff]+/g, '').toLowerCase();
  }

  function editorDocument(root) {
    const iframe = findEditorIframe(root);
    if (!iframe) return null;
    try { return iframe.contentDocument || null; } catch (_) { return null; }
  }

  function nativeQuoteMarker(root, mode) {
    const doc = editorDocument(root);
    if (!doc) return null;
    return doc.getElementById(mode === 'reply' ? 'isReplyContent' : 'isForwardContent');
  }

  function routeComposeType() {
    let hash = String(location.hash || '');
    try { hash = decodeURIComponent(hash); } catch (_) {}
    const jsonMatch = hash.match(/["']type["']\s*:\s*["']([^"']+)["']/i);
    const queryMatch = hash.match(/(?:^|[?&#|,{])type\s*[=:]\s*["']?([^"'&,}|]+)/i);
    return String(jsonMatch?.[1] || queryMatch?.[1] || '').trim().toLowerCase();
  }

  function detectNativeComposeMode(root = findComposeRoot()) {
    if (!root) return { mode:'', evidence:[] };
    const evidence = [];
    const doc = editorDocument(root);
    if (doc?.getElementById('isForwardContent')) evidence.push('editor:#isForwardContent');
    if (doc?.getElementById('isReplyContent')) evidence.push('editor:#isReplyContent');
    const routeType = routeComposeType();
    if (routeType) evidence.push(`route:${routeType}`);
    // NetEase's own Compose source uses #isForwardContent and #isReplyContent to
    // distinguish quoted HTML drafts. Plain-text source messages may not create
    // either marker, so the native Compose route is the authoritative fallback.
    if (doc?.getElementById('isForwardContent')) return { mode:'forward', evidence };
    if (doc?.getElementById('isReplyContent')) return { mode:'reply', evidence };
    if (/forward/.test(routeType)) return { mode:'forward', evidence };
    if (/reply/.test(routeType)) return { mode:'reply', evidence };
    return { mode:'', evidence };
  }

  function emailsFromText(value) {
    return [...new Set((String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) || []).map(v => v.toLowerCase()))];
  }

  function recipientEvidenceEmails(root) {
    const input = findRecipientInput(root);
    if (!input) return [];
    const inputRect = input.getBoundingClientRect();
    const subjectRect = findSubjectInput(root)?.getBoundingClientRect?.();
    const rightLimit = (subjectRect?.right || inputRect.right || window.innerWidth) + 30;
    const emails = new Set(emailsFromText(input.value || ''));
    const candidates = root.querySelectorAll('span,div,a,input,[title],[aria-label]');
    for (const el of candidates) {
      if (!visible(el)) continue;
      const rect = el.getBoundingClientRect();
      if (Math.abs((rect.top + rect.height / 2) - (inputRect.top + inputRect.height / 2)) > 58) continue;
      if (rect.left > rightLimit || rect.right < inputRect.left - 180) continue;
      const text = `${el.value || ''} ${textOf(el)} ${el.getAttribute?.('title') || ''} ${el.getAttribute?.('aria-label') || ''}`;
      for (const email of emailsFromText(text)) emails.add(email);
    }
    return [...emails];
  }

  async function ensureNativeRecipients(root, raw, mode) {
    const expected = splitRecipientAddresses(raw).map(value => emailsFromText(value)[0] || value.toLowerCase()).filter(value => value.includes('@'));
    if (!expected.length) throw new Error('Follow-up 缺少收件人。');
    let actual = recipientEvidenceEmails(root);
    if (expected.every(email => actual.includes(email))) return { expected, actual, changed:false };
    const unexpected = actual.filter(email => !expected.includes(email));
    if (unexpected.length) throw new Error(`原生${mode === 'forward' ? '转发' : '回复'}页已有非目标收件人：${unexpected.join('、')}。为避免误发，已停止。`);
    await setRecipients(root, expected.join(';'));
    actual = await waitFor(() => {
      const found = recipientEvidenceEmails(root);
      return expected.every(email => found.includes(email)) ? found : null;
    }, 5000, 120, '已填写收件人，但无法确认网易页面已接受该地址。');
    return { expected, actual, changed:true };
  }

  async function setNativeFollowUpIntro(root, introText, mode, task = {}) {
    const iframe = await waitFor(() => findEditorIframe(root), 8000, 120, '未找到原生 Follow-up 正文编辑器。');
    const doc = await waitFor(() => { try { return iframe.contentDocument || null; } catch (_) { return null; } }, 8000, 120, '无法访问原生 Follow-up 编辑器。');
    const markerId = mode === 'reply' ? 'isReplyContent' : 'isForwardContent';
    // Source integrity has already been verified before this function runs.
    // HTML source mail normally owns a marker; plain-text mail may not.
    const quote = doc.getElementById(markerId);
    let target = doc.getElementById('spnEditorContent');
    if (!target) {
      target = doc.getElementById('nmdaFollowUpIntro');
      if (!target) {
        target = doc.createElement('div');
        target.id = 'nmdaFollowUpIntro';
        if (quote?.parentNode) quote.parentNode.insertBefore(target, quote);
        else doc.body?.insertBefore(target, doc.body.firstChild || null);
      }
    }
    target.innerHTML = plainTextToHtml(introText || '');
    const editorBody = doc.body;
    editorBody?.focus();
    if (editorBody) { fire(editorBody, 'input'); fire(editorBody, 'change'); }
    await sleep(180);
    const expected = comparableText(introText).slice(0, 120);
    const actual = comparableText(target.innerText || target.textContent || '');
    if (expected && !actual.includes(expected.slice(0, Math.min(60, expected.length)))) throw new Error('Follow-up 正文写入后核验失败。');
    return { markerId:quote ? markerId : '', targetId:target.id || '', plainTextFallback:!quote };
  }

  function bodyIdentityText(value) {
    return comparableText(value).replace(/[>｜|]/g, '');
  }

  function sourceBodyAnchors(value) {
    const normalized = bodyIdentityText(value);
    if (!normalized) return [];
    if (normalized.length <= 90) return [normalized];
    const width = Math.min(64, Math.max(38, Math.floor(normalized.length / 5)));
    const starts = [0, Math.max(0, Math.floor((normalized.length - width) / 2)), Math.max(0, normalized.length - width)];
    return [...new Set(starts.map(start => normalized.slice(start, start + width)).filter(anchor => anchor.length >= 20))];
  }

  function nearbyReplyHeaderText(marker) {
    if (!marker) return '';
    const parts = [];
    let node = marker.previousSibling;
    for (let i = 0; node && i < 5; i++, node = node.previousSibling) {
      parts.unshift(node.innerText || node.textContent || '');
    }
    return parts.join(' ');
  }

  function editorQuotedFallbackText(doc) {
    if (!doc?.body) return '';
    const clone = doc.body.cloneNode(true);
    for (const selector of ['#spnEditorContent','#nmdaFollowUpIntro','#spnEditorSign','#divNeteaseMailCard','#divEditorGraphSign']) {
      clone.querySelectorAll?.(selector).forEach?.(el => el.remove());
    }
    return clone.innerText || clone.textContent || '';
  }

  function sourceAddressTokens(value) {
    const raw = String(value || '').trim();
    const emails = emailsFromText(raw);
    if (emails.length) return emails.map(email => comparableText(email));
    const display = raw.replace(/<[^>]+>/g, '').replace(/["']/g, '').trim();
    return display.length >= 3 ? [comparableText(display)] : [];
  }

  function sourceDateTokens(value) {
    const raw = String(value || '').trim();
    if (!raw) return [];
    const tokens = new Set();
    const normalizedRaw = comparableText(raw);
    if (normalizedRaw.length >= 6) tokens.add(normalizedRaw);
    let date = null;
    if (/^\d{10,13}$/.test(raw)) {
      const number = Number(raw);
      date = new Date(raw.length === 10 ? number * 1000 : number);
    } else {
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) date = new Date(parsed);
    }
    if (date && !Number.isNaN(date.getTime())) {
      const y = date.getFullYear(), m = date.getMonth() + 1, d = date.getDate();
      const mm = String(m).padStart(2, '0'), dd = String(d).padStart(2, '0');
      for (const token of [`${y}-${mm}-${dd}`,`${y}/${mm}/${dd}`,`${y}.${mm}.${dd}`,`${y}年${m}月${d}日`]) tokens.add(comparableText(token));
    }
    return [...tokens];
  }

  function validateSourceMetadata(task, mode, quoteTextRaw, replyHeaderRaw = '') {
    const quoteText = comparableText(quoteTextRaw);
    const replyHeader = comparableText(replyHeaderRaw);
    const failures = [];
    const checked = [];
    const target = mode === 'reply' ? `${replyHeader}${quoteText}` : quoteText;
    const expectAll = (label, tokens, haystack = target) => {
      if (!tokens.length) return;
      checked.push(label);
      const missing = tokens.filter(token => token && !haystack.includes(token));
      if (missing.length) failures.push(label);
    };

    // Native Forward includes a complete From/Date/To/Cc/Subject envelope.
    // Native Reply's quote header contains sender/date but not the original
    // subject/recipient envelope, so validate only information it actually owns.
    expectAll('发件人', sourceAddressTokens(task.sourceFrom));
    if (mode === 'forward') {
      expectAll('收件人', sourceAddressTokens(task.sourceTo));
      expectAll('抄送', sourceAddressTokens(task.sourceCc));
      const subject = comparableText(task.sourceSubject || '');
      if (subject) expectAll('原主题', [subject], quoteText);
    }
    const dateTokens = sourceDateTokens(task.sourceDate);
    if (dateTokens.length) {
      checked.push('日期');
      if (!dateTokens.some(token => target.includes(token))) failures.push('日期');
    }
    return { checked, failures, ok:failures.length === 0 };
  }

  async function waitNativeSourceIntegrity(root, task, mode) {
    const markerId = mode === 'reply' ? 'isReplyContent' : 'isForwardContent';
    const doc = editorDocument(root);
    const anchors = sourceBodyAnchors(task.sourceBody || '');
    // Wait for either the canonical native marker OR enough source text in the
    // editor. This preserves exact recognition for HTML while supporting the
    // marker-less plain-text path used by NetEase's quoteTextStart flow.
    const loaded = await waitFor(() => {
      const quote = nativeQuoteMarker(root, mode);
      const raw = quote ? (quote.innerText || quote.textContent || '') : editorQuotedFallbackText(doc);
      const identity = bodyIdentityText(raw);
      if (identity.length < 20) return null;
      if (!anchors.length) return { quote, raw, identity };
      const hits = anchors.filter(anchor => identity.includes(anchor));
      const required = anchors.length >= 3 ? 2 : anchors.length;
      return hits.length >= required ? { quote, raw, identity } : null;
    }, 6500, 120, `没有检测到与所选原邮件一致的网易原生${mode === 'forward' ? '转发' : '回复'}引用内容。`);
    const quote = loaded.quote;
    const quoteTextRaw = loaded.raw;
    const quoteText = loaded.identity;
    const matchedAnchors = anchors.filter(anchor => quoteText.includes(anchor));
    const requiredAnchors = anchors.length >= 3 ? 2 : anchors.length;
    const sourceMatched = !anchors.length || matchedAnchors.length >= requiredAnchors;
    if (!sourceMatched) throw new Error(`原生引用内容与所选已发送邮件正文不匹配（正文锚点 ${matchedAnchors.length}/${anchors.length}），可能打开了错误邮件；已停止。`);

    const replyHeaderRaw = mode === 'reply' ? nearbyReplyHeaderText(quote) : '';
    const metadata = validateSourceMetadata(task, mode, quoteTextRaw, replyHeaderRaw);
    if (!metadata.ok) throw new Error(`原生${mode === 'forward' ? '转发' : '回复'}未完整继承原邮件信息：${metadata.failures.join('、')} 核验失败；已停止保存。`);
    return {
      markerId:quote ? markerId : '', sourceMatched, quoteLength:quoteText.length,
      anchorsExpected:anchors.length, anchorsMatched:matchedAnchors.length,
      metadataChecked:metadata.checked, metadataVerified:metadata.ok,
      plainTextFallback:!quote
    };
  }

  async function waitNativeAttachmentIntegrity(root, task, mode) {
    const expected = (task.sourceAttachments || []).map(item => String(item?.name || '').trim()).filter(Boolean);
    if (mode !== 'forward') return { expected:0, matched:0, names:[], inventoryKnown:task.attachmentInventoryKnown === true, policy:'reply-does-not-require-original-attachments' };
    if (!expected.length) {
      if (task.hasAttachmentsHint && task.attachmentInventoryKnown !== true) {
        throw new Error('原邮件显示存在附件，但邮件详情没有返回可核验的附件清单；为避免转发漏附件，已停止。');
      }
      return { expected:0, matched:0, names:[], inventoryKnown:task.attachmentInventoryKnown === true, policy:'no-source-attachments-reported' };
    }
    const evidence = await waitFor(() => {
      const text = attachmentEvidenceText(root);
      const matched = expected.filter(name => attachmentNameVisible(root, name, text));
      return matched.length === expected.length ? matched : null;
    }, 9000, 180, `原生转发未完整继承原附件：预期 ${expected.join('、')}`);
    return { expected:expected.length, matched:evidence.length, names:evidence, inventoryKnown:task.attachmentInventoryKnown === true, policy:'forward-inherit-required' };
  }

  function findNativeReadActionButton(mode) {
    const label = mode === 'reply' ? '回复' : '转发';
    const textNodes = [...document.querySelectorAll('.nui-splitBtn-text')].filter(visible);
    let textNode = textNodes.find(el => compactText(el) === compactText(label));
    if (textNode) return textNode.closest('[role="button"],button,.nui-splitBtn') || textNode;
    const candidates = [...document.querySelectorAll('[role="button"],button,a')].filter(visible);
    return candidates.find(el => compactText(el) === compactText(label)) || null;
  }

  async function waitForNativeCompose(mode, beforeFingerprint = '', beforeHash = '', timeout = 10500) {
    return waitFor(() => {
      const root = findComposeRoot();
      if (!root) return null;
      const detected = detectNativeComposeMode(root);
      const fp = composeFingerprint(root);
      if (detected.mode === mode && (!beforeFingerprint || fp !== beforeFingerprint || String(location.hash || '') !== beforeHash)) return root;
      return null;
    }, timeout, 120, `没有检测到网易原生${mode === 'forward' ? '转发' : '回复'}写信页。`);
  }

  async function openNativeFollowUpCompose(task, mode) {
    const beforeFingerprint = composeFingerprint(findComposeRoot());
    const beforeHash = String(location.hash || '');
    const started = await chrome.runtime.sendMessage({ type:'NMDA_NATIVE_FOLLOWUP_START', sourceMessageId:task.sourceMessageId, mode }).catch(error => ({ok:false,reason:error?.message||String(error)}));
    if (started?.ok) {
      try { return await waitForNativeCompose(mode, beforeFingerprint, beforeHash, 9000); } catch (_) {}
    }

    let button = findNativeReadActionButton(mode);
    if (!button) {
      const opened = await chrome.runtime.sendMessage({ type:'NMDA_NATIVE_MESSAGE_OPEN', sourceMessageId:task.sourceMessageId }).catch(error => ({ok:false,reason:error?.message||String(error)}));
      if (!opened?.ok) throw new Error(`无法打开原始已发送邮件：${opened?.reason || started?.reason || 'native-route-failed'}`);
      button = await waitFor(() => findNativeReadActionButton(mode), 9000, 120, `已打开原邮件，但没有找到网易“${mode === 'forward' ? '转发' : '回复'}”按钮。`);
    }
    button.click();
    return waitForNativeCompose(mode, beforeFingerprint, beforeHash, 10000);
  }

  async function executeFollowUp(message) {
    const executionId = String(message.executionId || '');
    const task = message.task || {};
    const mode = task.mode === 'reply' ? 'reply' : 'forward';
    if (!String(task.sourceMessageId || '').trim()) throw new Error('Follow-up 缺少原邮件 ID。');

    reportProgress(executionId, 'open', `正在调用网易原生“${mode === 'forward' ? '转发' : '回复'}”…`);
    const root = await openNativeFollowUpCompose(task, mode);
    const detected = detectNativeComposeMode(root);
    if (detected.mode !== mode) throw new Error(`打开的 Compose 类型不匹配：预期 ${mode}，实际 ${detected.mode || 'unknown'}。`);

    reportProgress(executionId, 'verify-source', '正在核验原邮件、原文与附件继承…');
    const sourceIntegrity = await waitNativeSourceIntegrity(root, task, mode);
    const attachmentIntegrity = await waitNativeAttachmentIntegrity(root, task, mode);

    reportProgress(executionId, 'content', '正在填写 Follow-up 收件人、主题和正文…');
    const recipientIntegrity = await ensureNativeRecipients(root, task.recipients || '', mode);
    await setSubject(root, task.subject || '');
    const subjectInput = await waitFor(() => findSubjectInput(root), 3000, 100, '未找到主题输入框。');
    if (String(subjectInput.value || '').trim() !== String(task.subject || '').trim()) throw new Error('Follow-up 主题写入后核验失败。');
    const introIntegrity = await setNativeFollowUpIntro(root, task.introText || '', mode, task);

    // Re-check every business-critical field immediately before the transaction boundary.
    const finalMode = detectNativeComposeMode(root);
    if (finalMode.mode !== mode) throw new Error('保存前 Compose 类型发生变化，已停止。');
    const finalRecipients = recipientEvidenceEmails(root);
    const expectedRecipients = recipientIntegrity.expected || [];
    if (!expectedRecipients.every(email => finalRecipients.includes(email))) throw new Error('保存前收件人完整性核验失败。');
    if (String(findSubjectInput(root)?.value || '').trim() !== String(task.subject || '').trim()) throw new Error('保存前主题完整性核验失败。');
    await waitNativeSourceIntegrity(root, task, mode);
    await waitNativeAttachmentIntegrity(root, task, mode);

    reportProgress(executionId, 'save', '内容完整性核验通过，正在保存草稿…');
    const saveOutcome = await saveDraft(root, { scheduled:false });
    const nativeVerification = {
      mode,
      modeEvidence:finalMode.evidence,
      recipientCount:expectedRecipients.length,
      recipientsVerified:true,
      subjectVerified:true,
      introVerified:true,
      sourceVerified:!!sourceIntegrity.sourceMatched,
      sourceMarker:sourceIntegrity.markerId,
      sourceBodyAnchorsExpected:Number(sourceIntegrity.anchorsExpected || 0),
      sourceBodyAnchorsMatched:Number(sourceIntegrity.anchorsMatched || 0),
      sourceMetadataChecked:sourceIntegrity.metadataChecked || [],
      sourceMetadataVerified:sourceIntegrity.metadataVerified === true,
      sourcePlainTextFallback:sourceIntegrity.plainTextFallback === true,
      attachmentsExpected:Number(attachmentIntegrity.expected || 0),
      attachmentsMatched:Number(attachmentIntegrity.matched || 0),
      attachmentInventoryKnown:attachmentIntegrity.inventoryKnown === true,
      attachmentPolicy:attachmentIntegrity.policy || '',
      saveEvidence:saveOutcome.evidence || ''
    };
    reportProgress(executionId, 'done', '原生 Follow-up 已完成完整性核验并保存。', nativeVerification);
    return { ok:true, outcome:{ saveOutcome, nativeVerification, attachment:{verified:true,mode:'native-inherited',missingNames:[]} } };
  }

  function findComposeOption(root, label) {
    const target = compactText(label);
    return [...root.querySelectorAll('[role="checkbox"],.nui-chk')]
      .filter(visible)
      .find(el => compactText(el).includes(target) || compactText(el.getAttribute('aria-label') || '').includes(target) || compactText(el.getAttribute('title') || '').includes(target)) || null;
  }

  async function ensureMoreOptions(root) {
    const existing = findComposeLink(root, '更多选项');
    if (existing) {
      existing.click();
      await sleep(150);
    }
  }

  async function enableComposeOption(root, label, enabled) {
    if (!enabled) return;
    let option = findComposeOption(root, label);
    if (!option) {
      await ensureMoreOptions(root);
      option = await waitFor(() => findComposeOption(root, label), 3000, 100, `原草稿启用了“${label}”，但当前页面无法定位该选项。`);
    }
    const checked = option.getAttribute('aria-checked') === 'true'
      || option.classList.contains('nui-chk-checked')
      || !!option.querySelector('.nui-ico-checkbox-checked,.nui-ico-checkbox-checked2');
    if (!checked) {
      option.click();
      await sleep(120);
    }
  }

  function findAttachmentInput(root) {
    return root.querySelector('div[id$="_attachBrowser"] > input[type="file"]')
      || [...root.querySelectorAll('input[type="file"]')].find(el => el.closest('[id$="_attachBrowser"]'))
      || root.querySelector('input[type="file"]') || null;
  }

  function uniqueFiles(files) {
    const map = new Map();
    for (const file of files || []) {
      if (!file) continue;
      const key = Importer?.fileIdentity?.(file) || `${file.name}|${file.size}|${file.lastModified}`;
      if (!map.has(key)) map.set(key, file);
    }
    return [...map.values()];
  }

  function attachmentEvidenceText(root) {
    const parts = [];
    const nodes = root.querySelectorAll('a,span,div,li,p,[title],[aria-label]');
    for (const el of nodes) {
      if (el.matches?.('input[type="file"], [id$="_attachBrowser"]')) continue;
      const value = compactText(`${textOf(el)} ${el.getAttribute?.('title') || ''} ${el.getAttribute?.('aria-label') || ''}`).toLowerCase();
      if (value) parts.push(value);
    }
    return parts.join('\n');
  }

  function attachmentNameVisible(root, fileName, evidenceText = '') {
    const wanted = compactText(fileName).toLowerCase();
    if (!wanted) return false;
    const evidence = evidenceText || attachmentEvidenceText(root);
    return evidence.includes(wanted);
  }

  async function waitAttachmentEvidence(root, files, timeout = 9000) {
    const start = Date.now();
    let missing = [...files];
    while (Date.now() - start < timeout) {
      const evidence = attachmentEvidenceText(root);
      missing = files.filter(file => !attachmentNameVisible(root, file.name, evidence));
      if (!missing.length) return { verified: true, missing: [] };
      await sleep(250);
    }
    return { verified: false, missing };
  }

  async function injectFilesIntoInput(input, files) {
    const dt = new DataTransfer();
    files.forEach(file => dt.items.add(file));
    try { input.files = dt.files; }
    catch (error) { throw new Error(`无法把附件交给网易上传控件：${error.message}`); }
    fire(input, 'input');
    fire(input, 'change');
  }

  async function addAttachments(root, files, onProgress = () => {}) {
    const selected = uniqueFiles(files);
    if (!selected.length) return { verified: true, missing: [], mode: 'none' };
    let input = await waitFor(() => findAttachmentInput(root), 8000, 120, '未找到网易邮箱附件控件。');

    // 优先模拟用户在文件选择器中一次多选：速度更快，也更贴近真实上传。
    if (input.multiple || selected.length === 1) {
      await injectFilesIntoInput(input, selected);
      onProgress(selected.length, selected.length, selected.map(file => file.name).join('、'));
      await sleep(450);
      const evidence = await waitAttachmentEvidence(root, selected);
      return { ...evidence, mode: 'multi' };
    }

    // 如果网易当前实例的 input 没有 multiple，则逐个交给控件；每次重新寻找 input，
    // 因为网易可能在一次上传后替换该 DOM 节点。
    for (let i = 0; i < selected.length; i++) {
      input = await waitFor(() => findAttachmentInput(root), 8000, 120, '附件上传过程中网易附件控件消失。');
      await injectFilesIntoInput(input, [selected[i]]);
      onProgress(i + 1, selected.length, selected[i].name);
      await sleep(550);
    }
    const evidence = await waitAttachmentEvidence(root, selected);
    return { ...evidence, mode: 'sequential' };
  }

  function findMoreSendOptions(root) {
    return [...root.querySelectorAll('a,[role="link"],button,[role="button"]')].filter(visible).find(el => hasUiText(el, '更多发送选项')) || null;
  }

  function findScheduleCheckbox(root) {
    const aria = [...root.querySelectorAll('[role="checkbox"]')].find(el => visible(el) && (
      compactText(el.getAttribute('aria-label') || '').includes('定时发送') || hasUiText(el, '定时发送')
    ));
    if (aria) return aria;
    const text = [...root.querySelectorAll('a,button,div,span,label')].filter(visible).find(el => hasUiText(el, '定时发送'));
    return text ? text.closest('[role="checkbox"]') || text : null;
  }

  function scheduleFields(root) {
    return {
      year: root.querySelector('select[id$="_scheduleYear"]'), month: root.querySelector('select[id$="_scheduleMonth"]'),
      day: root.querySelector('select[id$="_scheduleDay"]'), hour: root.querySelector('select[id$="_scheduleHour"]'),
      minute: root.querySelector('select[id$="_scheduleMinute"]')
    };
  }

  function allScheduleFieldsVisible(root) {
    return Object.values(scheduleFields(root)).every(el => el && visible(el));
  }

  async function ensureScheduleEnabled(root) {
    if (allScheduleFieldsVisible(root)) return;
    const more = findMoreSendOptions(root);
    if (more) { more.click(); await sleep(220); }
    let checkbox = findScheduleCheckbox(root);
    if (!checkbox) checkbox = await waitFor(() => findScheduleCheckbox(root), 3000, 120, '未找到“定时发送”选项。');
    if (!allScheduleFieldsVisible(root)) {
      checkbox.click();
      try { await waitFor(() => allScheduleFieldsVisible(root), 2500, 120, ''); }
      catch (_) {
        checkbox.click();
        await waitFor(() => allScheduleFieldsVisible(root), 3500, 120, '启用定时发送后没有出现日期时间控件。');
      }
    }
  }

  function setSelectValue(select, desired) {
    if (!select) throw new Error('定时发送下拉框不存在。');
    const values = [...select.options].map(o => o.value);
    let value = String(desired);
    if (!values.includes(value)) {
      const numeric = values.map(v => ({ v, n: Number(v) })).filter(x => Number.isFinite(x.n));
      if (!numeric.length) throw new Error(`下拉框不存在可用值：${desired}`);
      numeric.sort((a, b) => Math.abs(a.n - Number(desired)) - Math.abs(b.n - Number(desired)));
      value = numeric[0].v;
    }
    nativeSetValue(select, value); fire(select, 'input'); fire(select, 'change');
    return value;
  }

  async function setSchedule(root, datetimeLocal) {
    if (!datetimeLocal) throw new Error('已启用定时发送，但没有填写定时时间。');
    const date = new Date(datetimeLocal);
    if (Number.isNaN(date.getTime())) throw new Error('定时时间格式无效。');
    await ensureScheduleEnabled(root);
    const fields = scheduleFields(root);
    setSelectValue(fields.year, date.getFullYear());
    setSelectValue(fields.month, date.getMonth() + 1);
    setSelectValue(fields.day, date.getDate());
    setSelectValue(fields.hour, date.getHours());
    const actualMinute = setSelectValue(fields.minute, date.getMinutes());
    await sleep(180);
    return actualMinute;
  }

  function findSaveDraftButton(root) {
    // NetEase renders the visible label as <span class="nui-btn-text">存草稿</span>
    // inside a generated <div role="button" id="_mail_button_...">.  The generated
    // id is unstable, and in some Compose layouts the top toolbar is outside the
    // content root returned by findComposeRoot().  Resolve the semantic leaf first
    // and climb to the actual clickable button; search the current Compose scope
    // first, then fall back to the document.
    const scopes = [];
    if (root?.querySelectorAll) scopes.push(root);
    if (root !== document) scopes.push(document);

    for (const scope of scopes) {
      // Strongest evidence: NetEase's own button text span.
      const label = [...scope.querySelectorAll('span.nui-btn-text, [role="button"] span, button span')]
        .filter(visible)
        .find(el => compactText(el) === '存草稿');
      if (label) {
        const button = label.closest('[role="button"],button');
        if (button && visible(button)) return button;
      }

      // Accessibility/text fallback for variants that expose the label on the button.
      const button = [...scope.querySelectorAll('[role="button"],button')]
        .filter(visible)
        .find(el => {
          const aria = compactText(el.getAttribute('aria-label') || '');
          const title = compactText(el.getAttribute('title') || '');
          const ownLabel = [...el.querySelectorAll('span')].some(span => visible(span) && compactText(span) === '存草稿');
          return aria === '存草稿' || title === '存草稿' || ownLabel || compactText(el) === '存草稿';
        });
      if (button) return button;
    }
    return null;
  }

  function isDraftRoute() {
    try { return decodeURIComponent(location.hash || '').includes('"type":"draft"'); }
    catch (_) { return false; }
  }

  function regularDraftSuccessSignals() {
    // Normal drafts stay on the Compose page. NetEase confirms the save with a
    // transient green success tip such as “邮件已于13:23成功保存到草稿箱”.
    // Only visible success/tip nodes count; hidden historical tips remain in the DOM.
    const selectors = [
      '.nui-tips-suc',
      '.nui-frameTips.nui-tips-suc',
      '[aria-live="polite"]',
      '[role="status"]'
    ].join(',');
    return [...document.querySelectorAll(selectors)]
      .filter(visible)
      .filter(el => {
        const text = compactText(el);
        return text.includes('草稿箱') && (
          text.includes('成功保存') ||
          text.includes('已保存') ||
          text.includes('保存成功')
        );
      });
  }

  function draftSignalFingerprint(el) {
    if (!el) return '';
    return `${el.id || ''}|${compactText(el)}`;
  }

  function captureDraftSaveBaseline() {
    return {
      routeWasDraft: isDraftRoute(),
      regularSignals: new Set(regularDraftSuccessSignals().map(draftSignalFingerprint)),
      timedSuccessVisible: isTimedDraftSuccessVisible()
    };
  }

  function isTimedDraftSuccessVisible(deep = false) {
    // Prefer semantic/result-like nodes. A broad div scan is retained only as a
    // throttled compatibility fallback while waiting for NetEase's result page.
    const selector = deep
      ? 'h1,h2,h3,section,div,[role="main"],[role="status"]'
      : 'h1,h2,h3,[role="main"],[role="status"],.nui-tips-suc,[class*="success"],[class*="result"]';
    const candidates = [...document.querySelectorAll(selector)].filter(visible);
    return candidates.some(el => compactText(el).includes('定时发信设置成功'));
  }

  function findFreshRegularDraftSuccess(baseline) {
    const before = baseline?.regularSignals || new Set();
    return regularDraftSuccessSignals().find(el => !before.has(draftSignalFingerprint(el))) || null;
  }

  async function waitForDraftSaveOutcome({ scheduled, baseline }) {
    if (scheduled) {
      const start = Date.now();
      let poll = 0;
      while (Date.now() - start < 9000) {
        // Deep compatibility scans are much more expensive on NetEase's large DOM;
        // run them roughly once per 800 ms instead of every 100 ms.
        const deep = poll % 8 === 7;
        if (!baseline?.timedSuccessVisible && isTimedDraftSuccessVisible(deep)) {
          return { kind: 'scheduled-result', evidence: '定时发信设置成功' };
        }
        poll++;
        await sleep(100);
      }
      throw new Error('已点击“存草稿”，但未检测到“定时发信设置成功”，已停止，避免继续写下一封。');
    }

    return waitFor(() => {
      const tip = findFreshRegularDraftSuccess(baseline);
      if (tip) return { kind: 'regular-tip', evidence: textOf(tip) };
      if (!baseline?.routeWasDraft && isDraftRoute()) {
        return { kind: 'draft-route', evidence: 'Compose 路由进入 draft' };
      }
      return null;
    }, 7000, 100, '已点击“存草稿”，但未检测到网易“成功保存到草稿箱”的新提示，已停止，避免继续写下一封。');
  }

  async function saveDraft(root, options = {}) {
    // “存草稿” is a hard transaction boundary, but NetEase has TWO success
    // state machines:
    //   normal draft    -> editor remains open + transient success tip
    //   scheduled draft -> dedicated “定时发信设置成功” result page
    // Never infer success solely from navigation. Require fresh business evidence
    // produced after this click before the next batch task is allowed to start.
    const scheduled = !!options.scheduled;
    const button = await waitFor(() => findSaveDraftButton(root), 5000, 120, '未找到“存草稿”按钮，已停止，避免草稿未保存。');
    const baseline = captureDraftSaveBaseline();
    button.click();
    const outcome = await waitForDraftSaveOutcome({ scheduled, baseline });
    await sleep(scheduled ? 350 : 250);
    return outcome;
  }



  function bytesFromBase64(value) {
    const binary = atob(String(value || ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function readVaultFile(ref) {
    const id = String(ref?.id || '');
    if (!id) throw new Error('附件临时引用缺少 id。');
    const meta = await chrome.runtime.sendMessage({ type: 'NMDA_VAULT_META', id });
    if (!meta?.ok) throw new Error(`无法读取附件 ${ref?.name || id}：${meta?.reason || '临时文件不存在'}`);
    const chunkSize = 256 * 1024;
    const parts = [];
    for (let offset = 0; offset < meta.size; offset += chunkSize) {
      const chunk = await chrome.runtime.sendMessage({ type: 'NMDA_VAULT_CHUNK', id, offset, length: Math.min(chunkSize, meta.size - offset) });
      if (!chunk?.ok) throw new Error(`读取附件 ${meta.name} 失败：${chunk?.reason || 'chunk-error'}`);
      parts.push(bytesFromBase64(chunk.base64));
    }
    return new File(parts, meta.name, { type: meta.type || 'application/octet-stream', lastModified: meta.lastModified || Date.now() });
  }

  function reportProgress(executionId, phase, message, detail = {}) {
    chrome.runtime.sendMessage({
      type: 'NMDA_EXECUTION_PROGRESS', executionId: String(executionId || ''), phase,
      message: String(message || ''), detail
    }).catch(() => {});
  }

  async function executeDraft(message) {
    const executionId = String(message.executionId || '');
    const task = message.task || {};
    const fresh = message.fresh !== false;
    reportProgress(executionId, 'open', '正在打开新的写信页…');
    const root = fresh ? await openFreshCompose() : await openCompose();

    reportProgress(executionId, 'content', '正在填写收件人、主题和正文…');
    await setRecipients(root, task.recipients || '');
    await setAuxRecipients(root, task.cc || '', '抄送');
    await setAuxRecipients(root, task.bcc || '', '密送');
    await setSubject(root, task.subject || '');
    await setBody(root, task.body || '', task.bodyHtml || '', !!task.bodyIsHtml);
    if (Number(task.priority || 0) === 1) await enableComposeOption(root, '紧急', true);
    if (task.requestReadReceipt) await enableComposeOption(root, '已读回执', true);

    let attachmentResult = { verified: true, missing: [], mode: 'none' };
    const refs = Array.isArray(task.attachments) ? task.attachments : [];
    if (refs.length) {
      reportProgress(executionId, 'attachments', `正在准备 ${refs.length} 个附件…`);
      const files = [];
      for (let i = 0; i < refs.length; i++) {
        files.push(await readVaultFile(refs[i]));
        reportProgress(executionId, 'attachments', `正在读取附件 ${i + 1}/${refs.length} · ${refs[i]?.name || ''}`);
      }
      attachmentResult = await addAttachments(root, files, (done, total, name) => {
        reportProgress(executionId, 'attachments', `正在上传附件 ${done}/${total} · ${name}`, { done, total, name });
      });
    } else {
      reportProgress(executionId, 'attachments', '没有附件，跳过附件步骤。');
    }

    let actualMinute = null;
    if (task.scheduleAt) {
      reportProgress(executionId, 'schedule', `正在设置定时 ${String(task.scheduleAt).replace('T', ' ')}…`);
      actualMinute = await setSchedule(root, task.scheduleAt);
    } else {
      reportProgress(executionId, 'schedule', '未设置定时，将保存普通草稿。');
    }

    reportProgress(executionId, 'save', `正在点击“存草稿”并确认${task.scheduleAt ? '定时设置' : '草稿保存'}…`);
    const saveOutcome = await saveDraft(root, { scheduled: !!task.scheduleAt });
    const missingNames = (attachmentResult.missing || []).map(file => file?.name || '').filter(Boolean);
    reportProgress(executionId, 'done', '草稿已确认保存。', { evidence: saveOutcome.evidence || '' });
    return {
      ok: true,
      outcome: {
        saveOutcome,
        actualMinute,
        attachment: { verified: !!attachmentResult.verified, mode: attachmentResult.mode || 'none', missingNames }
      }
    };
  }


  const batchMonitorState={total:0,current:0,succeeded:0,failed:0,remaining:0,status:'idle',task:null,message:'',items:[],events:[]};

  function ensureBatchMonitor(){
    let root=document.getElementById('nmda-mail-batch-monitor');
    if(root)return root;
    const style=document.createElement('style');style.id='nmda-mail-batch-monitor-style';style.textContent=`
      #nmda-mail-batch-monitor{position:fixed;right:18px;top:68px;z-index:2147483646;width:min(360px,calc(100vw - 28px));font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#1f2937;background:#fff;border:1px solid #d7dee7;border-radius:14px;box-shadow:0 18px 50px rgba(15,23,42,.18);overflow:hidden;isolation:isolate}
      #nmda-mail-batch-monitor *{box-sizing:border-box}
      #nmda-mail-batch-monitor[data-minimized="1"] .nmda-mbm-body,#nmda-mail-batch-monitor[data-minimized="1"] .nmda-mbm-foot{display:none}
      .nmda-mbm-head{display:grid;grid-template-columns:34px minmax(0,1fr) auto;gap:10px;align-items:center;padding:12px 13px 9px;background:linear-gradient(180deg,#fbfdff,#f7faff);border-bottom:1px solid #e8edf3}
      .nmda-mbm-logo{display:grid;place-items:center;width:34px;height:34px;border-radius:10px;background:#1264d7;color:#fff;font-weight:800;box-shadow:inset 0 -1px 0 rgba(0,0,0,.1)}
      .nmda-mbm-title{min-width:0}.nmda-mbm-title strong{display:block;font-size:13px;font-weight:800;color:#182230}.nmda-mbm-title small{display:block;margin-top:2px;color:#748092;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .nmda-mbm-min{border:0;background:transparent;color:#697586;font-size:18px;line-height:1;width:30px;height:30px;border-radius:8px;cursor:pointer}.nmda-mbm-min:hover{background:#edf2f7}
      .nmda-mbm-progress{height:4px;background:#e9eef5;overflow:hidden}.nmda-mbm-progress>i{display:block;height:100%;width:0;background:#1264d7;transition:width .25s ease}
      #nmda-mail-batch-monitor[data-state="done"] .nmda-mbm-progress>i{background:#16803c}#nmda-mail-batch-monitor[data-state="error"] .nmda-mbm-progress>i{background:#c2410c}#nmda-mail-batch-monitor[data-state="stopped"] .nmda-mbm-progress>i{background:#9a6700}
      .nmda-mbm-body{padding:12px 13px;display:grid;gap:10px}.nmda-mbm-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}.nmda-mbm-stat{padding:7px 8px;border:1px solid #e4e9ef;border-radius:9px;background:#fbfcfe}.nmda-mbm-stat span{display:block;color:#7a8796;font-size:10px}.nmda-mbm-stat strong{display:block;margin-top:1px;font-size:14px;font-weight:800;color:#253044}
      .nmda-mbm-current{padding:10px;border:1px solid #d9e5f5;border-radius:10px;background:#f6f9fe}.nmda-mbm-current-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px}.nmda-mbm-current-head span{font-size:10px;font-weight:800;color:#1264d7}.nmda-mbm-current-head b{font-size:10px;font-weight:700;color:#708090}.nmda-mbm-recipient,.nmda-mbm-subject{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.nmda-mbm-recipient{font-size:12px;font-weight:750;color:#1f2937}.nmda-mbm-subject{margin-top:2px;color:#697586;font-size:11px}.nmda-mbm-message{margin-top:7px;padding-top:7px;border-top:1px dashed #cfdaea;color:#4b5d73;font-size:11px}
      .nmda-mbm-events{display:grid;gap:5px;max-height:142px;overflow:auto}.nmda-mbm-event{display:grid;grid-template-columns:15px minmax(0,1fr);gap:7px;align-items:start;color:#5d6b7a;font-size:10.5px}.nmda-mbm-event i{width:7px;height:7px;margin:4px 0 0 3px;border-radius:50%;background:#94a3b8;box-shadow:0 0 0 3px #f1f5f9}.nmda-mbm-event[data-kind="done"] i{background:#16a34a;box-shadow:0 0 0 3px #dcfce7}.nmda-mbm-event[data-kind="error"] i{background:#dc2626;box-shadow:0 0 0 3px #fee2e2}.nmda-mbm-event[data-kind="running"] i{background:#2563eb;box-shadow:0 0 0 3px #dbeafe}.nmda-mbm-event strong{font-weight:750;color:#344054}.nmda-mbm-event small{display:block;color:#7b8794;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .nmda-mbm-foot{display:flex;justify-content:flex-end;gap:7px;padding:9px 13px 11px;border-top:1px solid #edf0f3;background:#fbfcfd}.nmda-mbm-btn{min-height:30px;padding:0 10px;border:1px solid #d4dae2;border-radius:8px;background:#fff;color:#435266;font:inherit;font-size:11px;font-weight:700;cursor:pointer}.nmda-mbm-btn:hover{background:#f5f7fa}.nmda-mbm-btn[data-role="stop"]{color:#9a3412;border-color:#fed7aa;background:#fffaf5}.nmda-mbm-btn[data-role="workspace"]{color:#fff;background:#1264d7;border-color:#1264d7}.nmda-mbm-btn[hidden]{display:none}
      @media(max-width:760px){#nmda-mail-batch-monitor{right:8px;top:54px;width:calc(100vw - 16px)}}
    `;document.documentElement.appendChild(style);
    root=document.createElement('section');root.id='nmda-mail-batch-monitor';root.dataset.state='running';root.innerHTML=`<header class="nmda-mbm-head"><span class="nmda-mbm-logo">N</span><div class="nmda-mbm-title"><strong>批量草稿正在执行</strong><small>工作台已交接到网易邮箱</small></div><button class="nmda-mbm-min" type="button" title="收起">−</button></header><div class="nmda-mbm-progress"><i></i></div><div class="nmda-mbm-body"><div class="nmda-mbm-stats"><div class="nmda-mbm-stat"><span>进度</span><strong data-stat="progress">0 / 0</strong></div><div class="nmda-mbm-stat"><span>已完成</span><strong data-stat="done">0</strong></div><div class="nmda-mbm-stat"><span>剩余</span><strong data-stat="remaining">0</strong></div></div><div class="nmda-mbm-current"><div class="nmda-mbm-current-head"><span>当前任务</span><b data-current-index>—</b></div><div class="nmda-mbm-recipient" data-current-recipient>等待开始…</div><div class="nmda-mbm-subject" data-current-subject></div><div class="nmda-mbm-message" data-current-message>正在准备执行队列。</div></div><div class="nmda-mbm-events" data-events></div></div><footer class="nmda-mbm-foot"><button class="nmda-mbm-btn" data-role="stop" type="button">当前封后停止</button><button class="nmda-mbm-btn" data-role="workspace" type="button" hidden>返回工作台</button></footer>`;
    document.body.appendChild(root);
    root.querySelector('.nmda-mbm-min')?.addEventListener('click',()=>{root.dataset.minimized=root.dataset.minimized==='1'?'0':'1';root.querySelector('.nmda-mbm-min').textContent=root.dataset.minimized==='1'?'+':'−';});
    root.querySelector('[data-role="stop"]')?.addEventListener('click',async event=>{event.currentTarget.disabled=true;event.currentTarget.textContent='已请求停止';await chrome.runtime.sendMessage({type:'NMDA_BATCH_STOP_REQUEST'}).catch(()=>{});});
    root.querySelector('[data-role="workspace"]')?.addEventListener('click',()=>chrome.runtime.sendMessage({type:'NMDA_OPEN_APP'}).catch(()=>{}));
    return root;
  }

  function batchMonitorEvent(kind,title,detail=''){
    batchMonitorState.events.unshift({kind,title,detail,time:Date.now()});
    batchMonitorState.events=batchMonitorState.events.slice(0,6);
  }

  function renderBatchMonitor(){
    const root=ensureBatchMonitor(),state=batchMonitorState;
    root.dataset.state=state.status||'running';
    const finished=state.status==='done'||state.status==='error'||state.status==='stopped';
    const doneCount=Math.max(0,Number(state.succeeded||0)+Number(state.failed||0));
    const pct=state.total?Math.min(100,Math.max(0,(doneCount/Number(state.total))*100)):0;
    root.querySelector('.nmda-mbm-progress>i').style.width=`${finished&&state.status==='done'?100:pct}%`;
    root.querySelector('[data-stat="progress"]').textContent=`${Math.min(doneCount,Number(state.total||0))} / ${Number(state.total||0)}`;
    root.querySelector('[data-stat="done"]').textContent=String(Number(state.succeeded||0));
    root.querySelector('[data-stat="remaining"]').textContent=String(Math.max(0,Number(state.remaining||0)));
    const title=root.querySelector('.nmda-mbm-title strong'),subtitle=root.querySelector('.nmda-mbm-title small');
    if(finished){title.textContent=state.status==='done'?'批量草稿已完成':state.status==='error'?'批量执行已停止':'批量执行已停止';subtitle.textContent=state.message||`成功 ${state.succeeded} · 失败 ${state.failed}`;}else{title.textContent='批量草稿正在执行';subtitle.textContent=`正在网易邮箱处理 ${Number(state.current||0)}/${Number(state.total||0)}`;}
    root.querySelector('[data-current-index]').textContent=state.current&&state.total?`${state.current} / ${state.total}`:'—';
    root.querySelector('[data-current-recipient]').textContent=state.task?.recipient|| (finished?'本批次执行结束':'等待下一封邮件');
    root.querySelector('[data-current-subject]').textContent=state.task?.subject||'';
    root.querySelector('[data-current-message]').textContent=state.message|| (finished?'可以返回工作台查看批次状态。':'正在准备执行队列。');
    const events=root.querySelector('[data-events]');events.innerHTML='';
    for(const item of state.events){const row=document.createElement('div');row.className='nmda-mbm-event';row.dataset.kind=item.kind||'';const dot=document.createElement('i');const copy=document.createElement('div');const strong=document.createElement('strong');strong.textContent=item.title||'';const small=document.createElement('small');small.textContent=item.detail||'';copy.append(strong,small);row.append(dot,copy);events.appendChild(row);}
    const stop=root.querySelector('[data-role="stop"]'),workspace=root.querySelector('[data-role="workspace"]');if(stop)stop.hidden=finished;if(workspace)workspace.hidden=!finished;
  }

  function updateBatchMonitor(payload={}){
    const action=String(payload.action||'');
    if(action==='start'){
      Object.assign(batchMonitorState,{total:Number(payload.total||0),current:0,succeeded:0,failed:0,remaining:Number(payload.remaining??payload.total??0),status:'running',task:null,message:'正在准备第一封邮件。',items:Array.isArray(payload.items)?payload.items:[],events:[]});
      batchMonitorEvent('running','执行已开始',`共 ${batchMonitorState.total} 封邮件`);
    }else if(action==='task-start'){
      Object.assign(batchMonitorState,{current:Number(payload.current||0),total:Number(payload.total||batchMonitorState.total),succeeded:Number(payload.succeeded||0),failed:Number(payload.failed||0),remaining:Number(payload.remaining??batchMonitorState.remaining),status:'running',task:payload.task||null,message:'正在打开写信页…'});
      batchMonitorEvent('running',`开始 ${payload.task?.id||`第 ${payload.current} 封`}`,payload.task?.subject||payload.task?.recipient||'');
    }else if(action==='task-progress'){
      Object.assign(batchMonitorState,{current:Number(payload.current||batchMonitorState.current),total:Number(payload.total||batchMonitorState.total),succeeded:Number(payload.succeeded??batchMonitorState.succeeded),failed:Number(payload.failed??batchMonitorState.failed),remaining:Number(payload.remaining??batchMonitorState.remaining),task:payload.task||batchMonitorState.task,message:String(payload.message||'正在处理…')});
    }else if(action==='task-done'){
      Object.assign(batchMonitorState,{current:Number(payload.current||batchMonitorState.current),succeeded:Number(payload.succeeded||batchMonitorState.succeeded),failed:Number(payload.failed||batchMonitorState.failed),remaining:Number(payload.remaining??batchMonitorState.remaining),task:payload.task||batchMonitorState.task,message:String(payload.message||'草稿已保存')});
      batchMonitorEvent('done',`${payload.task?.id||'当前邮件'} 已完成`,payload.task?.subject||payload.task?.recipient||'');
    }else if(action==='task-error'){
      Object.assign(batchMonitorState,{current:Number(payload.current||batchMonitorState.current),succeeded:Number(payload.succeeded||batchMonitorState.succeeded),failed:Number(payload.failed||batchMonitorState.failed),remaining:Number(payload.remaining??batchMonitorState.remaining),task:payload.task||batchMonitorState.task,message:String(payload.message||'执行失败'),status:'error'});
      batchMonitorEvent('error',`${payload.task?.id||'当前邮件'} 执行失败`,payload.message||'');
    }else if(action==='finish'){
      Object.assign(batchMonitorState,{total:Number(payload.total||batchMonitorState.total),succeeded:Number(payload.succeeded||0),failed:Number(payload.failed||0),remaining:Number(payload.remaining||0),status:String(payload.status||'done'),message:String(payload.message||'执行结束')});
      batchMonitorEvent(batchMonitorState.status==='done'?'done':'error',batchMonitorState.status==='done'?'全部完成':'执行结束',batchMonitorState.message);
    }
    renderBatchMonitor();
    return {ok:true};
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'NMDA_PING') {
      sendResponse({ ok: true, role: 'netease-mail-executor', composeOpen: !!findComposeRoot() });
      return;
    }
    if (message?.type === 'NMDA_BATCH_MONITOR') {
      try { sendResponse(updateBatchMonitor(message.payload||{})); } catch (error) { sendResponse({ok:false,reason:error?.message||String(error)}); }
      return;
    }
    if (message?.type === 'NMDA_EXECUTE_FOLLOWUP') {
      executeFollowUp(message).then(sendResponse).catch(error => {
        console.error(`[${APP}] native follow-up execution`, error);
        reportProgress(message?.executionId, 'error', error?.message || String(error));
        sendResponse({ ok:false, reason:error?.message || String(error) });
      });
      return true;
    }
    if (message?.type === 'NMDA_EXECUTE_DRAFT') {
      executeDraft(message).then(sendResponse).catch(error => {
        console.error(`[${APP}] remote execution`, error);
        reportProgress(message?.executionId, 'error', error?.message || String(error));
        sendResponse({ ok: false, reason: error?.message || String(error) });
      });
      return true;
    }
    if (message?.type === 'NMDA_LEGACY_PREFS') {
      try {
        sendResponse({ ok: true, scheduleRules: localStorage.getItem('nmda.schedule.rules.v1') || '' });
      } catch (error) {
        sendResponse({ ok: false, reason: error?.message || String(error) });
      }
    }
  });

})();
