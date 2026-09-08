(() => {
  'use strict';

  const STORAGE_PREFIX = 'nmda.contacts.v1:'; // keep the old key so v0.6 data migrates in place
  const SYNC_META_PREFIX = 'nmda.mailboxSync.v2:';
  const STAGE_OPTIONS = ['未联系', '已发送', '已回复'];
  const POLICY_OPTIONS = ['正常', '暂停', '不再联系'];
  const STATUS_OPTIONS = ['未联系', '已发送', '已回复', '待跟进', '暂停', '不再联系']; // compatibility
  const SYSTEM_CLASSIFICATIONS = new Set([...STAGE_OPTIONS, '待跟进', ...POLICY_OPTIONS, '有草稿']);

  function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
  }

  function normalizeTag(value) {
    return String(value ?? '').trim().replace(/\s+/g, ' ');
  }

  function parseTags(value) {
    const raw = Array.isArray(value) ? value : String(value ?? '').split(/[;,，；|\n]+/);
    const seen = new Set();
    const tags = [];
    for (const item of raw) {
      const tag = normalizeTag(item);
      if (!tag) continue;
      const key = tag.toLocaleLowerCase('zh-CN');
      if (seen.has(key)) continue;
      seen.add(key);
      tags.push(tag);
    }
    return tags;
  }

  function parseContactTags(value) {
    return parseTags(value).filter(tag => !SYSTEM_CLASSIFICATIONS.has(tag));
  }

  function mergeTags(...values) {
    const seen = new Set();
    const tags = [];
    for (const value of values) {
      for (const tag of parseTags(value)) {
        const key = tag.toLocaleLowerCase('zh-CN');
        if (seen.has(key)) continue;
        seen.add(key);
        tags.push(tag);
      }
    }
    return tags;
  }

  function mergeContactTags(...values) {
    return parseContactTags(mergeTags(...values));
  }

  function parseRecipients(raw) {
    const text = String(raw || '');
    const results = [];
    const seen = new Set();
    const emailRegex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}(?![A-Z0-9.-])/ig;
    let match;
    while ((match = emailRegex.exec(text))) {
      const email = normalizeEmail(match[0]);
      if (!email || seen.has(email)) continue;
      seen.add(email);
      const left = text.slice(Math.max(0, match.index - 100), match.index);
      const nameMatch = left.match(/(?:^|[;,，；\n])\s*([^<;,，；\n]{1,60})\s*<?\s*$/);
      const name = (nameMatch?.[1] || '').trim().replace(/^['"]|['"]$/g, '');
      results.push({ email, name: name && !name.includes('@') ? name : '' });
    }
    return results;
  }

  function storageKey(account) {
    return `${STORAGE_PREFIX}${normalizeEmail(account) || 'default'}`;
  }

  function inferredStage(sentCount) {
    return Number(sentCount || 0) > 0 ? '已发送' : '未联系';
  }

  function legacyDimensions(status, sentCount) {
    const base = { stage: inferredStage(sentCount), policy: '正常', followUp: false };
    if (status === '未联系' || status === '已发送' || status === '已回复') base.stage = status;
    else if (status === '待跟进') base.followUp = true;
    else if (status === '暂停') base.policy = '暂停';
    else if (status === '不再联系') base.policy = '不再联系';
    return base;
  }

  function interactionState(contact = {}) {
    const human = Number(contact.humanReplyCount || 0) || (Array.isArray(contact.replyHistory) ? contact.replyHistory.filter(item => item && !item.autoReply).length : 0);
    if (human > 0) return '已回复';
    if (Number(contact.sentCount || 0) > 0 || contact.knownSentAt) return '已发送';
    return '未联系';
  }

  function normalizeContactShape(contact, email = '') {
    if (!contact || typeof contact !== 'object') contact = {};
    const legacy = legacyDimensions(contact.status, contact.sentCount);
    contact.email = normalizeEmail(contact.email || email);
    contact.stage = STAGE_OPTIONS.includes(contact.stage) ? contact.stage : legacy.stage;
    contact.stageSource = ['manual', 'mailbox', 'default'].includes(contact.stageSource)
      ? contact.stageSource
      : (contact.stageChangedAt ? 'manual' : (contact.stage === '已回复' ? 'manual' : (Number(contact.sentCount || 0) > 0 ? 'mailbox' : 'default')));
    contact.policy = POLICY_OPTIONS.includes(contact.policy) ? contact.policy : legacy.policy;
    contact.followUp = typeof contact.followUp === 'boolean' ? contact.followUp : legacy.followUp;
    contact.tags = parseContactTags(contact.tags || []);
    contact.sentCount = Number(contact.sentCount || 0);
    contact.sentMessageIds = Array.isArray(contact.sentMessageIds) ? contact.sentMessageIds : [];
    contact.history = Array.isArray(contact.history) ? contact.history : [];
    contact.draftCount = Number(contact.draftCount || 0);
    contact.draftMessageIds = Array.isArray(contact.draftMessageIds) ? contact.draftMessageIds : [];
    contact.draftHistory = Array.isArray(contact.draftHistory) ? contact.draftHistory : [];
    contact.lastDraftAt = contact.lastDraftAt || '';
    contact.lastDraftSubject = contact.lastDraftSubject || '';
    contact.replyCount = Number(contact.replyCount || 0);
    contact.humanReplyCount = Number(contact.humanReplyCount || 0);
    contact.autoReplyCount = Number(contact.autoReplyCount || 0);
    contact.replyMessageIds = Array.isArray(contact.replyMessageIds) ? contact.replyMessageIds : [];
    contact.replyHistory = Array.isArray(contact.replyHistory) ? contact.replyHistory : [];
    contact.lastReplyAt = contact.lastReplyAt || '';
    contact.lastReplySubject = contact.lastReplySubject || '';
    contact.lastAutoReplyAt = contact.lastAutoReplyAt || '';
    contact.lastAutoReplySubject = contact.lastAutoReplySubject || '';
    contact.followUpEvents = Array.isArray(contact.followUpEvents) ? contact.followUpEvents : [];
    contact.followUpCount = Number(contact.followUpCount || contact.followUpEvents.filter(item => item && item.status !== 'cancelled').length || 0);
    // v1.7+ durable send evidence is created only by an actual v1.7 reader observation.
    // Do not infer it from legacy counters: the purpose of a full rebuild is to be able
    // to correct stale/incorrect pre-v1.7 mailbox-derived data.
    contact.knownSentAt = contact.knownSentAt || '';
    contact.mailboxSnapshotAt = contact.mailboxSnapshotAt || '';
    // Interaction state is derived from mailbox evidence; legacy stage remains migration input only.
    contact.stage = interactionState(contact);
    contact.stageSource = contact.stage === '未联系' ? 'default' : 'mailbox';
    contact.status = contact.stage;
    return contact;
  }

  async function load(account) {
    const key = storageKey(account);
    const stored = (await chrome.storage.local.get(key))[key];
    if (!stored || typeof stored !== 'object') return {};
    for (const [email, contact] of Object.entries(stored)) stored[email] = normalizeContactShape(contact, email);
    return stored;
  }

  async function save(account, contacts) {
    const key = storageKey(account);
    const normalized = {};
    for (const [email, contact] of Object.entries(contacts || {})) normalized[normalizeEmail(email)] = normalizeContactShape(contact, email);
    await chrome.storage.local.set({ [key]: normalized });
  }

  function syncMetaKey(account) {
    return `${SYNC_META_PREFIX}${normalizeEmail(account) || 'default'}`;
  }

  async function loadSyncMeta(account) {
    const key = syncMetaKey(account);
    const stored = (await chrome.storage.local.get(key))[key];
    return stored && typeof stored === 'object' ? stored : {};
  }

  async function saveSyncMeta(account, meta) {
    const key = syncMetaKey(account);
    await chrome.storage.local.set({ [key]: { ...(meta || {}), account: normalizeEmail(account) || 'default' } });
  }

  function cloneContacts(contacts) {
    const cloned = {};
    for (const [email, contact] of Object.entries(contacts || {})) cloned[normalizeEmail(email)] = normalizeContactShape(JSON.parse(JSON.stringify(contact || {})), email);
    return cloned;
  }

  function ensureContact(contacts, email, patch = {}) {
    email = normalizeEmail(email);
    if (!email) return null;
    const now = new Date().toISOString();
    const prev = normalizeContactShape(contacts[email] || {}, email);
    const legacyPatch = patch.status ? legacyDimensions(patch.status, prev.sentCount) : {};
    const next = {
      name: patch.name || prev.name || '',
      stage: STAGE_OPTIONS.includes(patch.stage) ? patch.stage : (legacyPatch.stage || prev.stage || '未联系'),
      policy: POLICY_OPTIONS.includes(patch.policy) ? patch.policy : (legacyPatch.policy || prev.policy || '正常'),
      followUp: typeof patch.followUp === 'boolean' ? patch.followUp : (patch.status === '待跟进' ? true : !!prev.followUp),
      tags: patch.replaceTags ? parseContactTags(patch.tags || []) : mergeContactTags(prev.tags || [], patch.tags || []),
      sentCount: Number(prev.sentCount || 0),
      lastSentAt: prev.lastSentAt || '',
      lastSubject: prev.lastSubject || '',
      sentMessageIds: Array.isArray(prev.sentMessageIds) ? prev.sentMessageIds : [],
      history: Array.isArray(prev.history) ? prev.history : [],
      draftCount: Number(prev.draftCount || 0),
      lastDraftAt: prev.lastDraftAt || '',
      lastDraftSubject: prev.lastDraftSubject || '',
      draftMessageIds: Array.isArray(prev.draftMessageIds) ? prev.draftMessageIds : [],
      draftHistory: Array.isArray(prev.draftHistory) ? prev.draftHistory : [],
      replyCount: Number(prev.replyCount || 0),
      humanReplyCount: Number(prev.humanReplyCount || 0),
      autoReplyCount: Number(prev.autoReplyCount || 0),
      replyMessageIds: Array.isArray(prev.replyMessageIds) ? prev.replyMessageIds : [],
      replyHistory: Array.isArray(prev.replyHistory) ? prev.replyHistory : [],
      lastReplyAt: prev.lastReplyAt || '',
      lastReplySubject: prev.lastReplySubject || '',
      lastAutoReplyAt: prev.lastAutoReplyAt || '',
      lastAutoReplySubject: prev.lastAutoReplySubject || '',
      followUpEvents: Array.isArray(prev.followUpEvents) ? prev.followUpEvents : [],
      followUpCount: Number(prev.followUpCount || 0),
      createdAt: prev.createdAt || now,
      updatedAt: now,
      ...prev,
      ...patch,
      email
    };
    if (patch.status === '暂停' || patch.status === '不再联系') next.policy = patch.status;
    if (patch.status === '待跟进') next.followUp = true;
    if (STAGE_OPTIONS.includes(patch.status)) next.stage = patch.status;
    if (!STAGE_OPTIONS.includes(next.stage)) next.stage = inferredStage(next.sentCount);
    if (!POLICY_OPTIONS.includes(next.policy)) next.policy = '正常';
    next.followUp = !!next.followUp;
    next.tags = patch.replaceTags ? parseContactTags(patch.tags || []) : mergeContactTags(prev.tags || [], patch.tags || []);
    next.status = next.stage;
    delete next.replaceTags;
    contacts[email] = normalizeContactShape(next, email);
    return contacts[email];
  }

  function timeMs(value) {
    if (value == null || value === '') return 0;
    if (typeof value === 'number') {
      const n = value < 1e12 ? value * 1000 : value;
      return Number.isFinite(n) ? n : 0;
    }
    const s = String(value).trim();
    if (/^\d{10,13}$/.test(s)) {
      const n = Number(s);
      return n < 1e12 ? n * 1000 : n;
    }
    const direct = Date.parse(s);
    if (Number.isFinite(direct)) return direct;
    const normalized = s.replace(/年|\//g, '-').replace(/月/g, '-').replace(/日/g, ' ').replace(/\s+/g, ' ').trim();
    const parsed = Date.parse(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function isoTime(value) {
    const ms = timeMs(value);
    return ms ? new Date(ms).toISOString() : '';
  }

  function sentRecordId(message, email) {
    return String(message.id || `${message.sentAt || message.sentDate || ''}|${message.subject || ''}|${email}`);
  }

  function applySentMessages(contacts, messages) {
    let contactsTouched = 0;
    let newLinks = 0;
    let failedMessages = 0;
    for (const message of messages || []) {
      if (message.failed) { failedMessages++; continue; }
      const sentIso = isoTime(message.sentAt ?? message.sentDate ?? message.date);
      for (const recipient of message.recipients || []) {
        const email = normalizeEmail(recipient.email || recipient.address);
        if (!email) continue;
        const contact = ensureContact(contacts, email, { name: recipient.name || '' });
        contactsTouched++;
        const mid = sentRecordId(message, email);
        const ids = new Set(contact.sentMessageIds || []);
        if (!ids.has(mid)) {
          ids.add(mid);
          newLinks++;
          contact.sentCount = Number(contact.sentCount || 0) + 1;
          contact.sentMessageIds = [...ids].slice(-500);
          contact.history = [
            { id: mid, subject: message.subject || '', sentAt: sentIso, to: recipient.name || email, hasAttachmentsHint:!!message.hasAttachmentsHint, attachmentCountHint:Number(message.attachmentCountHint||0)||0 },
            ...(contact.history || []).filter(item => item.id !== mid)
          ].slice(0, 50);
        }
        if (sentIso && (!contact.lastSentAt || timeMs(sentIso) >= timeMs(contact.lastSentAt))) {
          contact.lastSentAt = sentIso;
          contact.lastSubject = message.subject || contact.lastSubject || '';
        }
        if (sentIso && (!contact.knownSentAt || timeMs(sentIso) >= timeMs(contact.knownSentAt))) contact.knownSentAt = sentIso;
        if (contact.stageSource !== 'manual' && contact.stage !== '已回复') { contact.stage = '已发送'; contact.stageSource = 'mailbox'; }
        contact.status = contact.stage;
        contact.updatedAt = new Date().toISOString();
      }
    }
    return { contacts, contactsTouched, newLinks, failedMessages };
  }

  function draftRecordId(message, email) {
    return String(message.id || `${message.savedAt || message.sentAt || message.date || ''}|${message.subject || ''}|${email}`);
  }

  function clearActiveDraftState(contacts) {
    for (const raw of Object.values(contacts || {})) {
      const contact = normalizeContactShape(raw);
      contact.draftCount = 0;
      contact.draftMessageIds = [];
      contact.draftHistory = [];
      contact.lastDraftAt = '';
      contact.lastDraftSubject = '';
    }
  }

  function applyDraftMessages(contacts, messages, options = {}) {
    const replaceActive = !!options.replaceActive;
    if (replaceActive) clearActiveDraftState(contacts);
    let contactsTouched = 0;
    let newLinks = 0;
    let draftsWithoutRecipient = 0;
    for (const message of messages || []) {
      const savedIso = isoTime(message.savedAt ?? message.sentAt ?? message.sentDate ?? message.date ?? message.receivedDate);
      const recipients = message.recipients || [];
      if (!recipients.length) { draftsWithoutRecipient++; continue; }
      for (const recipient of recipients) {
        const email = normalizeEmail(recipient.email || recipient.address);
        if (!email) continue;
        const contact = ensureContact(contacts, email, { name: recipient.name || '' });
        contactsTouched++;
        const mid = draftRecordId(message, email);
        const ids = new Set(contact.draftMessageIds || []);
        if (!ids.has(mid)) {
          ids.add(mid);
          newLinks++;
          contact.draftMessageIds = [...ids].slice(-1000);
        }
        const history = [
          { id: mid, subject: message.subject || '', savedAt: savedIso, to: recipient.name || email },
          ...(contact.draftHistory || []).filter(item => item.id !== mid)
        ];
        history.sort((a, b) => timeMs(b.savedAt) - timeMs(a.savedAt));
        contact.draftHistory = history.slice(0, 100);
        contact.draftCount = contact.draftMessageIds.length;
        if (savedIso && (!contact.lastDraftAt || timeMs(savedIso) >= timeMs(contact.lastDraftAt))) {
          contact.lastDraftAt = savedIso;
          contact.lastDraftSubject = message.subject || contact.lastDraftSubject || '';
        }
        // Drafts are preparation state only. Never advance 未联系 -> 已发送 here.
        contact.updatedAt = new Date().toISOString();
      }
    }
    return { contacts, contactsTouched, newLinks, draftsWithoutRecipient, replaceActive };
  }

  function autoReplyClassification(message = {}) {
    const subject = String(message.subject || '').trim();
    const sender = normalizeEmail(message.sender?.email || message.from?.email || message.from || '');
    const haystack = `${subject} ${String(message.autoReplyHint || '')}`.toLowerCase();
    const subjectPatterns = [
      /\bauto(?:matic)?[\s-]*reply\b/i,
      /\bout[\s-]*of[\s-]*(?:the[\s-]*)?office\b/i,
      /\booo\b/i,
      /\bvacation(?:\s+reply|\s+responder)?\b/i,
      /\baway\s+from\s+(?:the\s+)?office\b/i,
      /自动(?:回复|答复|回覆)/i,
      /不在办公室/i,
      /外出(?:自动)?回复/i,
      /休假(?:自动)?回复/i,
      /假期(?:自动)?回复/i
    ];
    const senderPattern = /^(?:no-?reply|do-?not-?reply|mailer-daemon|postmaster|autoresponder|auto-?reply)@/i;
    const subjectMatch = subjectPatterns.some(pattern => pattern.test(haystack));
    const senderMatch = senderPattern.test(sender);
    return {
      isAutoReply: subjectMatch || senderMatch || message.autoReply === true,
      reason: subjectMatch ? 'subject-pattern' : senderMatch ? 'sender-pattern' : message.autoReply === true ? 'mailbox-flag' : ''
    };
  }

  function inboxRecordId(message, email) {
    return String(message.id || `${message.receivedAt || message.sentAt || message.date || ''}|${message.subject || ''}|${email}`);
  }

  function applyInboxMessages(contacts, messages, options = {}) {
    const replaceActive = !!options.replaceActive;
    if (replaceActive) {
      for (const raw of Object.values(contacts || {})) {
        const contact = normalizeContactShape(raw);
        contact.replyCount = 0; contact.humanReplyCount = 0; contact.autoReplyCount = 0;
        contact.replyMessageIds = []; contact.replyHistory = [];
        contact.lastReplyAt = ''; contact.lastReplySubject = '';
        contact.lastAutoReplyAt = ''; contact.lastAutoReplySubject = '';
      }
    }
    let contactsTouched = 0, newLinks = 0, autoReplies = 0, humanReplies = 0, skippedWithoutSender = 0;
    for (const message of messages || []) {
      const sender = message.sender || message.from || {};
      const email = normalizeEmail(sender.email || sender.address || (typeof sender === 'string' ? sender : ''));
      if (!email) { skippedWithoutSender++; continue; }
      if (!contacts[email]) { skippedWithoutSender++; continue; }
      const existing = normalizeContactShape(contacts[email], email);
      if (!Number(existing.sentCount || 0) && !existing.knownSentAt) { skippedWithoutSender++; continue; }
      const contact = ensureContact(contacts, email, { name: sender.name || '' });
      contactsTouched++;
      const receivedIso = isoTime(message.receivedAt ?? message.sentAt ?? message.sentDate ?? message.date ?? message.receivedDate);
      const classification = autoReplyClassification(message);
      const mid = inboxRecordId(message, email);
      const ids = new Set(contact.replyMessageIds || []);
      const isNew = !ids.has(mid);
      if (isNew) { ids.add(mid); newLinks++; }
      contact.replyMessageIds = [...ids].slice(-1000);
      const historyItem = {
        id: mid, subject: message.subject || '', receivedAt: receivedIso,
        from: sender.name || email, autoReply: !!classification.isAutoReply,
        autoReplyReason: classification.reason || ''
      };
      contact.replyHistory = [historyItem, ...(contact.replyHistory || []).filter(item => item.id !== mid)]
        .sort((a,b) => timeMs(b.receivedAt) - timeMs(a.receivedAt)).slice(0, 100);
      contact.replyCount = contact.replyMessageIds.length;
      contact.humanReplyCount = contact.replyHistory.filter(item => !item.autoReply).length;
      contact.autoReplyCount = contact.replyHistory.filter(item => item.autoReply).length;
      if (classification.isAutoReply) {
        if (isNew) autoReplies++;
        if (receivedIso && (!contact.lastAutoReplyAt || timeMs(receivedIso) >= timeMs(contact.lastAutoReplyAt))) {
          contact.lastAutoReplyAt = receivedIso;
          contact.lastAutoReplySubject = message.subject || contact.lastAutoReplySubject || '';
        }
      } else {
        if (isNew) humanReplies++;
        if (receivedIso && (!contact.lastReplyAt || timeMs(receivedIso) >= timeMs(contact.lastReplyAt))) {
          contact.lastReplyAt = receivedIso;
          contact.lastReplySubject = message.subject || contact.lastReplySubject || '';
        }
        if (contact.stageSource !== 'manual') { contact.stage = '已回复'; contact.stageSource = 'mailbox'; contact.status = contact.stage; }
      }
      contact.updatedAt = new Date().toISOString();
    }
    return { contacts, contactsTouched, newLinks, autoReplies, humanReplies, skippedWithoutSender, replaceActive };
  }

  function addFollowUpEvent(contacts, email, event = {}) {
    const contact = ensureContact(contacts, email);
    if (!contact) return null;
    const now = new Date().toISOString();
    const id = String(event.id || `fu:${Date.now()}:${Math.random().toString(36).slice(2,8)}`);
    const next = {
      id, createdAt: event.createdAt || now, status: event.status || 'draft',
      mode: event.mode || 'forward', sourceMessageId: String(event.sourceMessageId || ''),
      sourceSubject: String(event.sourceSubject || ''), subject: String(event.subject || ''),
      scheduleAt: String(event.scheduleAt || ''), note: String(event.note || ''),
      verification: event.verification && typeof event.verification === 'object' ? { ...event.verification } : null
    };
    contact.followUpEvents = [next, ...(contact.followUpEvents || []).filter(item => item.id !== id)].slice(0,100);
    contact.followUpCount = contact.followUpEvents.filter(item => item && item.status !== 'cancelled').length;
    contact.followUp = false;
    contact.followUpChangedAt = now;
    contact.updatedAt = now;
    return next;
  }

  function buildMailboxSnapshot(sentMessages, draftMessages, inboxMessages = []) {
    const facts = {};
    const now = new Date().toISOString();
    const ensureFact = (email, name = '') => {
      email = normalizeEmail(email);
      if (!email) return null;
      if (!facts[email]) facts[email] = {
        email, name: name || '', sentMessageIds: [], history: [], sentCount: 0, lastSentAt: '', lastSubject: '',
        draftMessageIds: [], draftHistory: [], draftCount: 0, lastDraftAt: '', lastDraftSubject: '',
        replyMessageIds: [], replyHistory: [], replyCount: 0, humanReplyCount: 0, autoReplyCount: 0,
        lastReplyAt: '', lastReplySubject: '', lastAutoReplyAt: '', lastAutoReplySubject: ''
      };
      if (!facts[email].name && name) facts[email].name = name;
      return facts[email];
    };

    let failedMessages = 0, draftsWithoutRecipient = 0;
    for (const message of sentMessages || []) {
      if (message.failed) { failedMessages++; continue; }
      const sentIso = isoTime(message.sentAt ?? message.sentDate ?? message.date);
      for (const recipient of message.recipients || []) {
        const email = normalizeEmail(recipient.email || recipient.address);
        const fact = ensureFact(email, recipient.name || '');
        if (!fact) continue;
        const mid = sentRecordId(message, email);
        if (!fact.sentMessageIds.includes(mid)) {
          fact.sentMessageIds.push(mid);
          fact.history.push({ id: mid, subject: message.subject || '', sentAt: sentIso, to: recipient.name || email, hasAttachmentsHint:!!message.hasAttachmentsHint, attachmentCountHint:Number(message.attachmentCountHint||0)||0 });
        }
        if (sentIso && (!fact.lastSentAt || timeMs(sentIso) >= timeMs(fact.lastSentAt))) {
          fact.lastSentAt = sentIso;
          fact.lastSubject = message.subject || fact.lastSubject || '';
        }
      }
    }
    for (const fact of Object.values(facts)) {
      fact.history.sort((a, b) => timeMs(b.sentAt) - timeMs(a.sentAt));
      fact.sentCount = fact.sentMessageIds.length;
      fact.sentMessageIds = fact.sentMessageIds.slice(-5000);
      fact.history = fact.history.slice(0, 200);
    }

    for (const message of draftMessages || []) {
      const savedIso = isoTime(message.savedAt ?? message.sentAt ?? message.sentDate ?? message.date ?? message.receivedDate);
      const recipients = message.recipients || [];
      if (!recipients.length) { draftsWithoutRecipient++; continue; }
      for (const recipient of recipients) {
        const email = normalizeEmail(recipient.email || recipient.address);
        const fact = ensureFact(email, recipient.name || '');
        if (!fact) continue;
        const mid = draftRecordId(message, email);
        if (!fact.draftMessageIds.includes(mid)) fact.draftMessageIds.push(mid);
        fact.draftHistory = [
          { id: mid, subject: message.subject || '', savedAt: savedIso, to: recipient.name || email },
          ...fact.draftHistory.filter(item => item.id !== mid)
        ];
        if (savedIso && (!fact.lastDraftAt || timeMs(savedIso) >= timeMs(fact.lastDraftAt))) {
          fact.lastDraftAt = savedIso;
          fact.lastDraftSubject = message.subject || fact.lastDraftSubject || '';
        }
      }
    }
    for (const fact of Object.values(facts)) {
      fact.draftHistory.sort((a, b) => timeMs(b.savedAt) - timeMs(a.savedAt));
      fact.draftCount = fact.draftMessageIds.length;
      fact.draftMessageIds = fact.draftMessageIds.slice(-5000);
      fact.draftHistory = fact.draftHistory.slice(0, 200);
    }
    let inboxWithoutSender = 0;
    for (const message of inboxMessages || []) {
      const sender = message.sender || message.from || {};
      const email = normalizeEmail(sender.email || sender.address || (typeof sender === 'string' ? sender : ''));
      if (!email) { inboxWithoutSender++; continue; }
      const fact = facts[email] || null;
      if (!fact || !Number(fact.sentCount || 0)) { inboxWithoutSender++; continue; }
      if (!fact.name && sender.name) fact.name = sender.name;
      const receivedIso = isoTime(message.receivedAt ?? message.sentAt ?? message.sentDate ?? message.date ?? message.receivedDate);
      const classification = autoReplyClassification(message);
      const mid = inboxRecordId(message, email);
      if (!fact.replyMessageIds.includes(mid)) fact.replyMessageIds.push(mid);
      fact.replyHistory = [{ id:mid, subject:message.subject||'', receivedAt:receivedIso, from:sender.name||email, autoReply:!!classification.isAutoReply, autoReplyReason:classification.reason||'' }, ...fact.replyHistory.filter(item=>item.id!==mid)];
      if (classification.isAutoReply) {
        if (receivedIso && (!fact.lastAutoReplyAt || timeMs(receivedIso) >= timeMs(fact.lastAutoReplyAt))) { fact.lastAutoReplyAt = receivedIso; fact.lastAutoReplySubject = message.subject || ''; }
      } else if (receivedIso && (!fact.lastReplyAt || timeMs(receivedIso) >= timeMs(fact.lastReplyAt))) { fact.lastReplyAt = receivedIso; fact.lastReplySubject = message.subject || ''; }
    }
    for (const fact of Object.values(facts)) {
      fact.replyHistory.sort((a,b)=>timeMs(b.receivedAt)-timeMs(a.receivedAt));
      fact.replyCount = fact.replyMessageIds.length;
      fact.humanReplyCount = fact.replyHistory.filter(item=>!item.autoReply).length;
      fact.autoReplyCount = fact.replyHistory.filter(item=>item.autoReply).length;
      fact.replyMessageIds = fact.replyMessageIds.slice(-5000);
      fact.replyHistory = fact.replyHistory.slice(0,200);
    }
    return { facts, builtAt: now, failedMessages, draftsWithoutRecipient, inboxWithoutSender };
  }

  function rebuildMailboxSnapshot(existingContacts, sentMessages, draftMessages, inboxMessages = []) {
    const snapshot = buildMailboxSnapshot(sentMessages, draftMessages, inboxMessages);
    const contacts = cloneContacts(existingContacts);
    const now = snapshot.builtAt;

    // Replace ONLY mailbox-derived facts. Manual CRM dimensions survive intact.
    for (const [email, raw] of Object.entries(contacts)) {
      const contact = normalizeContactShape(raw, email);
      contact.sentCount = 0; contact.lastSentAt = ''; contact.lastSubject = ''; contact.sentMessageIds = []; contact.history = [];
      contact.draftCount = 0; contact.lastDraftAt = ''; contact.lastDraftSubject = ''; contact.draftMessageIds = []; contact.draftHistory = [];
      contact.replyCount = 0; contact.humanReplyCount = 0; contact.autoReplyCount = 0; contact.replyMessageIds = []; contact.replyHistory = [];
      contact.lastReplyAt = ''; contact.lastReplySubject = ''; contact.lastAutoReplyAt = ''; contact.lastAutoReplySubject = '';
      contact.mailboxSnapshotAt = now;
      contacts[email] = contact;
    }

    for (const [email, fact] of Object.entries(snapshot.facts)) {
      const contact = ensureContact(contacts, email, { name: fact.name || '' });
      if (!contact.name && fact.name) contact.name = fact.name;
      contact.sentCount = fact.sentCount;
      contact.lastSentAt = fact.lastSentAt;
      contact.lastSubject = fact.lastSubject;
      contact.sentMessageIds = [...fact.sentMessageIds];
      contact.history = [...fact.history];
      contact.draftCount = fact.draftCount;
      contact.lastDraftAt = fact.lastDraftAt;
      contact.lastDraftSubject = fact.lastDraftSubject;
      contact.draftMessageIds = [...fact.draftMessageIds];
      contact.draftHistory = [...fact.draftHistory];
      contact.replyCount = fact.replyCount; contact.humanReplyCount = fact.humanReplyCount; contact.autoReplyCount = fact.autoReplyCount;
      contact.replyMessageIds = [...fact.replyMessageIds]; contact.replyHistory = [...fact.replyHistory];
      contact.lastReplyAt = fact.lastReplyAt; contact.lastReplySubject = fact.lastReplySubject;
      contact.lastAutoReplyAt = fact.lastAutoReplyAt; contact.lastAutoReplySubject = fact.lastAutoReplySubject;
      if (fact.lastSentAt && (!contact.knownSentAt || timeMs(fact.lastSentAt) >= timeMs(contact.knownSentAt))) contact.knownSentAt = fact.lastSentAt;
      contact.mailboxSnapshotAt = now;
      contact.updatedAt = now;
    }

    for (const contact of Object.values(contacts)) {
      // A full rebuild corrects the current mailbox snapshot, but never forgets that
      // a send was observed before merely because the user later deleted Sent mail.
      if (contact.stageSource !== 'manual') {
        if (Number(contact.humanReplyCount || 0) > 0) { contact.stage = '已回复'; contact.stageSource = 'mailbox'; }
        else if (contact.knownSentAt || Number(contact.sentCount || 0) > 0) { contact.stage = '已发送'; contact.stageSource = 'mailbox'; }
        else { contact.stage = '未联系'; contact.stageSource = 'default'; }
        contact.status = contact.stage;
      }
    }

    return {
      contacts, builtAt: now,
      contactFacts: Object.keys(snapshot.facts).length,
      sentMessages: (sentMessages || []).length,
      draftMessages: (draftMessages || []).length,
      inboxMessages: (inboxMessages || []).length,
      failedMessages: snapshot.failedMessages,
      draftsWithoutRecipient: snapshot.draftsWithoutRecipient,
      inboxWithoutSender: snapshot.inboxWithoutSender
    };
  }

  function mergeRecipientList(contacts, recipients, defaultStage = '未联系') {
    let added = 0;
    for (const item of recipients || []) {
      const email = normalizeEmail(item.email || item.address);
      if (!email) continue;
      const existed = !!contacts[email];
      ensureContact(contacts, email, { name: item.name || '', stage: STAGE_OPTIONS.includes(defaultStage) ? defaultStage : '未联系', tags: item.tags || [] });
      if (!existed) added++;
    }
    return added;
  }

  function setStage(contacts, email, stage) {
    if (!STAGE_OPTIONS.includes(stage)) throw new Error(`未知互动阶段：${stage}`);
    const contact = ensureContact(contacts, email);
    if (!contact) return null;
    contact.stage = stage;
    contact.status = stage;
    contact.stageSource = 'manual';
    contact.stageChangedAt = new Date().toISOString();
    contact.updatedAt = contact.stageChangedAt;
    return contact;
  }

  function setPolicy(contacts, email, policy) {
    if (!POLICY_OPTIONS.includes(policy)) throw new Error(`未知发送策略：${policy}`);
    const contact = ensureContact(contacts, email);
    if (!contact) return null;
    contact.policy = policy;
    contact.policyChangedAt = new Date().toISOString();
    contact.updatedAt = contact.policyChangedAt;
    return contact;
  }

  function setFollowUp(contacts, email, followUp) {
    const contact = ensureContact(contacts, email);
    if (!contact) return null;
    contact.followUp = !!followUp;
    contact.followUpChangedAt = new Date().toISOString();
    contact.updatedAt = contact.followUpChangedAt;
    return contact;
  }

  function setStatus(contacts, email, status) {
    if (!STATUS_OPTIONS.includes(status)) throw new Error(`未知联系人状态：${status}`);
    if (STAGE_OPTIONS.includes(status)) return setStage(contacts, email, status);
    if (status === '待跟进') return setFollowUp(contacts, email, true);
    return setPolicy(contacts, email, status);
  }

  function setTags(contacts, email, tags) {
    const contact = ensureContact(contacts, email);
    if (!contact) return null;
    contact.tags = parseContactTags(tags);
    contact.tagsChangedAt = new Date().toISOString();
    contact.updatedAt = contact.tagsChangedAt;
    return contact;
  }

  function addTags(contacts, email, tags) {
    const contact = ensureContact(contacts, email);
    if (!contact) return null;
    contact.tags = mergeContactTags(contact.tags || [], tags || []);
    contact.tagsChangedAt = new Date().toISOString();
    contact.updatedAt = contact.tagsChangedAt;
    return contact;
  }

  function removeTags(contacts, email, tags) {
    const contact = ensureContact(contacts, email);
    if (!contact) return null;
    const remove = new Set(parseContactTags(tags).map(tag => tag.toLocaleLowerCase('zh-CN')));
    contact.tags = parseContactTags(contact.tags || []).filter(tag => !remove.has(tag.toLocaleLowerCase('zh-CN')));
    contact.tagsChangedAt = new Date().toISOString();
    contact.updatedAt = contact.tagsChangedAt;
    return contact;
  }

  function classificationItems(contact) {
    contact = normalizeContactShape(contact || {});
    const items = [{ kind:'stage', value:interactionState(contact) }];
    if (contact.policy && contact.policy !== '正常') items.push({ kind:'policy', value:contact.policy });
    if (Number(contact.draftCount || 0) > 0) items.push({ kind:'draft', value:'有草稿' });
    for (const tag of parseContactTags(contact.tags || [])) items.push({ kind:'tag', value:tag });
    return items;
  }

  function classificationLabels(contact) {
    return classificationItems(contact).map(item => item.value);
  }

  function policyBlocksSend(contact) {
    contact = normalizeContactShape(contact || {});
    return contact.policy === '暂停' || contact.policy === '不再联系';
  }

  function formatDisplayTime(value) {
    const ms = timeMs(value);
    if (!ms) return '—';
    return new Date(ms).toLocaleString('zh-CN', { hour12: false });
  }

  function csvEscape(value) {
    const s = String(value ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function toCsv(contacts) {
    const rows = [['邮箱', '姓名', '互动阶段', '待跟进', '发送策略', '长期标记', '已识别发送次数', '最后发送时间', '最后发送主题', '当前草稿数', '最后草稿时间', '最后草稿主题', '真人回复数', 'Auto Reply数', '最后真人回复时间', '最后真人回复主题', '已创建Follow-up次数']];
    Object.values(contacts || {}).sort((a, b) => normalizeEmail(a.email).localeCompare(normalizeEmail(b.email))).forEach(raw => {
      const c = normalizeContactShape(raw);
      rows.push([c.email, c.name || '', c.stage || '未联系', c.followUp ? '是' : '否', c.policy || '正常', parseContactTags(c.tags || []).join(';'), c.sentCount || 0, c.lastSentAt || '', c.lastSubject || '', c.draftCount || 0, c.lastDraftAt || '', c.lastDraftSubject || '', c.humanReplyCount || 0, c.autoReplyCount || 0, c.lastReplyAt || '', c.lastReplySubject || '', c.followUpCount || 0]);
    });
    return '\ufeff' + rows.map(row => row.map(csvEscape).join(',')).join('\r\n');
  }

  globalThis.NMDAContacts = {
    STATUS_OPTIONS,
    STAGE_OPTIONS,
    POLICY_OPTIONS,
    SYSTEM_CLASSIFICATIONS: [...SYSTEM_CLASSIFICATIONS],
    normalizeEmail,
    normalizeTag,
    parseTags,
    parseContactTags,
    mergeTags,
    mergeContactTags,
    parseRecipients,
    normalizeContactShape,
    interactionState,
    load,
    save,
    loadSyncMeta,
    saveSyncMeta,
    cloneContacts,
    ensureContact,
    applySentMessages,
    applyDraftMessages,
    applyInboxMessages,
    autoReplyClassification,
    addFollowUpEvent,
    buildMailboxSnapshot,
    rebuildMailboxSnapshot,
    clearActiveDraftState,
    mergeRecipientList,
    setStatus,
    setStage,
    setPolicy,
    setFollowUp,
    setTags,
    addTags,
    removeTags,
    classificationItems,
    classificationLabels,
    policyBlocksSend,
    formatDisplayTime,
    toCsv
  };
})();
