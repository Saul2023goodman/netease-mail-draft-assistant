'use strict';

function runMain(tabId, func, args = []) {
  return chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func,
    args
  }).then(results => results?.[0]?.result || { ok: false, reason: 'no-execution-result' });
}

function readMailbox(tabId, fid, requested) {
  const raw = String(requested ?? '200').trim().toLowerCase();
  const requestedLimit = raw === 'all' || raw === '-1' ? -1 : Number(raw || 200);
  return runMain(tabId, (fidArg, requestedArg) => new Promise(async resolve => {
    try {
      if (!window.$?.DataAction) return resolve({ ok: false, reason: '$.DataAction unavailable' });
      const uid = typeof window.$S === 'function' ? String(window.$S('uid') || '') : '';
      const PAGE_SIZE = 200;
      // Full rebuild is an explicit maintenance operation. Keep a high safety ceiling,
      // but never call a capped scan 'complete'.
      const HARD_MAX = 100000;
      const MAX_PAGES = 600;
      const requestedAll = Number(requestedArg) < 0;
      const wanted = requestedAll ? HARD_MAX : Math.max(1, Math.min(HARD_MAX, Number(requestedArg) || 200));

      function requestPage(extra = {}, limit = PAGE_SIZE) {
        return new Promise((res, rej) => {
          try {
            const dataAction = new window.$.DataAction();
            dataAction.wmsvr({
              func: 'mbox:listMessages',
              body: {
                order: 'date',
                desc: true,
                fid: fidArg,
                summaryWindowSize: 0,
                limit,
                returnTotal: true,
                skipLockedFolders: true,
                ...extra
              },
              call(response) { res(response || {}); },
              error(error) { rej(new Error(error?.message || error?.code || 'mbox:listMessages failed')); },
              ignoreError: true
            });
          } catch (error) { rej(error); }
        });
      }

      function parseRecipients(item) {
        const recipients = [];
        try {
          const parsed = window.$.Uri?.getEmails?.(String(item?.to || ''));
          for (const match of parsed?.match || []) {
            const email = String(match?.address || '').trim().toLowerCase();
            if (!email) continue;
            recipients.push({ email, name: String(match?.name || '').trim() });
          }
        } catch (_) {}
        return recipients;
      }

      function parseSender(item) {
        const raw = String(item?.from || item?.sender || item?.mailFrom || '');
        try {
          const parsed = window.$.Uri?.getEmails?.(raw);
          const match = parsed?.match?.[0];
          const email = String(match?.address || '').trim().toLowerCase();
          if (email) return { email, name: String(match?.name || '').trim(), raw };
        } catch (_) {}
        const email = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase() || '';
        const name = raw.replace(/<[^>]+>/g,'').replace(email,'').trim().replace(/^['"]|['"]$/g,'');
        return { email, name, raw };
      }

      function detectAutoReplyHint(item) {
        const subject = String(item?.subject || '');
        const sender = parseSender(item);
        const text = `${subject} ${sender.email}`.toLowerCase();
        const subjectAuto = /(?:auto(?:matic)?[\s-]*reply|out[\s-]*of[\s-]*(?:the[\s-]*)?office|\booo\b|vacation(?:\s+reply|\s+responder)?|自动(?:回复|答复|回覆)|不在办公室|外出(?:自动)?回复|休假(?:自动)?回复|假期(?:自动)?回复)/i.test(text);
        const senderAuto = /^(?:no-?reply|do-?not-?reply|mailer-daemon|postmaster|autoresponder|auto-?reply)@/i.test(sender.email || '');
        return subjectAuto ? 'subject-pattern' : senderAuto ? 'sender-pattern' : '';
      }

      function normalizeMailboxDate(value) {
        if (value == null || value === '') return '';
        try {
          let date = null;
          if (value instanceof Date && !Number.isNaN(value.getTime())) date = value;
          else if (value && typeof value === 'object' && typeof value.getTime === 'function') {
            const time = Number(value.getTime());
            if (Number.isFinite(time)) date = new Date(time);
          } else if (typeof value === 'number' || /^\d{10,13}$/.test(String(value).trim())) {
            let time = Number(value); if (time < 1e12) time *= 1000;
            const candidate = new Date(time); if (!Number.isNaN(candidate.getTime())) date = candidate;
          }
          if (date) {
            const pad = number => String(number).padStart(2, '0');
            return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
          }
        } catch (_) {}
        return String(value).trim();
      }

      function normalize(item) {
        let sndStatus = item?.sndStatus;
        const flags = item?.flags || {};
        if (fidArg === 3) {
          if (typeof sndStatus !== 'number') {
            const queued = !!flags.rcptQueued, succeeded = !!flags.rcptSucceed, failed = !!flags.rcptFailed;
            if (queued || succeeded || failed) sndStatus = succeeded ? (failed ? 5 : 1) : (failed ? 4 : 1);
          } else if (sndStatus === 3 && flags.rcptFailed) sndStatus = 4;
        }
        const sentRaw = item?.sentDate ?? item?.date ?? item?.receivedDate ?? item?.modifiedDate ?? '';
        const sentTimestamp = normalizeMailboxDate(sentRaw);
        const explicitScheduleRaw = item?.scheduleAt ?? item?.scheduleDate ?? item?.scheduledAt ?? item?.scheduledDate ?? item?.scheduledTime ?? item?.planSendTime ?? item?.deliverAt ?? item?.sendAt ?? item?.sendTime ?? '';
        const explicitSchedule = normalizeMailboxDate(explicitScheduleRaw);
        let futureSent = false;
        try {
          const parsed = sentTimestamp ? new Date(sentTimestamp) : null;
          futureSent = !!parsed && !Number.isNaN(parsed.getTime()) && parsed.getTime() > Date.now() + 60 * 1000;
        } catch (_) {}
        // The official NetEase draft-open path passes folderData.sentDate into Compose
        // whenever flags.scheduleDelivery is true. Some mailbox variants omit that flag
        // even though the draft row still carries a future sentDate, so a future sentDate
        // in fid=2 is also strong schedule evidence.
        const scheduledDraft = fidArg === 2 && (!!flags.scheduleDelivery || !!explicitSchedule || futureSent);
        const scheduleValue = scheduledDraft ? (explicitSchedule || sentTimestamp) : explicitSchedule;
        const savedRaw = item?.modifiedDate ?? item?.date ?? item?.receivedDate ?? (scheduledDraft ? '' : item?.sentDate) ?? '';
        const savedTimestamp = normalizeMailboxDate(savedRaw);
        return {
          id: String(item?.id || item?.mid || ''),
          subject: String(item?.subject || ''),
          toRaw: String(item?.to || ''),
          fromRaw: String(item?.from || item?.sender || item?.mailFrom || ''),
          recipients: parseRecipients(item),
          sender: parseSender(item),
          sentAt: sentTimestamp,
          receivedAt: fidArg === 1 ? sentTimestamp : '',
          savedAt: savedTimestamp,
          autoReplyHint: fidArg === 1 ? detectAutoReplyHint(item) : '',
          autoReply: fidArg === 1 ? !!detectAutoReplyHint(item) : false,
          scheduleAt: scheduleValue,
          scheduleEvidence: scheduledDraft ? (flags.scheduleDelivery ? 'scheduleDelivery-flag' : (explicitSchedule ? 'explicit-schedule-field' : (futureSent ? 'future-sentDate' : ''))) : '',
          flags: { ...flags },
          hasAttachmentsHint: !!(item?.attached || item?.realAttached || Number(item?.attachmentCount || item?.attachCount || 0) > 0 || flags.attached || flags.realAttached),
          attachmentCountHint: Number(item?.attachmentCount || item?.attachCount || 0) || 0,
          scheduledDraft,
          sndStatus: typeof sndStatus === 'number' ? sndStatus : null,
          failed: fidArg === 3 && typeof sndStatus === 'number' ? sndStatus > 3 : false
        };
      }

      const seen = new Set();
      const messages = [];
      let total = 0;
      let totalKnown = false;
      let exhausted = false;
      let mode = null;
      let lastRaw = null;
      let pages = 0;
      let stopReason = '';

      function append(response) {
        const items = Array.isArray(response?.var) ? response.var : [];
        if (response?.total !== undefined && response?.total !== null && Number.isFinite(Number(response.total))) { total = Math.max(total, Number(response.total)); totalKnown = true; }
        let added = 0;
        for (const item of items) {
          const parsed = normalize(item);
          const key = parsed.id || `${parsed.savedAt}|${parsed.subject}|${parsed.toRaw}`;
          if (seen.has(key)) continue;
          seen.add(key);
          messages.push(parsed);
          added++;
        }
        lastRaw = items[items.length - 1] || lastRaw;
        return { items, added };
      }

      const firstLimit = Math.min(PAGE_SIZE, wanted);
      const first = await requestPage({}, firstLimit);
      pages++;
      const firstOutcome = append(first);
      if (!totalKnown && firstOutcome.items.length < firstLimit) exhausted = true;

      async function probeMode() {
        const lastId = String(lastRaw?.id || lastRaw?.mid || '');
        const candidates = [];
        if (lastId) candidates.push({ name: 'start-id', extra: { start: lastId } });
        candidates.push({ name: 'offset', extra: { offset: messages.length } });
        candidates.push({ name: 'start-index', extra: { start: messages.length } });
        for (const candidate of candidates) {
          try {
            const before = messages.length;
            const response = await requestPage(candidate.extra, Math.min(PAGE_SIZE, Math.max(1, wanted - messages.length)));
            pages++;
            const outcome = append(response);
            if (outcome.added > 0 && messages.length > before) {
              mode = candidate.name;
              if (outcome.items.length < Math.min(PAGE_SIZE, Math.max(1, wanted - before))) exhausted = true;
              return true;
            }
          } catch (_) {}
        }
        return false;
      }

      while (messages.length < wanted && !exhausted && (!totalKnown || messages.length < total) && pages < MAX_PAGES) {
        if (!mode) {
          const ok = await probeMode();
          if (!ok) { stopReason = 'pagination-unavailable'; break; }
          continue;
        }
        const lastId = String(lastRaw?.id || lastRaw?.mid || '');
        let extra = {};
        if (mode === 'start-id') extra = { start: lastId };
        else if (mode === 'offset') extra = { offset: messages.length };
        else extra = { start: messages.length };
        try {
          const before = messages.length;
          const pageLimit = Math.min(PAGE_SIZE, Math.max(1, wanted - messages.length));
          const response = await requestPage(extra, pageLimit);
          pages++;
          const outcome = append(response);
          if (!outcome.added || messages.length === before) { stopReason = 'pagination-stalled'; break; }
          if (outcome.items.length < pageLimit) exhausted = true;
        } catch (error) {
          stopReason = error?.message || 'pagination-failed';
          break;
        }
      }

      const effectiveTotal = totalKnown ? Math.max(total, messages.length) : messages.length;
      const targetCount = requestedAll ? Math.min(totalKnown ? effectiveTotal : messages.length, HARD_MAX) : Math.min(wanted, totalKnown ? effectiveTotal : messages.length);
      const resultMessages = messages.slice(0, targetCount);
      const complete = totalKnown ? (resultMessages.length >= effectiveTotal || effectiveTotal === 0) : exhausted;
      const reachedRequested = requestedAll ? complete : (resultMessages.length >= wanted || complete);
      if (requestedAll && totalKnown && effectiveTotal > HARD_MAX) stopReason = `hard-cap-${HARD_MAX}`;
      if (!complete && pages >= MAX_PAGES && !stopReason) stopReason = `page-cap-${MAX_PAGES}`;

      resolve({
        ok: true,
        uid,
        fid: fidArg,
        total: effectiveTotal,
        messages: resultMessages,
        pages,
        paginationMode: mode || 'single-page',
        complete,
        reachedRequested,
        truncated: !complete && (requestedAll || resultMessages.length < effectiveTotal),
        stopReason,
        hardMax: HARD_MAX
      });
    } catch (error) {
      resolve({ ok: false, reason: error?.message || String(error) });
    }
  }), [fid, requestedLimit]);
}

async function readMailboxState(tabId, mode = 'quick') {
  const full = mode === 'full';
  const requested = full ? 'all' : 500;
  const sent = await readMailbox(tabId, 3, requested);
  if (!sent?.ok) return { ok: false, phase: 'sent', reason: sent?.reason || '读取已发送失败', sent };
  const drafts = await readMailbox(tabId, 2, requested);
  if (!drafts?.ok) return { ok: false, phase: 'drafts', reason: drafts?.reason || '读取草稿箱失败', sent, drafts };
  const inbox = await readMailbox(tabId, 1, requested);
  if (!inbox?.ok) return { ok: false, phase: 'inbox', reason: inbox?.reason || '读取收件箱失败', sent, drafts, inbox };
  const complete = !!sent.complete && !!drafts.complete && !!inbox.complete;
  return {
    ok: true,
    mode: full ? 'full' : 'quick',
    uid: sent.uid || drafts.uid || inbox.uid || '',
    sent, drafts, inbox, complete,
    coverage: {
      sent: { read: sent.messages?.length || 0, total: sent.total || 0, complete: !!sent.complete, pages: sent.pages || 0 },
      drafts: { read: drafts.messages?.length || 0, total: drafts.total || 0, complete: !!drafts.complete, pages: drafts.pages || 0 },
      inbox: { read: inbox.messages?.length || 0, total: inbox.total || 0, complete: !!inbox.complete, pages: inbox.pages || 0 }
    }
  };
}


async function readMessageDetail(tabId, summary = {}) {
  return runMain(tabId, (summaryArg) => new Promise(async resolve => {
    try {
      if (!window.$?.DataAction) return resolve({ ok:false, reason:'$.DataAction unavailable' });
      const id = String(summaryArg?.id || summaryArg?.mid || '').trim();
      if (!id) return resolve({ ok:false, reason:'message-id-missing' });
      function request(body) {
        return new Promise((res, rej) => {
          try {
            const action = new window.$.DataAction();
            action.wmsvr({ func:'mbox:readMessage', body, call(response){res(response||{});}, error(error){rej(new Error(error?.message||error?.code||'mbox:readMessage failed'));}, ignoreError:true });
          } catch (error) { rej(error); }
        });
      }
      let response = null, lastError = null;
      const headerRequest = {
        header:true,
        returnImageInfo:true,
        returnAntispamInfo:true,
        returnHeaders:{
          'Auto-Submitted':'A','X-Autoreply':'A','X-Autorespond':'A','X-Auto-Response-Suppress':'A',
          'Precedence':'A','Reply-To':'A','Return-Path':'A','List-Id':'A','Sender':'A','From':''
        },
        supportTNEF:true
      };
      for (const body of [{id,...headerRequest},{mid:id,...headerRequest}]) {
        try { response = await request(body); if (response) break; } catch (error) { lastError = error; }
      }
      if (!response) return resolve({ok:false,id,reason:lastError?.message||'读取邮件详情失败'});
      const root = response?.var ?? response;
      const queue = [], seen = new Set();
      if (root && typeof root === 'object') queue.push(root);
      for (let i=0;i<queue.length && i<800;i++) {
        const node=queue[i]; if(!node||typeof node!=='object'||seen.has(node))continue; seen.add(node);
        for(const value of (Array.isArray(node)?node:Object.values(node))) if(value&&typeof value==='object') queue.push(value);
      }
      const keyNorm=v=>String(v||'').replace(/[\s_\-]/g,'').toLowerCase();
      function first(keys,{allowObject=false}={}) {
        const wanted=new Set(keys.map(keyNorm));
        for(const node of queue){ if(Array.isArray(node))continue; for(const [key,value] of Object.entries(node)){ if(!wanted.has(keyNorm(key))||value==null)continue; if(typeof value==='object'&&!allowObject)continue; if(typeof value==='string'&&!value.trim())continue; return value; }}
        return '';
      }
      function recipientText(value) {
        const fmt=item=>{ if(typeof item==='string')return item.trim(); if(!item||typeof item!=='object')return ''; const email=String(item.address||item.email||item.mail||'').trim(); const name=String(item.name||item.displayName||'').trim(); return email?(name?`${name} <${email}>`:email):''; };
        if(Array.isArray(value))return value.map(fmt).filter(Boolean).join('; ');
        return fmt(value)||String(value||'').trim();
      }
      function htmlToText(raw,isHtml=true){ if(!isHtml)return String(raw||'').trim(); try{const doc=new DOMParser().parseFromString(String(raw||''),'text/html'); return String(doc.body?.innerText||doc.body?.textContent||'').replace(/\u00a0/g,' ').replace(/\r\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();}catch(_){const div=document.createElement('div');div.innerHTML=String(raw||'');return String(div.textContent||'').trim();}}
      const direct=root && !Array.isArray(root) ? root : {};
      const subject=String(direct.subject ?? first(['subject','mailSubject','title']) ?? summaryArg?.subject ?? '').trim();
      const from=recipientText(direct.from ?? direct.sender ?? first(['from','sender','mailFrom'],{allowObject:true})) || String(summaryArg?.fromRaw||'').trim();
      const to=recipientText(direct.to ?? first(['to','recipients','recipient','toList'],{allowObject:true})) || String(summaryArg?.toRaw||'').trim();
      const cc=recipientText(direct.cc ?? first(['cc','ccList'],{allowObject:true}));
      const date=String(direct.sentDate ?? direct.date ?? direct.receivedDate ?? first(['sentDate','date','receivedDate','receiveDate']) ?? summaryArg?.receivedAt ?? summaryArg?.sentAt ?? '').trim();
      const isHtml=direct.isHtml !== false;
      const bodyHtml=String(direct.content ?? direct.bodyHtml ?? first(['content','body','mailContent','html','contentHtml','bodyHtml','mailBody']) ?? '');
      const body=htmlToText(bodyHtml,isHtml);

      const attachmentKeys = ['attachments','attachment','attach','attaches','attachmentList','attachList','attachmentInfos','attachInfos'];
      let attachmentInventoryKnown = attachmentKeys.some(key => Object.prototype.hasOwnProperty.call(direct, key));
      const attachmentCandidates = [];
      const attachmentSeen = new Set();
      function pushAttachment(value) {
        if (!value) return;
        if (Array.isArray(value)) { value.forEach(pushAttachment); return; }
        if (typeof value !== 'object') return;
        const name = String(value.fileName || value.filename || value.name || value.attachName || value.displayName || '').trim();
        const aid = String(value.id || value.aid || value.attachId || value.fileId || value.part || '').trim();
        const size = Number(value.size || value.fileSize || value.length || 0) || 0;
        if (name) {
          const key = `${aid}|${name}|${size}`;
          if (!attachmentSeen.has(key)) {
            attachmentSeen.add(key);
            attachmentCandidates.push({ id:aid, name, size, contentType:String(value.contentType || value.mimeType || value.type || '') });
          }
        }
      }
      for (const key of attachmentKeys) if (Object.prototype.hasOwnProperty.call(direct,key)) pushAttachment(direct[key]);
      for (const node of queue) {
        if (!node || Array.isArray(node) || typeof node !== 'object') continue;
        for (const [key,value] of Object.entries(node)) {
          if (!/attach/i.test(key)) continue;
          attachmentInventoryKnown = true;
          pushAttachment(value);
        }
      }

      const headerObj=direct?.headers||direct?.header||direct?.mailHeaders||{};
      const headerText=JSON.stringify(headerObj);
      const autoHeaderHint=`${headerText}`.toLowerCase();
      const autoSubjectHint=`${subject}`.toLowerCase();
      const autoBodyHint=`${body}`.slice(0,1600).toLowerCase();
      let autoReplyReason='';
      if (/(?:auto-submitted[^a-z]*auto-replied|x-autoreply|x-autorespond|x-auto-response-suppress)/i.test(autoHeaderHint)) autoReplyReason='auto-header';
      else if (/(?:auto(?:matic)?[\s-]*reply|out[\s-]*of[\s-]*(?:the[\s-]*)?office|\booo\b|vacation(?:\s+reply|\s+responder)?|自动(?:回复|答复|回覆)|不在办公室|外出(?:自动)?回复|休假(?:自动)?回复|假期(?:自动)?回复)/i.test(autoSubjectHint)) autoReplyReason='auto-subject';
      else if (/(?:no-?reply|do-?not-?reply|mailer-daemon|postmaster|autoresponder|auto-?reply)@/i.test(from)) autoReplyReason='sender-pattern';
      else if (/(?:this is an automated (?:reply|response)|i am (?:currently )?out of (?:the )?office|i will be out of (?:the )?office|thank you for your email[^.]{0,120}(?:away|leave|vacation)|这是(?:一封)?自动(?:回复|答复|回覆)|本人(?:目前)?不在办公室|我(?:目前)?正在休假|外出期间无法及时回复)/i.test(autoBodyHint)) autoReplyReason='auto-body';
      const autoReply=!!autoReplyReason;
      resolve({
        ok:true,id,subject,from,to,cc,date,body,bodyHtml,isHtml,autoReply,autoReplyReason,
        attachments:attachmentCandidates,attachmentInventoryKnown,
        hasAttachmentsHint:!!summaryArg?.hasAttachmentsHint,attachmentCountHint:Number(summaryArg?.attachmentCountHint||0)||0,
        rawKeys:Object.keys(direct).slice(0,100)
      });
    } catch (error) { resolve({ok:false,id:String(summaryArg?.id||''),reason:error?.message||String(error)}); }
  }), [summary]);
}

async function readDraftDetail(tabId, summary = {}) {
  return runMain(tabId, (summaryArg) => new Promise(async resolve => {
    try {
      if (!window.$?.DataAction) return resolve({ ok:false, reason:'$.DataAction unavailable' });
      const id = String(summaryArg?.id || '').trim();
      if (!id) return resolve({ ok:false, reason:'draft-id-missing' });

      // The webmail source itself opens a draft by calling:
      //   mbox:restoreDraft { id }
      // The response.var object is the compose data model consumed by fillContent().
      // Reading this model is faster and much more stable than opening every draft
      // and scraping the editor iframe.
      function request(func, body) {
        return new Promise((res, rej) => {
          try {
            const action = new window.$.DataAction();
            action.wmsvr({
              func,
              body,
              call(response) { res(response || {}); },
              error(error) { rej(new Error(error?.message || error?.code || `${func} failed`)); },
              ignoreError: true
            });
          } catch (error) { rej(error); }
        });
      }

      function normalizeSchedule(value) {
        if (value == null || value === '') return '';
        let d = null;
        try {
          if (value instanceof Date && !Number.isNaN(value.getTime())) d = value;
          else if (value && typeof value === 'object' && typeof value.getTime === 'function') {
            const time = Number(value.getTime()); if (Number.isFinite(time)) d = new Date(time);
          } else if (typeof value === 'number' || /^\d{10,13}$/.test(String(value).trim())) {
            let n = Number(value); if (n < 1e12) n *= 1000;
            const candidate = new Date(n); if (!Number.isNaN(candidate.getTime())) d = candidate;
          } else {
            const candidate = new Date(String(value)); if (!Number.isNaN(candidate.getTime())) d = candidate;
          }
        } catch (_) {}
        if (d) {
          const pad = number => String(number).padStart(2, '0');
          return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        }
        return String(value).trim();
      }

      function htmlToText(value, isHtml) {
        let raw = String(value ?? '');
        if (!raw) return '';
        if (isHtml === false || !/<[a-z][\s\S]*>/i.test(raw)) return raw.replace(/\r\n?/g,'\n').trim();
        raw = raw
          .replace(/<\s*br\s*\/?\s*>/gi,'\n')
          .replace(/<\/(?:p|div|li|tr|h[1-6])\s*>/gi,'\n')
          .replace(/<\s*li\b[^>]*>/gi,'• ');
        try {
          const doc = new DOMParser().parseFromString(raw, 'text/html');
          doc.querySelectorAll('script,style,noscript').forEach(el => el.remove());
          return String(doc.body?.textContent || '')
            .replace(/\u00a0/g,' ')
            .replace(/[ \t]+\n/g,'\n')
            .replace(/\n{3,}/g,'\n\n')
            .trim();
        } catch (_) {
          const div = document.createElement('div'); div.innerHTML = raw;
          return String(div.textContent || '').replace(/\u00a0/g,' ').trim();
        }
      }

      function recipientText(value) {
        const format = item => {
          if (typeof item === 'string') return item.trim();
          if (!item || typeof item !== 'object') return '';
          const email = String(item.address || item.email || item.mail || '').trim();
          const name = String(item.name || item.displayName || '').trim();
          return email ? (name ? `${name} <${email}>` : email) : '';
        };
        if (Array.isArray(value)) return value.map(format).filter(Boolean).join('; ');
        return format(value) || String(value || '').trim();
      }

      function attachmentList(value, kind='attachment') {
        const values = Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : [];
        const out = [], seen = new Set();
        for (const item of values) {
          if (!item) continue;
          if (typeof item === 'string') {
            const name = item.trim(); if (!name) continue;
            const key = `${kind}|${name}`.toLowerCase(); if (seen.has(key)) continue; seen.add(key);
            out.push({name,size:0,id:'',url:'',contentType:'',kind});
            continue;
          }
          if (typeof item !== 'object') continue;
          const name = String(item.name || item.fileName || item.filename || item.displayName || '').trim();
          const attachmentId = String(item.id || item.attachmentId || item.aid || item.partId || item.fileId || '').trim();
          const url = String(item.url || item.downloadUrl || item.href || '').trim();
          if (!name && !attachmentId) continue;
          const key = `${kind}|${attachmentId}|${name}`.toLowerCase(); if (seen.has(key)) continue; seen.add(key);
          out.push({
            name: name || `附件 ${attachmentId}`,
            size: Number(item.size || item.fileSize || item.length || 0) || 0,
            id: attachmentId,
            url,
            contentType: String(item.contentType || item.type || '').trim(),
            inlined: !!item.inlined,
            mixed: !!item.mixed,
            kind
          });
        }
        return out;
      }

      // Locked drafts are intentionally not auto-unlocked. The official UI invokes a
      // separate unlock flow first; silently changing lock state during an import would
      // be an unexpected mailbox mutation.
      if (summaryArg?.flags?.locked) {
        return resolve({
          ok:false, id, locked:true, reason:'草稿已锁定；请先在网易邮箱解锁后重新读取',
          subject:String(summaryArg?.subject||''), recipients:String(summaryArg?.toRaw||''),
          body:'', bodyHtml:'', scheduleAt:normalizeSchedule(summaryArg?.scheduleAt||''),
          savedAt:String(summaryArg?.savedAt||''), attachments:[], detailSource:'locked-metadata-only'
        });
      }

      let response, source = 'mbox:restoreDraft', restoreError = null;
      try {
        response = await request('mbox:restoreDraft', { id });
      } catch (error) {
        restoreError = error;
      }

      // Compatibility fallback only. It is deliberately second-choice because the
      // ComposeModule source proves restoreDraft is the native draft-loading endpoint.
      if (!response) {
        source = 'mbox:readMessage-fallback';
        let lastError = restoreError;
        for (const body of [{ mid:id }, { id }]) {
          try { response = await request('mbox:readMessage', body); if (response) break; }
          catch (error) { lastError = error; }
        }
        if (!response) return resolve({ ok:false, id, reason:lastError?.message || '读取草稿详情失败', detailSource:source });
      }

      const root = response?.var ?? response;
      if (!root || typeof root !== 'object') {
        return resolve({ ok:false, id, reason:'草稿详情响应为空', detailSource:source });
      }

      // Native restoreDraft schema consumed by ComposeBase.fillContent():
      // account, to, cc, bcc, showOneRcpt, subject, priority,
      // requestReadReceipt, scheduleDate, content, isHtml, attachments, link.
      const direct = root && !Array.isArray(root) ? root : {};
      let subject = String(direct.subject ?? summaryArg?.subject ?? '').trim();
      let recipients = recipientText(direct.to) || String(summaryArg?.toRaw || '').trim();
      let cc = recipientText(direct.cc);
      let bcc = recipientText(direct.bcc);
      let bodyHtml = direct.content == null ? '' : String(direct.content);
      let isHtml = direct.isHtml !== false;
      let body = htmlToText(bodyHtml, isHtml);
      let attachments = [
        ...attachmentList(direct.attachments, 'attachment'),
        ...attachmentList(direct.link, 'cloud-link')
      ];

      // If NetEase changes the shape, preserve the old defensive traversal as a
      // forward-compatible salvage path rather than returning an empty draft.
      if (!subject || !recipients || !bodyHtml) {
        const keyNorm = value => String(value || '').replace(/[\s_\-]/g,'').toLowerCase();
        const objectQueue = [], seen = new Set();
        if (root && typeof root === 'object') objectQueue.push(root);
        for (let i=0; i<objectQueue.length && i<600; i++) {
          const node = objectQueue[i];
          if (!node || typeof node !== 'object' || seen.has(node)) continue;
          seen.add(node);
          const values = Array.isArray(node) ? node : Object.values(node);
          for (const value of values) if (value && typeof value === 'object') objectQueue.push(value);
        }
        function first(keys, {allowObject=false}={}) {
          const wanted = new Set(keys.map(keyNorm));
          for (const node of objectQueue) {
            if (Array.isArray(node)) continue;
            for (const [key,value] of Object.entries(node)) {
              if (!wanted.has(keyNorm(key)) || value == null) continue;
              if (typeof value === 'object' && !allowObject) continue;
              if (typeof value === 'string' && !value.trim()) continue;
              return value;
            }
          }
          return '';
        }
        if (!subject) subject = String(first(['subject','mailSubject','title']) || summaryArg?.subject || '').trim();
        if (!recipients) recipients = recipientText(first(['to','recipients','recipient','toList'],{allowObject:true})) || String(summaryArg?.toRaw||'').trim();
        if (!bodyHtml) {
          const candidate = first(['content','body','mailContent','html','contentHtml','bodyHtml','text','plainText','mailBody']);
          bodyHtml = String(candidate || '');
          body = htmlToText(bodyHtml, isHtml);
        }
      }

      const scheduledByList = !!summaryArg?.flags?.scheduleDelivery || !!summaryArg?.scheduledDraft;
      // Match NetEase's own Compose restore behavior: for a scheduled draft the list
      // row's sentDate is authoritative and is written back to response.scheduleDate
      // after restoreDraft returns. restoreDraft.scheduleDate is only a fallback.
      const listSchedule = normalizeSchedule(summaryArg?.scheduleAt || (scheduledByList ? summaryArg?.sentAt : ''));
      const restoredSchedule = normalizeSchedule(direct.scheduleDate || direct.scheduleAt || '');
      const scheduleAt = scheduledByList ? (listSchedule || restoredSchedule) : (restoredSchedule || listSchedule);
      const savedAt = String(summaryArg?.savedAt || direct.modifiedDate || direct.saveDate || '').trim();
      const rawKeys = Object.keys(direct).slice(0,80);

      resolve({
        ok:true, id, subject, recipients, cc, bcc, body, bodyHtml, isHtml,
        scheduleAt, savedAt, attachments,
        scheduleEvidence: scheduledByList ? String(summaryArg?.scheduleEvidence || 'mailbox-list') : (restoredSchedule ? 'restoreDraft' : ''),
        account:String(direct.account || '').trim(),
        priority:Number(direct.priority || 0) || 0,
        requestReadReceipt:!!direct.requestReadReceipt,
        showOneRcpt:!!direct.showOneRcpt,
        detailSource:source,
        directSchema:source === 'mbox:restoreDraft',
        rawKeys
      });
    } catch (error) {
      resolve({ ok:false, id:String(summaryArg?.id||''), reason:error?.message || String(error) });
    }
  }), [summary]);
}

async function readDraftImport(tabId, requested = 300) {
  const limit = Math.max(1, Math.min(1000, Number(requested) || 300));
  const listing = await readMailbox(tabId, 2, limit);
  if (!listing?.ok) return { ok:false, reason:listing?.reason || '读取草稿箱失败', listing };
  const summaries = Array.isArray(listing.messages) ? listing.messages : [];
  const details = new Array(summaries.length);
  let cursor = 0;
  const workerCount = Math.min(4, Math.max(1, summaries.length));
  async function worker() {
    while (cursor < summaries.length) {
      const index = cursor++;
      const summary = summaries[index];
      try { details[index] = await readDraftDetail(tabId, summary); }
      catch (error) { details[index] = { ok:false, id:summary?.id || '', reason:error?.message || String(error) }; }
    }
  }
  await Promise.all(Array.from({length:workerCount}, worker));
  return {
    ok:true,
    uid:listing.uid || '',
    total:listing.total || summaries.length,
    read:summaries.length,
    complete:!!listing.complete,
    truncated:!!listing.truncated,
    drafts:summaries.map((summary,index) => ({ ...summary, ...(details[index] || {}), summary })),
    failures:details.filter(item => item && item.ok === false).length
  };
}

importScripts('file-vault.js');

const APP_URL = chrome.runtime.getURL('app.html');
const MAIL_URL = 'https://mail.163.com/';

async function listMailTabs() {
  const tabs = await chrome.tabs.query({ url: ['https://mail.163.com/*'] });
  return tabs.sort((a,b) => Number(b.active)-Number(a.active) || Number(b.lastAccessed||0)-Number(a.lastAccessed||0));
}

async function resolveMailTab(sender, { create = false, focus = false } = {}) {
  let tab = sender?.tab?.url?.startsWith('https://mail.163.com/') ? sender.tab : null;
  if (!tab) tab = (await listMailTabs())[0] || null;
  if (!tab && create) tab = await chrome.tabs.create({ url: MAIL_URL, active: !!focus });
  if (tab && focus) {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }
  return tab;
}

async function waitForExecutor(tabId, timeout = 10000) {
  const started = Date.now(); let lastError = null;
  while (Date.now() - started < timeout) {
    try { const ping = await chrome.tabs.sendMessage(tabId, { type: 'NMDA_PING' }); if (ping?.ok) return ping; }
    catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw lastError || new Error('网易邮箱执行器尚未就绪');
}

async function accountInfo(tabId) {
  return runMain(tabId, () => {
    try {
      const uid = typeof window.$S === 'function' ? (window.$S('uid') || '') : '';
      return { ok: true, uid: String(uid || '') };
    } catch (error) { return { ok: false, reason: error?.message || String(error) }; }
  });
}

async function nativeReadRoute(tabId, { id = '', action = '' } = {}) {
  id = String(id || '').trim();
  action = String(action || '').trim();
  if (!id) return { ok:false, reason:'message-id-missing' };
  return runMain(tabId, (midArg, actionArg) => {
    try {
      const JS = window.$?.JS;
      if (!JS || typeof JS.go !== 'function') return { ok:false, reason:'$.JS.go unavailable' };
      const param = { id:String(midArg || '') };
      if (actionArg) param.action = String(actionArg);
      JS.go({ module:'read.ReadModule', param });
      return { ok:true, method:'$.JS.go/read.ReadModule', id:param.id, action:param.action || '' };
    } catch (error) { return { ok:false, reason:error?.message || String(error) }; }
  }, [id, action]);
}

async function nativeFollowUpStart(tabId, request = {}) {
  const mode = request.mode === 'reply' ? 'reply' : 'forward';
  return nativeReadRoute(tabId, { id:request.sourceMessageId || request.id || '', action:mode });
}

async function connectionStatus(sender) {
  const tab = await resolveMailTab(sender);
  if (!tab?.id) return { ok: true, connected: false, authenticated: false };
  let executor = null;
  try { executor = await chrome.tabs.sendMessage(tab.id, { type: 'NMDA_PING' }); } catch (_) {}
  let account = { ok:false, uid:'' };
  if (executor?.ok) { try { account = await accountInfo(tab.id); } catch (_) {} }
  return {
    ok:true, connected:!!executor?.ok, authenticated:!!String(account?.uid||'').trim(), account:String(account?.uid||''),
    tabId:tab.id, active:!!tab.active, title:tab.title||'', url:tab.url||'', executor:executor?.role||''
  };
}

async function openApp() {
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find(tab => String(tab.url || '').split('#')[0].split('?')[0] === APP_URL);
  if (existing?.id) {
    await chrome.tabs.update(existing.id, { active:true });
    if (existing.windowId !== undefined) await chrome.windows.update(existing.windowId,{focused:true}).catch(()=>{});
    return existing;
  }
  return chrome.tabs.create({ url: APP_URL, active:true });
}

chrome.action.onClicked.addListener(() => { openApp().catch(console.error); });
chrome.runtime.onInstalled.addListener(() => { globalThis.NMDAVault?.cleanup?.().catch(()=>{}); });

function broadcastConnectionChange() {
  chrome.runtime.sendMessage({ type:'NMDA_CONNECTION_CHANGED' }).catch(()=>{});
}
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => { if (String(tab?.url||'').startsWith('https://mail.163.com/') || String(changeInfo.url||'').startsWith('https://mail.163.com/')) broadcastConnectionChange(); });
chrome.tabs.onRemoved.addListener(() => { broadcastConnectionChange(); });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === 'NMDA_CONNECTION_STATUS') return connectionStatus(sender);
    if (message?.type === 'NMDA_OPEN_MAIL') {
      const tab = await resolveMailTab(sender, { create:true, focus:message.focus !== false });
      return { ok:!!tab?.id, tabId:tab?.id || null };
    }
    if (message?.type === 'NMDA_OPEN_APP') { const tab=await openApp(); return {ok:true,tabId:tab?.id||null}; }
    if (message?.type === 'NMDA_BATCH_MONITOR') {
      const tab=await resolveMailTab(sender,{create:false,focus:false});
      if(!tab?.id)return {ok:false,reason:'mailbox-not-connected'};
      await waitForExecutor(tab.id).catch(()=>null);
      try{return await chrome.tabs.sendMessage(tab.id,{type:'NMDA_BATCH_MONITOR',payload:message.payload||{}});}
      catch(error){return {ok:false,reason:error?.message||String(error)};}
    }
    if (message?.type === 'NMDA_BATCH_STOP_REQUEST') {
      chrome.runtime.sendMessage({type:'NMDA_BATCH_STOP_BROADCAST'}).catch(()=>{});
      return {ok:true};
    }

    if (message?.type === 'NMDA_VAULT_META') {
      const meta = await globalThis.NMDAVault.meta(message.id);
      return meta ? { ok:true, ...meta } : { ok:false, reason:'vault-file-not-found' };
    }
    if (message?.type === 'NMDA_VAULT_CHUNK') {
      const base64 = await globalThis.NMDAVault.chunkBase64(message.id, Number(message.offset||0), Number(message.length||262144));
      return base64 === null ? {ok:false,reason:'vault-file-not-found'} : {ok:true,base64};
    }
    if (message?.type === 'NMDA_EXECUTION_PROGRESS') {
      chrome.runtime.sendMessage({ ...message, type:'NMDA_EXECUTION_PROGRESS_BROADCAST', tabId:sender.tab?.id || null }).catch(()=>{});
      return {ok:true};
    }

    const tab = await resolveMailTab(sender);
    const tabId = tab?.id;
    if (!tabId) return { ok:false, reason:'mailbox-not-connected' };

    if (message?.type === 'NMDA_EXECUTE_DRAFT' || message?.type === 'NMDA_EXECUTE_FOLLOWUP') {
      await waitForExecutor(tabId);
      return chrome.tabs.sendMessage(tabId, message);
    }
    if (message?.type === 'NMDA_NATIVE_FOLLOWUP_START') return nativeFollowUpStart(tabId, message);
    if (message?.type === 'NMDA_NATIVE_MESSAGE_OPEN') return nativeReadRoute(tabId, { id:message.sourceMessageId || message.id || '' });
    if (message?.type === 'NMDA_OPEN_COMPOSE') {
      return runMain(tabId, () => {
        try {
          if (window.Interface && typeof window.Interface.compose === 'function') { window.Interface.compose(); return { ok:true, method:'window.Interface.compose' }; }
          return { ok:false, reason:'window.Interface.compose unavailable' };
        } catch (error) { return {ok:false,reason:error?.message||String(error)}; }
      });
    }
    if (message?.type === 'NMDA_ACCOUNT_INFO') return accountInfo(tabId);
    if (message?.type === 'NMDA_READ_MAILBOX_STATE') return readMailboxState(tabId, message.mode === 'full' ? 'full' : 'quick');
    if (message?.type === 'NMDA_READ_SENT') return readMailbox(tabId,3,message.limit ?? 200);
    if (message?.type === 'NMDA_READ_DRAFTS') return readMailbox(tabId,2,message.limit ?? 200);
    if (message?.type === 'NMDA_READ_INBOX') return readMailbox(tabId,1,message.limit ?? 500);
    if (message?.type === 'NMDA_READ_MESSAGE_DETAIL') return readMessageDetail(tabId,message.summary || {id:message.id||''});
    if (message?.type === 'NMDA_IMPORT_DRAFTS') return readDraftImport(tabId,message.limit ?? 300);
    return {ok:false,reason:'unknown-message'};
  })().then(sendResponse).catch(error => sendResponse({ok:false,reason:error?.message||String(error)}));
  return true;
});
