(() => {
  'use strict';

  const Contacts = globalThis.NMDAContacts;
  const DefaultPolicy = globalThis.NMDADefaultPolicy;
  const SETTINGS_KEY = 'nmda.followup.settings.v1';
  const REGISTRY_KEY = 'nmda.followup.import.registry.v1';
  const state = {
    account: '',
    contacts: {},
    settings: null,
    selected: new Set(),
    search: '',
    filter: 'eligible',
    loading: false
  };

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const $ = selector => document.querySelector(selector);

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[ch]));
  }

  function firstEmail(value) {
    return String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase() || '';
  }

  async function send(message) {
    if (!globalThis.chrome?.runtime?.sendMessage) throw new Error('历史邮件导入仅在 Chrome 扩展中可用。');
    return chrome.runtime.sendMessage(message);
  }

  async function storageGet(key) {
    if (!globalThis.chrome?.storage?.local) return {};
    return chrome.storage.local.get(key);
  }

  async function storageSet(values) {
    if (!globalThis.chrome?.storage?.local) return;
    return chrome.storage.local.set(values);
  }

  function defaultSettings() {
    const policy = DefaultPolicy?.followUp || {};
    return { ...policy };
  }

  function normalizeSettings(value = {}) {
    const base = defaultSettings();
    return {
      ...base,
      ...value,
      mode: ['forward','reply','new'].includes(value.mode) ? value.mode : base.mode,
      minDays: Math.max(0, Math.min(365, Number(value.minDays ?? base.minDays) || 0)),
      maxCount: Math.max(0, Math.min(20, Number(value.maxCount ?? base.maxCount) || 0)),
      blockHumanReply: value.blockHumanReply == null ? !!base.blockHumanReply : value.blockHumanReply !== false,
      blockAutoReply: value.blockAutoReply == null ? !!base.blockAutoReply : value.blockAutoReply === true,
      fwPrefix: String(value.fwPrefix ?? base.fwPrefix ?? '').trim(),
      rePrefix: String(value.rePrefix ?? base.rePrefix ?? '').trim(),
      template: String(value.template ?? base.template)
    };
  }

  async function loadSettings() {
    const stored = (await storageGet(SETTINGS_KEY))[SETTINGS_KEY];
    state.settings = normalizeSettings(stored || {});
    return state.settings;
  }

  async function saveSettings() {
    state.settings = normalizeSettings({
      mode: $('#nmda-history-mode')?.value,
      minDays: $('#nmda-history-min-days')?.value,
      maxCount: $('#nmda-history-max-count')?.value,
      blockHumanReply: $('#nmda-history-block-human')?.checked,
      blockAutoReply: $('#nmda-history-block-auto')?.checked,
      fwPrefix: state.settings?.fwPrefix,
      rePrefix: state.settings?.rePrefix,
      template: $('#nmda-history-template')?.value ?? state.settings?.template
    });
    await storageSet({ [SETTINGS_KEY]: state.settings });
    return state.settings;
  }

  async function detectAccount() {
    const result = await send({ type:'NMDA_ACCOUNT_INFO' });
    const account = Contacts?.normalizeEmail?.(result?.uid || '') || String(result?.uid || '').toLowerCase();
    if (!result?.ok || !account) throw new Error('没有检测到已登录的网易邮箱账号。');
    return account;
  }

  function stripPrefix(subject) {
    return String(subject || '').replace(/^\s*(?:(?:re|fw|fwd)\s*:\s*)+/i, '').trim();
  }

  function sortedSentHistory(contact) {
    return [...(contact?.history || [])]
      .filter(item => item?.id)
      .sort((a,b) => (Date.parse(b.sentAt || '') || 0) - (Date.parse(a.sentAt || '') || 0));
  }

  function sourceFor(contact) {
    const history = sortedSentHistory(contact);
    return history.find(item => !/^\s*(?:fw|fwd|re)\s*:/i.test(String(item.subject || ''))) || history[0] || null;
  }

  function repliesAfter(contact, sentAt) {
    const floor = Date.parse(sentAt || '') || 0;
    return [...(contact?.replyHistory || [])]
      .filter(item => (Date.parse(item.receivedAt || '') || 0) > floor)
      .sort((a,b) => (Date.parse(b.receivedAt || '') || 0) - (Date.parse(a.receivedAt || '') || 0));
  }

  function eligibility(contact, settings = state.settings || defaultSettings()) {
    contact = Contacts?.normalizeContactShape?.(contact || {}) || contact || {};
    const source = sourceFor(contact);
    if (!source) return { eligible:false, source:null, reasons:['没有已发送原邮件'], days:0, human:[], auto:[] };
    const sourceMs = Date.parse(source.sentAt || '') || 0;
    const days = sourceMs ? Math.max(0, Math.floor((Date.now() - sourceMs) / 86400000)) : 0;
    const replies = repliesAfter(contact, source.sentAt);
    const human = replies.filter(item => !item.autoReply);
    const auto = replies.filter(item => item.autoReply);
    const reasons = [];
    if (contact.policy === '暂停') reasons.push('联系人已暂停');
    if (contact.policy === '不再联系') reasons.push('联系人已设为不再联系');
    if (days < settings.minDays) reasons.push(`仅等待 ${days} 天`);
    if (settings.blockHumanReply && human.length) reasons.push('已有真人回复');
    if (settings.blockAutoReply && auto.length) reasons.push('已有 Auto Reply');
    if (settings.maxCount > 0 && Number(contact.followUpCount || 0) >= settings.maxCount) reasons.push(`已达到 ${settings.maxCount} 次上限`);
    return { eligible:reasons.length === 0, source, reasons, days, human, auto };
  }

  function renderTemplate(template, contact, source, days) {
    const vars = {
      name: contact.name || '',
      email: contact.email || '',
      subject: stripPrefix(source.subject || ''),
      days: String(days || 0)
    };
    return String(template || '').replace(/{{\s*(name|email|subject|days)\s*}}/gi, (_, key) => vars[String(key).toLowerCase()] ?? '');
  }

  function expectedSubject(source, settings) {
    const base = stripPrefix(source?.subject || '');
    if (settings.mode === 'forward') return `${settings.fwPrefix} ${base}`.trim();
    if (settings.mode === 'reply') return `${settings.rePrefix} ${base}`.trim();
    return base;
  }

  async function loadContacts() {
    state.account = await detectAccount();
    state.contacts = Contacts ? await Contacts.load(state.account) : {};
    return state.contacts;
  }

  async function syncThroughExistingMailboxReader() {
    const connection = await send({ type:'NMDA_CONNECTION_STATUS' });
    if (!connection?.connected || !connection?.authenticated) throw new Error('请先连接并登录网易邮箱。');
    state.account = await detectAccount();
    state.contacts = Contacts ? await Contacts.load(state.account) : {};
    const result = await send({ type:'NMDA_READ_MAILBOX_STATE', mode:'quick' });
    if(!result?.ok)throw new Error(result?.reason || '邮箱读取失败');
    const next=Contacts.cloneContacts(state.contacts);
    Contacts.applySentMessages(next,result.sent?.messages||[]);
    Contacts.applyDraftMessages(next,result.drafts?.messages||[],{replaceActive:result.drafts?.complete===true});
    Contacts.applyInboxMessages(next,result.inbox?.messages||[]);
    await Contacts.save(state.account,next);
    state.contacts=next;
    return next;
  }

  async function loadRegistry() {
    const stored = (await storageGet(REGISTRY_KEY))[REGISTRY_KEY];
    const entries = Array.isArray(stored?.entries) ? stored.entries : [];
    return { version:1, entries };
  }

  async function appendRegistry(entries) {
    const registry = await loadRegistry();
    const existing = new Map(registry.entries.map(item => [item.id, item]));
    for (const entry of entries) existing.set(entry.id, entry);
    const cutoff = Date.now() - 45 * 86400000;
    registry.entries = [...existing.values()].filter(item => {
      if (!item) return false;
      if (item.status === 'completed' && Date.parse(item.completedAt || 0) < cutoff) return false;
      return true;
    }).slice(-500);
    await storageSet({ [REGISTRY_KEY]: registry });
  }

  function pendingRegistryByEmail(registry) {
    const map = new Map();
    for (const entry of registry?.entries || []) {
      if (entry?.status !== 'pending') continue;
      const email = firstEmail(entry.email);
      if (!email) continue;
      if (!map.has(email)) map.set(email, []);
      map.get(email).push(entry);
    }
    return map;
  }

  function setStatus(message, tone = '') {
    const el = $('#nmda-history-status');
    if (!el) return;
    el.textContent = String(message || '');
    el.dataset.tone = tone;
  }

  function syncSettingControls() {
    const settings = state.settings || defaultSettings();
    if ($('#nmda-history-mode')) $('#nmda-history-mode').value = settings.mode;
    if ($('#nmda-history-min-days')) $('#nmda-history-min-days').value = String(settings.minDays);
    if ($('#nmda-history-max-count')) $('#nmda-history-max-count').value = String(settings.maxCount);
    if ($('#nmda-history-block-human')) $('#nmda-history-block-human').checked = !!settings.blockHumanReply;
    if ($('#nmda-history-block-auto')) $('#nmda-history-block-auto').checked = !!settings.blockAutoReply;
    if ($('#nmda-history-template')) $('#nmda-history-template').value = settings.template;
  }

  async function renderCandidates() {
    if (!Contacts) return;
    const body = $('#nmda-history-body');
    const summary = $('#nmda-history-summary');
    if (!body || !summary) return;
    const query = String($('#nmda-history-search')?.value || '').trim().toLowerCase();
    const filter = 'eligible';
    state.search = query;
    state.filter = filter;
    const registry = await loadRegistry();
    const pending = pendingRegistryByEmail(registry);
    const rows = [];
    for (const raw of Object.values(state.contacts || {})) {
      const contact = Contacts.normalizeContactShape(raw);
      if (!Number(contact.sentCount || 0)) continue;
      const check = eligibility(contact);
      const haystack = `${contact.email} ${contact.name || ''} ${check.source?.subject || ''}`.toLowerCase();
      if (query && !haystack.includes(query)) continue;
      if (filter === 'eligible' && !check.eligible) continue;
      if (filter === 'human' && !check.human.length) continue;
      if (filter === 'auto' && !check.auto.length) continue;
      if (filter === 'pending' && !(pending.get(contact.email)?.length)) continue;
      rows.push({ contact, check, alreadyPending:pending.get(contact.email)?.length || 0 });
    }
    rows.sort((a,b) => {
      if (a.check.eligible !== b.check.eligible) return a.check.eligible ? -1 : 1;
      return (Date.parse(a.check.source?.sentAt || '') || 0) - (Date.parse(b.check.source?.sentAt || '') || 0);
    });
    const eligibleCount = Object.values(state.contacts || {}).filter(raw => Number(raw?.sentCount || 0) && eligibility(raw).eligible).length;
    summary.textContent = `${eligibleCount} 个可导入 · 当前显示 ${rows.length}`;
    body.innerHTML = rows.length ? rows.map(({contact,check,alreadyPending}) => {
      const disabled = !check.eligible || alreadyPending > 0;
      const reply = check.human.length ? '真人回复' : check.auto.length ? 'Auto Reply' : '无回复';
      const stateText = alreadyPending ? '已在当前任务中' : check.eligible ? `已等待 ${check.days} 天` : check.reasons.join('；');
      return `<tr data-email="${escapeHtml(contact.email)}">
        <td><input type="checkbox" data-history-select="${escapeHtml(contact.email)}" ${state.selected.has(contact.email) ? 'checked' : ''} ${disabled ? 'disabled' : ''}></td>
        <td class="nmda-history-contact"><strong>${escapeHtml(contact.name || contact.email)}</strong><small>${escapeHtml(contact.name ? contact.email : '')}</small></td>
        <td class="nmda-history-source"><strong title="${escapeHtml(check.source?.subject || '')}">${escapeHtml(check.source?.subject || '(无主题)')}</strong><small>${escapeHtml(Contacts.formatDisplayTime(check.source?.sentAt || ''))}</small></td>
        <td><span class="nmda-history-reply" data-kind="${check.human.length ? 'human' : check.auto.length ? 'auto' : 'none'}">${escapeHtml(reply)}</span></td>
        <td class="nmda-history-state" data-ok="${check.eligible && !alreadyPending ? '1' : '0'}">${escapeHtml(stateText)}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="5" class="nmda-history-empty">没有匹配的历史邮件。</td></tr>';
    const validVisible = rows.filter(row => row.check.eligible && !row.alreadyPending).map(row => row.contact.email);
    state.selected = new Set([...state.selected].filter(email => validVisible.includes(email)));
    updateSelectedCount();
  }

  function updateSelectedCount() {
    const el = $('#nmda-history-selected');
    const button = $('#nmda-history-import-selected');
    if (el) el.textContent = `已选 ${state.selected.size} 封`;
    if (button) button.disabled = !state.selected.size || state.loading;
  }

  function createModal() {
    if ($('#nmda-history-import-modal')) return;
    const panel = $('#nmda-panel') || document.body;
    const overlay = document.createElement('div');
    overlay.id = 'nmda-history-import-modal';
    overlay.className = 'nmda-workflow-modal-overlay nmda-history-import-modal';
    overlay.hidden = true;
    overlay.innerHTML = `
      <section class="nmda-workflow-dialog nmda-history-dialog" role="dialog" aria-modal="true" aria-labelledby="nmda-history-title">
        <header class="nmda-workflow-dialog-head">
          <div><span class="nmda-dialog-eyebrow">导入来源</span><h3 id="nmda-history-title">处理待跟进邮件</h3><p>这里只显示当前规则判断为需要处理的历史邮件；导入后与普通任务走同一套核验、排期与执行流程。</p></div>
          <button class="nmda-dialog-close" id="nmda-history-close" type="button" aria-label="关闭">×</button>
        </header>
        <div class="nmda-history-body-wrap">
          <div class="nmda-history-toolbar">
            <label class="nmda-history-search"><span>⌕</span><input id="nmda-history-search" type="search" placeholder="搜索联系人或原主题"></label>
            <button class="nmda-btn nmda-btn-small" id="nmda-history-sync" type="button">同步邮箱</button>
          </div>
          <div class="nmda-history-rulebar">
            <label><span>形式</span><select id="nmda-history-mode"><option value="forward">Fw / 原生转发</option><option value="reply">Re / 原生回复</option><option value="new">新邮件</option></select></label>
            <label><span>最少等待</span><input id="nmda-history-min-days" type="number" min="0" max="365" step="1"><b>天</b></label>
            <label><span>最多次数</span><input id="nmda-history-max-count" type="number" min="0" max="20" step="1"></label>
            <label class="nmda-history-check"><input id="nmda-history-block-human" type="checkbox"><span>真人回复后停止</span></label>
            <label class="nmda-history-check"><input id="nmda-history-block-auto" type="checkbox"><span>Auto Reply 也停止</span></label>
            <details class="nmda-history-template"><summary>正文模板</summary><textarea id="nmda-history-template" rows="6"></textarea><small>变量：{{name}} · {{email}} · {{subject}} · {{days}}</small></details>
          </div>
          <div class="nmda-history-list-head"><div><strong>历史邮件</strong><small id="nmda-history-status">读取已同步的联系人记录。</small></div><span id="nmda-history-summary">0 个可导入</span></div>
          <div class="nmda-table-wrap nmda-history-table-wrap"><table class="nmda-table nmda-history-table"><thead><tr><th></th><th>联系人</th><th>原邮件</th><th>回复</th><th>状态</th></tr></thead><tbody id="nmda-history-body"></tbody></table></div>
        </div>
        <footer class="nmda-workflow-dialog-foot nmda-history-foot"><span id="nmda-history-selected">已选 0 封</span><div class="nmda-dialog-foot-spacer"></div><button class="nmda-btn nmda-btn-small nmda-btn-quiet" id="nmda-history-cancel" type="button">取消</button><button class="nmda-btn nmda-btn-primary nmda-btn-small" id="nmda-history-import-selected" type="button" disabled>导入所选</button></footer>
      </section>`;
    panel.appendChild(overlay);

    const close = () => { overlay.hidden = true; };
    $('#nmda-history-close')?.addEventListener('click', close);
    $('#nmda-history-cancel')?.addEventListener('click', close);
    overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
    $('#nmda-history-search')?.addEventListener('input', () => renderCandidates().catch(()=>{}));
    $('#nmda-history-body')?.addEventListener('change', event => {
      const input = event.target.closest?.('[data-history-select]');
      if (!input) return;
      const email = input.dataset.historySelect;
      if (input.checked) state.selected.add(email); else state.selected.delete(email);
      updateSelectedCount();
    });
    ['nmda-history-mode','nmda-history-min-days','nmda-history-max-count','nmda-history-block-human','nmda-history-block-auto'].forEach(id => {
      $(`#${id}`)?.addEventListener('change', async () => { await saveSettings(); state.selected.clear(); await renderCandidates(); });
    });
    let templateTimer = 0;
    $('#nmda-history-template')?.addEventListener('input', () => {
      clearTimeout(templateTimer);
      templateTimer = setTimeout(() => saveSettings().catch(()=>{}), 250);
    });
    $('#nmda-history-sync')?.addEventListener('click', async event => {
      const button = event.currentTarget;
      button.disabled = true;
      setStatus('正在同步已发送、草稿与回复记录…');
      try {
        await syncThroughExistingMailboxReader();
        setStatus('邮箱记录已同步。', 'ok');
        state.selected.clear();
        await renderCandidates();
      } catch (error) {
        setStatus(`同步失败：${error.message}`, 'error');
      } finally { button.disabled = false; }
    });
    $('#nmda-history-import-selected')?.addEventListener('click', () => importSelected().catch(error => setStatus(`导入失败：${error.message}`, 'error')));
  }

  async function openModal() {
    createModal();
    const modal = $('#nmda-history-import-modal');
    if (!modal) return;
    modal.hidden = false;
    setStatus('正在读取已同步的联系人记录…');
    try {
      await Promise.all([loadSettings(), loadContacts()]);
      syncSettingControls();
      state.selected.clear();
      await renderCandidates();
      setStatus('选择需要处理的原邮件，然后加入当前任务。', 'ok');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  async function mapPool(items, limit, worker) {
    const out = new Array(items.length);
    let cursor = 0;
    const runners = Array.from({ length:Math.min(limit, Math.max(1, items.length)) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        out[index] = await worker(items[index], index);
      }
    });
    await Promise.all(runners);
    return out;
  }

  async function buildImportedTask(email) {
    const contact = Contacts.normalizeContactShape(state.contacts[email] || {});
    const check = eligibility(contact);
    if (!check.eligible || !check.source) throw new Error(`${email} 当前不符合导入规则。`);
    const detail = await send({ type:'NMDA_READ_MESSAGE_DETAIL', summary:check.source });
    if (!detail?.ok) throw new Error(`${email}：${detail?.reason || '无法读取原邮件详情'}`);
    const settings = state.settings || defaultSettings();
    const introText = renderTemplate(settings.template, contact, check.source, check.days).trim();
    const modeLabel = settings.mode === 'forward' ? 'Fw 转发' : settings.mode === 'reply' ? 'Re 回复' : '新邮件';
    const reviewMarker = `\n\n—— 原邮件上下文（执行时由网易原生 ${modeLabel} 保留）——\n`;
    const sourceHeader = [
      `From: ${detail.from || ''}`,
      `Date: ${detail.date || check.source.sentAt || ''}`,
      `Subject: ${detail.subject || check.source.subject || ''}`,
      `To: ${detail.to || contact.email || ''}`
    ].join('\n');
    const reviewBody = `${introText}${reviewMarker}${sourceHeader}\n\n${detail.body || ''}`.trim();
    const id = `fuimp:${Date.now()}:${Math.random().toString(36).slice(2,9)}`;
    const subject = expectedSubject(check.source, settings);
    return {
      task: {
        id,
        recipients: contact.email,
        subject,
        body: reviewBody,
        tags: '历史邮件导入'
      },
      registry: {
        id,
        status:'pending',
        createdAt:new Date().toISOString(),
        updatedAt:new Date().toISOString(),
        account:state.account,
        email:contact.email,
        name:contact.name || '',
        mode:settings.mode,
        sourceMessageId:String(check.source.id || ''),
        sourceSubject:String(detail.subject || check.source.subject || ''),
        sourceBody:String(detail.body || ''),
        sourceIsHtml:detail.isHtml !== false,
        sourceFrom:String(detail.from || ''),
        sourceTo:String(detail.to || ''),
        sourceCc:String(detail.cc || ''),
        sourceDate:String(detail.date || check.source.sentAt || ''),
        sourceAttachments:Array.isArray(detail.attachments) ? detail.attachments.map(item => ({name:String(item?.name || ''),size:Number(item?.size || 0) || 0})).filter(item => item.name) : [],
        attachmentInventoryKnown:detail.attachmentInventoryKnown === true,
        hasAttachmentsHint:detail.hasAttachmentsHint === true || check.source.hasAttachmentsHint === true,
        attachmentCountHint:Number(detail.attachmentCountHint || check.source.attachmentCountHint || 0) || 0,
        introText,
        expectedSubject:subject,
        reviewMarker
      }
    };
  }

  async function importSelected() {
    if (!state.selected.size || state.loading) return;
    state.loading = true;
    updateSelectedCount();
    await saveSettings();
    const emails = [...state.selected];
    setStatus(`正在读取 ${emails.length} 封原邮件详情…`);
    const results = await mapPool(emails, 3, async email => {
      try { return { ok:true, value:await buildImportedTask(email) }; }
      catch (error) { return { ok:false, email, error }; }
    });
    const good = results.filter(item => item.ok).map(item => item.value);
    const failed = results.filter(item => !item.ok);
    if (!good.length) {
      state.loading = false;
      updateSelectedCount();
      throw new Error(failed.map(item => item.error?.message || item.email).join('；') || '没有可导入邮件。');
    }

    await appendRegistry(good.map(item => item.registry));
    const input = $('#nmda-import-file');
    if (!input) throw new Error('当前批次导入器尚未就绪。');
    const file = new File([JSON.stringify(good.map(item => item.task), null, 2)], `history-task-${Date.now()}.json`, { type:'application/json' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles:true }));

    state.selected.clear();
    state.loading = false;
    updateSelectedCount();
    const modal = $('#nmda-history-import-modal');
    if (modal) modal.hidden = true;
    await refreshPendingEntry();
    const note = failed.length ? `；${failed.length} 封读取失败，可重新打开待处理列表重试` : '';
    const importStatus = $('#nmda-import-status');
    if (importStatus) {
      importStatus.textContent = `已把 ${good.length} 封历史邮件加入当前批次${note}。已进入统一任务流程。`;
      importStatus.dataset.kind = failed.length ? 'warn' : 'ok';
    }
  }

  function eligiblePendingCount() {
    return Object.values(state.contacts || {}).filter(raw => Number(raw?.sentCount || 0) && eligibility(raw).eligible).length;
  }

  async function refreshPendingEntry() {
    const button=$('#nmda-history-pending');
    if(!button)return;
    try{
      await Promise.all([loadSettings(),loadContacts()]);
      const count=eligiblePendingCount();
      button.hidden=count===0;
      button.textContent=count?`待处理 ${count}`:'待处理';
    }catch(_){button.hidden=true;}
  }

  function installImportEntry() {
    const actions = $('#nmda-import-card .nmda-card-head .nmda-row');
    if (!actions || $('#nmda-history-pending')) return;
    const button = document.createElement('button');
    button.id = 'nmda-history-pending';
    button.type = 'button';
    button.className = 'nmda-btn nmda-btn-small nmda-btn-quiet';
    button.hidden = true;
    button.textContent = '待处理';
    actions.insertBefore(button, actions.firstChild);
    button.addEventListener('click', () => openModal().catch(error => console.warn('[NMDA] history pending failed', error)));
    setTimeout(()=>refreshPendingEntry(),500);
    window.addEventListener('focus',()=>refreshPendingEntry().catch(()=>{}));
  }


  function relabelProduct() {
    const batchTab = $('[data-tab="batch"] strong');
    if (batchTab) batchTab.textContent = '外联任务';
    const batchTitle = $('[data-page-head="batch"] h2');
    if (batchTitle) batchTitle.textContent = '外联任务';
    const batchDesc = $('[data-page-head="batch"] p');
    if (batchDesc) batchDesc.textContent = '导入 → 自动识别 → 核验异常 → 排期 → 执行';
  }

  function init() {
    if (!$('#nmda-root')) return;
    relabelProduct();
    installImportEntry();
    createModal();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once:true });
  else queueMicrotask(init);
})();
