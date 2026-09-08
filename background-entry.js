'use strict';

// Follow-up is modeled as an import source. The app imports a historical message into
// the normal task pipeline; this router only switches the final execution back to
// NetEase's native Fw/Re path so the original message and attachments stay intact.
importScripts('contacts.js');

const FOLLOWUP_IMPORT_REGISTRY_KEY = 'nmda.followup.import.registry.v1';
const nativeTabSendMessage = chrome.tabs.sendMessage.bind(chrome.tabs);
const Contacts = globalThis.NMDAContacts;

function firstEmail(value) {
  return String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase() || '';
}

function cleanSubject(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

async function loadRegistry() {
  const stored = (await chrome.storage.local.get(FOLLOWUP_IMPORT_REGISTRY_KEY))[FOLLOWUP_IMPORT_REGISTRY_KEY];
  const entries = Array.isArray(stored?.entries) ? stored.entries : [];
  const cutoff = Date.now() - 30 * 86400000;
  return {
    version: 1,
    entries: entries.filter(entry => {
      if (!entry || typeof entry !== 'object') return false;
      if (entry.status === 'completed' && Date.parse(entry.completedAt || 0) < cutoff) return false;
      if (entry.status === 'cancelled' && Date.parse(entry.updatedAt || 0) < cutoff) return false;
      return true;
    })
  };
}

async function saveRegistry(registry) {
  await chrome.storage.local.set({ [FOLLOWUP_IMPORT_REGISTRY_KEY]: registry });
}

function findImportedFollowUp(message, registry) {
  const task = message?.task || {};
  const email = firstEmail(task.recipients);
  if (!email) return null;
  const pending = (registry?.entries || [])
    .filter(entry => entry?.status === 'pending' && firstEmail(entry.email) === email)
    .sort((a, b) => (Date.parse(b.createdAt || '') || 0) - (Date.parse(a.createdAt || '') || 0));
  if (!pending.length) return null;
  const body = String(task.body || '');
  const marked = pending.filter(entry => entry.reviewMarker && body.includes(String(entry.reviewMarker)));
  const pool = marked.length ? marked : pending;
  const subject = cleanSubject(task.subject);
  const exact = pool.filter(entry => cleanSubject(entry.expectedSubject) === subject);
  if (exact.length) return exact[0];
  return pool.length === 1 ? pool[0] : null;
}

function introFromTask(task, entry) {
  const body = String(task?.body || '');
  const marker = String(entry?.reviewMarker || '');
  if (marker) {
    const index = body.indexOf(marker);
    if (index >= 0) return body.slice(0, index).trim();
  }
  return String(entry?.introText || body).trim();
}

async function recordCompletion(entry, currentTask, result, registry) {
  const now = new Date().toISOString();
  entry.status = 'completed';
  entry.completedAt = now;
  entry.updatedAt = now;
  entry.executedSubject = String(currentTask?.subject || entry.expectedSubject || '');
  entry.lastVerification = result?.outcome?.nativeVerification || null;
  await saveRegistry(registry);

  if (!Contacts || !entry.account || !entry.email) return;
  try {
    const contacts = await Contacts.load(entry.account);
    Contacts.addFollowUpEvent(contacts, entry.email, {
      mode: entry.mode || 'forward',
      sourceMessageId: entry.sourceMessageId || '',
      sourceSubject: entry.sourceSubject || '',
      subject: entry.executedSubject,
      status: 'draft',
      note: result?.outcome?.saveOutcome?.evidence || '由历史邮件导入任务创建',
      verification: result?.outcome?.nativeVerification || null
    });
    await Contacts.save(entry.account, contacts);
  } catch (_) {}
}

chrome.tabs.sendMessage = async function routedTabSendMessage(tabId, message, ...rest) {
  if (message?.type !== 'NMDA_EXECUTE_DRAFT') {
    return nativeTabSendMessage(tabId, message, ...rest);
  }

  let registry;
  try { registry = await loadRegistry(); }
  catch (_) { return nativeTabSendMessage(tabId, message, ...rest); }

  const entry = findImportedFollowUp(message, registry);
  if (!entry) return nativeTabSendMessage(tabId, message, ...rest);

  const task = message.task || {};
  let result;
  if (entry.mode === 'new') {
    const marker = String(entry.reviewMarker || '');
    const cleanBody = marker ? String(task.body || '').replace(marker, '\n\n---------- Original message ----------\n') : String(task.body || '');
    result = await nativeTabSendMessage(tabId, { ...message, task:{ ...task, body:cleanBody } }, ...rest);
  } else {
    const routed = {
      ...message,
      type: 'NMDA_EXECUTE_FOLLOWUP',
      task: {
        mode: entry.mode === 'reply' ? 'reply' : 'forward',
        sourceMessageId: String(entry.sourceMessageId || ''),
        recipients: String(task.recipients || entry.email || ''),
        subject: String(task.subject || entry.expectedSubject || ''),
        introText: introFromTask(task, entry),
        sourceSubject: String(entry.sourceSubject || ''),
        sourceBody: String(entry.sourceBody || ''),
        sourceIsHtml: entry.sourceIsHtml !== false,
        sourceFrom: String(entry.sourceFrom || ''),
        sourceTo: String(entry.sourceTo || ''),
        sourceCc: String(entry.sourceCc || ''),
        sourceDate: String(entry.sourceDate || ''),
        sourceAttachments: Array.isArray(entry.sourceAttachments) ? entry.sourceAttachments : [],
        attachmentInventoryKnown: entry.attachmentInventoryKnown === true,
        hasAttachmentsHint: entry.hasAttachmentsHint === true,
        attachmentCountHint: Number(entry.attachmentCountHint || 0) || 0
      }
    };
    result = await nativeTabSendMessage(tabId, routed, ...rest);
  }

  if (result?.ok) {
    try { await recordCompletion(entry, task, result, registry); } catch (_) {}
  }
  return result;
};

importScripts('background.js');
