(() => {
  'use strict';

  const Contacts = globalThis.NMDAContacts;
  if (!Contacts || typeof document === 'undefined') return;

  const $ = selector => document.querySelector(selector);
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const firstEmail = value => String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase() || '';
  let current = { account:'', email:'', contacts:null };

  async function send(message) {
    if (!globalThis.chrome?.runtime?.sendMessage) return null;
    try { return await chrome.runtime.sendMessage(message); } catch (_) { return null; }
  }

  async function account() {
    const result = await send({ type:'NMDA_ACCOUNT_INFO' });
    return Contacts.normalizeEmail(result?.uid || '') || 'default';
  }

  function interactionState(contact) {
    return Contacts.interactionState?.(contact) || (Number(contact?.humanReplyCount || 0) > 0 ? '已回复' : Number(contact?.sentCount || 0) > 0 ? '已发送' : '未联系');
  }

  function recentEvents(contact) {
    const events = [];
    for (const item of contact?.history || []) events.push({ at:item.sentAt, kind:'已发送', subject:item.subject || '(无主题)' });
    for (const item of contact?.replyHistory || []) events.push({ at:item.receivedAt, kind:item.autoReply ? 'Auto Reply' : '真人回复', subject:item.subject || '(无主题)' });
    for (const item of contact?.draftHistory || []) events.push({ at:item.savedAt, kind:'草稿', subject:item.subject || '(无主题)' });
    return events.filter(item => item.at).sort((a,b)=>(Date.parse(b.at)||0)-(Date.parse(a.at)||0)).slice(0,8);
  }

  function ensureDrawer() {
    let drawer = $('#nmda-contact-evidence');
    if (drawer) return drawer;
    const panel = $('#nmda-panel') || document.body;
    drawer = document.createElement('aside');
    drawer.id = 'nmda-contact-evidence';
    drawer.className = 'nmda-contact-evidence';
    drawer.hidden = true;
    drawer.innerHTML = `
      <header><div><span>联系人证据</span><strong id="nmda-evidence-title">联系人</strong><small id="nmda-evidence-email"></small></div><button id="nmda-evidence-close" type="button" aria-label="关闭">×</button></header>
      <div class="nmda-evidence-body">
        <div class="nmda-evidence-facts" id="nmda-evidence-facts"></div>
        <label class="nmda-evidence-policy"><span>联系策略</span><select id="nmda-evidence-policy"><option value="正常">允许联系</option><option value="暂停">暂停</option><option value="不再联系">永久停止</option></select></label>
        <div class="nmda-evidence-history"><div class="nmda-evidence-section-title">最近记录</div><div id="nmda-evidence-history"></div></div>
      </div>`;
    panel.appendChild(drawer);
    $('#nmda-evidence-close')?.addEventListener('click', () => { drawer.hidden = true; });
    $('#nmda-evidence-policy')?.addEventListener('change', async event => {
      if (!current.contacts || !current.email) return;
      Contacts.setPolicy(current.contacts, current.email, event.target.value);
      await Contacts.save(current.account, current.contacts);
      document.dispatchEvent(new CustomEvent('nmda:contact-policy-changed', { detail:{ email:current.email, policy:event.target.value } }));
      await render(current.email);
    });
    return drawer;
  }

  async function render(email) {
    email = Contacts.normalizeEmail(email);
    if (!email) return;
    const drawer = ensureDrawer();
    const acct = await account();
    const contacts = await Contacts.load(acct);
    const contact = Contacts.normalizeContactShape(contacts[email] || Contacts.ensureContact(contacts, email), email);
    current = { account:acct, email, contacts };
    const state = interactionState(contact);
    const title = $('#nmda-evidence-title'), emailEl = $('#nmda-evidence-email'), policy = $('#nmda-evidence-policy');
    if (title) title.textContent = contact.name || email;
    if (emailEl) emailEl.textContent = contact.name ? email : '';
    if (policy) policy.value = contact.policy || '正常';
    const facts = $('#nmda-evidence-facts');
    if (facts) facts.innerHTML = [
      [state,'当前互动'],
      [Number(contact.sentCount||0),'已发送'],
      [Number(contact.draftCount||0),'草稿'],
      [Number(contact.humanReplyCount||0),'真人回复'],
      [Number(contact.autoReplyCount||0),'Auto Reply']
    ].map(([value,label]) => `<div><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`).join('');
    const history = $('#nmda-evidence-history');
    const events = recentEvents(contact);
    if (history) history.innerHTML = events.length ? events.map(item => `<article><div><strong>${escapeHtml(item.kind)}</strong><span>${escapeHtml(Contacts.formatDisplayTime(item.at))}</span></div><small>${escapeHtml(item.subject)}</small></article>`).join('') : '<div class="nmda-evidence-empty">暂无邮箱记录。</div>';
    drawer.hidden = false;
  }

  document.addEventListener('click', event => {
    const cell = event.target.closest?.('.nmda-recipient-cell');
    if (!cell) return;
    const email = firstEmail(cell.getAttribute('title') || cell.textContent || '');
    if (!email) return;
    event.preventDefault();
    render(email).catch(error => console.warn('[NMDA] contact evidence', error));
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      const drawer = $('#nmda-contact-evidence');
      if (drawer && !drawer.hidden) drawer.hidden = true;
    }
  });
})();
