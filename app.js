(() => {
  'use strict';

  if (window.top !== window || document.getElementById('nmda-root')) return;

  const Importer = globalThis.NMDAImporter;
  const Recognizer = globalThis.NMDAMailRecognizer;
  const Scheduler = globalThis.NMDAScheduler;
  const Preferences = globalThis.NMDAPreferences || globalThis.NMDAPolicyProfile;
  const Contacts = globalThis.NMDAContacts;
  const Roster = globalThis.NMDARoster;
  const Vault = globalThis.NMDAVault;

  const runtime = globalThis.chrome?.runtime || null;
  const canRuntime = !!runtime?.sendMessage;
  const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

  const state = {
    token: 0,
    busy: false,
    executing: false,
    stopRequested: false,
    dataset: null,
    sourceRoles: new Map(),
    taskEdits: new Map(),
    tasks: [],
    attachmentFiles: [],
    roster: { entries: [], warnings: [], stats: {} },
    contacts: null,
    contactAccount: '',
    connection: null,
    selected: new Set(),
    filter: 'all',
    editKey: '',
    schedulePlan: null,
    execution: { done:0, failed:0, total:0 },
    runState: new Map(),
    status: { text:'加入邮件资料后开始。', tone:'' }
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  }

  function uniqueFiles(files) {
    const seen = new Set(), out = [];
    for (const file of files || []) {
      if (!file) continue;
      const key = Importer?.fileIdentity?.(file) || `${file.name}|${file.size}|${file.lastModified}`;
      if (seen.has(key)) continue;
      seen.add(key); out.push(file);
    }
    return out;
  }

  function emailOf(value) { return String(value || '').match(EMAIL_RE)?.[0]?.toLowerCase() || ''; }
  function normalizeText(value) { return String(value ?? '').normalize('NFKC').trim(); }
  function recipientValid(value) {
    const parts = String(value || '').split(/[;,，；\n]+/).map(x => x.trim()).filter(Boolean);
    return parts.length > 0 && parts.every(part => EMAIL_RE.test(part.replace(/^.*<([^>]+)>.*$/, '$1')));
  }
  function fileName(file) { return String(file?.webkitRelativePath || file?._nmdaPath || file?.name || ''); }
  function taskKey(setIndex, rowIndex) { return `${setIndex}:${rowIndex}`; }

  function setStatus(text, tone = '') {
    state.status = { text:String(text || ''), tone };
    const el = document.getElementById('nmda-import-status');
    if (el) { el.textContent = state.status.text; el.dataset.kind = tone; }
  }

  async function send(message) {
    if (!canRuntime) return null;
    return runtime.sendMessage(message);
  }

  function suggestedStart() {
    if (Preferences?.suggestedStart) return Preferences.suggestedStart();
    const d = new Date(Date.now() + 60 * 60000); d.setMinutes(0, 0, 0);
    return Scheduler?.formatLocalDateTime?.(d) || '';
  }

  function effectiveRules() {
    const base = Preferences?.effectiveSchedule?.() || Preferences?.getEffectivePreferences?.()?.schedule || Scheduler?.DEFAULT_RULES || {};
    return {
      ...base,
      startAt: document.getElementById('nmda-schedule-start')?.value || suggestedStart(),
      policySource:'explicit', __explicit:true
    };
  }

  function buildShell() {
    const root = document.createElement('div');
    root.id = 'nmda-root';
    root.innerHTML = `
      <section id="nmda-panel" aria-label="网易邮箱外联工作台">
        <header class="nmda-topbar">
          <div class="nmda-brand"><span class="nmda-brand-mark">N</span><div><strong>网易邮箱外联工作台</strong><small>导入 → 核验 → 排期 → 创建草稿</small></div></div>
          <div class="nmda-top-actions">
            <div id="nmda-connection" class="nmda-connection" data-state="checking"><span></span><div><strong>检查邮箱连接</strong><small>网易邮箱</small></div></div>
            <button id="nmda-open-mail" class="nmda-btn" type="button">连接邮箱</button>
          </div>
        </header>

        <main class="nmda-workbench">
          <section id="nmda-import-card" class="nmda-card nmda-source-card">
            <div class="nmda-card-head">
              <div><span class="nmda-kicker">1 · 来源</span><h2>加入邮件资料</h2><p>文件加入后直接生成任务；不会自动跳页，也不会在后台替你推进流程。</p></div>
              <div class="nmda-row"><button id="nmda-reset" class="nmda-btn nmda-btn-quiet" type="button">清空批次</button></div>
            </div>
            <input id="nmda-import-file" type="file" multiple hidden accept=".xlsx,.xls,.ods,.fods,.docx,.docm,.dotx,.doc,.csv,.tsv,.psv,.json,.jsonl,.ndjson,.txt,.html,.htm,.xml,.zip,.pdf,.ppt,.pptx,.rtf,.png,.jpg,.jpeg,.gif,.webp,.svg,.rar,.7z">
            <input id="nmda-import-dir" type="file" webkitdirectory multiple hidden>
            <div id="nmda-drop" class="nmda-drop" tabindex="0" role="button">
              <strong>拖入文件或文件夹</strong><span>也可以点击选择文件；DOCX / XLSX / PDF / ZIP 等均走同一个入口</span>
            </div>
            <div class="nmda-source-actions">
              <button id="nmda-pick-files" class="nmda-btn nmda-btn-primary" type="button">选择文件</button>
              <button id="nmda-pick-folder" class="nmda-btn" type="button">选择文件夹</button>
              <button id="nmda-toggle-paste" class="nmda-btn nmda-btn-quiet" type="button">粘贴文本</button>
              <button id="nmda-import-drafts" class="nmda-btn nmda-btn-quiet" type="button">读取草稿箱</button>
            </div>
            <div id="nmda-paste-box" class="nmda-paste" hidden><textarea id="nmda-paste-source" rows="7" placeholder="粘贴邮件正文、表格或 JSON"></textarea><button id="nmda-paste-import" class="nmda-btn nmda-btn-primary" type="button">加入当前批次</button></div>
            <div id="nmda-import-status" class="nmda-status">加入邮件资料后开始。</div>
            <div id="nmda-source-summary" class="nmda-summary-grid" hidden></div>
            <div id="nmda-source-roles" class="nmda-source-roles" hidden></div>
          </section>

          <section id="nmda-review-card" class="nmda-card" hidden>
            <div class="nmda-card-head">
              <div><span class="nmda-kicker">2 · 核验</span><h2>邮件任务</h2><p>完整任务自动通过；只对缺失、冲突、附件未匹配或联系保护项做处理。</p></div>
              <div class="nmda-row"><button id="nmda-select-ready" class="nmda-btn" type="button">选择全部可创建</button></div>
            </div>
            <div class="nmda-task-toolbar">
              <div id="nmda-review-stats" class="nmda-inline-stats"></div>
              <div class="nmda-segmented"><button data-filter="all" class="is-active">全部</button><button data-filter="issues">仅待处理</button><button data-filter="ready">可创建</button></div>
            </div>
            <div id="nmda-task-list" class="nmda-task-list"></div>
            <div class="nmda-attachments-bar">
              <input id="nmda-attachment-input" type="file" multiple hidden>
              <div><strong>附件池</strong><span id="nmda-attachment-summary">0 个文件</span></div>
              <button id="nmda-add-attachments" class="nmda-btn nmda-btn-quiet" type="button">添加附件文件</button>
            </div>
          </section>

          <section id="nmda-schedule-card" class="nmda-card" hidden>
            <div class="nmda-card-head"><div><span class="nmda-kicker">3 · 排期</span><h2>安排时间</h2><p>排期只在你点击“应用排期”时计算，不再自动跳转或反复重算。</p></div></div>
            <div class="nmda-schedule-grid">
              <label><span>起始时间</span><input id="nmda-schedule-start" type="datetime-local"></label>
              <label><span>同校每轮最多</span><input id="nmda-rule-max-school" type="number" min="1" max="100" value="1"></label>
              <label><span>轮次间隔（天）</span><input id="nmda-rule-interval-days" type="number" min="1" max="365" value="7"></label>
              <label class="nmda-check"><input id="nmda-rule-group-institution" type="checkbox" checked><span>按学校分组</span></label>
              <label class="nmda-check"><input id="nmda-rule-preserve-existing" type="checkbox" checked><span>保留已有排期</span></label>
              <label class="nmda-check"><input id="nmda-rule-skip-holidays" type="checkbox" checked><span>跳过周末/支持的节假日</span></label>
            </div>
            <div class="nmda-row"><button id="nmda-apply-schedule" class="nmda-btn nmda-btn-primary" type="button">应用排期</button><button id="nmda-clear-schedule" class="nmda-btn nmda-btn-quiet" type="button">清除自动排期</button></div>
            <div id="nmda-schedule-summary" class="nmda-status"></div>
          </section>

          <section id="nmda-execute-card" class="nmda-card" hidden>
            <div class="nmda-card-head"><div><span class="nmda-kicker">4 · 执行</span><h2>创建网易草稿</h2><p>逐封执行；失败不会锁死整个批次，可以修正后单独重试。</p></div></div>
            <div id="nmda-execution-summary" class="nmda-execution-summary"></div>
            <div class="nmda-row"><button id="nmda-run" class="nmda-btn nmda-btn-primary" type="button">创建所选草稿</button><button id="nmda-stop" class="nmda-btn nmda-btn-danger" type="button" hidden>完成当前封后停止</button></div>
          </section>
        </main>
      </section>

      <div id="nmda-editor" class="nmda-modal" hidden>
        <section class="nmda-dialog" role="dialog" aria-modal="true">
          <header><div><span class="nmda-kicker">邮件核验</span><h3 id="nmda-editor-title">编辑邮件</h3></div><button id="nmda-editor-close" type="button">×</button></header>
          <div class="nmda-form-grid">
            <label><span>收件人</span><input id="nmda-edit-recipients"></label>
            <label><span>学校 / 机构</span><input id="nmda-edit-school"></label>
            <label class="wide"><span>主题</span><input id="nmda-edit-subject"></label>
            <label class="wide"><span>正文</span><textarea id="nmda-edit-body" rows="14"></textarea></label>
            <label class="wide"><span>附件名称 / 路径（分号分隔）</span><input id="nmda-edit-attachments"></label>
            <label><span>定时时间</span><input id="nmda-edit-schedule" type="datetime-local"></label>
            <label><span>任务标记</span><input id="nmda-edit-tags"></label>
          </div>
          <div id="nmda-editor-issues" class="nmda-editor-issues"></div>
          <footer><button id="nmda-editor-disable" class="nmda-btn nmda-btn-quiet" type="button">排除这封</button><span></span><button id="nmda-editor-cancel" class="nmda-btn" type="button">取消</button><button id="nmda-editor-save" class="nmda-btn nmda-btn-primary" type="button">保存并重新核验</button></footer>
        </section>
      </div>`;
    document.body.appendChild(root);
    return root;
  }

  const ui = buildShell();
  const $ = id => document.getElementById(id);

  function recordSets() { return state.dataset?.recordSets || state.dataset?.sheets || []; }

  function inferredRole(set, index) {
    if (state.sourceRoles.has(index)) return state.sourceRoles.get(index);
    const raw = String(set?.meta?.purposeOverride || set?.meta?.sourcePurpose || '').toLowerCase();
    if (['mail','roster','attachment','ignored'].includes(raw)) return raw;
    try {
      const classified = Importer?.classifyRecordSet?.(set);
      const purpose = String(classified?.purpose || '').toLowerCase();
      if (['mail','roster','attachment','ignored'].includes(purpose)) return purpose;
    } catch (_) {}
    const detection = Importer?.detectHeader?.(set?.rows || []);
    if (detection?.mapping?.recipients != null && (detection.mapping.body != null || detection.mapping.subject != null)) return 'mail';
    return 'ignored';
  }

  function rowValue(row, mapping, field) {
    const index = mapping?.[field];
    return index == null ? '' : (row?.[index] ?? '');
  }

  function actionAttachmentRefs(value) {
    return Importer?.splitAttachments?.(value) || String(value || '').split(/[;；|\n]+/).map(x=>x.trim()).filter(Boolean);
  }

  function normalizeSchedule(raw) {
    const value = normalizeText(raw);
    if (!value) return '';
    const parsed = Importer?.parseDateValue?.(raw);
    return parsed ? Importer.formatLocalDateTime(parsed) : '';
  }

  function buildRoster() {
    if (!Roster || !state.dataset) return { entries:[], warnings:[], stats:{} };
    const sets = recordSets().filter((set, index) => inferredRole(set, index) === 'roster');
    if (!sets.length) return { entries:[], warnings:[], stats:{} };
    try { return Roster.parseDataset({ recordSets:sets, sheets:sets }); }
    catch (error) { return { entries:[], warnings:[`总名单读取失败：${error.message}`], stats:{} }; }
  }

  function applyRoster(tasks) {
    state.roster = buildRoster();
    if (!Roster || !state.roster.entries?.length) return;
    const index = Roster.buildMatchIndex(state.roster.entries);
    for (const task of tasks) {
      const match = Roster.matchOne(task, index);
      task.rosterMatch = match;
      if (match.status === 'matched' && match.entry) {
        task.rosterReference = match.entry;
        task.rosterMeta = match.entry;
        if (!task.school && match.entry.school) { task.school = match.entry.school; task.schoolSource = 'roster'; }
        if (!task.recipients && match.emailCandidate) task.recipients = match.emailCandidate;
      } else if (match.status === 'ambiguous') {
        task.issues.push('总名单存在多个可能匹配项');
      }
    }
  }

  function contactPolicy(task) {
    if (!Contacts || !state.contacts) return null;
    const email = emailOf(task.recipients);
    if (!email) return null;
    const contact = state.contacts[email];
    if (!contact) return null;
    const policy = String(contact.policy || '正常');
    return policy === '正常' ? null : policy;
  }

  function rebuildTasks() {
    const sets = recordSets();
    const fileIndex = Importer?.buildFileIndex?.(state.attachmentFiles || []);
    const tasks = [];

    sets.forEach((set, setIndex) => {
      if (inferredRole(set, setIndex) !== 'mail') return;
      const rows = set?.rows || [];
      if (!rows.length) return;
      const detection = Importer.detectHeader(rows);
      const mapping = detection.mapping || {};
      const start = Math.max(0, Number(detection.index || 0) + 1);
      for (let rowIndex = start; rowIndex < rows.length; rowIndex++) {
        const row = rows[rowIndex] || [];
        const meta = set.meta?.rowMeta?.[rowIndex] || {};
        const key = taskKey(setIndex, rowIndex);
        const edit = state.taskEdits.get(key) || {};
        if (edit.excluded) continue;

        const mailboxDraft = meta.mailboxDraft || null;
        const sourceBody = String(rowValue(row, mapping, 'body') ?? '');
        const cleanedBody = set.meta?.mailFrames && Recognizer?.sanitizeRecognizedBody ? Recognizer.sanitizeRecognizedBody(sourceBody).text : sourceBody;
        const recipients = normalizeText(edit.recipients ?? rowValue(row, mapping, 'recipients'));
        const subject = normalizeText(edit.subject ?? rowValue(row, mapping, 'subject'));
        const body = String(edit.body ?? cleanedBody);
        const schoolRaw = normalizeText(edit.school ?? rowValue(row, mapping, 'school') ?? meta.school ?? '');
        const attachmentRaw = edit.attachments ?? rowValue(row, mapping, 'attachments');
        const attachmentRefs = actionAttachmentRefs(attachmentRaw);
        const resolved = Importer?.resolveFiles?.(attachmentRefs, fileIndex) || { files:[], missing:attachmentRefs, ambiguous:[], details:[] };
        const scheduleRaw = edit.scheduleAt ?? mailboxDraft?.scheduleAt ?? rowValue(row, mapping, 'scheduleAt');
        const scheduleAt = normalizeSchedule(scheduleRaw) || normalizeText(edit.scheduleAt || '');
        const tagsRaw = edit.tags ?? rowValue(row, mapping, 'tags');
        const tags = String(tagsRaw || '').split(/[;；|,，\n]+/).map(x=>x.trim()).filter(Boolean);
        const id = normalizeText(edit.id ?? rowValue(row, mapping, 'id')) || `${setIndex + 1}-${rowIndex + 1}`;
        const meaningful = recipients || subject || body.trim() || attachmentRefs.length || scheduleAt;
        if (!meaningful) continue;

        const issues = [], warnings = [];
        if (!recipients) issues.push('缺少收件人');
        else if (!recipientValid(recipients)) issues.push('收件人邮箱格式无效');
        if (!subject) issues.push('缺少主题');
        if (!body.trim()) issues.push('缺少正文');
        if (resolved.missing?.length) issues.push(`缺少附件：${resolved.missing.join('、')}`);
        if (resolved.ambiguous?.length) issues.push(`附件同名冲突：${resolved.ambiguous.join('、')}`);
        for (const issue of meta.issues || []) {
          const text = String(issue || '');
          if (/未定位收件人/.test(text) && recipients) continue;
          if (/主题为空/.test(text) && subject) continue;
          if (/正文过短/.test(text) && body.trim().length >= 40) continue;
          warnings.push(text);
        }
        const run = state.runState.get(key) || {};
        const task = {
          editKey:key, id, setIndex, rowIndex, source:set.source || set.name || '',
          recipients, cc:String(mailboxDraft?.cc || ''), bcc:String(mailboxDraft?.bcc || ''),
          school:schoolRaw, schoolSource:schoolRaw ? (edit.school != null ? 'manual' : 'imported') : '',
          subject, body,
          bodyHtml: mailboxDraft && edit.body == null ? String(mailboxDraft.bodyHtml || '') : '',
          bodyIsHtml: mailboxDraft && edit.body == null ? mailboxDraft.isHtml !== false && !!mailboxDraft.bodyHtml : false,
          priority:Number(mailboxDraft?.priority || 0) || 0,
          requestReadReceipt:!!mailboxDraft?.requestReadReceipt,
          attachmentRefs, files:resolved.files || [], attachmentDetails:resolved.details || [],
          scheduleAt, scheduleSource:edit.scheduleSource || (scheduleAt ? (mailboxDraft ? 'mailbox' : 'imported') : ''),
          scheduleReason:edit.scheduleReason || '', tags,
          enabled: state.selected.has(key), issues, warnings:[...new Set(warnings.filter(Boolean))],
          runtimeError:String(run.error || ''), status:run.status === 'done' ? 'done' : 'ready', importHeading:meta.heading || '', importRecipientEvidence:meta.recipientEvidence || null
        };
        tasks.push(task);
      }
    });

    applyRoster(tasks);
    for (const task of tasks) {
      const policy = contactPolicy(task);
      if (policy) task.issues.push(`联系保护：${policy}`);
    }

    const keys = new Set(tasks.map(task => task.editKey));
    for (const key of [...state.selected]) if (!keys.has(key)) state.selected.delete(key);
    state.tasks = tasks;
    syncSelectionState({ renderNow:false });
    state.schedulePlan = null;
    render();
  }

  function syncSelectionState({ renderNow=true } = {}) {
    for (const task of state.tasks) {
      task.enabled = state.selected.has(task.editKey);
      task.issues = (task.issues || []).filter(issue => !String(issue || '').startsWith('当前批次重复：'));
    }
    if (Roster?.auditTaskDuplicates) {
      const audit = Roster.auditTaskDuplicates(state.tasks);
      for (const group of audit.groups || []) {
        const active = (group.tasks || []).filter(task => state.selected.has(task.editKey));
        if (active.length > 1) for (const task of active) {
          if (!task.issues.some(issue => String(issue || '').startsWith('当前批次重复：'))) {
            task.issues.push(`当前批次重复：${group.label || '同一联系人'}`);
          }
        }
      }
    }
    state.schedulePlan = null;
    if (renderNow) {
      renderTasks();
      renderSchedule();
      renderExecution();
    }
  }

  function taskReady(task) { return task.enabled && !task.issues.length && task.status !== 'done' && task.status !== 'running'; }
  function activeTasks() { return state.tasks.filter(task => state.selected.has(task.editKey)); }

  function roleLabel(role) { return ({mail:'邮件',roster:'总名单',attachment:'附件',ignored:'暂不使用'})[role] || role; }

  function renderSourceSummary() {
    const box = $('nmda-source-summary');
    if (!state.dataset) { box.hidden = true; return; }
    const sets = recordSets();
    const counts = {mail:0,roster:0,attachment:0,ignored:0};
    sets.forEach((set, index) => counts[inferredRole(set,index)] = (counts[inferredRole(set,index)] || 0) + 1);
    box.hidden = false;
    box.innerHTML = `
      <div><strong>${state.tasks.length}</strong><span>邮件任务</span></div>
      <div><strong>${state.tasks.filter(t=>t.issues.length).length}</strong><span>需处理</span></div>
      <div><strong>${state.roster.entries?.length || 0}</strong><span>名单记录</span></div>
      <div><strong>${state.attachmentFiles.length}</strong><span>附件文件</span></div>`;

    const roles = $('nmda-source-roles');
    const ambiguous = sets.filter((set,index) => {
      const raw = String(set?.meta?.sourcePurpose || '');
      return !raw || raw === 'ambiguous';
    });
    roles.hidden = !(ambiguous.length || state.tasks.length === 0);
    if (!roles.hidden) {
      roles.innerHTML = `<div class="nmda-source-role-head"><strong>来源用途</strong><span>仅当系统没有生成正确任务时需要调整。</span></div>` + sets.map((set,index)=>{
        const role=inferredRole(set,index); const rows=Math.max(0,(set.rows||[]).length-1);
        return `<label class="nmda-source-role"><span><strong>${escapeHtml(set.name || set.source || `来源 ${index+1}`)}</strong><small>${rows} 行</small></span><select data-source-role="${index}"><option value="mail" ${role==='mail'?'selected':''}>邮件</option><option value="roster" ${role==='roster'?'selected':''}>总名单</option><option value="attachment" ${role==='attachment'?'selected':''}>附件</option><option value="ignored" ${role==='ignored'?'selected':''}>暂不使用</option></select></label>`;
      }).join('');
      roles.querySelectorAll('[data-source-role]').forEach(select=>select.addEventListener('change',()=>{
        state.sourceRoles.set(Number(select.dataset.sourceRole), select.value);
        rebuildTasks();
      }));
    }
  }

  function issueText(task) {
    if (task.runtimeError) return `执行失败：${task.runtimeError}`;
    if (task.issues.length) return task.issues.join('；');
    if (task.warnings.length) return task.warnings.join('；');
    return task.enabled ? '可创建' : '未选择';
  }

  function filteredTasks() {
    if (state.filter === 'issues') return state.tasks.filter(task=>task.issues.length || task.runtimeError);
    if (state.filter === 'ready') return state.tasks.filter(task=>!task.issues.length && task.status !== 'done');
    return state.tasks;
  }

  function renderTasks() {
    const card = $('nmda-review-card');
    card.hidden = !state.dataset;
    if (card.hidden) return;
    const tasks = filteredTasks();
    const list = $('nmda-task-list');
    $('nmda-review-stats').innerHTML = `<strong>${state.tasks.length}</strong> 封 · <span>${state.tasks.filter(t=>t.issues.length).length} 待处理</span> · <span>${activeTasks().length} 已选</span>`;
    list.innerHTML = tasks.length ? tasks.map((task,index)=>{
      const selected=state.selected.has(task.editKey), issues=task.issues.length>0 || !!task.runtimeError;
      const tone=task.status==='done'?'done':task.status==='running'?'running':issues?'issue':selected?'ready':'idle';
      return `<article class="nmda-task-row" data-task-row="${escapeHtml(task.editKey)}" data-tone="${tone}">
        <label class="nmda-task-select"><input type="checkbox" data-task-select="${escapeHtml(task.editKey)}" ${selected?'checked':''} ${task.status==='running'?'disabled':''}><span></span></label>
        <button class="nmda-task-main" type="button" data-task-open="${escapeHtml(task.editKey)}">
          <span class="nmda-task-index">${String(index+1).padStart(2,'0')}</span>
          <span class="nmda-task-copy"><strong class="nmda-recipient-cell" title="${escapeHtml(task.recipients)}">${escapeHtml(task.recipients || '未填写收件人')}</strong><b>${escapeHtml(task.subject || '未填写主题')}</b><small>${escapeHtml(task.school || task.source || '')}</small></span>
          <span class="nmda-task-state"><strong>${task.status==='done'?'已创建':task.status==='running'?'创建中':issues?'待处理':selected?'已选择':'可选'}</strong><small>${escapeHtml(issueText(task))}</small></span>
        </button>
      </article>`;
    }).join('') : '<div class="nmda-empty">当前筛选下没有任务。</div>';

    list.querySelectorAll('[data-task-select]').forEach(input=>input.addEventListener('change',()=>{
      const key=input.dataset.taskSelect; input.checked ? state.selected.add(key) : state.selected.delete(key);
      syncSelectionState();
    }));
    list.querySelectorAll('[data-task-open]').forEach(button=>button.addEventListener('click',()=>openEditor(button.dataset.taskOpen)));
    $('nmda-attachment-summary').textContent = `${state.attachmentFiles.length} 个文件${state.tasks.some(t=>t.issues.some(x=>x.startsWith('缺少附件')))?' · 仍有未匹配':''}`;
  }

  function renderSchedule() {
    const card=$('nmda-schedule-card'), has=state.tasks.length>0;
    card.hidden=!has; if(!has)return;
    const selected=activeTasks();
    const ready=selected.filter(task=>!task.issues.length);
    const scheduled=ready.filter(task=>task.scheduleAt).length;
    $('nmda-schedule-summary').textContent=`已选 ${selected.length} 封，其中 ${ready.length} 封可排期，${scheduled} 封已有时间。`;
  }

  function renderExecution() {
    const card=$('nmda-execute-card'), has=state.tasks.length>0;
    card.hidden=!has; if(!has)return;
    const selected=activeTasks();
    const blocked=selected.filter(task=>task.issues.length);
    const done=selected.filter(task=>task.status==='done');
    const ready=selected.filter(task=>!task.issues.length && task.status!=='done' && task.status!=='running');
    $('nmda-execution-summary').innerHTML=`<div><strong>${selected.length}</strong><span>已选</span></div><div><strong>${ready.length}</strong><span>待创建 / 可重试</span></div><div><strong>${done.length}</strong><span>已创建</span></div><div><strong>${blocked.length}</strong><span>被阻止</span></div>${state.executing?`<div><strong>${state.execution.done}/${state.execution.total}</strong><span>当前进度</span></div>`:''}`;
    $('nmda-run').disabled=state.executing || !ready.length;
    $('nmda-stop').hidden=!state.executing;
  }

  function render() {
    renderSourceSummary(); renderTasks(); renderSchedule(); renderExecution();
    $('nmda-import-status').textContent=state.status.text; $('nmda-import-status').dataset.kind=state.status.tone;
  }

  function openEditor(key) {
    const task=state.tasks.find(item=>item.editKey===key); if(!task)return;
    state.editKey=key;
    $('nmda-editor-title').textContent=task.recipients || task.subject || '编辑邮件';
    $('nmda-edit-recipients').value=task.recipients || '';
    $('nmda-edit-school').value=task.school || '';
    $('nmda-edit-subject').value=task.subject || '';
    $('nmda-edit-body').value=task.body || '';
    $('nmda-edit-attachments').value=(task.attachmentRefs||[]).join('; ');
    $('nmda-edit-schedule').value=task.scheduleAt || '';
    $('nmda-edit-tags').value=(task.tags||[]).join('; ');
    $('nmda-editor-issues').innerHTML=task.issues.length ? `<strong>当前待处理</strong><p>${escapeHtml(task.issues.join('；'))}</p>` : '<strong>当前已通过必填校验</strong>';
    $('nmda-editor').hidden=false;
  }
  function closeEditor(){ state.editKey=''; $('nmda-editor').hidden=true; }
  function saveEditor() {
    const key=state.editKey; const task=state.tasks.find(item=>item.editKey===key); if(!task)return closeEditor();
    const prev=state.taskEdits.get(key)||{};
    state.taskEdits.set(key,{...prev,
      recipients:$('nmda-edit-recipients').value.trim(), school:$('nmda-edit-school').value.trim(),
      subject:$('nmda-edit-subject').value.trim(), body:$('nmda-edit-body').value,
      attachments:$('nmda-edit-attachments').value.trim(), scheduleAt:$('nmda-edit-schedule').value,
      scheduleSource:$('nmda-edit-schedule').value?'manual':'', tags:$('nmda-edit-tags').value.trim()
    });
    state.runState.delete(key);
    closeEditor(); rebuildTasks(); setStatus('修改已保存并重新校验。','ok');
  }
  function excludeEditor() {
    if(!state.editKey)return;
    const prev=state.taskEdits.get(state.editKey)||{};
    state.taskEdits.set(state.editKey,{...prev,excluded:true}); state.selected.delete(state.editKey); state.runState.delete(state.editKey);
    closeEditor(); rebuildTasks(); setStatus('这封邮件已从当前批次排除。','ok');
  }

  async function refreshConnection() {
    const el=$('nmda-connection'), button=$('nmda-open-mail');
    if(!canRuntime){el.dataset.state='preview';el.querySelector('strong').textContent='预览环境';el.querySelector('small').textContent='邮箱执行仅在扩展中可用';button.disabled=true;return;}
    try{
      const result=await send({type:'NMDA_CONNECTION_STATUS'}); state.connection=result;
      const connected=!!result?.connected, authenticated=!!result?.authenticated;
      el.dataset.state=authenticated?'ok':connected?'warn':'off';
      el.querySelector('strong').textContent=authenticated?(result.account||'网易邮箱已连接'):connected?'网易邮箱待登录':'网易邮箱未连接';
      el.querySelector('small').textContent=authenticated?'可以创建草稿':connected?'请完成登录':'点击右侧连接';
      button.textContent=connected?'打开邮箱':'连接邮箱'; button.disabled=false;
      if(authenticated) await loadContacts(result.account||'');
    }catch(error){el.dataset.state='off';el.querySelector('strong').textContent='连接检查失败';el.querySelector('small').textContent=error.message;}
  }

  async function loadContacts(accountHint='') {
    if(!Contacts)return;
    try{
      let account=Contacts.normalizeEmail?.(accountHint||'')||'';
      if(!account){const info=await send({type:'NMDA_ACCOUNT_INFO'});account=Contacts.normalizeEmail?.(info?.uid||'')||String(info?.uid||'').toLowerCase();}
      if(!account)return;
      state.contactAccount=account; state.contacts=await Contacts.load(account);
      if(state.dataset) rebuildTasks();
    }catch(_){}
  }

  function reset({message='当前批次已清空。'}={}) {
    if(state.executing)return setStatus('正在创建草稿，当前批次不能清空。','warn');
    state.token++; state.dataset=null; state.sourceRoles.clear(); state.taskEdits.clear(); state.tasks=[]; state.attachmentFiles=[]; state.roster={entries:[],warnings:[],stats:{}}; state.selected.clear(); state.schedulePlan=null; state.runState.clear(); state.filter='all';
    $('nmda-import-file').value=''; $('nmda-import-dir').value=''; $('nmda-attachment-input').value=''; $('nmda-paste-source').value='';
    setStatus(message,'ok'); render();
  }

  async function parseFiles(files, {directory=false,label='资料'}={}) {
    if(!Importer || !files?.length)return;
    const token=++state.token; state.busy=true; setStatus(`正在读取 ${label}…`);
    try{
      const dataset=directory?await Importer.parseDirectory(files):await Importer.parseFiles(files);
      if(token!==state.token)return;
      state.dataset=dataset; state.sourceRoles.clear(); state.taskEdits.clear(); state.selected.clear(); state.runState.clear();
      state.attachmentFiles=uniqueFiles(dataset?.embeddedFiles||[]);
      rebuildTasks();
      for(const task of state.tasks) if(!task.issues.length) state.selected.add(task.editKey);
      syncSelectionState();
      const warnings=(dataset?.warnings||[]).filter(Boolean);
      setStatus(`已生成 ${state.tasks.length} 封邮件${warnings.length?`；${warnings[0]}`:''}。`, state.tasks.length?'ok':'warn');
      render();
    }catch(error){if(token===state.token){state.dataset=null;state.tasks=[];setStatus(`读取失败：${error.message}`,'error');render();}}
    finally{if(token===state.token)state.busy=false;}
  }

  async function importPaste() {
    const text=$('nmda-paste-source').value.trim(); if(!text)return setStatus('请先粘贴内容。','warn');
    const file=new File([text],`pasted-${Date.now()}.txt`,{type:'text/plain;charset=utf-8',lastModified:Date.now()});
    await parseFiles([file],{label:'粘贴内容'});
  }

  async function importDrafts() {
    if(!canRuntime)return setStatus('草稿箱读取仅在 Chrome 扩展中可用。','warn');
    try{
      const connection=await send({type:'NMDA_CONNECTION_STATUS'});
      if(!connection?.authenticated){await send({type:'NMDA_OPEN_MAIL',focus:true});return setStatus('请先登录网易邮箱，然后再次点击“读取草稿箱”。','warn');}
      setStatus('正在读取网易草稿箱…');
      const result=await send({type:'NMDA_IMPORT_DRAFTS',limit:300});
      if(!result?.ok)throw new Error(result?.reason||'草稿箱读取失败');
      const rows=[['编号','收件人','学校 / 机构','主题','正文','附件','定时时间','标签']], rowMeta=[null];
      for(const draft of result.drafts||[]){
        const recipients=String(draft.recipients||draft.to||'').trim();
        const attachments=(draft.attachments||[]).filter(x=>!x?.inlined).map(x=>String(x?.name||x||'')).filter(Boolean);
        rows.push([String(draft.id||''),recipients,'',String(draft.subject||''),String(draft.body||draft.text||''),attachments.join(';'),String(draft.scheduleAt||''),'草稿箱']);
        rowMeta.push({mailboxDraft:draft,issues:draft.ok===false?[draft.reason||'草稿详情读取不完整']:[]});
      }
      state.dataset={recordSets:[{name:'网易草稿箱',source:'网易草稿箱',rows,meta:{sourcePurpose:'mail',mailboxDrafts:true,rowMeta}}],sheets:[],sourceFiles:[],embeddedFiles:[],warnings:[],format:'mailbox-drafts',meta:{}};
      state.dataset.sheets=state.dataset.recordSets; state.sourceRoles.clear();state.taskEdits.clear();state.selected.clear();state.runState.clear();state.attachmentFiles=[];rebuildTasks();for(const task of state.tasks)if(!task.issues.length)state.selected.add(task.editKey);syncSelectionState();setStatus(`已读取 ${state.tasks.length} 封网易草稿。`,'ok');
    }catch(error){setStatus(`草稿箱读取失败：${error.message}`,'error');}
  }

  function addAttachments(files) {
    state.attachmentFiles=uniqueFiles([...state.attachmentFiles,...files]); rebuildTasks(); setStatus(`附件池现在有 ${state.attachmentFiles.length} 个文件。`,'ok');
  }

  function readScheduleControls() {
    const grouping=$('nmda-rule-group-institution').checked?'institution':'none';
    const values={
      grouping,
      maxPerGroupPerRound:Number($('nmda-rule-max-school').value)||null,
      intervalDays:Number($('nmda-rule-interval-days').value)||null,
      preserveExisting:$('nmda-rule-preserve-existing').checked,
      skipHolidays:$('nmda-rule-skip-holidays').checked
    };
    for(const [field,value] of Object.entries(values))Preferences?.setScheduleOverride?.(field,value);
    return {...values,startAt:$('nmda-schedule-start').value,policySource:'explicit',__explicit:true};
  }

  function applySchedule() {
    if(!Scheduler)return setStatus('排期模块不可用。','error');
    const candidates=activeTasks().filter(task=>!task.issues.length);
    if(!candidates.length)return setStatus('当前没有已选择且通过校验的邮件可排期。','warn');
    try{
      const rules=readScheduleControls(); const plan=Scheduler.buildPlan(candidates,rules,new Date());
      for(const item of plan.assignments){const prev=state.taskEdits.get(item.editKey)||{};state.taskEdits.set(item.editKey,{...prev,scheduleAt:item.scheduleAt,scheduleSource:'auto',scheduleReason:item.reason});}
      state.schedulePlan=plan; rebuildTasks(); setStatus(`已为 ${plan.assignments.length} 封邮件安排时间，保留 ${plan.preserved.length} 封已有排期。`,'ok');
    }catch(error){setStatus(`排期未应用：${error.message}`,'error');}
  }

  function clearAutoSchedule() {
    for(const task of state.tasks){const prev=state.taskEdits.get(task.editKey)||{};if((prev.scheduleSource||task.scheduleSource)==='auto')state.taskEdits.set(task.editKey,{...prev,scheduleAt:'',scheduleSource:'',scheduleReason:''});}
    rebuildTasks(); setStatus('自动生成的排期已清除；导入或手工时间保持不变。','ok');
  }

  async function prepareVaultRefs(files) {
    if(!files?.length)return [];
    if(!Vault)throw new Error('附件临时仓库不可用');
    const refs=[];
    for(const file of files){const meta=await Vault.putFile(file);refs.push({id:meta.id,name:meta.name,size:meta.size,type:meta.type,lastModified:meta.lastModified});}
    return refs;
  }

  async function releaseVaultRefs(refs) {
    const ids=(refs||[]).map(x=>x.id).filter(Boolean); if(ids.length)try{await Vault.removeMany(ids);}catch(_){}
  }

  async function executeOne(task) {
    const executionId=crypto.randomUUID(); const refs=await prepareVaultRefs(task.files||[]);
    try{
      const result=await send({type:'NMDA_EXECUTE_DRAFT',executionId,fresh:true,task:{
        recipients:task.recipients,cc:task.cc||'',bcc:task.bcc||'',subject:task.subject,body:task.body,
        bodyHtml:task.bodyHtml||'',bodyIsHtml:!!task.bodyIsHtml,priority:Number(task.priority||0)||0,requestReadReceipt:!!task.requestReadReceipt,
        scheduleAt:task.scheduleAt||'',attachments:refs
      }});
      if(!result?.ok)throw new Error(result?.reason||'网易邮箱没有完成草稿创建');
      return result;
    }finally{await releaseVaultRefs(refs);}
  }

  function updateTaskRow(task) {
    const row=document.querySelector(`[data-task-row="${CSS.escape(task.editKey)}"]`); if(!row)return;
    row.dataset.tone=task.status==='done'?'done':task.status==='running'?'running':task.runtimeError?'issue':task.enabled?'ready':'idle';
    const strong=row.querySelector('.nmda-task-state strong'),small=row.querySelector('.nmda-task-state small');
    if(strong)strong.textContent=task.status==='done'?'已创建':task.status==='running'?'创建中':task.runtimeError?'失败':task.enabled?'已选择':'可选';
    if(small)small.textContent=task.runtimeError?`执行失败：${task.runtimeError}`:issueText(task);
  }

  async function executeSelected() {
    if(state.executing)return;
    const tasks=activeTasks().filter(task=>!task.issues.length && task.status!=='done' && task.status!=='running');
    if(!tasks.length)return setStatus('没有可执行的已选邮件。','warn');
    if(!canRuntime)return setStatus('创建草稿仅在 Chrome 扩展中可用。','warn');
    const connection=await send({type:'NMDA_CONNECTION_STATUS'}).catch(()=>null);
    if(!connection?.connected||!connection?.authenticated){await send({type:'NMDA_OPEN_MAIL',focus:true}).catch(()=>null);return setStatus('已打开网易邮箱。请完成登录后再点击“创建所选草稿”。','warn');}

    state.executing=true;state.stopRequested=false;state.execution={done:0,failed:0,total:tasks.length};renderExecution();
    setStatus(`开始创建 ${tasks.length} 封草稿…`);
    for(const task of tasks){
      if(state.stopRequested)break;
      task.status='running';task.runtimeError='';state.runState.set(task.editKey,{status:'running',error:''});updateTaskRow(task);
      try{await executeOne(task);task.status='done';task.runtimeError='';state.runState.set(task.editKey,{status:'done',error:''});state.execution.done++;}
      catch(error){task.status='ready';task.runtimeError=error.message;state.runState.set(task.editKey,{status:'ready',error:error.message});state.execution.failed++;}
      updateTaskRow(task);renderExecution();
    }
    state.executing=false;renderExecution();
    const stopped=state.stopRequested?'；已按请求停止':'';
    setStatus(`执行完成：成功 ${state.execution.done}，失败 ${state.execution.failed}${stopped}。`,state.execution.failed?'warn':'ok');
  }

  async function filesFromDrop(dataTransfer) {
    const items=[...(dataTransfer?.items||[])]; const out=[];
    async function readEntry(entry,path=''){
      if(entry.isFile){const file=await new Promise((resolve,reject)=>entry.file(resolve,reject));try{Object.defineProperty(file,'_nmdaPath',{value:`${path}${file.name}`,configurable:true});}catch(_){ }return [file];}
      if(!entry.isDirectory)return[];const reader=entry.createReader(),entries=[];while(true){const part=await new Promise((resolve,reject)=>reader.readEntries(resolve,reject));if(!part.length)break;entries.push(...part);}const nested=[];for(const child of entries)nested.push(...await readEntry(child,`${path}${entry.name}/`));return nested;
    }
    for(const item of items){const entry=item.webkitGetAsEntry?.();if(entry)out.push(...await readEntry(entry));else{const file=item.getAsFile?.();if(file)out.push(file);}}
    if(!items.length)out.push(...[...(dataTransfer?.files||[])]);
    return uniqueFiles(out);
  }

  function bind() {
    $('nmda-pick-files').addEventListener('click',()=>$('nmda-import-file').click());
    $('nmda-pick-folder').addEventListener('click',()=>$('nmda-import-dir').click());
    $('nmda-import-file').addEventListener('change',async event=>{const files=[...(event.target.files||[])];event.target.value='';await parseFiles(files,{label:files.length===1?files[0].name:`${files.length} 个文件`});});
    $('nmda-import-dir').addEventListener('change',async event=>{const files=[...(event.target.files||[])];event.target.value='';await parseFiles(files,{directory:true,label:`文件夹（${files.length} 个文件）`});});
    const drop=$('nmda-drop');drop.addEventListener('click',()=>$('nmda-import-file').click());drop.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();$('nmda-import-file').click();}});drop.addEventListener('dragover',event=>{event.preventDefault();drop.classList.add('is-dragging');});drop.addEventListener('dragleave',()=>drop.classList.remove('is-dragging'));drop.addEventListener('drop',async event=>{event.preventDefault();drop.classList.remove('is-dragging');const files=await filesFromDrop(event.dataTransfer);if(!files.length)return setStatus('没有识别到可导入文件。','warn');await parseFiles(files,{directory:files.some(file=>fileName(file).includes('/')),label:`拖入的 ${files.length} 个文件`});});
    $('nmda-toggle-paste').addEventListener('click',()=>{$('nmda-paste-box').hidden=!$('nmda-paste-box').hidden;if(!$('nmda-paste-box').hidden)$('nmda-paste-source').focus();});
    $('nmda-paste-import').addEventListener('click',()=>void importPaste());
    $('nmda-import-drafts').addEventListener('click',()=>void importDrafts());
    $('nmda-reset').addEventListener('click',()=>reset());
    $('nmda-add-attachments').addEventListener('click',()=>$('nmda-attachment-input').click());
    $('nmda-attachment-input').addEventListener('change',event=>{addAttachments([...(event.target.files||[])]);event.target.value='';});
    $('nmda-select-ready').addEventListener('click',()=>{for(const task of state.tasks){if(!task.issues.length)state.selected.add(task.editKey);}syncSelectionState();});
    document.querySelectorAll('[data-filter]').forEach(button=>button.addEventListener('click',()=>{state.filter=button.dataset.filter;document.querySelectorAll('[data-filter]').forEach(b=>b.classList.toggle('is-active',b===button));renderTasks();}));
    $('nmda-editor-close').addEventListener('click',closeEditor);$('nmda-editor-cancel').addEventListener('click',closeEditor);$('nmda-editor-save').addEventListener('click',saveEditor);$('nmda-editor-disable').addEventListener('click',excludeEditor);$('nmda-editor').addEventListener('click',event=>{if(event.target===event.currentTarget)closeEditor();});
    $('nmda-apply-schedule').addEventListener('click',applySchedule);$('nmda-clear-schedule').addEventListener('click',clearAutoSchedule);
    $('nmda-run').addEventListener('click',()=>void executeSelected());$('nmda-stop').addEventListener('click',()=>{state.stopRequested=true;$('nmda-stop').disabled=true;setStatus('已请求停止；当前这一封完成后结束。','warn');});
    $('nmda-open-mail').addEventListener('click',async()=>{if(canRuntime){await send({type:'NMDA_OPEN_MAIL',focus:true}).catch(()=>null);setTimeout(()=>void refreshConnection(),600);}});
    window.addEventListener('focus',()=>void refreshConnection());
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refreshConnection();});
    document.addEventListener('nmda:contact-policy-changed',()=>void loadContacts(state.contactAccount));
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!$('nmda-editor').hidden)closeEditor();});
  }

  function hydrateScheduleControls() {
    const rules=Preferences?.effectiveSchedule?.()||{};
    $('nmda-schedule-start').value=suggestedStart();
    $('nmda-rule-max-school').value=String(rules.maxPerGroupPerRound||1);
    $('nmda-rule-interval-days').value=String(rules.intervalDays||7);
    $('nmda-rule-group-institution').checked=rules.grouping!=='none';
    $('nmda-rule-preserve-existing').checked=rules.preserveExisting!==false;
    $('nmda-rule-skip-holidays').checked=rules.skipHolidays===true;
  }

  document.documentElement.classList.add('nmda-app-document');
  document.body.classList.add('nmda-app-body');
  bind(); hydrateScheduleControls(); render(); void refreshConnection();
})();
