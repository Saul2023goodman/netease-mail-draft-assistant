(() => {
  'use strict';

  if (window.top !== window || document.getElementById('nmda-root')) return;

  const APP = 'NetEase Mail Draft Assistant';
  const STORAGE_KEY = 'nmda.form.v2';
  const FOLLOWUP_SETTINGS_KEY = 'nmda.followup.settings.v1';
  const Importer = globalThis.NMDAImporter;
  const MailRecognizer = globalThis.NMDAMailRecognizer;
  const Contacts = globalThis.NMDAContacts;
  const Scheduler = globalThis.NMDAScheduler;
  const Roster = globalThis.NMDARoster;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const executionProgressHandlers = new Map();

  // The standalone Railway preview does not have the extension APIs. Keep the
  // workbench interactive there while preserving the real extension behavior.
  const extensionRuntime = globalThis.chrome?.runtime || null;
  const extensionStorage = globalThis.chrome?.storage?.local || null;

  async function sendRuntimeMessage(message) {
    if (!extensionRuntime?.sendMessage) return null;
    return extensionRuntime.sendMessage(message);
  }

  async function storageGet(key) {
    if (extensionStorage?.get) return extensionStorage.get(key);
    try {
      const raw = window.localStorage.getItem(key);
      return raw == null ? {} : { [key]: JSON.parse(raw) };
    } catch (_) {
      return {};
    }
  }

  async function storageSet(values) {
    if (extensionStorage?.set) return extensionStorage.set(values);
    try {
      for (const [key, value] of Object.entries(values || {})) {
        window.localStorage.setItem(key, JSON.stringify(value));
      }
    } catch (_) {}
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

  async function prepareVaultRefs(files) {
    const refs = [];
    for (const file of files || []) {
      if (!file) continue;
      const meta = await globalThis.NMDAVault.putFile(file);
      refs.push({ id: meta.id, name: meta.name, size: meta.size, type: meta.type, lastModified: meta.lastModified });
    }
    return refs;
  }

  async function releaseVaultRefs(refs) {
    const ids = (refs || []).map(ref => ref?.id).filter(Boolean);
    if (!ids.length) return;
    try { await globalThis.NMDAVault.removeMany(ids); } catch (_) {}
  }

  async function executeDraftRemotely(task, { fresh = true, onProgress = () => {} } = {}) {
    const executionId = crypto.randomUUID();
    const refs = await prepareVaultRefs(task.files || []);
    executionProgressHandlers.set(executionId, onProgress);
    try {
      const connection = await sendRuntimeMessage({ type: 'NMDA_CONNECTION_STATUS' });
      if (!connection?.connected) throw new Error('没有检测到已打开的网易邮箱。请先点击右上角“打开网易邮箱”并完成登录。');
      if (!connection?.authenticated) throw new Error('网易邮箱页面已打开，但尚未检测到登录账号。请先完成登录。');
      const result = await sendRuntimeMessage({
        type: 'NMDA_EXECUTE_DRAFT', executionId, fresh,
        task: {
          recipients: task.recipients || '', cc: task.cc || '', bcc: task.bcc || '',
          subject: task.subject || '', body: task.body || '',
          bodyHtml: task.bodyHtml || '', bodyIsHtml: !!task.bodyIsHtml,
          priority: Number(task.priority || 0) || 0, requestReadReceipt: !!task.requestReadReceipt,
          scheduleAt: task.scheduleAt || '', attachments: refs
        }
      });
      if (!result?.ok) throw new Error(result?.reason || '网易邮箱执行器没有完成草稿创建。');
      return result.outcome || {};
    } finally {
      executionProgressHandlers.delete(executionId);
      await releaseVaultRefs(refs);
    }
  }


  async function executeNativeFollowUpRemotely(task, { onProgress = () => {} } = {}) {
    const executionId = crypto.randomUUID();
    executionProgressHandlers.set(executionId, onProgress);
    try {
      const connection = await sendRuntimeMessage({ type:'NMDA_CONNECTION_STATUS' });
      if (!connection?.connected) throw new Error('没有检测到已打开的网易邮箱。请先连接邮箱。');
      if (!connection?.authenticated) throw new Error('网易邮箱页面已打开，但尚未检测到登录账号。请先完成登录。');
      const result = await sendRuntimeMessage({
        type:'NMDA_EXECUTE_FOLLOWUP', executionId,
        task:{
          mode:task.mode === 'reply' ? 'reply' : 'forward',
          sourceMessageId:String(task.sourceMessageId || ''),
          recipients:String(task.recipients || ''),
          subject:String(task.subject || ''),
          introText:String(task.introText || ''),
          sourceSubject:String(task.sourceSubject || ''),
          sourceBody:String(task.sourceBody || ''),
          sourceIsHtml:task.sourceIsHtml !== false,
          sourceFrom:String(task.sourceFrom || ''),
          sourceTo:String(task.sourceTo || ''),
          sourceCc:String(task.sourceCc || ''),
          sourceDate:String(task.sourceDate || ''),
          sourceAttachments:Array.isArray(task.sourceAttachments) ? task.sourceAttachments.map(item => ({name:String(item?.name||''),size:Number(item?.size||0)||0})).filter(item=>item.name) : [],
          attachmentInventoryKnown:task.attachmentInventoryKnown === true,
          hasAttachmentsHint:task.hasAttachmentsHint === true,
          attachmentCountHint:Number(task.attachmentCountHint || 0) || 0
        }
      });
      if (!result?.ok) throw new Error(result?.reason || '网易邮箱原生 Follow-up 执行器没有完成草稿创建。');
      return result.outcome || {};
    } finally {
      executionProgressHandlers.delete(executionId);
    }
  }

  async function updateMailboxBatchMonitor(payload = {}) {
    try { return await sendRuntimeMessage({ type:'NMDA_BATCH_MONITOR', payload }); }
    catch (_) { return null; }
  }

  async function waitForMailboxExecutionReady(timeoutMs = 4500) {
    const deadline = Date.now() + Math.max(800, Number(timeoutMs || 0));
    let last = null;
    while (Date.now() < deadline) {
      try {
        last = await sendRuntimeMessage({ type:'NMDA_CONNECTION_STATUS' });
        if (last?.connected && last?.authenticated) return last;
      } catch (_) {}
      await sleep(260);
    }
    return last;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[ch]));
  }

  function buildUI() {
    const root = document.createElement('div');
    root.id = 'nmda-root';
    root.innerHTML = `
      <button id="nmda-launcher" type="button" title="网易邮箱外联工作台" aria-label="打开网易邮箱外联工作台">
        <span class="nmda-launcher-mark">N</span><span class="nmda-launcher-dot"></span>
      </button>
      <section id="nmda-panel" hidden aria-label="网易邮箱外联工作台">
        <header class="nmda-head">
          <div class="nmda-brand">
            <div class="nmda-brand-mark">N</div>
            <div>
              <div class="nmda-title">网易邮箱外联工作台</div>
              <div class="nmda-subtitle">批量外联草稿工作台</div>
            </div>
          </div>
          <div class="nmda-head-actions">
            <div class="nmda-mail-connection" id="nmda-mail-connection" data-state="checking"><span class="nmda-mail-connection-dot"></span><span class="nmda-mail-connection-copy"><strong id="nmda-mail-connection-title">正在检查网易邮箱</strong><small id="nmda-mail-connection-detail">连接状态</small></span><button class="nmda-btn nmda-btn-small nmda-mail-open-button" id="nmda-open-mail" type="button">连接邮箱</button></div>
            <button class="nmda-icon-btn" id="nmda-expand" type="button" title="全屏 / 还原">⛶</button>
            <button class="nmda-icon-btn nmda-close" id="nmda-close" type="button" title="关闭">×</button>
          </div>
        </header>

        <nav class="nmda-tabs" aria-label="工作台模块">
          <div class="nmda-nav-label">工作区</div>
          <button class="nmda-tab is-active" data-tab="batch" type="button" title="批量草稿"><span class="nmda-tab-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="4" y="4" width="6" height="6" rx="1.5"/><rect x="14" y="4" width="6" height="6" rx="1.5"/><rect x="4" y="14" width="6" height="6" rx="1.5"/><rect x="14" y="14" width="6" height="6" rx="1.5"/></svg></span><span><strong>批量草稿</strong><small>导入 · 核验 · 排期</small></span></button>
          <button class="nmda-tab" data-tab="single" type="button" title="单封草稿"><span class="nmda-tab-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 19h4l10-10a2.2 2.2 0 0 0-4-4L5 15v4Z"/><path d="m13.5 6.5 4 4"/></svg></span><span><strong>单封草稿</strong><small>快速创建一封</small></span></button>
          <button class="nmda-tab" data-tab="contacts" type="button" title="联系人"><span class="nmda-tab-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.2"/><path d="M5.5 19c.7-3.2 3-5 6.5-5s5.8 1.8 6.5 5"/></svg></span><span><strong>联系人</strong><small>状态与联系记录</small></span></button>
          <button class="nmda-tab" data-tab="followup" type="button" title="Follow-up"><span class="nmda-tab-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 7H5v-3"/><path d="M5.5 7.2A8 8 0 1 1 4 13"/><path d="M9 12h6"/><path d="m13 9 3 3-3 3"/></svg></span><span><strong>Follow-up</strong><small>回复核验 · 人工跟进</small></span></button>

        </nav>

        <main class="nmda-main">
          <div class="nmda-page-head" data-page-head="single" hidden>
            <div><h2>单封草稿</h2><p>填写内容，设置附件或时间。</p></div>
          </div>
          <section class="nmda-tabpane nmda-page" data-pane="single" hidden>
            <div class="nmda-single-grid">
              <div class="nmda-card nmda-compose-card">
                <div class="nmda-card-head"><div><div class="nmda-card-title">邮件内容</div></div></div>
                <label class="nmda-field"><span class="nmda-label">收件人</span><textarea id="nmda-recipients" placeholder="a@example.com; b@example.com"></textarea><span class="nmda-hint">多人可用分号、逗号或换行分隔</span></label>
                <label class="nmda-field"><span class="nmda-label">主题</span><input id="nmda-subject" type="text" placeholder="邮件主题"></label>
                <label class="nmda-field nmda-grow-field"><span class="nmda-label">正文</span><textarea id="nmda-body-text" placeholder="邮件正文"></textarea></label>
              </div>

              <aside class="nmda-side-stack">
                <div class="nmda-card nmda-single-options-card">
                  <div class="nmda-card-head"><div><div class="nmda-card-title">发送选项</div><div class="nmda-card-desc">附件和定时均为可选。</div></div></div>
                  <div class="nmda-field nmda-file-field"><span class="nmda-label">附件</span><div class="nmda-file-picker"><label class="nmda-btn nmda-btn-small" for="nmda-files">选择附件</label><span id="nmda-single-file-summary" class="nmda-hint">未选择附件</span><input id="nmda-files" type="file" multiple hidden></div><span class="nmda-hint">刷新页面后需重新选择本地附件。</span></div>
                  <div class="nmda-option-divider"></div>
                  <label class="nmda-field"><span class="nmda-label">定时时间</span><input id="nmda-schedule-at" type="datetime-local"><span class="nmda-hint">留空则不设置定时。</span></label>
                </div>
                <div class="nmda-card nmda-action-card">
                  <div class="nmda-actions"><button class="nmda-btn nmda-btn-primary" id="nmda-fill" type="button">创建草稿</button></div>
                  
                  <div id="nmda-status">准备就绪。</div>
                </div>
              </aside>
            </div>
          </section>


          <div class="nmda-page-head" data-page-head="batch">
            <div><h2>批量草稿</h2><p>导入 → 核验 → 排期 → 创建</p></div>
          </div>
          <section class="nmda-tabpane nmda-page nmda-ingest-page nmda-bulk-workbench" data-pane="batch" data-phase="empty">
            <aside class="nmda-process-guide" aria-label="批量流程">
              <div class="nmda-process-guide-title"><small>当前批次</small><strong>步骤 1 / 3</strong></div>
              <button type="button" data-flow-step="1"><span>1</span><strong>导入资料</strong><small>拖入邮件与批次资料</small></button>
              <i></i>
              <button type="button" data-flow-step="2"><span>2</span><strong>核验待办</strong><small>内容 · 去重 · 附件</small></button>
              <i></i>
              <button type="button" data-flow-step="3"><span>3</span><strong>选择与排期</strong><small>确认后转到网易邮箱执行</small></button>
            </aside>

            <div class="nmda-workflow-stage-head" id="nmda-stage-prepare">
              <span class="nmda-stage-number">01</span><div><strong>准备邮件</strong><small>把邮件资料加入本批次。</small></div>
            </div>
            <div class="nmda-ingest-workspace nmda-ingest-workspace-v2">
              <div class="nmda-card nmda-ingest-source-card" id="nmda-import-card">
                <div class="nmda-card-head"><div><div class="nmda-card-title" id="nmda-import-card-title">导入邮件资料</div><div class="nmda-card-desc" id="nmda-import-card-desc">把本批次邮件资料放进来。</div></div><div class="nmda-row nmda-wrap"><span class="nmda-import-busy-badge" id="nmda-import-busy-badge" hidden>正在处理…</span><button class="nmda-btn nmda-btn-small" id="nmda-open-supplement-preflight" type="button" hidden>批次准备</button><button class="nmda-btn nmda-btn-small nmda-btn-quiet" id="nmda-reset-import" type="button" hidden>清空本批次</button></div></div>
                <input id="nmda-import-file" type="file" multiple hidden accept=".xlsx,.xls,.ods,.fods,.docx,.docm,.dotx,.doc,.csv,.tsv,.psv,.json,.jsonl,.ndjson,.txt,.html,.htm,.xml,.zip,.pdf,.ppt,.pptx,.rtf,.png,.jpg,.jpeg,.gif,.webp,.svg,.rar,.7z">
                <input id="nmda-import-dir" type="file" webkitdirectory multiple hidden>
                <input id="nmda-import-package" type="file" hidden accept=".zip">
                <input id="nmda-roster-file" type="file" multiple hidden accept=".xlsx,.xls,.ods,.fods,.docx,.docm,.dotx,.doc,.csv,.tsv,.psv,.json,.jsonl,.ndjson,.txt,.html,.htm,.xml,.zip">
                <div class="nmda-import-drop-zone" id="nmda-import-drop-zone" role="button" tabindex="0" aria-label="拖入邮件资料，或点击选择文件">
                  <div class="nmda-import-drop-zone-icon" aria-hidden="true"><span>↓</span></div>
                  <div class="nmda-import-drop-zone-copy"><strong>把邮件资料拖到这里</strong><small>支持文件、文件夹与 ZIP；也可以点击此区域选择文件</small></div>
                  <div class="nmda-import-drop-zone-types"><span>DOCX</span><span>XLSX</span><span>PDF</span><span>ZIP</span><span>更多</span></div>
                </div>
                <div class="nmda-source-action-grid nmda-source-action-grid-compact">
                  <label class="nmda-source-action" for="nmda-import-file"><span class="nmda-source-action-icon">＋</span><strong>选择文件</strong><small>从电脑选择资料</small></label>
                  <label class="nmda-source-action" for="nmda-import-dir"><span class="nmda-source-action-icon">▤</span><strong>选择文件夹</strong><small>批量加入整个文件夹</small></label>
                  <label class="nmda-source-action nmda-source-action-legacy" for="nmda-import-package" hidden><span class="nmda-source-action-icon">▣</span><strong>打开 ZIP</strong></label>
                  <button class="nmda-source-action nmda-source-action-button" id="nmda-show-paste" type="button"><span class="nmda-source-action-icon">⌘</span><strong>粘贴内容</strong><small>粘贴邮件文本或表格</small></button>
                  <button class="nmda-source-action nmda-source-action-button nmda-source-action-mailbox" id="nmda-import-drafts" type="button"><span class="nmda-source-action-icon">✉</span><strong>读取草稿箱</strong><small>识别正文、主题、定时与附件</small></button>
                </div>
                <div class="nmda-paste-panel" id="nmda-paste-panel" hidden>
                  <textarea id="nmda-paste-source" placeholder="粘贴邮件、名单或表格内容"></textarea>
                  <div class="nmda-row nmda-wrap"><button class="nmda-btn nmda-btn-primary nmda-btn-small" id="nmda-paste-import" type="button">加入本批次</button></div>
                </div>
                <div class="nmda-ingest-source-tools"><span id="nmda-import-format-info" class="nmda-hint">先加入邮件资料。</span><button class="nmda-btn nmda-btn-small nmda-btn-quiet" id="nmda-template" type="button">下载模板</button></div>
                <div class="nmda-batch-prep-strip" id="nmda-batch-prep-strip" hidden>
                  <div class="nmda-batch-prep-label"><span>批次资料</span><small>总名单与附件</small></div>
                  <div class="nmda-batch-prep-item" id="nmda-prep-roster-state" data-state="pending"><span>参考总名单</span><strong>未决定</strong></div>
                  <div class="nmda-batch-prep-item nmda-batch-prep-attachment" id="nmda-prep-attachment-state" data-state="pending"><div><span>附件</span><strong>未准备</strong></div><button class="nmda-text-action" id="nmda-manage-attachments-strip" type="button">查看 / 修改</button></div>
                  <button class="nmda-btn nmda-btn-small" id="nmda-edit-batch-prep" type="button">补充资料</button>
                </div>
                <div class="nmda-context-cue nmda-roster-context-cue" id="nmda-roster-context-cue" data-state="prepare">
                  <div class="nmda-context-cue-icon" aria-hidden="true">◎</div>
                  <div class="nmda-context-cue-main">
                    <span class="nmda-context-eyebrow" id="nmda-roster-context-eyebrow">推荐 · 导入时补充</span>
                    <strong id="nmda-roster-context-title">有参考总名单？建议一起加入</strong>
                    <small id="nmda-roster-context-copy">用于查重、名单核对和院校排期；没有也可以继续。</small>
                    <div class="nmda-context-benefits" id="nmda-roster-context-benefits"><span>减少重复联系</span><span>发现名单遗漏</span><span>辅助院校排期</span></div>
                    <div id="nmda-roster-source-status" class="nmda-context-status">未添加参考总名单。</div>
                  </div>
                  <div class="nmda-context-cue-actions">
                    <label class="nmda-btn nmda-btn-small nmda-btn-primary" id="nmda-roster-upload-action" for="nmda-roster-file">上传参考总名单</label>
                    <button class="nmda-btn nmda-btn-small nmda-btn-quiet" id="nmda-roster-skip" type="button" hidden>本批次暂不添加</button>
                    <button class="nmda-btn nmda-btn-small nmda-btn-quiet" id="nmda-roster-remove" type="button" hidden>移除</button>
                  </div>
                </div>
                <div id="nmda-import-status" class="nmda-summary nmda-import-status">还没有添加资料。</div>
                <div id="nmda-source-inventory" class="nmda-source-inventory" hidden></div>

              </div>

              <div class="nmda-supplement-preflight" id="nmda-supplement-preflight" hidden aria-hidden="true">
                <section class="nmda-supplement-dialog nmda-classify-dialog" role="dialog" aria-modal="true" aria-labelledby="nmda-supplement-title">
                  <header class="nmda-classify-head">
                    <div class="nmda-classify-head-main">
                      <div class="nmda-supplement-head-icon" data-state="ok">✓</div>
                      <div>
                        <span class="nmda-supplement-kicker">导入完成</span>
                        <h3 id="nmda-supplement-title">确认文件用途</h3>
                        <p>确认有疑问的文件即可。</p>
                      </div>
                    </div>
                    <div class="nmda-classify-head-summary" id="nmda-preflight-routing-chips" aria-label="分类概览"></div>
                  </header>

                  <nav class="nmda-classify-modebar" aria-label="导入核验步骤">
                    <button class="is-active" type="button" data-preflight-view="files"><span>1</span><strong>核验文件</strong><small>确认用途</small></button>
                    <button type="button" data-preflight-view="support"><span>2</span><strong>批次资料</strong><small>名单与附件</small></button>
                  </nav>

                  <div class="nmda-classify-workspace" data-preflight-view="files">
                    <div class="nmda-classify-files-view" data-preflight-panel="files">
                    <aside class="nmda-classify-sidebar">
                      <div class="nmda-classify-pane-head">
                        <div><span>目录 / 批次</span><strong id="nmda-preflight-directory-title">全部文件</strong></div>
                        <span id="nmda-preflight-directory-count">0</span>
                      </div>
                      <div class="nmda-classify-directory-nav" id="nmda-preflight-directory-nav"></div>


                    </aside>

                    <section class="nmda-preflight-source-routing nmda-classify-main" id="nmda-preflight-source-routing">
                      <div class="nmda-classify-toolbar">
                        <div class="nmda-classify-toolbar-title">
                          <strong id="nmda-preflight-source-routing-summary">文件列表</strong>
                          <small id="nmda-preflight-source-routing-subtitle">点击文件在右侧查看内容；用途不对时再修改。</small>
                        </div>
                        <div class="nmda-classify-toolbar-actions">
                          <label class="nmda-classify-search"><span>⌕</span><input id="nmda-preflight-source-search" type="search" placeholder="搜索文件名或目录"></label>
                        </div>
                      </div>

                      <div class="nmda-classify-dropzones" id="nmda-preflight-dropzones" aria-label="拖拽文件重新分类">
                        <button class="nmda-classify-dropzone" data-drop-purpose="mail" data-tone="mail" type="button"><span class="nmda-drop-icon">✉</span><span><strong>邮件</strong><small>拖到这里</small></span><b data-drop-count="mail">0</b></button>
                        <button class="nmda-classify-dropzone" data-drop-purpose="roster" data-tone="roster" type="button"><span class="nmda-drop-icon">名</span><span><strong>总名单</strong><small>拖到这里</small></span><b data-drop-count="roster">0</b></button>
                        <button class="nmda-classify-dropzone" data-drop-purpose="attachment" data-tone="attachment" type="button"><span class="nmda-drop-icon">附</span><span><strong>附件</strong><small>拖到这里</small></span><b data-drop-count="attachment">0</b></button>
                        <button class="nmda-classify-dropzone" data-drop-purpose="review" data-tone="review" type="button"><span class="nmda-drop-icon">!</span><span><strong>待确认</strong><small>稍后再看</small></span><b data-drop-count="review">0</b></button>
                        <button class="nmda-classify-dropzone" data-drop-purpose="ignored" data-tone="ignored" type="button"><span class="nmda-drop-icon">×</span><span><strong>暂不使用</strong><small>本批次忽略</small></span><b data-drop-count="ignored">0</b></button>
                      </div>

                      <div class="nmda-preflight-routing-tip" hidden><span>↕</span><small>拖动文件时会出现快速归类区域。</small></div>
                      <div class="nmda-preflight-source-routing-list nmda-classify-file-list" id="nmda-preflight-source-routing-list"></div>
                    </section>

                    <aside class="nmda-classify-inspector-pane" aria-label="当前文件核验">
                      <div class="nmda-source-inspector-empty" id="nmda-source-inspector-empty">
                        <span class="nmda-source-inspector-empty-icon">⌁</span>
                        <strong>选择一个文件查看内容</strong>
                        <small>分类正确无需操作；只有发现用途不对时才修改。</small>
                      </div>
                      <div class="nmda-source-inspector-card" id="nmda-source-inspector-card" hidden>
                        <div class="nmda-source-inspector-card-head">
                          <button class="nmda-source-inspector-close" id="nmda-source-inspector-close" type="button" aria-label="返回文件列表">←</button>
                          <div><span>当前文件</span><strong id="nmda-source-inspector-title">文件核验</strong></div>
                        </div>
                        <div class="nmda-source-inspector-overview" id="nmda-source-inspector-overview"></div>
                        <div class="nmda-source-inspector-actions" id="nmda-source-inspector-actions"></div>
                        <div class="nmda-source-inspector-content" id="nmda-source-inspector-content"></div>
                        <button class="nmda-source-next-review" id="nmda-source-next-review" type="button" hidden>查看下一个待确认 →</button>
                        <div class="nmda-source-inspector-legacy-tools" id="nmda-ingest-diagnostics" hidden aria-hidden="true">
                          <div class="nmda-diagnostics-grid">
                            <div class="nmda-ingest-structure-card" id="nmda-structure-card" hidden>
                              <div class="nmda-card-subtitle">读取内容</div>
                              <div class="nmda-field nmda-inspector-collection-list-field"><span class="nmda-label">文件内内容</span><div id="nmda-collection-list" class="nmda-collection-list"></div></div>
                              <label class="nmda-field" id="nmda-collection-field"><span class="nmda-label">当前内容</span><select id="nmda-collection-select"></select></label>
                              <div id="nmda-structure-summary" class="nmda-structure-summary"></div>
                              <div class="nmda-raw-preview-wrap"><div id="nmda-structure-preview" class="nmda-structure-preview"></div></div>
                            </div>
                            <div class="nmda-ingest-mapping-card" id="nmda-mapping-card" hidden>
                              <div class="nmda-card-subtitle">邮件内容对应</div>
                              <div id="nmda-header-info" class="nmda-hint nmda-semantic-detection"></div>
                              <div id="nmda-semantic-summary" class="nmda-semantic-summary"></div>
                              <div class="nmda-row nmda-wrap nmda-mapping-actions"><button class="nmda-btn nmda-btn-small" id="nmda-apply-profile" type="button" hidden>使用已有设置</button><button class="nmda-btn nmda-btn-small" id="nmda-save-profile" type="button" hidden>保存当前设置</button><button class="nmda-btn nmda-btn-small" id="nmda-toggle-mapping" type="button">调整读取内容</button></div>
                              <div id="nmda-profile-info" class="nmda-hint"></div>
                              <div id="nmda-mapping" class="nmda-mapping nmda-semantic-mapping" hidden></div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </aside>
                    </div>

                    <section class="nmda-classify-support-view" data-preflight-panel="support" data-support-view="roster" hidden>
                      <header class="nmda-support-view-head">
                        <div><span>批次资料</span><strong>按需要补充</strong></div>
                        <nav class="nmda-support-modebar" aria-label="批次资料类型">
                          <button class="is-active" type="button" data-support-view="roster"><span>名</span><strong>参考名单</strong></button>
                          <button type="button" data-support-view="attachment"><span>附</span><strong>附件</strong></button>
                        </nav>
                      </header>
                    <section class="nmda-classify-supplements nmda-classify-upload-dock" id="nmda-preflight-supplements" aria-label="批次资料">
                        <div class="nmda-classify-supplement-stack">
                          <article class="nmda-supplement-box nmda-supplement-box-compact" id="nmda-preflight-roster-box" data-support-pane="roster" data-state="pending">
                            <div class="nmda-supplement-box-icon">名</div>
                            <div class="nmda-supplement-box-main">
                              <strong id="nmda-preflight-roster-title">参考总名单</strong>
                              <small id="nmda-preflight-roster-copy">已有总名单时可加入。</small>
                              <div class="nmda-supplement-status" id="nmda-preflight-roster-status">尚未添加</div>
                            </div>
                            <div class="nmda-supplement-actions">
                              <label class="nmda-btn nmda-btn-small nmda-btn-primary" for="nmda-roster-file">上传名单</label>
                            </div>
                          </article>
                          <article class="nmda-supplement-box nmda-supplement-box-compact nmda-supplement-box-attachment" id="nmda-preflight-attachment-box" data-support-pane="attachment" data-state="pending">
                            <div class="nmda-supplement-box-icon">附</div>
                            <div class="nmda-supplement-box-main">
                              <strong id="nmda-preflight-attachment-title">附件工作台</strong>
                              <small id="nmda-preflight-attachment-copy">所有附件统一在一个面板中配置发送范围。</small>
                              <div class="nmda-attachment-requirements" id="nmda-preflight-attachment-requirements"></div>
                              <div class="nmda-supplement-status" id="nmda-preflight-attachment-status">尚未添加</div>
                              <div class="nmda-attachment-assets nmda-attachment-assets-inline" id="nmda-preflight-attachment-assets" hidden>
                                <div class="nmda-attachment-assets-head"><strong>附件状态</strong><span id="nmda-preflight-attachment-assets-count"></span></div>
                                <div class="nmda-attachment-assets-list" id="nmda-preflight-attachment-assets-list"></div>
                              </div>
                            </div>
                            <div class="nmda-supplement-actions">
                              <button class="nmda-btn nmda-btn-small nmda-btn-primary" type="button" data-open-attachment-manager>打开附件工作台</button>
                            </div>
                          </article>
                        </div>
                      </section>
                    </section>
                  </div>

                  <footer class="nmda-supplement-foot nmda-classify-foot">
                    <button class="nmda-btn nmda-btn-quiet" id="nmda-close-supplement-preflight" type="button">返回上传</button>
                    <div class="nmda-classify-foot-summary"><strong id="nmda-preflight-batch-summary">正在核验本批次</strong><small>无误即可继续。</small></div>
                    <button class="nmda-btn nmda-btn-primary" id="nmda-complete-supplement-preflight" type="button">确认分类并继续 →</button>
                  </footer>
                </section>
              </div>

              <div class="nmda-attachment-manager-overlay" id="nmda-attachment-manager-overlay" hidden aria-hidden="true">
                <section class="nmda-attachment-manager" role="dialog" aria-modal="true" aria-labelledby="nmda-attachment-manager-title">
                  <div class="nmda-attachment-manager-head">
                    <div><span class="nmda-supplement-kicker">统一附件配置</span><h3 id="nmda-attachment-manager-title">附件工作台</h3><p>每个文件只配置“发给哪些邮件”。拖入文件或文件夹后，可自动匹配、应用全部邮件，或精确指定邮件。</p></div>
                    <button class="nmda-icon-btn" id="nmda-close-attachment-manager" type="button" aria-label="关闭附件工作台">×</button>
                  </div>
                  <div class="nmda-attachment-manager-body">
                    <div class="nmda-attachment-workspace-stats" id="nmda-attachment-manager-summary">尚未加入附件。</div>
                    <div class="nmda-attachment-manager-drop" id="nmda-attachment-manager-drop" tabindex="0" role="button" aria-label="拖入或选择附件">
                      <span class="nmda-attachment-manager-drop-icon">⇧</span>
                      <div><strong>拖入附件或文件夹</strong><small>也可以点击选择文件；文件夹会保留相对路径并参与自动匹配。</small></div>
                      <span class="nmda-attachment-manager-drop-action">选择文件</span>
                    </div>
                    <div class="nmda-attachment-manager-addbar">
                      <label class="nmda-btn nmda-btn-small nmda-btn-primary" for="nmda-attachment-files">选择文件</label>
                      <label class="nmda-btn nmda-btn-small" for="nmda-attachment-dir">选择文件夹</label>
                      <input id="nmda-attachment-files" type="file" multiple hidden>
                      <input id="nmda-attachment-dir" type="file" webkitdirectory multiple hidden>
                      <input id="nmda-shared-files" type="file" multiple hidden aria-hidden="true">
                      <span id="nmda-file-index-info" class="nmda-hint">尚未选择本地附件。</span>
                    </div>
                    <section class="nmda-attachment-workspace-section">
                      <header><div><strong>附件文件</strong><small>逐个确认实际发送范围。</small></div><span id="nmda-attachment-manager-file-count">0 个</span></header>
                      <div class="nmda-attachment-assets" id="nmda-attachment-manager-assets">
                        <div class="nmda-attachment-assets-list nmda-attachment-workspace-list" id="nmda-attachment-manager-list"></div>
                        <div class="nmda-attachment-assets-empty" id="nmda-attachment-manager-empty">还没有附件。把文件拖到上方即可开始配置。</div>
                      </div>
                    </section>
                    <section class="nmda-attachment-target-editor" id="nmda-attachment-target-editor" hidden>
                      <header><div><span>指定邮件</span><strong id="nmda-attachment-target-title">选择适用邮件</strong></div><button class="nmda-icon-btn" id="nmda-attachment-target-close" type="button" aria-label="关闭指定邮件设置">×</button></header>
                      <div class="nmda-attachment-target-toolbar"><label><span>⌕</span><input id="nmda-attachment-target-search" type="search" placeholder="搜索收件人、主题或学校"></label><button class="nmda-btn nmda-btn-small" id="nmda-attachment-target-all" type="button">全选当前</button><button class="nmda-btn nmda-btn-small nmda-btn-quiet" id="nmda-attachment-target-clear" type="button">清空</button></div>
                      <div class="nmda-attachment-target-list" id="nmda-attachment-target-list"></div>
                    </section>
                    <section class="nmda-attachment-workspace-section nmda-attachment-requirement-section" id="nmda-attachment-manager-requirements-section">
                      <header><div><strong>邮件中的附件要求</strong><small>用于检查自动匹配是否覆盖完整，不需要另开一套附件界面。</small></div><span id="nmda-attachment-manager-requirements-count">0 项</span></header>
                      <div class="nmda-attachment-requirement-list" id="nmda-attachment-manager-requirements"></div>
                    </section>
                  </div>
                  <div class="nmda-attachment-manager-foot">
                    <button class="nmda-btn nmda-btn-danger-quiet" id="nmda-manager-clear-attachments" type="button">清空附件</button>
                    <div class="nmda-row nmda-wrap"><span class="nmda-hint" id="nmda-attachment-manager-foot-note">更改范围会立即同步到邮件任务。</span><button class="nmda-btn nmda-btn-primary" id="nmda-attachment-manager-done" type="button">完成</button></div>
                  </div>
                </section>
              </div>

              <div class="nmda-card nmda-ingest-result-card" id="nmda-ingest-result-card" hidden>
                <div class="nmda-card-head nmda-ingest-result-head">
                  <div><div class="nmda-card-title">当前待办</div><div class="nmda-card-desc">处理本批次仍需确认或补充的内容。</div></div>
                  <div class="nmda-row nmda-wrap"><button class="nmda-btn nmda-btn-small nmda-btn-quiet" id="nmda-restore-excluded" type="button" hidden>恢复已排除</button><button class="nmda-btn nmda-btn-primary nmda-btn-small" id="nmda-review-import-issues" type="button" hidden>继续处理待办</button></div>
                </div>
                <div class="nmda-context-cue nmda-context-cue-compact nmda-attachment-context-cue" id="nmda-attachment-context-cue" hidden>
                  <div class="nmda-context-cue-icon" aria-hidden="true">⇧</div>
                  <div class="nmda-context-cue-main"><span class="nmda-context-eyebrow">待办 · 创建前必须补齐</span><strong id="nmda-attachment-context-title">附件待补</strong><small id="nmda-attachment-context-copy">添加本批次需要的附件。</small></div>
                  <div class="nmda-context-cue-actions"><button class="nmda-btn nmda-btn-primary nmda-btn-small" id="nmda-attachment-send-action" type="button" data-open-attachment-manager>打开附件工作台</button><button class="nmda-btn nmda-btn-small nmda-btn-quiet" id="nmda-attachment-later" type="button">稍后处理</button></div>
                </div>
                <div class="nmda-attachment-library-bar" id="nmda-attachment-library-bar" hidden><div class="nmda-attachment-library-bar-main"><span class="nmda-attachment-library-bar-icon">↗</span><div><strong id="nmda-attachment-library-bar-title">附件资料</strong><small id="nmda-attachment-library-bar-copy">查看或调整已加入的附件。</small></div></div><button class="nmda-btn nmda-btn-small" id="nmda-manage-attachments-workflow" type="button">查看 / 修改</button></div>
                <div id="nmda-import-preview-summary" class="nmda-ingest-health"></div>
                <div id="nmda-review-guidance" class="nmda-review-guidance">解析完成后可查看每封邮件的结果。</div>
                <details class="nmda-optional-source-details nmda-attachment-gateway" id="nmda-attachments-card" hidden>
                  <summary><span><strong>附件工作台</strong><small>查看文件、发送范围与匹配状态</small></span><span>展开</span></summary>
                  <div id="nmda-attachment-summary" class="nmda-summary">尚未添加附件。</div>
                  <div class="nmda-row nmda-wrap"><button class="nmda-btn nmda-btn-small nmda-btn-primary" type="button" data-open-attachment-manager>打开附件工作台</button></div>
                  <div id="nmda-attachment-resolution" class="nmda-attachment-resolution" hidden><div id="nmda-attachment-resolution-list"></div></div>
                </details>
                <div class="nmda-import-handoff-card" id="nmda-import-handoff-card" hidden>
                  <div id="nmda-import-ready-summary" class="nmda-import-ready-summary">尚未生成任务。</div>
                  <div class="nmda-row nmda-import-handoff-actions"><span class="nmda-hint" id="nmda-handoff-hint"></span><button class="nmda-btn nmda-btn-primary" id="nmda-go-batch" type="button">进入选择与安排</button></div>
                </div>
              </div>

              <div class="nmda-card nmda-inline-review" id="nmda-inline-review" hidden>
                <div class="nmda-inline-review-top">
                  <div><div class="nmda-card-title" id="nmda-review-workspace-title">邮件审阅</div><div class="nmda-card-desc" id="nmda-review-workspace-desc">先看状态，再处理少数需要人工介入的邮件。</div></div>
                  <div class="nmda-inline-review-actions"><div id="nmda-review-page-summary" class="nmda-review-page-summary"></div><button class="nmda-btn nmda-btn-small nmda-btn-quiet" id="nmda-review-next-pending" type="button">下一个待办</button><button class="nmda-btn nmda-btn-small nmda-btn-quiet" id="nmda-import-editor-cancel" type="button">完成并返回</button></div>
                </div>
                <div class="nmda-review-boardbar">
                  <div class="nmda-review-board-copy"><strong id="nmda-review-queue-title">邮件状态</strong><small id="nmda-review-queue-caption">颜色与形状直接表示自动识别结果。</small></div>
                  <div class="nmda-review-filter nmda-review-status-tabs" id="nmda-review-filter" role="group" aria-label="邮件状态筛选">
                    <button class="is-active" type="button" data-review-filter="all">全部</button>
                    <button type="button" data-review-filter="auto">自动通过</button>
                    <button type="button" data-review-filter="pending">需处理</button>
                    <button type="button" data-review-filter="decision">冲突/重复</button>
                    <button type="button" data-review-filter="confirmed">已确认</button>
                  </div>
                  <div class="nmda-review-queue-tools">
                    <label class="nmda-review-search"><span aria-hidden="true">⌕</span><input id="nmda-review-search" type="search" placeholder="搜索收件人 / 邮箱 / 主题" autocomplete="off"></label>
                    <button class="nmda-btn nmda-btn-small nmda-btn-quiet nmda-review-subject-entry" id="nmda-review-fill-subjects" type="button" hidden>一键补主题</button>
                    <button class="nmda-btn nmda-btn-small nmda-btn-quiet nmda-review-bulk-entry" id="nmda-review-select-filtered" type="button">批量确认…</button>
                  </div>
                </div>
                <div class="nmda-review-subject-prompt" id="nmda-review-subject-prompt" hidden>
                  <div class="nmda-review-subject-prompt-copy"><span class="nmda-review-subject-prompt-icon" aria-hidden="true">T</span><div><strong id="nmda-review-subject-prompt-title">检测到多封邮件缺少主题</strong><small id="nmda-review-subject-prompt-copy">输入一次，只补齐缺少主题的邮件，不覆盖已有主题。</small></div></div>
                  <label class="nmda-review-subject-prompt-input"><span>统一主题</span><input id="nmda-review-bulk-subject-input" type="text" placeholder="输入要补齐的邮件主题" autocomplete="off"></label>
                  <div class="nmda-review-subject-prompt-actions"><button class="nmda-btn nmda-btn-primary nmda-btn-small" id="nmda-review-bulk-subject-apply" type="button">一键补齐</button><button class="nmda-btn nmda-btn-small nmda-btn-quiet" id="nmda-review-bulk-subject-dismiss" type="button">稍后处理</button></div>
                </div>
                <div class="nmda-review-batchbar" id="nmda-review-batchbar" hidden>
                  <div><strong id="nmda-review-selected-count">已选 0 封</strong><small>一次确认所选邮件</small></div>
                  <div class="nmda-row"><button class="nmda-btn nmda-btn-primary nmda-btn-small" id="nmda-review-confirm-selected" type="button">确认所选</button><button class="nmda-btn nmda-btn-small nmda-btn-quiet" id="nmda-review-clear-selected" type="button">取消</button></div>
                </div>
                <div class="nmda-review-page-empty" id="nmda-review-page-empty">添加资料后，这里会显示每封邮件的识别状态。</div>
                <div id="nmda-review-queue" class="nmda-review-queue nmda-review-mail-grid"></div>

                <div class="nmda-review-workbench" id="nmda-import-editor-overlay" hidden aria-hidden="true">
                  <section class="nmda-review-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="nmda-import-editor-title">
                    <div class="nmda-review-layout">
                      <section class="nmda-review-edit-pane">
                        <div class="nmda-review-pane-title nmda-review-mail-toolbar">
                          <span class="nmda-review-mail-heading"><strong id="nmda-import-editor-title">审阅邮件</strong><small id="nmda-import-editor-evidence">先核对完整邮件，再决定是否需要修正</small></span>
                          <div class="nmda-review-mail-actions">
                            <div class="nmda-review-pager" role="group" aria-label="切换邮件"><button type="button" id="nmda-review-prev" aria-label="上一封">‹</button><span id="nmda-review-position">1 / 1</span><button type="button" id="nmda-review-next" aria-label="下一封">›</button></div>
                            <button class="nmda-review-exclude-direct" id="nmda-review-exclude" type="button" title="排除后可在已排除邮件中恢复">排除此封</button>
                            <button class="nmda-icon-btn nmda-review-detail-close" id="nmda-import-editor-close" type="button" aria-label="关闭邮件审阅">×</button>
                          </div>
                        </div>
                        <div class="nmda-review-problem-strip"><span class="nmda-review-problem-shape" aria-hidden="true">!</span><span id="nmda-review-problem-summary">重点核对开头、结尾与邮件边界</span></div>
                        <div class="nmda-review-edit-scroll">
                          <div id="nmda-review-feedback" class="nmda-review-feedback" hidden></div>
                          <section class="nmda-duplicate-decision" id="nmda-duplicate-decision" hidden>
                            <div class="nmda-duplicate-decision-head">
                              <div><strong id="nmda-duplicate-decision-title">发现重复邮件</strong><small id="nmda-duplicate-decision-copy">同时比较本组邮件，决定实际要保留的版本。</small></div>
                              <span class="nmda-duplicate-kind" id="nmda-duplicate-decision-kind">重复</span>
                            </div>
                            <div class="nmda-duplicate-candidates" id="nmda-duplicate-candidates"></div>
                            <div class="nmda-duplicate-actions">
                              <span class="nmda-hint" id="nmda-duplicate-decision-hint">默认勾选信息更完整的一封；也可以直接勾选多封。</span>
                              <div class="nmda-row nmda-wrap"><button class="nmda-btn nmda-btn-primary" id="nmda-duplicate-keep-selected" type="button">保留所选（1）</button><button class="nmda-btn" id="nmda-duplicate-keep-all" type="button">全部保留</button></div>
                            </div>
                          </section>

                          <section class="nmda-review-audit-view" id="nmda-review-audit-view">
                            <div class="nmda-review-semantic-legend" id="nmda-review-semantic-legend" aria-label="语义高亮图例"></div>
                            <div class="nmda-review-audit-checks" aria-label="邮件核验要点">
                              <div class="nmda-review-audit-check" id="nmda-audit-check-recipient"><span>收件人</span><strong id="nmda-audit-recipient-state">—</strong></div>
                              <div class="nmda-review-audit-check" id="nmda-audit-check-subject"><span>主题</span><strong id="nmda-audit-subject-state">—</strong></div>
                              <div class="nmda-review-audit-check" id="nmda-audit-check-opening"><span>开头</span><strong id="nmda-audit-opening-state">—</strong></div>
                              <div class="nmda-review-audit-check" id="nmda-audit-check-closing"><span>结尾</span><strong id="nmda-audit-closing-state">—</strong></div>
                              <div class="nmda-review-audit-check" id="nmda-audit-check-attachment"><span>附件</span><strong id="nmda-audit-attachment-state">—</strong></div>
                            </div>

                            <div class="nmda-review-edge-focus">
                              <article class="nmda-review-edge-card" data-edge="opening"><header><span>01</span><div><strong>开头核验</strong><small>称呼、身份与第一段是否属于这封邮件</small></div></header><pre id="nmda-audit-opening">—</pre></article>
                              <article class="nmda-review-edge-card" data-edge="closing"><header><span>02</span><div><strong>结尾核验</strong><small>收尾、署名与邮件终点是否正确</small></div></header><pre id="nmda-audit-closing">—</pre></article>
                            </div>

                            <section class="nmda-review-mail-sheet" aria-label="完整邮件">
                              <div class="nmda-review-mail-sheet-head">
                                <div><span>收件人</span><strong id="nmda-audit-recipient">—</strong></div>
                                <div><span>主题</span><strong id="nmda-audit-subject">—</strong></div>
                              </div>
                              <div class="nmda-review-mail-sheet-title"><strong>完整邮件</strong><small>从头到尾连续显示；开头和结尾已在上方重点抽取</small></div>
                              <pre class="nmda-review-mail-sheet-body" id="nmda-audit-full-body">—</pre>
                            </section>
                          </section>

                          <section class="nmda-review-correction-panel" id="nmda-review-correction-panel" hidden>
                            <div class="nmda-review-correction-head"><div><strong>修正识别结果</strong><small>只在发现错误时修改；返回审阅后重新核对完整邮件。</small></div></div>
                            <div class="nmda-import-editor-grid nmda-review-core-fields">
                              <label class="nmda-field" id="nmda-review-field-recipients"><span class="nmda-label">收件人</span><input id="nmda-import-edit-recipients" type="text" placeholder="recipient@example.edu"><span id="nmda-recipient-assist" class="nmda-field-assist" hidden></span></label>
                              <label class="nmda-field nmda-import-editor-wide" id="nmda-review-field-subject"><span class="nmda-label">主题</span><input id="nmda-import-edit-subject" type="text"></label>
                              <div class="nmda-context-assist" id="nmda-subject-assist" hidden>
                                <div><strong id="nmda-subject-assist-title">还有邮件缺少主题</strong><small id="nmda-subject-assist-copy"></small></div>
                                <div class="nmda-row nmda-wrap"><button class="nmda-btn nmda-btn-primary nmda-btn-small" id="nmda-subject-assist-apply" type="button">一键填写</button><button class="nmda-btn nmda-btn-small nmda-btn-quiet" id="nmda-subject-assist-dismiss" type="button">不用</button></div>
                              </div>
                              <label class="nmda-field nmda-import-editor-wide" id="nmda-review-field-body"><span class="nmda-label">正文</span><textarea id="nmda-import-edit-body"></textarea></label>
                            </div>
                          </section>
                        </div>
                        <input id="nmda-import-edit-schedule" type="hidden">
                        <input id="nmda-import-edit-attachments" type="hidden">
                        <input id="nmda-import-edit-tags" type="hidden">
                        <div class="nmda-review-actions" id="nmda-review-actions">
                          <span class="nmda-review-action-copy">先完整核验，再确认；缺失必填内容时必须先修正。</span>
                          <div class="nmda-row nmda-wrap">
                            <button class="nmda-btn nmda-btn-quiet" id="nmda-review-back-audit" type="button" hidden>← 返回审阅</button>
                            <button class="nmda-btn" id="nmda-review-correct" type="button">发现问题，修正</button>
                            <button class="nmda-btn" id="nmda-import-editor-save" type="button">确认无误</button>
                            <button class="nmda-btn nmda-btn-primary" id="nmda-import-editor-next" type="button">确认无误，下一封</button>
                          </div>
                        </div>
                      </section>
                    </div>
                  </section>
                </div>
              </div>

              <div class="nmda-card nmda-roster-audit-card" id="nmda-roster-audit-card" hidden>
                <div class="nmda-card-head"><div><div class="nmda-card-title">联系人核验</div><div class="nmda-card-desc">发现可能重复的联系人时会在这里提示。</div></div></div>
                <input id="nmda-roster-enabled" type="checkbox" checked hidden>
                <input id="nmda-roster-auto-school" type="checkbox" checked hidden>
                <input id="nmda-roster-strict" type="checkbox" hidden>
                <div id="nmda-roster-audit-summary" class="nmda-ingest-health"></div>
                <div id="nmda-roster-audit-note" class="nmda-review-guidance"></div>
                <details class="nmda-roster-details"><summary>查看核验详情</summary><div id="nmda-roster-audit-details" class="nmda-roster-audit-details"></div></details>
              </div>

            </div>

            <div class="nmda-workflow-stage-separator" aria-hidden="true"></div>
            <div class="nmda-workflow-stage-head" id="nmda-stage-execute" hidden>
              <span class="nmda-stage-number">03</span><div><strong>确认与安排</strong><small>确认邮件与发送时间。</small></div>
            </div>
            <div class="nmda-batch-empty" id="nmda-batch-empty" hidden><button id="nmda-go-import" type="button" hidden>回到准备区</button></div>

            <div class="nmda-card nmda-list-card nmda-planning-workspace" id="nmda-preview-card" hidden>
              <div class="nmda-card-head nmda-list-head nmda-planning-head">
                <div><div class="nmda-card-title">安排本次邮件</div><div class="nmda-card-desc">主页面只看邮件与时间；需要修改时打开审阅或排期设置。</div></div>
                <div class="nmda-planning-head-actions">
                  <div id="nmda-batch-summary" class="nmda-summary nmda-summary-inline"></div>
                  <button class="nmda-btn nmda-btn-small nmda-btn-quiet nmda-pre-send-file-action" id="nmda-manage-attachments-planning" type="button" data-open-attachment-manager>附件工作台</button>
                  <button class="nmda-btn nmda-btn-small nmda-btn-quiet" id="nmda-open-review-from-planning" type="button">审阅邮件</button>
                  <button class="nmda-btn nmda-btn-small nmda-btn-primary" id="nmda-open-schedule-modal" type="button">排期设置</button>
                </div>
              </div>
              <div class="nmda-planning-statusbar">
                <span id="nmda-planning-rule-chip">尚未应用排期规则</span>
                <span id="nmda-planning-selection-chip">选择邮件后即可安排时间</span>
                <span id="nmda-planning-attachment-chip">附件可随时在工作台调整</span>
              </div>
              <details class="nmda-scope-tools" id="nmda-scope-tools">
                <summary><span><strong>筛选邮件</strong><small>搜索、按状态筛选或调整本次范围</small></span><span class="nmda-scope-toggle">展开</span></summary>
                <div class="nmda-task-toolbar">
                  <label class="nmda-search-field"><input id="nmda-batch-search" type="search" placeholder="搜索收件人或主题"></label>
                  <label class="nmda-compact-select"><span>联系状态</span><select id="nmda-batch-stage-filter"><option value="">全部</option><option value="未联系">未联系</option><option value="已发送">已发送</option><option value="已回复">已回复</option></select></label>
                  <button class="nmda-btn nmda-btn-small" id="nmda-bulk-enable" type="button">纳入筛选结果</button>
                  <button class="nmda-btn nmda-btn-small nmda-btn-quiet" id="nmda-clear-selection" type="button">排除全部</button>
                </div>
              </details>
              <input id="nmda-batch-tag-include" type="hidden"><button id="nmda-clear-tag-filter" type="button" hidden></button><div id="nmda-batch-tag-chips" hidden></div>
              <input id="nmda-bulk-tag-value" type="hidden"><button id="nmda-bulk-add-tag" type="button" hidden></button><button id="nmda-bulk-remove-tag" type="button" hidden></button><button id="nmda-bulk-disable" type="button" hidden></button>
              <div class="nmda-table-wrap nmda-batch-table-wrap"><table class="nmda-table nmda-batch-table"><thead><tr><th>选择</th><th>收件人</th><th>主题</th><th>发送时间</th><th>结果</th><th></th></tr></thead><tbody id="nmda-preview-body"></tbody></table></div>
              <div class="nmda-mail-handoff-bar" id="nmda-mail-handoff-bar">
                <div class="nmda-mail-handoff-copy"><span class="nmda-mail-handoff-mark" aria-hidden="true">N</span><div><strong id="nmda-batch-status">准备转到网易邮箱执行</strong><small id="nmda-create-preflight">确认本次范围与排期后，真实创建过程将在网易邮箱页面显示。</small></div></div>
                <button class="nmda-btn nmda-btn-primary nmda-mail-handoff-action" id="nmda-batch-start" type="button">前往网易邮箱并创建所选草稿</button>
                <button id="nmda-batch-stop" type="button" hidden disabled>当前封后停止</button>
              </div>
            </div>

            <div class="nmda-workflow-modal-overlay" id="nmda-schedule-modal" hidden>
              <section class="nmda-workflow-dialog nmda-schedule-dialog" role="dialog" aria-modal="true" aria-labelledby="nmda-schedule-dialog-title">
                <header class="nmda-workflow-dialog-head">
                  <div><span class="nmda-dialog-eyebrow">本批次</span><h3 id="nmda-schedule-dialog-title">排期设置</h3><p>设置规则后应用到当前已选择邮件。</p></div>
                  <button class="nmda-dialog-close" id="nmda-close-schedule-modal" type="button" aria-label="关闭排期设置">×</button>
                </header>
                <section class="nmda-schedule-dialog-body" id="nmda-scheduler-card" hidden>
                  <div class="nmda-schedule-dialog-summary" id="nmda-schedule-summary"></div>
                  <div class="nmda-scheduler-grid">
                    <label class="nmda-field"><span class="nmda-label">开始时间</span><input id="nmda-rule-start-at" type="datetime-local"></label>
                    <label class="nmda-field"><span class="nmda-label">每所院校每轮最多</span><input id="nmda-rule-max-school" type="number" min="1" max="20" step="1" value="1"></label>
                    <label class="nmda-field"><span class="nmda-label">同校间隔</span><div class="nmda-input-suffix"><input id="nmda-rule-interval-days" type="number" min="1" max="365" step="1" value="7"><span>天</span></div></label>
                    <label class="nmda-check-card"><input id="nmda-rule-preserve-existing" type="checkbox" checked><span><strong>保留草稿 / 导入原排期</strong></span></label>
                    <label class="nmda-check-card nmda-schedule-wide-check"><input id="nmda-rule-skip-holidays" type="checkbox" checked><span><strong>避开节假日和周末</strong></span></label>
                  </div>
                  <div class="nmda-schedule-rule-preview" id="nmda-schedule-rule-preview">同校每 7 天最多 1 位。</div>
                </section>
                <footer class="nmda-workflow-dialog-foot">
                  <button class="nmda-btn nmda-btn-small nmda-btn-quiet" id="nmda-clear-auto-schedule" type="button">清除自动时间</button>
                  <div class="nmda-dialog-foot-spacer"></div>
                  <button class="nmda-btn nmda-btn-small" id="nmda-cancel-schedule-modal" type="button">取消</button>
                  <button class="nmda-btn nmda-btn-primary nmda-btn-small" id="nmda-apply-schedule" type="button">应用排期</button>
                </footer>
              </section>
            </div>



          </section>

          <div class="nmda-page-head" data-page-head="followup" hidden>
            <div><h2>Follow-up</h2><p>查看回复证据，按自定义条件人工生成跟进草稿。</p></div>
          </div>
          <section class="nmda-tabpane nmda-page nmda-followup-page" data-pane="followup" hidden>
            <div class="nmda-contact-command-strip nmda-followup-command-strip">
              <div class="nmda-contact-sync-state"><span class="nmda-contact-sync-dot"></span><div><strong>回复记录</strong><span id="nmda-followup-sync-meta" class="nmda-read-meta">尚未同步收件箱。</span></div></div>
              <div id="nmda-followup-status" class="nmda-contact-status-inline">Follow-up 已就绪。</div>
              <div class="nmda-contact-command-actions"><button class="nmda-btn nmda-btn-primary nmda-btn-small" id="nmda-followup-sync" type="button">同步邮箱与回复</button></div>
            </div>

            <div class="nmda-followup-layout">
              <div class="nmda-card nmda-followup-list-card">
                <div class="nmda-card-head nmda-list-head"><div><div class="nmda-card-title">可跟进邮件</div><div class="nmda-card-desc">条件只负责筛选；不会自动创建或发送任何邮件。</div></div><div id="nmda-followup-summary" class="nmda-summary nmda-summary-inline">0 个候选</div></div>
                <div class="nmda-contact-toolbar nmda-followup-toolbar">
                  <label class="nmda-contact-searchbox"><span>⌕</span><input id="nmda-followup-search" type="text" placeholder="搜索邮箱、姓名或原主题"></label>
                  <select id="nmda-followup-filter"><option value="eligible">符合条件</option><option value="sent">全部已发送</option><option value="human">有真人回复</option><option value="auto">有 Auto Reply</option><option value="created">已创建 Follow-up</option></select>
                </div>
                <div class="nmda-table-wrap nmda-followup-table-wrap"><table class="nmda-table nmda-followup-table"><thead><tr><th>联系人</th><th>原邮件</th><th>回复</th><th>Follow-up</th><th></th></tr></thead><tbody id="nmda-followup-body"></tbody></table></div>
              </div>

              <aside class="nmda-card nmda-followup-settings-card">
                <div class="nmda-card-head"><div><div class="nmda-card-title">跟进规则</div><div class="nmda-card-desc">用于筛选与生成格式；最终仍需人工触发。</div></div></div>
                <div class="nmda-followup-settings-grid">
                  <label class="nmda-field"><span class="nmda-label">跟进形式</span><select id="nmda-followup-mode"><option value="forward">Fw / 网易原生转发</option><option value="reply">Re / 网易原生回复</option><option value="new">新邮件</option></select></label>
                  <label class="nmda-field"><span class="nmda-label">最少等待</span><div class="nmda-input-suffix"><input id="nmda-followup-min-days" type="number" min="0" max="365" step="1"><span>天</span></div></label>
                  <label class="nmda-field"><span class="nmda-label">最多创建次数</span><input id="nmda-followup-max-count" type="number" min="0" max="20" step="1"><span class="nmda-hint">0 = 不限制</span></label>
                  <label class="nmda-field"><span class="nmda-label">Fw 前缀</span><input id="nmda-followup-fw-prefix" type="text" placeholder="Fw:"></label>
                  <label class="nmda-field"><span class="nmda-label">Re 前缀</span><input id="nmda-followup-re-prefix" type="text" placeholder="Re:"></label>
                  <label class="nmda-check-card"><input id="nmda-followup-block-human" type="checkbox"><span><strong>真人回复后停止跟进</strong><small>默认开启</small></span></label>
                  <label class="nmda-check-card"><input id="nmda-followup-block-auto" type="checkbox"><span><strong>Auto Reply 也视为已回复</strong><small>默认关闭</small></span></label>
                  <label class="nmda-field nmda-followup-template-field"><span class="nmda-label">Follow-up 正文</span><textarea id="nmda-followup-template" rows="8"></textarea><span class="nmda-hint">变量：{{name}} · {{email}} · {{subject}} · {{days}}</span></label>
                </div>
                <div class="nmda-actions nmda-followup-settings-actions"><button class="nmda-btn nmda-btn-primary nmda-btn-small" id="nmda-followup-save-settings" type="button">保存规则</button><button class="nmda-btn nmda-btn-small nmda-btn-quiet" id="nmda-followup-reset-settings" type="button">恢复默认</button></div>
              </aside>
            </div>
          </section>

          <div class="nmda-page-head" data-page-head="contacts" hidden>
            <div><h2>联系人</h2><p>浏览联系人；点开后再编辑状态和历史。</p></div>
          </div>
          <section class="nmda-tabpane nmda-page nmda-contacts-page" data-pane="contacts" hidden>
            <div class="nmda-contact-command-strip">
              <div class="nmda-contact-sync-state"><span class="nmda-contact-sync-dot"></span><div><strong>邮箱记录</strong><span id="nmda-mailbox-read-meta" class="nmda-read-meta">尚未同步邮箱状态。</span></div></div>
              <div id="nmda-contact-status" class="nmda-contact-status-inline">正在加载联系人…</div>
              <div class="nmda-contact-command-actions">
                <button class="nmda-btn nmda-btn-primary nmda-btn-small" id="nmda-refresh-history" type="button">同步邮箱</button>
                <button class="nmda-btn nmda-btn-small" id="nmda-export-contacts" type="button">导出 CSV</button>
                <details class="nmda-contact-maintenance-menu"><summary>维护</summary><button class="nmda-btn nmda-btn-small" id="nmda-rebuild-history" type="button">重建联系人记录</button></details>
              </div>
            </div>

            <div class="nmda-card nmda-contact-list-card nmda-contact-browser-card">
              <div class="nmda-card-head nmda-list-head nmda-contact-browser-head"><div><div class="nmda-card-title">联系人列表</div><div class="nmda-card-desc">主列表只展示关键信息；详细状态与历史在联系人弹窗中处理。</div></div><div id="nmda-contact-summary" class="nmda-summary nmda-summary-inline">0 个联系人</div></div>
              <div class="nmda-contact-toolbar nmda-contact-toolbar-unified">
                <label class="nmda-contact-searchbox"><span>⌕</span><input id="nmda-contact-search" type="text" placeholder="搜索邮箱、姓名、主题或状态"></label>
                <input id="nmda-contact-class-filter" type="text" placeholder="筛选状态 / 策略 / 长期标记">
              </div>
              <div id="nmda-contact-class-chips" class="nmda-tag-chips nmda-class-chip-bar"></div>
              <div class="nmda-table-wrap nmda-contact-table-wrap"><table class="nmda-table nmda-contact-table"><thead><tr><th>联系人</th><th>当前状态</th><th>最近活动</th><th>已发送</th><th>草稿</th><th></th></tr></thead><tbody id="nmda-contact-body"></tbody></table></div>
            </div>
          </section>

          <div class="nmda-workflow-modal-overlay" id="nmda-followup-reply-modal" hidden>
            <section class="nmda-workflow-dialog nmda-followup-reply-dialog" role="dialog" aria-modal="true" aria-labelledby="nmda-followup-reply-title">
              <header class="nmda-workflow-dialog-head"><div><span class="nmda-dialog-eyebrow">回复详情</span><h3 id="nmda-followup-reply-title">邮件回复</h3><p id="nmda-followup-reply-meta"></p></div><button class="nmda-dialog-close" id="nmda-followup-reply-close" type="button" aria-label="关闭回复详情">×</button></header>
              <div class="nmda-followup-reply-body"><div id="nmda-followup-reply-badge"></div><div id="nmda-followup-reply-fields" class="nmda-followup-reply-fields"></div><div id="nmda-followup-reply-attachments" class="nmda-followup-reply-attachments" hidden></div><article id="nmda-followup-reply-content" class="nmda-followup-reply-content">正在读取…</article></div>
              <footer class="nmda-workflow-dialog-foot"><div class="nmda-dialog-foot-spacer"></div><button class="nmda-btn nmda-btn-small" id="nmda-followup-reply-close-secondary" type="button">关闭</button></footer>
            </section>
          </div>

          <div class="nmda-workflow-modal-overlay" id="nmda-contact-modal" hidden>
            <section class="nmda-workflow-dialog nmda-contact-dialog" role="dialog" aria-modal="true" aria-labelledby="nmda-contact-dialog-title">
              <header class="nmda-workflow-dialog-head">
                <div><span class="nmda-dialog-eyebrow">联系人</span><h3 id="nmda-contact-dialog-title">联系人详情</h3><p id="nmda-contact-dialog-email"></p></div>
                <button class="nmda-dialog-close" id="nmda-close-contact-modal" type="button" aria-label="关闭联系人详情">×</button>
              </header>
              <div class="nmda-contact-dialog-body">
                <section class="nmda-contact-profile-panel">
                  <div class="nmda-contact-profile-summary" id="nmda-contact-profile-summary"></div>
                  <div class="nmda-contact-editor-grid">
                    <label class="nmda-field"><span class="nmda-label">互动阶段</span><select id="nmda-contact-modal-stage"></select></label>
                    <label class="nmda-field"><span class="nmda-label">发送策略</span><select id="nmda-contact-modal-policy"></select></label>
                    <label class="nmda-check-card"><input id="nmda-contact-modal-followup" type="checkbox"><span><strong>待跟进</strong></span></label>
                    <label class="nmda-field nmda-contact-modal-tags"><span class="nmda-label">长期标记</span><input id="nmda-contact-modal-tags" type="text" placeholder="重点;第一批"></label>
                  </div>
                </section>
                <section class="nmda-contact-history-panel">
                  <div class="nmda-contact-history-head"><strong>联系记录</strong><span id="nmda-contact-history-summary"></span></div>
                  <div class="nmda-contact-history-columns">
                    <div><h4>已发送</h4><div id="nmda-contact-sent-history" class="nmda-contact-history-list"></div></div>
                    <div><h4>草稿</h4><div id="nmda-contact-draft-history" class="nmda-contact-history-list"></div></div>
                  </div>
                </section>
              </div>
              <footer class="nmda-workflow-dialog-foot">
                <button class="nmda-btn nmda-btn-small nmda-btn-quiet" id="nmda-contact-modal-close-secondary" type="button">关闭</button>
                <div class="nmda-dialog-foot-spacer"></div>
                <button class="nmda-btn nmda-btn-primary nmda-btn-small" id="nmda-save-contact-modal" type="button">保存联系人</button>
              </footer>
            </section>
          </div>
        </main>
      </section>`;
    document.documentElement.appendChild(root);
    return root;
  }

  const ui = buildUI();
  // Review is a task modal, not part of any stage canvas. Detaching it prevents
  // stage visibility rules from hiding it when the user opens review from planning.
  const reviewPortal=ui.querySelector('#nmda-inline-review');
  ui.querySelector('#nmda-panel')?.appendChild(reviewPortal);
  // Attachment workspace is a shared portal too: import, review and planning all open
  // exactly the same panel, so no stage visibility rule may own or hide it.
  const attachmentPortal=ui.querySelector('#nmda-attachment-manager-overlay');
  ui.querySelector('#nmda-panel')?.appendChild(attachmentPortal);
  const $ = id => ui.querySelector(`#${id}`);
  const launcher = $('nmda-launcher'), panel = $('nmda-panel');
  document.documentElement.classList.add('nmda-app-document');
  document.body?.classList.add('nmda-app-body');
  ui.classList.add('nmda-standalone');
  panel.hidden = false;
  launcher.hidden = true;
  $('nmda-expand').hidden = true;
  $('nmda-close').hidden = true;
  const recipientsEl = $('nmda-recipients'), subjectEl = $('nmda-subject'), bodyEl = $('nmda-body-text'), filesEl = $('nmda-files');
  const scheduleAtEl = $('nmda-schedule-at');
  const fillButton = $('nmda-fill'), statusEl = $('nmda-status');

  let hostScrollSnapshot=null;
  function setHostScrollLocked(locked){
    const targets=[document.documentElement,document.body].filter(Boolean);
    if(locked&&!hostScrollSnapshot){
      hostScrollSnapshot=targets.map(el=>({el,value:el.style.getPropertyValue('overflow'),priority:el.style.getPropertyPriority('overflow')}));
      for(const el of targets)el.style.setProperty('overflow','hidden','important');
    }else if(!locked&&hostScrollSnapshot){
      for(const item of hostScrollSnapshot){if(item.value)item.el.style.setProperty('overflow',item.value,item.priority);else item.el.style.removeProperty('overflow');}
      hostScrollSnapshot=null;
    }
  }
  function syncModalState(){
    const modalOpen=[$('nmda-supplement-preflight'),$('nmda-attachment-manager-overlay'),$('nmda-schedule-modal'),$('nmda-contact-modal'),$('nmda-import-editor-overlay')].some(el=>el&&!el.hidden);
    panel.classList.toggle('has-modal',modalOpen);
  }
  function setPanelOpen(open){panel.hidden=!open;setHostScrollLocked(open);if(open)syncModalState();}

  const connectionEl=$('nmda-mail-connection'), connectionTitleEl=$('nmda-mail-connection-title'), connectionDetailEl=$('nmda-mail-connection-detail'), openMailEl=$('nmda-open-mail');
  async function refreshMailboxConnection(){
    if(!connectionEl)return null;
    try{
      const state=await sendRuntimeMessage({type:'NMDA_CONNECTION_STATUS'});
      const connected=!!state?.connected, authenticated=!!state?.authenticated;
      connectionEl.dataset.state=authenticated?'connected':connected?'login':'offline';
      connectionTitleEl.textContent=authenticated?(state.account?`网易邮箱 · ${state.account}`:'网易邮箱已连接'):connected?'网易邮箱已打开 · 待登录':'网易邮箱未连接';
      connectionDetailEl.textContent=authenticated?'已连接':connected?'请先登录':'未连接';
      openMailEl.textContent=connected?'切换邮箱':'连接邮箱';
      if(authenticated && state.account && typeof Contacts!=='undefined') {
        const normalized=Contacts?.normalizeEmail?.(state.account)||String(state.account).toLowerCase();
        if(contactBook?.loaded && contactBook.account!==normalized){await ensureContactBook(true);scheduleContactsRender({force:currentWorkbenchTab()==='contacts'});invalidateBatchView(true);}
      }
      return state;
    }catch(error){
      connectionEl.dataset.state='offline'; connectionTitleEl.textContent='连接状态不可用'; connectionDetailEl.textContent=error?.message||String(error); return null;
    }
  }
  openMailEl?.addEventListener('click',async()=>{openMailEl.disabled=true;try{await sendRuntimeMessage({type:'NMDA_OPEN_MAIL',focus:true});}finally{openMailEl.disabled=false;setTimeout(refreshMailboxConnection,500);}});
  if (extensionRuntime?.onMessage?.addListener) {
    extensionRuntime.onMessage.addListener(message=>{
    if(message?.type==='NMDA_CONNECTION_CHANGED') refreshMailboxConnection();
    if(message?.type==='NMDA_EXECUTION_PROGRESS_BROADCAST'){
      const handler=executionProgressHandlers.get(String(message.executionId||'')); if(handler) handler(message);
    }
    if(message?.type==='NMDA_BATCH_STOP_BROADCAST' && batch?.running){
      batch.stopRequested=true;
      if(batchStopEl)batchStopEl.disabled=true;
      setBatchStatus('网易邮箱已请求停止：当前这一封完成后不会继续下一封。','warn');
    }
    });
  }
  window.addEventListener('focus',refreshMailboxConnection);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshMailboxConnection();});
  refreshMailboxConnection();

  const contactBook = { account: '', contacts: {}, loaded: false };

  // UI performance state: navigation must stay a cheap visibility change.
  // Expensive lists are rendered only after their underlying data becomes dirty,
  // and input-driven refreshes are coalesced into a single animation frame.
  const viewPerf = {
    batchDirty: true,
    batchAuxDirty: true,
    contactsDirty: true,
    batchFrame: 0,
    contactsFrame: 0,
    contactVersion: 0,
    contactCacheVersion: -1,
    contactCache: null,
    contactRenderLimit: 250,
    reviewRenderLimit: 250,
    formSaveTimer: 0,
    contactPersistTimer: 0,
    contactPersistPromise: null
  };

  function debounce(fn, delay = 120) {
    let timer = 0;
    return (...args) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = 0; fn(...args); }, delay);
    };
  }

  function markContactsChanged() {
    viewPerf.contactVersion++;
    viewPerf.contactsDirty = true;
    viewPerf.contactCache = null;
  }

  function invalidateBatchView(aux = true) {
    viewPerf.batchDirty = true;
    if (aux) viewPerf.batchAuxDirty = true;
  }

  function batchPaneVisible() {
    return !panel.hidden && currentWorkbenchTab() === 'batch';
  }

  function contactsPaneVisible() {
    return !panel.hidden && currentWorkbenchTab() === 'contacts';
  }

  function followUpPaneVisible() {
    return !panel.hidden && currentWorkbenchTab() === 'followup';
  }

  function scheduleBatchRender({ aux = false, force = false } = {}) {
    invalidateBatchView(aux);
    if (!force && !batchPaneVisible()) return;
    if (viewPerf.batchFrame) cancelAnimationFrame(viewPerf.batchFrame);
    viewPerf.batchFrame = requestAnimationFrame(() => {
      viewPerf.batchFrame = 0;
      if (!force && !batchPaneVisible()) return;
      renderPreview({ aux: viewPerf.batchAuxDirty });
    });
  }

  function scheduleContactsRender({ force = false } = {}) {
    viewPerf.contactsDirty = true;
    if (!force && !contactsPaneVisible()) return;
    if (viewPerf.contactsFrame) cancelAnimationFrame(viewPerf.contactsFrame);
    viewPerf.contactsFrame = requestAnimationFrame(() => {
      viewPerf.contactsFrame = 0;
      if (!force && !contactsPaneVisible()) return;
      renderContacts();
    });
  }

  async function detectAccount() {
    try {
      const result = await sendRuntimeMessage({ type: 'NMDA_ACCOUNT_INFO' });
      if (result?.ok && result.uid) return Contacts?.normalizeEmail?.(result.uid) || String(result.uid).toLowerCase();
    } catch (_) {}
    const text = document.querySelector('#spnUid')?.textContent || '';
    return text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}(?![A-Z0-9.-])/i)?.[0]?.toLowerCase() || 'default';
  }

  async function ensureContactBook(force = false) {
    if (!Contacts) return contactBook;
    const account = await detectAccount();
    if (force || !contactBook.loaded || contactBook.account !== account) {
      contactBook.account = account;
      contactBook.contacts = await Contacts.load(account);
      contactBook.loaded = true;
      markContactsChanged();
    }
    return contactBook;
  }

  async function persistContacts() {
    if (!Contacts || !contactBook.loaded) return;
    if (viewPerf.contactPersistTimer) { clearTimeout(viewPerf.contactPersistTimer); viewPerf.contactPersistTimer = 0; }
    const pending = Contacts.save(contactBook.account, contactBook.contacts);
    viewPerf.contactPersistPromise = pending;
    try { await pending; } finally { if (viewPerf.contactPersistPromise === pending) viewPerf.contactPersistPromise = null; }
  }

  function queueContactsPersist(delay = 350) {
    if (!Contacts || !contactBook.loaded) return;
    if (viewPerf.contactPersistTimer) clearTimeout(viewPerf.contactPersistTimer);
    viewPerf.contactPersistTimer = setTimeout(() => {
      viewPerf.contactPersistTimer = 0;
      persistContacts().catch(error => console.warn(`[${APP}] contact persistence failed`, error));
    }, delay);
  }

  function contactClassificationsForRecipients(raw) {
    if (!Contacts || !contactBook.loaded) return [];
    const values = [];
    for (const item of Contacts.parseRecipients(raw)) {
      const contact = contactBook.contacts[item.email] || Contacts.ensureContact({}, item.email);
      values.push(...Contacts.classificationLabels(contact));
    }
    return Contacts.mergeTags(values);
  }

  function contactStateForRecipients(raw) {
    if (!Contacts || !contactBook.loaded) return { stage:'未联系', stages:['未联系'], followUp:false, policies:[], blocked:false };
    const stages=[], policies=[]; let followUp=false;
    for (const item of Contacts.parseRecipients(raw)) {
      const contact = Contacts.normalizeContactShape(contactBook.contacts[item.email] || Contacts.ensureContact({}, item.email));
      stages.push(contact.stage || '未联系');
      if (contact.followUp) followUp=true;
      if (contact.policy && contact.policy !== '正常') policies.push(contact.policy);
    }
    const uniqueStages=[...new Set(stages.length?stages:['未联系'])];
    return {
      stage: uniqueStages.length===1 ? uniqueStages[0] : '多状态',
      stages: uniqueStages,
      followUp,
      policies:[...new Set(policies)],
      blocked:policies.length>0
    };
  }

  function taskBusinessTags(task) {
    const contactTags=task ? taskContactSnapshot(task).tags : [];
    const taskTags=parseTaskClassifications(task?.tags || []);
    return Contacts ? Contacts.mergeTags(contactTags, taskTags) : [...new Set([...contactTags,...taskTags])];
  }

  function contactTagsForRecipients(raw) {
    if (!Contacts || !contactBook.loaded) return [];
    const tags = [];
    for (const item of Contacts.parseRecipients(raw)) tags.push(...(contactBook.contacts[item.email]?.tags || []));
    return Contacts.mergeTags(tags);
  }

  function contactPolicyGateForRecipients(raw) {
    if (!Contacts || !contactBook.loaded) return { blocked: false, policies: [], reasons: [] };
    const policies = [];
    const reasons = [];
    for (const item of Contacts.parseRecipients(raw)) {
      const contact = contactBook.contacts[item.email];
      const policy = contact?.policy || '正常';
      if (policy !== '正常') {
        policies.push(policy);
        reasons.push(`${item.email}：${policy}`);
      }
    }
    return { blocked: policies.length > 0, policies: [...new Set(policies)], reasons };
  }

  function tagsText(tags) {
    return (Contacts?.parseTags?.(tags) || []).join('；');
  }

  function classificationChipHtml(item) {
    const kind = item?.kind || 'tag';
    const value = item?.value || item || '';
    return `<span class="nmda-class-chip" data-class-kind="${escapeHtml(kind)}">${escapeHtml(value)}</span>`;
  }

  function contactOperationalItems(contact) {
    if(!Contacts) return [];
    const c=Contacts.normalizeContactShape(contact||{});
    const items=[{kind:'stage',value:c.stage||'未联系'}];
    if(c.followUp)items.push({kind:'followup',value:'待跟进'});
    if(c.policy&&c.policy!=='正常')items.push({kind:'policy',value:c.policy});
    for(const tag of (Contacts.parseContactTags?.(c.tags||[])||[]))items.push({kind:'tag',value:tag});
    return items;
  }

  function contactOperationalLabels(contact) { return contactOperationalItems(contact).map(item=>item.value); }

  function contactClassificationChips(contact) {
    return contactOperationalItems(contact).map(classificationChipHtml).join('');
  }

  function setContactStatusMessage(message, kind = '') {
    const el = $('nmda-contact-status');
    if (!el) return;
    el.textContent = message;
    if (kind) el.dataset.kind = kind; else delete el.dataset.kind;
  }

  function mailboxCoverageText(meta = {}) {
    if (!meta || (!meta.lastQuickAt && !meta.lastFullAt)) return '尚未读取邮箱状态。';
    const parts = [];
    if (meta.lastFullAt) parts.push(`最近修复：${Contacts.formatDisplayTime(meta.lastFullAt)}`);
    else if (meta.lastQuickAt) parts.push(`最近同步：${Contacts.formatDisplayTime(meta.lastQuickAt)}`);
    if (meta.sent) parts.push(`已发送 ${meta.sent.read ?? 0}${meta.sent.complete ? '（完整）' : meta.sent.total ? ` / ${meta.sent.total}` : ''}`);
    if (meta.drafts) parts.push(`草稿 ${meta.drafts.read ?? 0}${meta.drafts.complete ? '（完整）' : meta.drafts.total ? ` / ${meta.drafts.total}` : ''}`);
    if (meta.inbox) parts.push(`收件箱 ${meta.inbox.read ?? 0}${meta.inbox.complete ? '（完整）' : meta.inbox.total ? ` / ${meta.inbox.total}` : ''}`);
    if (meta.lastMode === 'full' && meta.complete) parts.push('邮箱记录已完整更新');
    return parts.join(' · ');
  }

  async function renderMailboxReadMeta(meta = null) {
    const el = $('nmda-mailbox-read-meta');
    if (!el || !Contacts) return;
    try {
      if (!meta) {
        await ensureContactBook();
        meta = await Contacts.loadSyncMeta(contactBook.account);
      }
      el.textContent = mailboxCoverageText(meta || {});
      el.dataset.complete = meta?.lastMode === 'full' && meta?.complete ? 'true' : 'false';
    } catch (_) { el.textContent = '暂时无法读取邮箱记录状态。'; }
  }

  function contactViewCache() {
    if(viewPerf.contactCache && viewPerf.contactCacheVersion===viewPerf.contactVersion)return viewPerf.contactCache;
    const rows=[];
    const stageCounts=Object.fromEntries(Contacts.STAGE_OPTIONS.map(stage=>[stage,0]));
    let followCount=0,pausedCount=0,noContactCount=0,withDraftCount=0;
    const classCounts=new Map();
    for(const raw of Object.values(contactBook.contacts||{})){
      const contact=Contacts.normalizeContactShape(raw);
      const labels=contactOperationalLabels(contact);
      stageCounts[contact.stage]=(stageCounts[contact.stage]||0)+1;
      if(contact.followUp)followCount++;
      if(contact.policy==='暂停')pausedCount++;
      if(contact.policy==='不再联系')noContactCount++;
      if(Number(contact.draftCount||0)>0)withDraftCount++;
      for(const value of (Contacts.parseContactTags?.(contact.tags||[])||[]))classCounts.set(value,(classCounts.get(value)||0)+1);
      const search=(`${contact.email} ${contact.name||''} ${contact.lastSubject||''} ${contact.lastDraftSubject||''} ${labels.join(' ')}`).toLowerCase();
      rows.push({contact,labelsLower:new Set(labels.map(value=>value.toLocaleLowerCase('zh-CN'))),search});
    }
    rows.sort((a,b)=>{
      const ta=Math.max(Date.parse(a.contact.lastSentAt||'')||0,Date.parse(a.contact.lastDraftAt||'')||0);
      const tb=Math.max(Date.parse(b.contact.lastSentAt||'')||0,Date.parse(b.contact.lastDraftAt||'')||0);
      return tb-ta||String(a.contact.email).localeCompare(String(b.contact.email));
    });
    const topClasses=[...classCounts.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],'zh-CN')).slice(0,40);
    viewPerf.contactCache={rows,stageCounts,followCount,pausedCount,noContactCount,withDraftCount,topClasses};
    viewPerf.contactCacheVersion=viewPerf.contactVersion;
    return viewPerf.contactCache;
  }

  function latestContactActivity(contact){
    const sent=Date.parse(contact.lastSentAt||'')||0,draft=Date.parse(contact.lastDraftAt||'')||0;
    if(!sent&&!draft)return {label:'暂无记录',time:'—',subject:''};
    if(sent>=draft)return {label:'已发送',time:Contacts.formatDisplayTime(contact.lastSentAt),subject:contact.lastSubject||''};
    return {label:'草稿',time:Contacts.formatDisplayTime(contact.lastDraftAt),subject:contact.lastDraftSubject||''};
  }

  function renderContacts() {
    if(!Contacts)return;
    const body=$('nmda-contact-body'),summary=$('nmda-contact-summary'),chipBar=$('nmda-contact-class-chips');
    if(!body||!summary)return;
    const query=String($('nmda-contact-search')?.value||'').trim().toLowerCase();
    const classFilter=Contacts.parseTags($('nmda-contact-class-filter')?.value||'').map(value=>value.toLocaleLowerCase('zh-CN'));
    const cache=contactViewCache();
    let rows=cache.rows;
    if(classFilter.length)rows=rows.filter(item=>classFilter.every(value=>item.labelsLower.has(value)));
    if(query)rows=rows.filter(item=>item.search.includes(query));
    const allCount=cache.rows.length;
    summary.textContent=`${allCount} 人 · 待跟进 ${cache.followCount} · 有草稿 ${cache.withDraftCount} · 已发送 ${cache.stageCounts['已发送']||0}`;

    if(chipBar){
      chipBar.innerHTML=cache.topClasses.length?cache.topClasses.slice(0,12).map(([value,count])=>`<button type="button" class="nmda-tag-chip" data-contact-class-chip="${escapeHtml(value)}">${escapeHtml(value)} <small>${count}</small></button>`).join(''):'';
    }

    const limit=Math.max(80,viewPerf.contactRenderLimit||250),visibleRows=rows.slice(0,limit);
    body.innerHTML=visibleRows.map(({contact})=>{
      const activity=latestContactActivity(contact);
      return `<tr data-contact-row="${escapeHtml(contact.email)}">
        <td class="nmda-contact-identity-cell"><strong>${escapeHtml(contact.name||contact.email)}</strong><small>${escapeHtml(contact.name?contact.email:'')}</small></td>
        <td><div class="nmda-class-preview nmda-contact-status-chips">${contactClassificationChips(contact)}</div></td>
        <td class="nmda-contact-activity-cell"><strong>${escapeHtml(activity.label)} · ${escapeHtml(activity.time)}</strong><small title="${escapeHtml(activity.subject)}">${escapeHtml(activity.subject||'—')}</small></td>
        <td class="nmda-contact-count-cell">${Number(contact.sentCount||0)}</td>
        <td class="nmda-contact-count-cell">${Number(contact.draftCount||0)}</td>
        <td class="nmda-contact-open-cell"><button class="nmda-contact-open" type="button" data-contact-open="${escapeHtml(contact.email)}">查看</button></td>
      </tr>`;
    }).join('');
    if(!rows.length)body.innerHTML='<tr><td colspan="6" class="nmda-empty-table-cell">暂无匹配联系人。</td></tr>';
    else if(rows.length>visibleRows.length)body.insertAdjacentHTML('beforeend',`<tr class="nmda-load-more-row"><td colspan="6"><button type="button" class="nmda-btn nmda-btn-small nmda-btn-quiet" data-contact-load-more>继续显示（${visibleRows.length}/${rows.length}）</button></td></tr>`);
    viewPerf.contactsDirty=false;
  }

  function contactHistoryHtml(items=[], kind='sent'){
    if(!items.length)return '<div class="nmda-contact-history-empty">暂无记录</div>';
    return items.slice(0,20).map(item=>{
      const time=kind==='sent'?(item.sentAt||''):(item.savedAt||'');
      return `<article class="nmda-contact-history-item"><div><strong>${escapeHtml(item.subject||'(无主题)')}</strong><small>${escapeHtml(Contacts.formatDisplayTime(time))}</small></div></article>`;
    }).join('');
  }

  function openContactModal(email){
    if(!Contacts||!email)return;
    const contact=Contacts.normalizeContactShape(contactBook.contacts[email]||Contacts.ensureContact(contactBook.contacts,email),email);
    batch.contactModalEmail=contact.email;
    $('nmda-contact-dialog-title').textContent=contact.name||contact.email;
    $('nmda-contact-dialog-email').textContent=contact.name?contact.email:'';
    const stage=$('nmda-contact-modal-stage'),policy=$('nmda-contact-modal-policy');
    stage.innerHTML=Contacts.STAGE_OPTIONS.map(value=>`<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('');
    policy.innerHTML=Contacts.POLICY_OPTIONS.map(value=>`<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('');
    stage.value=contact.stage||'未联系'; policy.value=contact.policy||'正常';
    $('nmda-contact-modal-followup').checked=!!contact.followUp;
    $('nmda-contact-modal-tags').value=tagsText(contact.tags);
    $('nmda-contact-profile-summary').innerHTML=`<div><strong>${Number(contact.sentCount||0)}</strong><span>已发送</span></div><div><strong>${Number(contact.draftCount||0)}</strong><span>草稿</span></div><div><strong>${escapeHtml(Contacts.formatDisplayTime(contact.lastSentAt))}</strong><span>最后发送</span></div><div><strong>${escapeHtml(Contacts.formatDisplayTime(contact.lastDraftAt))}</strong><span>最后草稿</span></div>`;
    $('nmda-contact-history-summary').textContent=`发送 ${Number(contact.sentCount||0)} · 草稿 ${Number(contact.draftCount||0)}`;
    $('nmda-contact-sent-history').innerHTML=contactHistoryHtml(contact.history||[],'sent');
    $('nmda-contact-draft-history').innerHTML=contactHistoryHtml(contact.draftHistory||[],'draft');
    const overlay=$('nmda-contact-modal'); overlay.hidden=false; syncModalState();
    requestAnimationFrame(()=>stage.focus({preventScroll:true}));
  }

  function closeContactModal(){
    const overlay=$('nmda-contact-modal'); if(overlay)overlay.hidden=true;
    batch.contactModalEmail=''; syncModalState();
  }

  async function saveContactModal(){
    const email=batch.contactModalEmail; if(!email||!Contacts)return;
    Contacts.setStage(contactBook.contacts,email,$('nmda-contact-modal-stage').value);
    Contacts.setPolicy(contactBook.contacts,email,$('nmda-contact-modal-policy').value);
    Contacts.setFollowUp(contactBook.contacts,email,$('nmda-contact-modal-followup').checked);
    Contacts.setTags(contactBook.contacts,email,$('nmda-contact-modal-tags').value);
    markContactsChanged(); await persistContacts(); scheduleContactsRender({force:true}); invalidateBatchView(true);
    setContactStatusMessage(`已保存 ${email}。`,'ok'); closeContactModal();
  }

  async function initContacts() {
    if(!Contacts){setContactStatusMessage('联系人模块未加载。','error');return;}
    try{
      await ensureContactBook(true);
      // Keep startup cheap: contacts stay data-only until the user opens that tab.
      scheduleContactsRender();
      await renderMailboxReadMeta();
      setContactStatusMessage(`当前邮箱：${contactBook.account}。联系人记录已就绪。`,'ok');
      if(typeof renderPreview==='function')scheduleBatchRender({aux:true});
    }catch(error){setContactStatusMessage(`联系人初始化失败：${error.message}`,'error');}
  }


  const followUpState = {
    settings: null,
    loading: false,
    busyEmails: new Set(),
    search: '',
    filter: 'eligible',
    formHydrated: false
  };

  function defaultFollowUpSettings() {
    return {
      mode: 'forward', minDays: 7, maxCount: 1,
      blockHumanReply: true, blockAutoReply: false,
      fwPrefix: 'Fw:', rePrefix: 'Re:',
      template: 'Dear {{name}},\n\nI am writing to follow up on my previous email regarding {{subject}}. I would be grateful if you had a chance to review it.\n\nBest regards,'
    };
  }

  function normalizeFollowUpSettings(value = {}) {
    const base = defaultFollowUpSettings();
    const mode = ['forward','reply','new'].includes(value.mode) ? value.mode : base.mode;
    return {
      ...base, ...value, mode,
      minDays: Math.max(0, Math.min(365, Number(value.minDays ?? base.minDays) || 0)),
      maxCount: Math.max(0, Math.min(20, Number(value.maxCount ?? base.maxCount) || 0)),
      blockHumanReply: value.blockHumanReply !== false,
      blockAutoReply: value.blockAutoReply === true,
      fwPrefix: String(value.fwPrefix ?? base.fwPrefix).trim() || 'Fw:',
      rePrefix: String(value.rePrefix ?? base.rePrefix).trim() || 'Re:',
      template: String(value.template ?? base.template)
    };
  }

  async function loadFollowUpSettings(force = false) {
    if (followUpState.settings && !force) return followUpState.settings;
    const stored = (await storageGet(FOLLOWUP_SETTINGS_KEY))[FOLLOWUP_SETTINGS_KEY];
    followUpState.settings = normalizeFollowUpSettings(stored || {});
    return followUpState.settings;
  }

  async function saveFollowUpSettings(settings) {
    followUpState.settings = normalizeFollowUpSettings(settings);
    await storageSet({ [FOLLOWUP_SETTINGS_KEY]: followUpState.settings });
    return followUpState.settings;
  }

  function followUpSettingsFromForm() {
    return normalizeFollowUpSettings({
      mode: $('nmda-followup-mode')?.value || 'forward',
      minDays: $('nmda-followup-min-days')?.value,
      maxCount: $('nmda-followup-max-count')?.value,
      blockHumanReply: !!$('nmda-followup-block-human')?.checked,
      blockAutoReply: !!$('nmda-followup-block-auto')?.checked,
      fwPrefix: $('nmda-followup-fw-prefix')?.value || 'Fw:',
      rePrefix: $('nmda-followup-re-prefix')?.value || 'Re:',
      template: $('nmda-followup-template')?.value || ''
    });
  }

  function fillFollowUpSettingsForm(settings) {
    settings = normalizeFollowUpSettings(settings || {});
    if ($('nmda-followup-mode')) $('nmda-followup-mode').value = settings.mode;
    if ($('nmda-followup-min-days')) $('nmda-followup-min-days').value = String(settings.minDays);
    if ($('nmda-followup-max-count')) $('nmda-followup-max-count').value = String(settings.maxCount);
    if ($('nmda-followup-block-human')) $('nmda-followup-block-human').checked = !!settings.blockHumanReply;
    if ($('nmda-followup-block-auto')) $('nmda-followup-block-auto').checked = !!settings.blockAutoReply;
    if ($('nmda-followup-fw-prefix')) $('nmda-followup-fw-prefix').value = settings.fwPrefix;
    if ($('nmda-followup-re-prefix')) $('nmda-followup-re-prefix').value = settings.rePrefix;
    if ($('nmda-followup-template')) $('nmda-followup-template').value = settings.template;
  }

  function setFollowUpStatus(message, kind = '') {
    const el = $('nmda-followup-status');
    if (!el) return;
    el.textContent = String(message || '');
    if (kind) el.dataset.kind = kind; else delete el.dataset.kind;
  }

  function stripMailPrefix(subject) {
    return String(subject || '').replace(/^\s*(?:(?:re|fw|fwd)\s*:\s*)+/i, '').trim();
  }

  function sortedSentHistory(contact) {
    return [...(contact?.history || [])].filter(item => item?.id).sort((a,b)=>(Date.parse(b.sentAt||'')||0)-(Date.parse(a.sentAt||'')||0));
  }

  function sourceSentForContact(contact) {
    const history = sortedSentHistory(contact);
    return history.find(item => !/^\s*(?:fw|fwd|re)\s*:/i.test(String(item.subject || ''))) || history[0] || null;
  }

  function repliesAfter(contact, sentAt) {
    const floor = Date.parse(sentAt || '') || 0;
    return [...(contact?.replyHistory || [])].filter(item => (Date.parse(item.receivedAt || '') || 0) > floor);
  }

  function followUpEligibility(contact, settings) {
    contact = Contacts.normalizeContactShape(contact || {});
    settings = normalizeFollowUpSettings(settings || {});
    const source = sourceSentForContact(contact);
    if (!source) return { eligible:false, source:null, reasons:['没有可跟进的已发送邮件'], humanReplies:[], autoReplies:[], days:0 };
    const sourceMs = Date.parse(source.sentAt || '') || 0;
    const days = sourceMs ? Math.max(0, Math.floor((Date.now() - sourceMs) / 86400000)) : 0;
    const replies = repliesAfter(contact, source.sentAt);
    const humanReplies = replies.filter(item => !item.autoReply);
    const autoReplies = replies.filter(item => item.autoReply);
    const reasons = [];
    if (contact.policy === '暂停') reasons.push('发送策略为“暂停”');
    if (contact.policy === '不再联系') reasons.push('发送策略为“不再联系”');
    if (days < settings.minDays) reasons.push(`仅等待 ${days} 天，规则要求 ${settings.minDays} 天`);
    if (settings.blockHumanReply && humanReplies.length) reasons.push('已有真人回复');
    if (settings.blockAutoReply && autoReplies.length) reasons.push('已有 Auto Reply');
    if (settings.maxCount > 0 && Number(contact.followUpCount || 0) >= settings.maxCount) reasons.push(`已达到 ${settings.maxCount} 次上限`);
    return { eligible: !reasons.length, source, reasons, humanReplies, autoReplies, days };
  }

  function followUpBadge(label, tone = '') {
    return `<span class="nmda-followup-badge"${tone ? ` data-tone="${escapeHtml(tone)}"` : ''}>${escapeHtml(label)}</span>`;
  }

  function autoReplyReasonLabel(reason) {
    return ({
      'auto-header':'邮件头明确标记自动回复',
      'auto-subject':'主题符合自动回复特征',
      'auto-body':'正文开头符合自动回复 / Out of Office 特征',
      'subject-pattern':'主题符合自动回复特征',
      'sender-pattern':'发件地址属于自动回复 / 系统地址',
      'mailbox-flag':'邮箱列表标记为自动回复',
      'detail-inspection':'读取邮件详情后识别为自动回复'
    })[String(reason || '')] || String(reason || 'Auto Reply 特征');
  }

  function followUpReplyHtml(contact, eligibility) {
    const latestHuman = eligibility.humanReplies[0];
    const latestAuto = eligibility.autoReplies[0];
    if (latestHuman) return `${followUpBadge('真人回复','human')}<button type="button" class="nmda-followup-link" data-followup-reply="${escapeHtml(contact.email)}" data-reply-id="${escapeHtml(latestHuman.id)}">查看</button>`;
    if (latestAuto) return `${followUpBadge('Auto Reply','auto')}<button type="button" class="nmda-followup-link" data-followup-reply="${escapeHtml(contact.email)}" data-reply-id="${escapeHtml(latestAuto.id)}">查看</button>`;
    return followUpBadge('未发现回复','quiet');
  }

  async function renderFollowUp() {
    if (!Contacts || !followUpPaneVisible()) return;
    await ensureContactBook();
    const settings = await loadFollowUpSettings();
    if (!followUpState.formHydrated) { fillFollowUpSettingsForm(settings); followUpState.formHydrated = true; }
    const body = $('nmda-followup-body'), summary = $('nmda-followup-summary');
    if (!body || !summary) return;
    const query = String($('nmda-followup-search')?.value || followUpState.search || '').trim().toLowerCase();
    const filter = $('nmda-followup-filter')?.value || followUpState.filter || 'eligible';
    followUpState.search = query; followUpState.filter = filter;
    const rows = [];
    for (const raw of Object.values(contactBook.contacts || {})) {
      const contact = Contacts.normalizeContactShape(raw);
      if (!Number(contact.sentCount || 0)) continue;
      const eligibility = followUpEligibility(contact, settings);
      const haystack = `${contact.email} ${contact.name||''} ${eligibility.source?.subject||''}`.toLowerCase();
      if (query && !haystack.includes(query)) continue;
      if (filter === 'eligible' && !eligibility.eligible) continue;
      if (filter === 'human' && !eligibility.humanReplies.length) continue;
      if (filter === 'auto' && !eligibility.autoReplies.length) continue;
      if (filter === 'created' && !Number(contact.followUpCount || 0)) continue;
      rows.push({contact,eligibility});
    }
    rows.sort((a,b)=>{
      if (a.eligibility.eligible !== b.eligibility.eligible) return a.eligibility.eligible ? -1 : 1;
      return (Date.parse(a.eligibility.source?.sentAt||'')||0) - (Date.parse(b.eligibility.source?.sentAt||'')||0);
    });
    const eligibleAll = Object.values(contactBook.contacts || {}).filter(raw => Number(raw?.sentCount||0) && followUpEligibility(raw, settings).eligible).length;
    summary.textContent = `${eligibleAll} 个符合条件 · 当前显示 ${rows.length}`;
    body.innerHTML = rows.length ? rows.map(({contact,eligibility}) => {
      const source = eligibility.source || {};
      const busy = followUpState.busyEmails.has(contact.email);
      const reason = eligibility.eligible ? `已等待 ${eligibility.days} 天` : eligibility.reasons.join('；');
      return `<tr>
        <td class="nmda-contact-identity-cell"><strong>${escapeHtml(contact.name||contact.email)}</strong><small>${escapeHtml(contact.name?contact.email:'')}</small></td>
        <td class="nmda-followup-source-cell"><strong title="${escapeHtml(source.subject||'')}">${escapeHtml(source.subject||'(无主题)')}</strong><small>${escapeHtml(Contacts.formatDisplayTime(source.sentAt))} · ${eligibility.days} 天</small></td>
        <td><div class="nmda-followup-reply-cell">${followUpReplyHtml(contact, eligibility)}</div></td>
        <td class="nmda-followup-state-cell"><strong>${escapeHtml(reason)}</strong><small>已创建 ${Number(contact.followUpCount||0)} 次</small></td>
        <td class="nmda-contact-open-cell"><button class="nmda-btn nmda-btn-small ${eligibility.eligible?'nmda-btn-primary':''}" type="button" data-followup-create="${escapeHtml(contact.email)}" ${eligibility.eligible && !busy ? '' : 'disabled'}>${busy?'正在创建…':'生成跟进草稿'}</button></td>
      </tr>`;
    }).join('') : '<tr><td colspan="5" class="nmda-empty-table-cell">当前没有匹配的 Follow-up 对象。</td></tr>';
    const meta = await Contacts.loadSyncMeta(contactBook.account).catch(()=>({}));
    const metaEl = $('nmda-followup-sync-meta');
    if (metaEl) metaEl.textContent = meta?.inbox ? `收件箱 ${meta.inbox.read ?? 0}${meta.inbox.complete ? '（完整）' : meta.inbox.total ? ` / ${meta.inbox.total}` : ''} · ${meta.lastQuickAt || meta.lastFullAt ? `最近同步 ${Contacts.formatDisplayTime(meta.lastQuickAt || meta.lastFullAt)}` : '尚未同步'}` : '尚未同步收件箱。';
  }

  function renderFollowUpTemplate(template, contact, source, days) {
    const vars = { name: contact.name || '', email: contact.email || '', subject: stripMailPrefix(source.subject || ''), days: String(days || 0) };
    return String(template || '').replace(/{{\s*(name|email|subject|days)\s*}}/gi, (_, key) => vars[String(key).toLowerCase()] ?? '');
  }

  function plainFollowUpHtml(text) {
    return `<div class="nmda-followup-note">${escapeHtml(String(text || '')).replace(/\n/g,'<br>')}</div>`;
  }

  function buildFollowUpDraft(contact, eligibility, detail, settings) {
    const source = eligibility.source;
    const baseSubject = stripMailPrefix(source.subject || detail.subject || '');
    let subject = baseSubject;
    if (settings.mode === 'forward') subject = `${settings.fwPrefix} ${baseSubject}`.trim();
    else if (settings.mode === 'reply') subject = `${settings.rePrefix} ${baseSubject}`.trim();
    const introText = renderFollowUpTemplate(settings.template, contact, source, eligibility.days);
    const introHtml = plainFollowUpHtml(introText);
    const originalHtml = detail.bodyHtml && detail.isHtml !== false ? String(detail.bodyHtml) : plainFollowUpHtml(detail.body || '');
    const header = `<div class="nmda-forward-header"><br><br>---------- ${settings.mode==='forward'?'Forwarded message':'Original message'} ----------<br>From: ${escapeHtml(detail.from || '')}<br>Date: ${escapeHtml(detail.date || source.sentAt || '')}<br>Subject: ${escapeHtml(detail.subject || source.subject || '')}<br>To: ${escapeHtml(detail.to || contact.email || '')}</div>`;
    const quoted = settings.mode === 'reply' ? `<blockquote style="margin:14px 0 0 0;padding-left:12px;border-left:2px solid #d0d7de">${header}${originalHtml}</blockquote>` : `${header}${originalHtml}`;
    return { recipients:contact.email, subject, body:introText, bodyHtml:`${introHtml}${quoted}`, bodyIsHtml:true, files:[], scheduleAt:'' };
  }

  async function createFollowUpDraft(email) {
    if (!email || followUpState.busyEmails.has(email)) return;
    await ensureContactBook();
    const contact = Contacts.normalizeContactShape(contactBook.contacts[email] || {});
    const settings = await loadFollowUpSettings();
    const eligibility = followUpEligibility(contact, settings);
    if (!eligibility.eligible) { setFollowUpStatus(`不能生成 ${email}：${eligibility.reasons.join('；')}`, 'warn'); return; }
    followUpState.busyEmails.add(email); renderFollowUp().catch(()=>{});
    try {
      setFollowUpStatus(`正在读取 ${email} 的原邮件并创建 ${settings.mode==='forward'?'Fw':settings.mode==='reply'?'Re':'新邮件'} 草稿…`);
      const detail = await sendRuntimeMessage({ type:'NMDA_READ_MESSAGE_DETAIL', summary:eligibility.source });
      if (!detail?.ok) throw new Error(detail?.reason || '无法读取原邮件正文');
      const task = buildFollowUpDraft(contact, eligibility, detail, settings);
      let outcome;
      if (settings.mode === 'forward' || settings.mode === 'reply') {
        outcome = await executeNativeFollowUpRemotely({
          mode:settings.mode,
          sourceMessageId:eligibility.source.id,
          recipients:contact.email,
          subject:task.subject,
          introText:renderFollowUpTemplate(settings.template, contact, eligibility.source, eligibility.days),
          sourceSubject:detail.subject || eligibility.source.subject || '',
          sourceBody:detail.body || '',
          sourceIsHtml:detail.isHtml !== false,
          sourceFrom:detail.from || '',
          sourceTo:detail.to || '',
          sourceCc:detail.cc || '',
          sourceDate:detail.date || eligibility.source.sentAt || '',
          sourceAttachments:detail.attachments || [],
          attachmentInventoryKnown:detail.attachmentInventoryKnown === true,
          hasAttachmentsHint:detail.hasAttachmentsHint === true || eligibility.source.hasAttachmentsHint === true,
          attachmentCountHint:Number(detail.attachmentCountHint || eligibility.source.attachmentCountHint || 0) || 0
        }, { onProgress:info => setFollowUpStatus(info?.message || '正在创建原生 Follow-up 草稿…') });
      } else {
        outcome = await executeDraftRemotely(task, { fresh:true, onProgress:info => setFollowUpStatus(info?.message || '正在创建草稿…') });
      }
      const verification = outcome?.nativeVerification || null;
      const verifiedNote = verification
        ? `原生${verification.mode === 'forward' ? '转发' : '回复'}核验：模式/收件人/主题/原文/原信信息${verification.attachmentsExpected ? `/附件 ${verification.attachmentsMatched}/${verification.attachmentsExpected}` : ''}完整`
        : (outcome?.saveOutcome?.evidence || '');
      Contacts.addFollowUpEvent(contactBook.contacts, email, {
        mode: settings.mode, sourceMessageId: eligibility.source.id, sourceSubject: eligibility.source.subject,
        subject: task.subject, status:'draft', note: verifiedNote, verification
      });
      await persistContacts(); markContactsChanged();
      setFollowUpStatus(`${email} 的 Follow-up 草稿已创建、内容完整性已核验并确认保存。`, 'ok');
    } catch (error) {
      setFollowUpStatus(`Follow-up 创建失败：${error.message}`, 'error');
    } finally {
      followUpState.busyEmails.delete(email);
      renderFollowUp().catch(()=>{});
    }
  }

  function closeFollowUpReplyModal() {
    const modal = $('nmda-followup-reply-modal'); if (modal) modal.hidden = true; syncModalState();
  }

  async function openFollowUpReply(email, replyId) {
    await ensureContactBook();
    const contact = Contacts.normalizeContactShape(contactBook.contacts[email] || {});
    const item = (contact.replyHistory || []).find(entry => String(entry.id) === String(replyId));
    if (!item) { setFollowUpStatus('没有找到这条回复记录，请先同步邮箱。','warn'); return; }
    const modal = $('nmda-followup-reply-modal'); if (!modal) return;
    modal.hidden = false; syncModalState();
    $('nmda-followup-reply-title').textContent = item.subject || '(无主题)';
    $('nmda-followup-reply-meta').textContent = `${item.from || email} · ${Contacts.formatDisplayTime(item.receivedAt)}`;
    $('nmda-followup-reply-badge').innerHTML = followUpBadge(item.autoReply ? 'Auto Reply' : '真人回复', item.autoReply ? 'auto' : 'human');
    $('nmda-followup-reply-fields').innerHTML = `<span><b>From</b>${escapeHtml(item.from || email)}</span><span><b>Date</b>${escapeHtml(Contacts.formatDisplayTime(item.receivedAt))}</span>`;
    const attachmentsBox = $('nmda-followup-reply-attachments'); if (attachmentsBox) { attachmentsBox.hidden = true; attachmentsBox.innerHTML = ''; }
    $('nmda-followup-reply-content').textContent = '正在读取邮件正文…';
    const detail = await sendRuntimeMessage({ type:'NMDA_READ_MESSAGE_DETAIL', summary:{id:item.id, subject:item.subject, receivedAt:item.receivedAt} });
    if (!detail?.ok) { $('nmda-followup-reply-content').textContent = `读取失败：${detail?.reason || '未知错误'}`; return; }
    $('nmda-followup-reply-fields').innerHTML = [
      ['From', detail.from || item.from || email], ['To', detail.to || '—'], ['Cc', detail.cc || '—'],
      ['Date', detail.date ? Contacts.formatDisplayTime(detail.date) : Contacts.formatDisplayTime(item.receivedAt)],
      ['判定依据', detail.autoReply ? autoReplyReasonLabel(detail.autoReplyReason) : '未发现自动回复特征']
    ].map(([key,value]) => `<span><b>${escapeHtml(key)}</b>${escapeHtml(value || '—')}</span>`).join('');
    if (attachmentsBox) {
      const attachments = Array.isArray(detail.attachments) ? detail.attachments : [];
      attachmentsBox.hidden = !attachments.length;
      attachmentsBox.innerHTML = attachments.length ? `<strong>附件 ${attachments.length}</strong><div>${attachments.map(att => `<span>${escapeHtml(att.name || '(未命名附件)')}${att.size ? ` · ${escapeHtml(String(att.size))} B` : ''}</span>`).join('')}</div>` : '';
    }
    const refinedAuto = !!detail.autoReply;
    if (refinedAuto !== !!item.autoReply) {
      item.autoReply = refinedAuto;
      item.autoReplyReason = detail.autoReplyReason || 'detail-inspection';
      contact.replyHistory = [...(contact.replyHistory || [])];
      contact.humanReplyCount = contact.replyHistory.filter(entry=>!entry.autoReply).length;
      contact.autoReplyCount = contact.replyHistory.filter(entry=>entry.autoReply).length;
      if (contact.stageSource !== 'manual') {
        if (contact.humanReplyCount > 0) { contact.stage='已回复'; contact.stageSource='mailbox'; }
        else if (contact.sentCount > 0 || contact.knownSentAt) { contact.stage='已发送'; contact.stageSource='mailbox'; }
        else { contact.stage='未联系'; contact.stageSource='default'; }
        contact.status=contact.stage;
      }
      contactBook.contacts[email]=contact; markContactsChanged(); await persistContacts();
    }
    $('nmda-followup-reply-badge').innerHTML = followUpBadge(refinedAuto ? 'Auto Reply' : '真人回复', refinedAuto ? 'auto' : 'human');
    $('nmda-followup-reply-content').textContent = detail.body || '(邮件正文为空)';
    renderFollowUp().catch(()=>{});
  }

  $('nmda-followup-save-settings')?.addEventListener('click', async () => {
    const settings = await saveFollowUpSettings(followUpSettingsFromForm());
    fillFollowUpSettingsForm(settings); followUpState.formHydrated = true; setFollowUpStatus('Follow-up 规则已保存。','ok'); await renderFollowUp();
  });
  $('nmda-followup-reset-settings')?.addEventListener('click', async () => {
    const settings = await saveFollowUpSettings(defaultFollowUpSettings()); fillFollowUpSettingsForm(settings); followUpState.formHydrated = true; setFollowUpStatus('已恢复默认规则。','ok'); await renderFollowUp();
  });
  $('nmda-followup-search')?.addEventListener('input', debounce(()=>renderFollowUp().catch(()=>{}),120));
  $('nmda-followup-filter')?.addEventListener('change',()=>renderFollowUp().catch(()=>{}));
  $('nmda-followup-mode')?.addEventListener('change',()=>{ followUpState.settings = followUpSettingsFromForm(); renderFollowUp().catch(()=>{}); });
  ['nmda-followup-min-days','nmda-followup-max-count','nmda-followup-block-human','nmda-followup-block-auto','nmda-followup-fw-prefix','nmda-followup-re-prefix'].forEach(id => $(id)?.addEventListener('change',()=>{ followUpState.settings = followUpSettingsFromForm(); renderFollowUp().catch(()=>{}); }));
  $('nmda-followup-template')?.addEventListener('input', debounce(()=>{ followUpState.settings = followUpSettingsFromForm(); },120));
  $('nmda-followup-sync')?.addEventListener('click', async event => {
    event.currentTarget.disabled = true;
    try { const ok = await runMailboxRead('quick'); if (ok) setFollowUpStatus('邮箱与回复记录已同步。','ok'); await renderFollowUp(); }
    finally { event.currentTarget.disabled = false; }
  });
  $('nmda-followup-body')?.addEventListener('click', event => {
    const create = event.target.closest?.('[data-followup-create]'); if (create) { createFollowUpDraft(create.dataset.followupCreate).catch(error=>setFollowUpStatus(error.message,'error')); return; }
    const reply = event.target.closest?.('[data-followup-reply]'); if (reply) openFollowUpReply(reply.dataset.followupReply, reply.dataset.replyId).catch(error=>setFollowUpStatus(`回复读取失败：${error.message}`,'error'));
  });
  $('nmda-followup-reply-close')?.addEventListener('click', closeFollowUpReplyModal);
  $('nmda-followup-reply-close-secondary')?.addEventListener('click', closeFollowUpReplyModal);
  $('nmda-followup-reply-modal')?.addEventListener('click', event => { if (event.target === event.currentTarget) closeFollowUpReplyModal(); });


  $('nmda-contact-class-chips')?.addEventListener('click',event=>{
    const button=event.target.closest?.('[data-contact-class-chip]');if(!button)return;
    const input=$('nmda-contact-class-filter');if(!input)return;
    const now=Contacts.parseTags(input.value),clicked=button.dataset.contactClassChip,key=clicked.toLocaleLowerCase('zh-CN');
    const exists=now.some(value=>value.toLocaleLowerCase('zh-CN')===key);
    input.value=exists?now.filter(value=>value.toLocaleLowerCase('zh-CN')!==key).join(';'):Contacts.mergeTags(now,[clicked]).join(';');
    viewPerf.contactRenderLimit=250;scheduleContactsRender({force:contactsPaneVisible()});
  });

  $('nmda-contact-body')?.addEventListener('click',event=>{
    const open=event.target.closest?.('[data-contact-open]');
    if(open){openContactModal(open.dataset.contactOpen);return;}
    if(!event.target.closest?.('[data-contact-load-more]'))return;
    viewPerf.contactRenderLimit=(viewPerf.contactRenderLimit||250)+250;
    scheduleContactsRender({force:true});
  });
  $('nmda-close-contact-modal')?.addEventListener('click',closeContactModal);
  $('nmda-contact-modal-close-secondary')?.addEventListener('click',closeContactModal);
  $('nmda-save-contact-modal')?.addEventListener('click',()=>saveContactModal().catch(error=>setContactStatusMessage(`保存失败：${error.message}`,'error')));
  $('nmda-contact-modal')?.addEventListener('click',event=>{if(event.target===event.currentTarget)closeContactModal();});

  $('nmda-contact-body')?.addEventListener('change',async event=>{
    const el=event.target;
    if(!(el instanceof HTMLInputElement||el instanceof HTMLSelectElement))return;
    let message='',kind='ok',affectsPolicy=false,affectsBatchView=false;
    if(el.dataset.contactStage){
      Contacts.setStage(contactBook.contacts,el.dataset.contactStage,el.value);
      message=`已更新 ${el.dataset.contactStage} 的互动阶段：${el.value}。`;affectsBatchView=true;
    }else if(el.dataset.contactPolicy){
      Contacts.setPolicy(contactBook.contacts,el.dataset.contactPolicy,el.value);
      message=`已更新 ${el.dataset.contactPolicy} 的联系策略：${el.value}。`;kind=el.value==='正常'?'ok':'warn';affectsPolicy=true;
    }else if(el.dataset.contactFollowup){
      Contacts.setFollowUp(contactBook.contacts,el.dataset.contactFollowup,el.checked);
      message=`${el.dataset.contactFollowup}${el.checked?' 已标记':' 已取消'}待跟进。`;affectsBatchView=true;
    }else if(el.dataset.contactTagsEmail){
      const contact=Contacts.setTags(contactBook.contacts,el.dataset.contactTagsEmail,el.value);
      message=`已更新 ${el.dataset.contactTagsEmail} 的长期标记：${tagsText(contact?.tags)||'无'}。`;affectsBatchView=true;
    }else return;
    markContactsChanged();
    queueContactsPersist();
    scheduleContactsRender();
    if(affectsPolicy&&batch.dataset)rebuildTasks();
    else if(affectsBatchView)scheduleBatchRender({aux:false});
    setContactStatusMessage(message,kind);
  });

  function setStatus(message, kind = '') {
    statusEl.textContent = message;
    if (kind) statusEl.dataset.kind = kind; else delete statusEl.dataset.kind;
  }

  function formState() {
    return { recipients: recipientsEl.value, subject: subjectEl.value, body: bodyEl.value, scheduleAt: scheduleAtEl.value };
  }

  async function saveFormState() {
    if (viewPerf.formSaveTimer) { clearTimeout(viewPerf.formSaveTimer); viewPerf.formSaveTimer = 0; }
    try { await storageSet({ [STORAGE_KEY]: formState() }); } catch (_) {}
  }

  function queueFormStateSave() {
    if (viewPerf.formSaveTimer) clearTimeout(viewPerf.formSaveTimer);
    viewPerf.formSaveTimer = setTimeout(() => {
      viewPerf.formSaveTimer = 0;
      saveFormState();
    }, 500);
  }

  async function restoreFormState() {
    try {
      const stored = (await storageGet(STORAGE_KEY))[STORAGE_KEY];
      if (!stored) return;
      recipientsEl.value = stored.recipients || ''; subjectEl.value = stored.subject || ''; bodyEl.value = stored.body || '';
      scheduleAtEl.value = stored.scheduleEnabled === false ? '' : (stored.scheduleAt || '');
    } catch (_) {}
  }

  function currentWorkbenchTab() {
    return ui.querySelector('.nmda-tab.is-active')?.dataset.tab || 'batch';
  }

  function renderProcessGuide() {
    const guides = ui.querySelectorAll('.nmda-process-guide');
    if (!guides.length || typeof batch === 'undefined') return;
    const hasSource = !!batch.dataset;
    const handed = !!batch.handoffComplete;
    const attachmentIssues=hasSource && typeof importAttachmentStats==='function' ? importAttachmentStats().issues : 0;
    let review = 0, selected = 0, scheduled = 0, other = 0, completed = 0;
    for (const task of (batch.tasks || [])) {
      if (hasSource && typeof taskNeedsImportReview === 'function' && taskNeedsImportReview(task)) review++;
      if (hasSource && typeof taskIssueState === 'function' && taskIssueState(task).other.length) other++;
      if (handed && task.enabled && ['ready','running','done','error'].includes(task.status)) {
        selected++;
        if (task.scheduleAt) scheduled++;
      }
      if (task.status === 'done' || task.status === 'error') completed++;
    }
    const blockers=review+other;
    const finalAttachmentPending=attachmentIssues;
    const contextPending=hasSource && typeof supplementPreflightNeedsDecision==='function' && supplementPreflightNeedsDecision();
    const creating=!!batch.running || completed>0;
    guides.forEach(guide => {
      const currentStep = (!hasSource || contextPending) ? 1 : blockers ? 2 : 3;
      guide.dataset.currentStep = String(currentStep);
      const canView = step => step===1 || (step===2&&hasSource&&!contextPending) || (step===3&&hasSource&&!contextPending&&!blockers);
      if (!canView(Number(batch.uiStep||1))) batch.uiStep=currentStep;
      const title = guide.querySelector('.nmda-process-guide-title strong');
      if (title) title.textContent = `步骤 ${Number(batch.uiStep||currentStep)} / 3`;
      const workbench=guide.closest('.nmda-bulk-workbench');
      if(workbench)workbench.dataset.viewStep=String(batch.uiStep||currentStep);
      guide.querySelectorAll('[data-flow-step]').forEach(button => {
        const step = Number(button.dataset.flowStep || 0);
        let state='locked', unlocked=false;
        if(step===1){unlocked=true; state=(!hasSource||contextPending)?'active':'done';}
        else if(step===2){unlocked=hasSource&&!contextPending; state=!unlocked?'locked':blockers?'active':'done';}
        else if(step===3){unlocked=hasSource&&!contextPending&&!blockers; state=!unlocked?'locked':creating?'active':'ready';}
        button.dataset.state=state; button.classList.toggle('is-viewing',step===Number(batch.uiStep||currentStep)); button.setAttribute('aria-current',step===Number(batch.uiStep||currentStep)?'step':'false'); button.disabled=!unlocked && !(step===2&&hasSource);
        const small=button.querySelector('small');
        if(!small) return;
        if(step===1) small.textContent=!hasSource?'先导入邮件':contextPending?'补总名单 / 附件':'批次资料已准备';
        if(step===2) small.textContent=!hasSource?'添加资料后处理':contextPending?'先完成批次准备':blockers?`${blockers} 项待办`:'待办已完成';
        if(step===3) small.textContent=blockers?'先完成内容待办':creating?`${completed}/${selected} 正在网易邮箱执行`:finalAttachmentPending?`附件工作台待处理 ${finalAttachmentPending} 项`:selected?`已选择 ${selected} 封${scheduled?` · 定时 ${scheduled}`:''}`:'进入后选择邮件';
      });
    });
  }

  function goToProcessStep(step) {
    const n = Number(step || 1);
    setWorkbenchTab('batch');
    closeScheduleModal({restoreFocus:false});
    if(reviewInlineEl && !reviewInlineEl.hidden && n!==2)hideReviewWorkspaceWithoutStash();
    batch.uiStep = n;
    renderProcessGuide();
    if (n === 1) {
      requestAnimationFrame(()=>$('nmda-import-card')?.scrollIntoView?.({behavior:'smooth',block:'start'}));
      return;
    }
    if (n === 2) {
      if (!batch.dataset) { batch.uiStep=1; renderProcessGuide(); return; }
      openReviewWorkspace({returnStep:2,pendingOnly:false});
      return;
    }
    if (!batch.handoffComplete) {
      batch.uiStep = 2;
      renderProcessGuide();
      setImportStatus('先完成当前待办，完成后会自动进入排期。', 'warn');
      openNextBlockingIssue();
      return;
    }
    if(n===3){
      scheduleBatchRender({aux:false,force:true});
      requestAnimationFrame(()=>$('nmda-stage-execute')?.scrollIntoView?.({behavior:'smooth',block:'start'}));
      return;
    }
  }

  function setWorkbenchTab(name) {
    const current = currentWorkbenchTab();
    if (current !== name) {
      ui.querySelectorAll('.nmda-tab').forEach(t => t.classList.toggle('is-active', t.dataset.tab === name));
      ui.querySelectorAll('.nmda-tabpane').forEach(p => { p.hidden = p.dataset.pane !== name; });
      ui.querySelectorAll('[data-page-head]').forEach(head => { head.hidden = head.dataset.pageHead !== name; });
    }
    // Switching workspace is intentionally cheap. Re-render only when data changed,
    // and defer that work until the browser can paint the tab transition first.
    if (name === 'batch' && viewPerf.batchDirty) scheduleBatchRender();
    if (name === 'contacts' && viewPerf.contactsDirty) scheduleContactsRender();
    if (name === 'followup') renderFollowUp().catch(error => setFollowUpStatus(`加载失败：${error.message}`, 'error'));
  }

  launcher.addEventListener('click', () => {
    setPanelOpen(panel.hidden);
    if (!panel.hidden) {
      const name = currentWorkbenchTab();
      if (name === 'batch' && viewPerf.batchDirty) scheduleBatchRender();
      if (name === 'contacts' && viewPerf.contactsDirty) scheduleContactsRender();
    }
  });
  $('nmda-close').addEventListener('click', () => { setPanelOpen(false); });
  $('nmda-expand').addEventListener('click', () => {
    panel.classList.toggle('is-maximized');
    $('nmda-expand').textContent = panel.classList.contains('is-maximized') ? '◱' : '⛶';
    $('nmda-expand').title = panel.classList.contains('is-maximized') ? '还原工作台' : '全屏工作台';
  });
  ui.querySelectorAll('.nmda-tab').forEach(tab => tab.addEventListener('click', () => setWorkbenchTab(tab.dataset.tab)));
  ui.querySelectorAll('[data-flow-step]').forEach(button => button.addEventListener('click', () => goToProcessStep(button.dataset.flowStep)));
  $('nmda-go-import')?.addEventListener('click', () => { setWorkbenchTab('batch'); requestAnimationFrame(() => $('nmda-stage-prepare')?.scrollIntoView?.({behavior:'smooth', block:'start'})); });

  [recipientsEl, subjectEl, bodyEl, scheduleAtEl].forEach(el => {
    el.addEventListener('input', queueFormStateSave);
    el.addEventListener('change', saveFormState);
  });
  filesEl?.addEventListener('change', () => {
    const summary = $('nmda-single-file-summary');
    if (!summary) return;
    const files = [...(filesEl.files || [])];
    summary.textContent = files.length ? (files.length === 1 ? files[0].name : `已选择 ${files.length} 个附件`) : '未选择附件';
  });

  fillButton.addEventListener('click', async () => {
    fillButton.disabled = true; await saveFormState();
    try {
      setStatus('准备连接网易邮箱…');
      const outcome = await executeDraftRemotely({
        recipients: recipientsEl.value, subject: subjectEl.value, body: bodyEl.value,
        scheduleAt: scheduleAtEl.value, files: [...(filesEl.files || [])]
      }, { fresh: true, onProgress: progress => setStatus(progress.message || '正在创建草稿…') });
      const attachment = outcome.attachment || {};
      const attachmentWarning = attachment.verified === false && attachment.missingNames?.length ? `；附件页面暂未确认：${attachment.missingNames.join('、')}` : '';
      setStatus(`完成：草稿已确认保存（${outcome.saveOutcome?.evidence || '网易页面确认'}）${attachmentWarning}。`, attachmentWarning ? 'warn' : 'ok');
      refreshMailboxConnection();
    } catch (error) { console.error(`[${APP}]`, error); setStatus(`失败：${error.message}`, 'error'); }
    finally { fillButton.disabled = false; }
  });

  const batch = {
    dataset: null, collectionIndex: 0, collectionConfigs: new Map(), detection: null, mapping: {}, tasks: [],
    directoryFiles: [], taskFiles: [], routedAttachmentFiles: [], sharedFiles: [], fileIndex: Importer?.buildFileIndex?.([]),
    attachmentOverrides: new Map(), attachmentPolicies: new Map(), attachmentTargetEditing:'', attachmentTargetSearch:'', taskEdits: new Map(), running: false, stopRequested: false,
    importMeta: null, profileSuggestion: null,
    sessionId: 0, importBusy: false, schedulePlan: null,
    scheduleRules: { ...(Scheduler?.DEFAULT_RULES || { maxPerGroupPerRound:1, intervalDays:7, preserveExisting:true, intraRoundMinutes:10 }), startAt: Scheduler?.defaultStart?.() || '' },
    roster: emptyRosterState(), duplicateAudit:null,
    handoffComplete: false, autoAdvancing: false, reviewFilter: 'all', reviewSearch: '', reviewSelected: new Set(), duplicateSelections: new Map(), attachmentAttentionShown: false, rosterPromptChoice:'idle', attachmentPromptDeferred:false, attachmentPrepChoice:'idle', supplementPreflightDone:false, supplementPreflightOpen:false, preflightView:'files', supportView:'roster', attachmentManagerOpen:false, uiStep:1, planningView:'rules', reviewReturnStep:2, contactModalEmail:'', sourceInspectName:'', preflightFolderPath:'', preflightSearch:'', preflightReviewOnly:false, preflightPurposeFilter:'', ignoredAttachmentIdentities:new Set(), bulkSubjectPromptAutoShown:false, bulkSubjectPromptDismissed:false
  };

  const importFileEl = $('nmda-import-file'), importDirEl = $('nmda-import-dir'), importPackageEl = $('nmda-import-package'), rosterFileEl = $('nmda-roster-file'), collectionSelectEl = $('nmda-collection-select'), mappingEl = $('nmda-mapping'), mappingToggleEl = $('nmda-toggle-mapping');
  const pasteSourceEl = $('nmda-paste-source'), importPreviewSummaryEl = $('nmda-import-preview-summary'), importReviewBtnEl = $('nmda-review-import-issues');
  const subjectAssistEl = $('nmda-subject-assist'), subjectAssistTitleEl = $('nmda-subject-assist-title'), subjectAssistCopyEl = $('nmda-subject-assist-copy');
  const importEditorOverlayEl = $('nmda-import-editor-overlay'), importEditRecipientsEl = $('nmda-import-edit-recipients'), importEditSubjectEl = $('nmda-import-edit-subject'), importEditBodyEl = $('nmda-import-edit-body'), importEditAttachmentsEl = $('nmda-import-edit-attachments'), importEditScheduleEl = $('nmda-import-edit-schedule'), importEditTagsEl = $('nmda-import-edit-tags'), importEditorEvidenceEl = $('nmda-import-editor-evidence');
  const reviewQueueEl = $('nmda-review-queue'), reviewSourceContextEl = $('nmda-review-source-context'), reviewSourceMetaEl = $('nmda-review-source-meta'), reviewCandidatesEl = $('nmda-review-email-candidates'), reviewProgressEl = $('nmda-review-progress'), reviewProblemSummaryEl = $('nmda-review-problem-summary'), reviewFeedbackEl = $('nmda-review-feedback');
  const reviewNavCountEl=$('nmda-review-nav-count'), reviewInlineEl=$('nmda-inline-review'), reviewPageSummaryEl=$('nmda-review-page-summary'), reviewPageEmptyEl=$('nmda-review-page-empty'), reviewQueueCaptionEl=$('nmda-review-queue-caption');
  const reviewWorkspaceTitleEl=$('nmda-review-workspace-title'), reviewWorkspaceDescEl=$('nmda-review-workspace-desc'), reviewActionsEl=$('nmda-review-actions'), reviewMoreMenuEl=$('nmda-review-more-menu'), reviewExitEl=$('nmda-import-editor-cancel');
  const reviewQueueTitleEl=$('nmda-review-queue-title'), reviewFilterEl=$('nmda-review-filter'), reviewSearchEl=$('nmda-review-search'), reviewMailTitleEl=$('nmda-review-mail-title'), reviewPositionEl=$('nmda-review-position'), reviewPrevEl=$('nmda-review-prev'), reviewNextEl=$('nmda-review-next');
  const reviewBatchbarEl=$('nmda-review-batchbar'), reviewSelectedCountEl=$('nmda-review-selected-count'), reviewEvidenceDetailsEl=$('nmda-review-evidence-details');
  const reviewFillSubjectsEl=$('nmda-review-fill-subjects'), reviewSubjectPromptEl=$('nmda-review-subject-prompt'), reviewSubjectPromptTitleEl=$('nmda-review-subject-prompt-title'), reviewSubjectPromptCopyEl=$('nmda-review-subject-prompt-copy'), reviewBulkSubjectInputEl=$('nmda-review-bulk-subject-input'), reviewBulkSubjectApplyEl=$('nmda-review-bulk-subject-apply');
  const duplicateDecisionEl=$('nmda-duplicate-decision'), duplicateDecisionTitleEl=$('nmda-duplicate-decision-title'), duplicateDecisionCopyEl=$('nmda-duplicate-decision-copy'), duplicateDecisionKindEl=$('nmda-duplicate-decision-kind'), duplicateCandidatesEl=$('nmda-duplicate-candidates'), duplicateDecisionHintEl=$('nmda-duplicate-decision-hint'), duplicateKeepSelectedEl=$('nmda-duplicate-keep-selected'), duplicateKeepAllEl=$('nmda-duplicate-keep-all');
  const dirEl = $('nmda-attachment-dir'), taskFilesEl = $('nmda-attachment-files'), sharedFilesEl = $('nmda-shared-files');
  const draftImportEl = $('nmda-import-drafts'), preSendMatchFilesEl = $('nmda-pre-send-match-files'), preSendSharedFilesEl = $('nmda-pre-send-shared-files');
  const previewBodyEl = $('nmda-preview-body'), batchSummaryEl = $('nmda-batch-summary'), batchStatusEl = $('nmda-batch-status'), importStatusEl = $('nmda-import-status');
  const batchStartEl = $('nmda-batch-start'), batchStopEl = $('nmda-batch-stop');
  const scheduleStartEl = $('nmda-rule-start-at'), scheduleMaxSchoolEl = $('nmda-rule-max-school'), scheduleIntervalDaysEl = $('nmda-rule-interval-days'), schedulePreserveEl = $('nmda-rule-preserve-existing'), scheduleHolidayEl = $('nmda-rule-skip-holidays');
  const scheduleApplyEl = $('nmda-apply-schedule'), scheduleClearEl = $('nmda-clear-auto-schedule'), scheduleSummaryEl = $('nmda-schedule-summary'), scheduleRulePreviewEl = $('nmda-schedule-rule-preview'), schedulerCardEl = $('nmda-scheduler-card'), schedulerToggleLabelEl = $('nmda-scheduler-toggle-label');
  const batchSearchEl = $('nmda-batch-search');
  const batchTagIncludeEl = $('nmda-batch-tag-include'), batchStageFilterEl = $('nmda-batch-stage-filter');
  const importBusyBadgeEl = $('nmda-import-busy-badge'), resetImportEl = $('nmda-reset-import');
  let subjectAssistTimer = null;

  function isCurrentBatchSession(token) { return Number(token) === Number(batch.sessionId); }

  const SCHEDULE_PREFS_KEY = 'nmda.schedule.rules.v1';
  function loadScheduleRulePrefs() {
    try { const raw=JSON.parse(localStorage.getItem(SCHEDULE_PREFS_KEY)||'{}'); return Scheduler?.normalizeRules?.({...raw,startAt:''}) || raw; }
    catch (_) { return {}; }
  }
  function freshScheduleRules() {
    const prefs=loadScheduleRulePrefs();
    return {
      ...(Scheduler?.DEFAULT_RULES || {maxPerGroupPerRound:1,intervalDays:7,preserveExisting:true,intraRoundMinutes:10,skipHolidays:true}),
      ...prefs,
      startAt: Scheduler?.defaultStart?.() || ''
    };
  }
  function saveScheduleRulePrefs(rules) {
    try { localStorage.setItem(SCHEDULE_PREFS_KEY, JSON.stringify({maxPerGroupPerRound:rules.maxPerGroupPerRound,intervalDays:rules.intervalDays,preserveExisting:rules.preserveExisting,intraRoundMinutes:rules.intraRoundMinutes||10,skipHolidays:rules.skipHolidays!==false})); } catch (_) {}
  }
  function syncScheduleRuleControls() {
    if(!batch.scheduleRules) batch.scheduleRules=freshScheduleRules();
    if(scheduleStartEl && document.activeElement!==scheduleStartEl) scheduleStartEl.value=batch.scheduleRules.startAt||'';
    if(scheduleMaxSchoolEl && document.activeElement!==scheduleMaxSchoolEl) scheduleMaxSchoolEl.value=String(batch.scheduleRules.maxPerGroupPerRound||1);
    if(scheduleIntervalDaysEl && document.activeElement!==scheduleIntervalDaysEl) scheduleIntervalDaysEl.value=String(batch.scheduleRules.intervalDays||7);
    if(schedulePreserveEl) schedulePreserveEl.checked=batch.scheduleRules.preserveExisting!==false;
    if(scheduleHolidayEl) scheduleHolidayEl.checked=batch.scheduleRules.skipHolidays!==false;
  }
  function readScheduleRuleControls() {
    const rules=Scheduler?.normalizeRules?.({
      startAt:scheduleStartEl?.value||batch.scheduleRules?.startAt||'',
      maxPerGroupPerRound:scheduleMaxSchoolEl?.value||1,
      intervalDays:scheduleIntervalDaysEl?.value||7,
      preserveExisting:schedulePreserveEl?.checked!==false,
      intraRoundMinutes:batch.scheduleRules?.intraRoundMinutes||10,
      skipHolidays:scheduleHolidayEl?.checked!==false
    }) || {startAt:scheduleStartEl?.value||'',maxPerGroupPerRound:Number(scheduleMaxSchoolEl?.value||1),intervalDays:Number(scheduleIntervalDaysEl?.value||7),preserveExisting:schedulePreserveEl?.checked!==false,skipHolidays:scheduleHolidayEl?.checked!==false};
    batch.scheduleRules=rules; saveScheduleRulePrefs(rules); return rules;
  }
  batch.scheduleRules = freshScheduleRules();
  (async()=>{
    try{
      if(localStorage.getItem(SCHEDULE_PREFS_KEY))return;
      const legacy=await sendRuntimeMessage({type:'NMDA_LEGACY_PREFS'});
      if(legacy?.ok&&legacy.scheduleRules){localStorage.setItem(SCHEDULE_PREFS_KEY,legacy.scheduleRules);batch.scheduleRules=freshScheduleRules();syncScheduleRuleControls();}
    }catch(_){}
  })();

  // One delegated handler replaces hundreds of row listeners that used to be
  // destroyed and rebound after every table refresh.
  previewBodyEl?.addEventListener('change', event => {
    const input=event.target;
    if(!(input instanceof HTMLInputElement))return;
    if(input.dataset.taskEnabled){
      const task=batch.tasks.find(item=>item.editKey===input.dataset.taskEnabled);if(!task)return;
      setTaskEdit(task,{enabled:input.checked});
      const row=input.closest('tr');if(row)row.dataset.enabled=input.checked?'1':'0';
      const stateCell=row?.querySelector('.nmda-task-state-cell');
      if(stateCell){const text=statusLabel(task),fileText=task.files?.length?` · 附件 ${task.files.length}`:'';stateCell.textContent=`${text}${fileText}`;stateCell.title=text;}
      renderBatchSummaryControls();
      renderScheduleCenter();
      // Only rebuild visible rows if an active search could depend on "未选择/可执行".
      if(String(batchSearchEl?.value||'').trim())scheduleBatchRender({aux:false});
      return;
    }
    if(input.dataset.taskSchedule){
      const task=batch.tasks.find(item=>item.editKey===input.dataset.taskSchedule);if(!task)return;
      const value=input.value||'';
      setTaskEdit(task,{scheduleAt:value,scheduleSource:value?'manual':'manual-clear',scheduleReason:value?'手工调整':''});
      const small=input.parentElement?.querySelector('small');if(small)small.textContent=scheduleSourceLabel(task);
      renderBatchSummaryControls();
      renderScheduleCenter();
      if(String(batchSearchEl?.value||'').trim())scheduleBatchRender({aux:false});
    }
  });

  reviewQueueEl?.addEventListener('click',event=>{
    if(event.target.closest?.('[data-review-load-more]')){viewPerf.reviewRenderLimit=(viewPerf.reviewRenderLimit||250)+250;renderReviewQueue(importEditorOverlayEl?.dataset.editKey||'');return;}
    const action=event.target.closest?.('[data-review-key]');
    if(!action)return;
    stashCurrentReviewDraft(); hideSubjectAssist();
    const task=(batch.tasks||[]).find(t=>t.editKey===action.dataset.reviewKey);if(task)openImportTaskEditor(task);
  });
  reviewQueueEl?.addEventListener('change',event=>{
    const input=event.target.closest?.('[data-review-select]');if(!input)return;
    const key=input.dataset.reviewSelect;if(!key)return;
    if(input.checked)batch.reviewSelected.add(key);else batch.reviewSelected.delete(key);
    input.closest('.nmda-mail-review-card')?.classList.toggle('is-selected',input.checked);
    renderReviewBatchActions();
    const visible=reviewVisibleTasks().filter(taskCanBatchConfirm),allSelected=visible.length&&visible.every(task=>batch.reviewSelected.has(task.editKey));
    const selectButton=$('nmda-review-select-filtered');if(selectButton){const batchMode=batch.reviewFilter==='pending'&&reviewTasks().length>0;selectButton.hidden=!batchMode||visible.length<2;selectButton.textContent=allSelected?'取消批量选择':`批量确认 ${visible.length} 封…`;}
  });


  reviewSearchEl?.addEventListener('input',()=>{
    batch.reviewSearch=String(reviewSearchEl.value||'');
    viewPerf.reviewRenderLimit=250;
    const currentKey=importEditorOverlayEl?.dataset.editKey||'';
    renderReviewQueue(currentKey);
    const visible=reviewVisibleTasks();
    if(currentKey && !visible.some(task=>task.editKey===currentKey))closeImportTaskEditor();
    else{const current=(batch.tasks||[]).find(task=>task.editKey===currentKey);if(current)updateReviewMailNavigation(current);}
  });
  reviewPrevEl?.addEventListener('click',()=>navigateReviewMail(-1));
  reviewNextEl?.addEventListener('click',()=>navigateReviewMail(1));

  function referenceRosterCount() {
    return Number(rosterState()?.entries?.length || 0);
  }

  function rosterContextState() {
    if(referenceRosterCount())return 'added';
    if(batch.dataset && (batch.tasks||[]).length)return batch.rosterPromptChoice==='skipped'?'skipped':'pending';
    return 'prepare';
  }

  function rosterContextNeedsDecision() {
    return rosterContextState()==='pending';
  }

  function attachmentPreparedFileCount() {
    return uniqueFiles([...(batch.directoryFiles||[]), ...(batch.taskFiles||[]), ...(batch.routedAttachmentFiles||[]), ...(batch.sharedFiles||[])]).length;
  }

  function attachmentPreflightState() {
    const count=attachmentPreparedFileCount();
    if(count) return 'added';
    if(batch.dataset && (batch.tasks||[]).length) return batch.attachmentPrepChoice==='skipped'?'skipped':'pending';
    return 'prepare';
  }

  function supplementPreflightNeedsDecision() {
    return !!batch.dataset && !batch.supplementPreflightDone;
  }

  function attachmentRequirementRefs() {
    const refs=[];const seen=new Set();
    for(const task of batch.tasks||[]) for(const ref of task.attachmentRefs||[]){
      const key=Importer.normalizeFileKey(ref);if(!key||seen.has(key))continue;seen.add(key);refs.push(String(ref));
    }
    return refs;
  }

  function formatAttachmentSize(file) {
    const size=Number(file?.size||0);if(!size)return '大小未知';
    if(size<1024)return `${size} B`;
    if(size<1024*1024)return `${Math.max(1,Math.round(size/1024))} KB`;
    return `${(size/1024/1024).toFixed(size>=10*1024*1024?0:1)} MB`;
  }

  function attachmentPolicyStore(){
    if(!(batch.attachmentPolicies instanceof Map))batch.attachmentPolicies=new Map();
    return batch.attachmentPolicies;
  }

  function attachmentDefaultMode(kind='task'){
    if(kind==='shared')return 'all';
    if(kind==='directory'||kind==='routed')return 'smart';
    return attachmentRequirementRefs().length?'smart':'all';
  }

  function ensureAttachmentPolicy(file,kind='task',options={}){
    const identity=Importer.fileIdentity(file);if(!identity)return {mode:'smart',targets:[],source:''};
    const store=attachmentPolicyStore();let policy=store.get(identity);
    if(!policy){policy={mode:options.mode||attachmentDefaultMode(kind),targets:[],source:options.source||''};store.set(identity,policy);}
    else{
      if(options.source&&!policy.source)policy.source=options.source;
      if(options.mode&&!policy.mode)policy.mode=options.mode;
      if(!Array.isArray(policy.targets))policy.targets=[];
    }
    return policy;
  }

  function attachmentKindForFile(file){
    const id=Importer.fileIdentity(file),has=items=>(items||[]).some(item=>Importer.fileIdentity(item)===id);
    if(has(batch.directoryFiles))return 'directory';
    if(has(batch.routedAttachmentFiles))return 'routed';
    if(has(batch.sharedFiles))return 'shared';
    return 'task';
  }

  function syncAttachmentPolicies(){
    const store=attachmentPolicyStore(),valid=new Set();
    const groups=[['directory',batch.directoryFiles||[],'文件夹'],['task',batch.taskFiles||[],'手动添加'],['routed',batch.routedAttachmentFiles||[],'随资料导入'],['shared',batch.sharedFiles||[],'旧版配置']];
    for(const [kind,files,source] of groups)for(const file of files){const id=Importer.fileIdentity(file);if(!id)continue;valid.add(id);ensureAttachmentPolicy(file,kind,{source});}
    for(const id of [...store.keys()])if(!valid.has(id))store.delete(id);
  }

  function attachmentPolicyForFile(file){syncAttachmentPolicies();return ensureAttachmentPolicy(file,attachmentKindForFile(file));}

  function attachmentPolicyLabel(policy,used=0){
    if(policy.mode==='all')return `全部邮件`;
    if(policy.mode==='selected')return `指定 ${Array.isArray(policy.targets)?policy.targets.length:0} 封`;
    return used?`自动匹配 ${used} 封`:'自动匹配';
  }

  function attachmentAssetEntries() {
    syncAttachmentPolicies();
    const groups=[
      ['directory',batch.directoryFiles||[],'文件夹导入'],
      ['task',batch.taskFiles||[],'手动添加'],
      ['routed',batch.routedAttachmentFiles||[],'随资料导入'],
      ['shared',batch.sharedFiles||[],'旧版配置']
    ];
    const out=[],seen=new Set();
    for(const [kind,files,source] of groups) for(const file of files){
      const identity=Importer.fileIdentity(file);if(!identity||seen.has(identity))continue;seen.add(identity);
      const used=(batch.tasks||[]).filter(task=>(task.files||[]).some(item=>Importer.fileIdentity(item)===identity)).length;
      const policy=ensureAttachmentPolicy(file,kind,{source});
      out.push({file,identity,kind,source:policy.source||source,used,policy});
    }
    return out;
  }

  function setAttachmentPolicy(identity,mode){
    const file=allAttachmentFiles().find(item=>Importer.fileIdentity(item)===identity);if(!file)return;
    const policy=ensureAttachmentPolicy(file,attachmentKindForFile(file));
    policy.mode=['smart','all','selected'].includes(mode)?mode:'smart';
    if(policy.mode!=='selected')batch.attachmentTargetEditing='';
    batch.attachmentPolicies.set(identity,policy);batch.handoffComplete=false;
    rebuildTasks();renderAttachmentAssetViews();
  }

  function setAttachmentTarget(identity,taskKey,checked){
    const file=allAttachmentFiles().find(item=>Importer.fileIdentity(item)===identity);if(!file)return;
    const policy=ensureAttachmentPolicy(file,attachmentKindForFile(file));policy.mode='selected';
    const targets=new Set(policy.targets||[]);checked?targets.add(taskKey):targets.delete(taskKey);policy.targets=[...targets];
    batch.attachmentPolicies.set(identity,policy);batch.handoffComplete=false;rebuildTasks();renderAttachmentAssetViews();
  }

  function addAttachmentFiles(files,{source='手动添加',mode=''}={}){
    files=uniqueFiles(files||[]);if(!files.length)return 0;
    for(const file of files)batch.ignoredAttachmentIdentities.delete(Importer.fileIdentity(file));
    batch.taskFiles=uniqueFiles([...(batch.taskFiles||[]),...files]);
    const inferred=mode||((files.some(file=>String(file?._nmdaPath||file?.webkitRelativePath||'').includes('/')))?'smart':attachmentDefaultMode('task'));
    for(const file of files)ensureAttachmentPolicy(file,'task',{source,mode:inferred});
    batch.attachmentPrepChoice='added';refreshFileIndex(false);renderSupplementPreflight();
    return files.length;
  }

  function sourceIdentityKey(value) {
    return String(value||'').replace(/\\/g,'/').replace(/^\.\//,'').trim();
  }

  function sourceIdentityMatches(value,sourceName,fileName='') {
    const candidate=sourceIdentityKey(value),full=sourceIdentityKey(sourceName),leaf=sourceIdentityKey(fileName||String(full).split('/').pop());
    if(!candidate)return false;
    return candidate===full||candidate===leaf;
  }

  function collectionDirectMatchesSource(collection,sourceName,fileName='') {
    return sourceIdentityMatches(collection?.source,sourceName,fileName);
  }

  function collectionMatchesSource(collection,sourceName,fileName='') {
    if(collectionDirectMatchesSource(collection,sourceName,fileName))return true;
    return (collection?.meta?.sourceMembers||[]).some(member=>sourceIdentityMatches(member,sourceName,fileName));
  }

  function sourceCollections(sourceName,fileName='') {
    const matches=recordSets().map((collection,index)=>({collection,index,direct:collectionDirectMatchesSource(collection,sourceName,fileName)})).filter(({collection})=>collectionMatchesSource(collection,sourceName,fileName));
    const direct=matches.filter(item=>item.direct);
    // Aggregate Word collections list every source in sourceMembers. They are an
    // execution view, not a per-file preview. Prefer the exact source collection
    // whenever it exists so selecting B.docx can never show A.docx's content.
    return (direct.length?direct:matches).map(({collection,index})=>({collection,index}));
  }

  function setSourcePurpose(sourceName,purpose,fileName='') {
    if(!['mail','roster','attachment','ignored'].includes(purpose))return;
    const resolvedFileName=fileName||String(sourceName||'').replace(/\\/g,'/').split('/').pop()||'';
    const related=sourceCollections(sourceName,resolvedFileName),primary=related.filter(({collection})=>!collection.meta?.supplemental),targets=primary.length?primary:related;
    if(!targets.length)return;
    for(const {collection,index} of targets){
      const config=ensureCollectionConfig(index);if(!config)continue;
      config.purpose=purpose;config.enabled=purpose==='mail';
      collection.meta={...(collection.meta||{}),purposeOverride:purpose,sourcePurpose:purpose,purposeConfidence:100,purposeReasons:['用户已确认资料用途']};
    }
    batch.handoffComplete=false;
    syncRoutedSources();
    clearStaleOverrides();
    batch.fileIndex=Importer.buildFileIndex(allAttachmentFiles());
    rebuildTasks();
    renderSourceInventory();renderCollectionList();renderPreflightSourceRoles();renderAttachmentAssetViews();renderSupplementPreflight();
    const label={mail:'邮件',roster:'参考总名单',attachment:'附件',ignored:'暂不使用'}[purpose];
    setImportStatus(`已将 ${resolvedFileName||sourceName} 调整为${label}，本批次结果已重新整理。`,'ok');
  }

  function sourcePurposeDecision(file) {
    const sourceName=sourceFileName(file),related=sourceCollections(sourceName,file?.name),primary=related.filter(({collection})=>!collection.meta?.supplemental),items=primary.length?primary:related;
    const userConfirmed=items.some(({collection})=>!!collection.meta?.purposeOverride);
    const configPurposes=[...new Set(items.map(({index})=>ensureCollectionConfig(index)?.purpose||'ignored'))];
    const evidence=items.map(({collection,index})=>({
      purpose:String(collection.meta?.sourcePurpose||'ambiguous'),
      confidence:Number(collection.meta?.purposeConfidence||0),
      reasons:collection.meta?.purposeReasons||[],index
    }));
    const scoreByPurpose=new Map();
    for(const item of evidence){
      if(!['mail','roster','attachment','ignored'].includes(item.purpose))continue;
      scoreByPurpose.set(item.purpose,Math.max(Number(scoreByPurpose.get(item.purpose)||0),item.confidence));
    }
    const ranked=[...scoreByPurpose.entries()].map(([purpose,confidence])=>({purpose,confidence})).sort((a,b)=>b.confidence-a.confidence);
    const top=ranked[0]||null,runner=ranked[1]||null;
    // A workbook can legitimately contain one useful roster sheet plus empty/helper
    // sheets. Do not make the whole file “待确认” merely because an auxiliary sheet
    // is ambiguous. Promote a single high-confidence source role only when it clearly
    // dominates every competing non-ambiguous role.
    const dominant=!userConfirmed&&top&&top.confidence>=85&&(!runner||runner.confidence<70||top.confidence-runner.confidence>=12)?top:null;
    let purpose='ignored';
    if(userConfirmed)purpose=configPurposes.length===1?configPurposes[0]:(configPurposes.find(value=>value!=='ignored')||configPurposes[0]||'ignored');
    else if(dominant)purpose=dominant.purpose;
    else if(configPurposes.length===1)purpose=configPurposes[0];
    const confidence=dominant?dominant.confidence:Math.max(0,...evidence.map(item=>item.confidence));
    const reasonSource=dominant?evidence.filter(item=>item.purpose===dominant.purpose):evidence;
    const reasons=[...new Set(reasonSource.flatMap(item=>item.reasons||[]))];
    const hasAmbiguous=evidence.some(item=>item.purpose==='ambiguous');
    const strongConflict=!!runner&&runner.confidence>=70&&(!top||top.confidence-runner.confidence<12);
    const needsReview=!userConfirmed&&!dominant&&(hasAmbiguous||confidence<70||strongConflict||!items.length);
    return{file,sourceName,purpose,confidence,reasons,items,needsReview,userConfirmed};
  }

  function roleConfidenceText(score) {
    const value=Number(score||0);return value>=90?'判断明确':value>=70?'基本确定':'需要留意';
  }

  function sourcePurposeOptions(selected) {
    const options=[['mail','邮件'],['roster','总名单'],['attachment','附件'],['review','待确认'],['ignored','暂不使用']];
    return options.map(([value,label])=>`<option value="${value}" ${selected===value?'selected':''}>${label}</option>`).join('');
  }

  function sourceRoleVisual(purpose,needsReview=false) {
    if(needsReview)return{label:'待确认',icon:'!',tone:'review'};
    return {
      mail:{label:'邮件',icon:'✉',tone:'mail'},
      roster:{label:'总名单',icon:'名',tone:'roster'},
      attachment:{label:'附件',icon:'附',tone:'attachment'},
      ignored:{label:'暂不使用',icon:'×',tone:'ignored'}
    }[purpose]||{label:'待确认',icon:'!',tone:'review'};
  }

  function buildSourceFolderTree(decisions) {
    const root={name:'全部文件',path:'',count:0,direct:0,folders:new Map()};
    for(const decision of decisions){
      root.count++;
      const parts=String(decision.sourceName||'').replace(/\\/g,'/').split('/').filter(Boolean);parts.pop();
      if(!parts.length){root.direct++;continue;}
      let node=root,path='';
      for(const part of parts){
        path=path?`${path}/${part}`:part;
        if(!node.folders.has(part))node.folders.set(part,{name:part,path,count:0,direct:0,folders:new Map()});
        node=node.folders.get(part);node.count++;
      }
      node.direct++;
    }
    return root;
  }

  function sourceFolderNavHtml(node,depth=0) {
    return [...node.folders.values()].sort((a,b)=>a.name.localeCompare(b.name,'zh-CN')).map(folder=>{
      const active=batch.preflightFolderPath===folder.path;
      return `<div class="nmda-classify-folder-branch"><button class="nmda-classify-folder-row${active?' is-active':''}" type="button" data-preflight-folder="${escapeHtml(encodeURIComponent(folder.path))}" style="--depth:${depth}"><span class="nmda-classify-folder-chevron">›</span><span class="nmda-classify-folder-icon">▰</span><span class="nmda-classify-folder-name" title="${escapeHtml(folder.name)}">${escapeHtml(folder.name)}</span><b>${folder.count}</b></button>${sourceFolderNavHtml(folder,depth+1)}</div>`;
    }).join('');
  }

  function sourceFileVisual(fileName) {
    const ext=String(fileName||'').split('.').pop().toLowerCase();
    if(['doc','docx','docm','rtf'].includes(ext))return{kind:'word',glyph:'W',label:ext==='rtf'?'RTF':'DOCX'};
    if(['xls','xlsx','ods','csv','tsv'].includes(ext))return{kind:'sheet',glyph:'X',label:['csv','tsv'].includes(ext)?ext.toUpperCase():'XLSX'};
    if(ext==='pdf')return{kind:'pdf',glyph:'P',label:'PDF'};
    if(['eml','msg'].includes(ext))return{kind:'email',glyph:'@',label:ext.toUpperCase()};
    if(['zip','rar','7z'].includes(ext))return{kind:'archive',glyph:'Z',label:ext.toUpperCase()};
    if(['jpg','jpeg','png','gif','webp','svg'].includes(ext))return{kind:'image',glyph:'▧',label:ext==='jpeg'?'JPG':ext.toUpperCase()};
    return{kind:'file',glyph:'F',label:(ext||'FILE').slice(0,5).toUpperCase()};
  }

  function sourceFileIconHtml(fileName) {
    const visual=sourceFileVisual(fileName);
    return `<span class="nmda-classify-file-icon" data-file-kind="${escapeHtml(visual.kind)}"><b>${escapeHtml(visual.glyph)}</b><small>${escapeHtml(visual.label)}</small></span>`;
  }

  function sourceFriendlyReason(decision) {
    if(decision.userConfirmed)return'你已确认这个文件的用途';
    const reason=String((decision.reasons||[]).find(Boolean)||'').trim();
    if(reason){
      if(reason.includes('证据不足或互相冲突'))return'文件同时具有多种用途特征，系统暂时没有替你决定';
      if(reason.includes('已停止自动分流'))return'文件用途不够明确，需要你看一眼内容后决定';
      if(reason.includes('普通文档缺少可验证'))return'暂时看不出明确的邮件、名单或附件用途';
      if(reason.includes('来源已明确指定用途'))return'这个用途来自你之前的选择';
      return reason.replace(/已按来源结构完成用途判断/g,'已根据文件内容判断用途');
    }
    if(decision.needsReview)return'系统不能完全确定，建议快速看一眼内容';
    if(decision.purpose==='mail')return'内容结构更像一封可以生成草稿的邮件';
    if(decision.purpose==='roster')return'内容更像联系人、导师或院校名单';
    if(decision.purpose==='attachment')return'内容更像需要随邮件使用的独立材料';
    return'当前不会参与本批次邮件创建';
  }

  function sourceFileTypeLabel(fileName) {
    const ext=String(fileName||'').split('.').pop().toLowerCase();
    if(['xls','xlsx','ods','csv','tsv'].includes(ext))return'表格';
    if(['doc','docx','docm','rtf'].includes(ext))return'Word';
    if(['eml','msg'].includes(ext))return'邮件文件';
    if(ext==='pdf')return'PDF';
    if(['zip','rar','7z'].includes(ext))return'压缩包';
    if(['jpg','jpeg','png','gif','webp','svg'].includes(ext))return'图片';
    return ext?ext.toUpperCase():'文件';
  }

  function sourcePrimaryCollection(decision) {
    const items=decision?.items||[],purpose=String(decision?.purpose||'');
    // When one workbook contains several sheets, preview the sheet that actually
    // supports the file-level decision instead of blindly taking the first sheet.
    const matchesPurpose=({collection,index})=>{
      const auto=String(collection?.meta?.sourcePurpose||''),configured=String(ensureCollectionConfig(index)?.purpose||'');
      return purpose&&purpose!=='ignored'&&(auto===purpose||configured===purpose);
    };
    return items.find(item=>matchesPurpose(item)&&!item.collection?.meta?.supplemental&&Array.isArray(item.collection?.rows)&&item.collection.rows.length)
      ||items.find(item=>matchesPurpose(item)&&Array.isArray(item.collection?.rows)&&item.collection.rows.length)
      ||items.find(({collection})=>!collection?.meta?.supplemental&&Array.isArray(collection?.rows)&&collection.rows.length)
      ||items.find(({collection})=>Array.isArray(collection?.rows)&&collection.rows.length)
      ||items[0]||null;
  }

  function sourceCollectionSnippet(decision,maxLength=86) {
    const item=sourcePrimaryCollection(decision),collection=item?.collection,rows=collection?.rows||[];
    if(!rows.length)return'';
    if(collection?.meta?.oneFileTask&&rows[1]){
      const subject=String(rows[1]?.[3]??'').replace(/\s+/g,' ').trim();
      const body=String(rows[1]?.[4]??'').replace(/\s+/g,' ').trim();
      const text=subject?`主题：${subject}${body?` · ${body}`:''}`:body;
      return text.length>maxLength?`${text.slice(0,maxLength)}…`:text;
    }
    const values=[];
    for(const row of rows.slice(0,6)){
      for(const cell of (row||[]).slice(0,6)){
        const text=String(cell??'').replace(/\s+/g,' ').trim();
        if(!text||values.includes(text))continue;
        values.push(text);
        if(values.join(' · ').length>=maxLength)break;
      }
      if(values.join(' · ').length>=maxLength)break;
    }
    const text=values.join(' · ');
    return text.length>maxLength?`${text.slice(0,maxLength)}…`:text;
  }

  function sourceTasksForDecision(decision) {
    const sourceName=sourceIdentityKey(decision?.sourceName),fileName=sourceIdentityKey(decision?.file?.name||String(sourceName).split('/').pop());
    const bySource=(batch.tasks||[]).filter(task=>!task.importExcluded&&sourceIdentityMatches(task.sourceFile,sourceName,fileName));
    if(bySource.length)return bySource;
    const indexes=new Set((decision?.items||[]).map(item=>item.index));
    return (batch.tasks||[]).filter(task=>indexes.has(Number(task.collectionIndex))&&!task.importExcluded);
  }

  function sourceRosterListHint(decision) {
    const item=sourcePrimaryCollection(decision),rows=item?.collection?.rows||[];
    if(rows.length<2)return'';
    const rosterDetection=typeof Importer.detectRosterHeader==='function'?Importer.detectRosterHeader(item.collection):null;
    const fallback=Importer.detectHeader(rows),headerIndex=rosterDetection&&Number(rosterDetection.index)>=0?Number(rosterDetection.index):Math.max(0,Number(fallback.index||0)),headers=(rows[headerIndex]||fallback.headers||[]).map(v=>String(v??'').trim());
    const records=Math.max(0,rows.length-headerIndex-1),sample=(rows[headerIndex+1]||[]).map(v=>String(v??'').replace(/\s+/g,' ').trim()).filter(Boolean);
    const usefulHeaders=headers.filter(Boolean).filter(h=>/学校|院校|大学|导师|教授|姓名|邮箱|方向|研究|联系人|university|school|supervisor|professor|name|email|research/i.test(h));
    const headerSummary=usefulHeaders.slice(0,3).join(' / ');
    const sampleSummary=sample.slice(0,2).join(' / ');
    return `${records} 条${headerSummary?` · ${headerSummary}`:''}${sampleSummary?` · 示例：${sampleSummary}`:''}`;
  }

  function sourceListContentHint(decision) {
    // The middle column exists only to answer “do I need to correct this file?”.
    // It intentionally shows a role-specific verification cue instead of dumping
    // raw headers/content that the user can inspect in the right pane.
    const tasks=sourceTasksForDecision(decision);
    if(decision.purpose==='mail'&&!decision.needsReview&&tasks.length){
      const task=tasks[0],subject=String(task.subject||'').replace(/\s+/g,' ').trim(),recipient=String(task.recipients||'').trim();
      if(recipient&&subject)return `${recipient} · ${subject}`;
      if(recipient)return `收件人 ${recipient}`;
      if(subject)return `主题 ${subject}`;
    }
    if(decision.purpose==='roster'&&!decision.needsReview){
      const rosterHint=sourceRosterListHint(decision);if(rosterHint)return rosterHint;
    }
    if(decision.needsReview){
      const rosterHint=sourceRosterListHint(decision);
      if(rosterHint)return `待确认 · ${rosterHint}`;
      return sourceFriendlyReason(decision);
    }
    const primary=sourcePrimaryCollection(decision),snippet=sourceCollectionSnippet(decision,72);
    if(decision.purpose==='attachment'){
      if(primary?.collection?.meta?.kind==='asset')return'—';
      return snippet?snippet:'—';
    }
    return snippet||'点击查看内容';
  }

  function sourceDecisionStateText(decision) {
    if(decision.userConfirmed)return'已修正';
    if(decision.needsReview)return'待确认';
    return decision.confidence>=85?'已识别':'建议看一眼';
  }

  function sourceDirectoryPath(sourceName) {
    const parts=String(sourceName||'').replace(/\\/g,'/').split('/').filter(Boolean);parts.pop();return parts.join('/');
  }

  function sourceVisibleDecisions(decisions) {
    const folder=String(batch.preflightFolderPath||''),query=String(batch.preflightSearch||'').trim().toLowerCase(),filter=String(batch.preflightPurposeFilter||'');
    return decisions.filter(decision=>{
      const directory=sourceDirectoryPath(decision.sourceName);
      if(folder && !(directory===folder||directory.startsWith(`${folder}/`)))return false;
      if(batch.preflightReviewOnly&&!decision.needsReview)return false;
      if(filter){if(filter==='review'){if(!decision.needsReview)return false;}else if(decision.needsReview||decision.purpose!==filter)return false;}
      if(query&&!`${decision.sourceName} ${decision.file?.name||''}`.toLowerCase().includes(query))return false;
      return true;
    });
  }

  function sourceFileRowsHtml(decisions) {
    if(!decisions.length)return'<div class="nmda-classify-empty"><span>⌕</span><strong>当前范围没有文件</strong><small>可以切换目录、清除筛选，或返回上传继续添加资料。</small></div>';
    return decisions.map(decision=>{
      const visual=sourceRoleVisual(decision.purpose,decision.needsReview),fileName=String(decision.sourceName||'').replace(/\\/g,'/').split('/').pop()||'未命名来源';
      const active=batch.sourceInspectName===decision.sourceName;
      const path=sourceDirectoryPath(decision.sourceName),meta=[path||'根目录',humanFileSize(decision.file?.size)].filter(Boolean).join(' · ');
      return `<div class="nmda-classify-file-row${active?' is-selected':''}" data-tone="${escapeHtml(visual.tone)}" data-review="${decision.needsReview?'1':'0'}" data-inspect-source="${escapeHtml(encodeURIComponent(decision.sourceName))}" data-source-row="${escapeHtml(encodeURIComponent(decision.sourceName))}" role="button" tabindex="0" aria-label="查看 ${escapeHtml(fileName)}"><span class="nmda-classify-drag" draggable="true" data-source-drag="${escapeHtml(encodeURIComponent(decision.sourceName))}" title="拖动可快速归类" aria-label="拖动 ${escapeHtml(fileName)} 重新归类">⠿</span>${sourceFileIconHtml(fileName)}<div class="nmda-classify-file-main"><strong>${escapeHtml(fileName)}</strong><small>${escapeHtml(meta)}</small></div><span class="nmda-classify-purpose-pill" data-tone="${escapeHtml(visual.tone)}"><i>${escapeHtml(visual.icon)}</i><span>${escapeHtml(visual.label)}</span></span></div>`;
    }).join('');
  }

  function setSourceNeedsReview(sourceName,fileName='') {
    const resolvedFileName=fileName||String(sourceName||'').replace(/\\/g,'/').split('/').pop()||'';
    const related=sourceCollections(sourceName,resolvedFileName),primary=related.filter(({collection})=>!collection.meta?.supplemental),targets=primary.length?primary:related;
    if(!targets.length)return;
    for(const {collection,index} of targets){
      const config=ensureCollectionConfig(index);if(!config)continue;
      config.purpose='ignored';config.enabled=false;
      collection.meta={...(collection.meta||{}),purposeOverride:'',sourcePurpose:'ambiguous',purposeConfidence:0,purposeReasons:['已标记为待确认']};
    }
    batch.handoffComplete=false;syncRoutedSources();clearStaleOverrides();batch.fileIndex=Importer.buildFileIndex(allAttachmentFiles());rebuildTasks();
    renderSourceInventory();renderCollectionList();renderPreflightSourceRoles();renderAttachmentAssetViews();renderSupplementPreflight();
    setImportStatus(`已将 ${resolvedFileName||sourceName} 标记为待确认。`,'ok');
  }

  function sourceRosterPreviewHtml(decision) {
    const first=sourcePrimaryCollection(decision);if(!first)return'';
    const collection=first.collection,config=ensureCollectionConfig(first.index),rosterDetection=typeof Importer.detectRosterHeader==='function'?Importer.detectRosterHeader(collection):null,detection=config?.detection||Importer.detectHeader(collection.rows||[]),headerIndex=rosterDetection&&Number(rosterDetection.index)>=0?Number(rosterDetection.index):Math.max(0,Number(detection.index||0));
    const headers=(collection.rows?.[headerIndex]||detection.headers||[]).slice(0,4).map(value=>String(value||'').trim()||'字段');
    const rows=(collection.rows||[]).slice(headerIndex+1,headerIndex+4).map(row=>headers.map((_,i)=>String(row?.[i]??'').trim()));
    if(!headers.length||!rows.length)return'<div class="nmda-inspector-empty-preview">已识别为名单资料，暂无适合快速预览的表格内容。</div>';
    return `<div class="nmda-inspector-preview-block"><div class="nmda-inspector-preview-head"><strong>内容预览</strong><span>约 ${Math.max(0,(collection.rows||[]).length-headerIndex-1)} 条</span></div><div class="nmda-inspector-mini-table"><div class="nmda-inspector-mini-row is-head">${headers.map(h=>`<span>${escapeHtml(h)}</span>`).join('')}</div>${rows.map(row=>`<div class="nmda-inspector-mini-row">${row.map(v=>`<span title="${escapeHtml(v)}">${escapeHtml(v||'—')}</span>`).join('')}</div>`).join('')}</div></div>`;
  }

  function sourceGenericPreviewHtml(decision) {
    const item=sourcePrimaryCollection(decision),collection=item?.collection,rows=(collection?.rows||[]).filter(row=>(row||[]).some(value=>String(value??'').trim()));
    if(!rows.length)return'<div class="nmda-inspector-empty-preview">暂时没有可展示的内容预览。</div>';
    if(collection?.meta?.oneFileTask&&rows[1]){
      const body=String(rows[1]?.[4]??'').trim(),subject=String(rows[1]?.[3]??'').trim();
      const text=(body||subject).replace(/\s+/g,' ').trim();
      return `<div class="nmda-inspector-preview-block"><div class="nmda-inspector-preview-head"><strong>文件内容</strong><span>${escapeHtml(sourceFileTypeLabel(decision.file?.name||decision.sourceName))}</span></div><div class="nmda-inspector-text-preview">${escapeHtml(text?`${text.slice(0,420)}${text.length>420?'…':''}`:'暂时没有可展示的正文')}</div></div>`;
    }
    const width=Math.max(0,...rows.slice(0,5).map(row=>(row||[]).filter(value=>String(value??'').trim()).length));
    if(width>=2){
      const previewRows=rows.slice(0,4),cols=Math.min(4,Math.max(2,width));
      return `<div class="nmda-inspector-preview-block"><div class="nmda-inspector-preview-head"><strong>文件内容</strong><span>前 ${previewRows.length} 行</span></div><div class="nmda-inspector-mini-table">${previewRows.map((row,rowIndex)=>`<div class="nmda-inspector-mini-row${rowIndex===0?' is-head':''}" style="--preview-cols:${cols}">${Array.from({length:cols},(_,i)=>{const value=String(row?.[i]??'').trim()||'—';return `<span title="${escapeHtml(value)}">${escapeHtml(value.length>34?`${value.slice(0,34)}…`:value)}</span>`;}).join('')}</div>`).join('')}</div></div>`;
    }
    const text=rows.slice(0,8).flat().map(value=>String(value??'').trim()).filter(Boolean).join(' ').replace(/\s+/g,' ').trim();
    return `<div class="nmda-inspector-preview-block"><div class="nmda-inspector-preview-head"><strong>文件内容</strong><span>${escapeHtml(sourceFileTypeLabel(decision.file?.name||decision.sourceName))}</span></div><div class="nmda-inspector-text-preview">${escapeHtml(text?`${text.slice(0,420)}${text.length>420?'…':''}`:'暂时没有可展示的内容')}</div></div>`;
  }

  function sourceInspectorContentHtml(decision) {
    const items=decision.items||[],tasks=sourceTasksForDecision(decision);
    if(decision.purpose==='mail'&&!decision.needsReview&&tasks.length){
      const task=tasks[0],body=String(task.body||'').replace(/\s+/g,' ').trim();
      return `<div class="nmda-inspector-preview-block"><div class="nmda-inspector-preview-head"><strong>邮件内容</strong><span>${tasks.length>1?`共 ${tasks.length} 封`:'1 封邮件'}</span></div><div class="nmda-inspector-mail-fields"><div><span>收件人</span><strong>${escapeHtml(task.recipients||'尚未读取')}</strong></div><div><span>主题</span><strong>${escapeHtml(task.subject||'尚未读取')}</strong></div><div class="is-body"><span>正文</span><p>${escapeHtml(body?`${body.slice(0,520)}${body.length>520?'…':''}`:'尚未读取')}</p></div></div></div>`;
    }
    if(decision.purpose==='roster'&&!decision.needsReview)return sourceRosterPreviewHtml(decision);
    return sourceGenericPreviewHtml(decision);
  }

  function renderSourceInspector(decision) {
    const empty=$('nmda-source-inspector-empty'),card=$('nmda-source-inspector-card');if(!empty||!card)return;
    if(!decision){empty.hidden=false;card.hidden=true;return;}
    empty.hidden=true;card.hidden=false;
    const visual=sourceRoleVisual(decision.purpose,decision.needsReview),fileName=String(decision.sourceName||'').replace(/\\/g,'/').split('/').pop()||decision.sourceName;
    const title=$('nmda-source-inspector-title'),overview=$('nmda-source-inspector-overview'),content=$('nmda-source-inspector-content'),actions=$('nmda-source-inspector-actions');
    if(title)title.textContent='文件核验';
    if(overview){
      const reviewNote=decision.needsReview?`<div class="nmda-inspector-review-note"><span>!</span><div><strong>这个文件需要你决定用途</strong><small>${escapeHtml(sourceFriendlyReason(decision))}</small></div></div>`:'';
      overview.innerHTML=`<div class="nmda-inspector-file-title">${sourceFileIconHtml(fileName)}<div><strong>${escapeHtml(fileName)}</strong><small>${escapeHtml(sourceDirectoryPath(decision.sourceName)||'根目录')} · ${escapeHtml(humanFileSize(decision.file?.size))}</small></div></div>${reviewNote}`;
    }
    if(actions){
      const mountPurposeSelect=()=>{
        const selected=decision.needsReview?'review':decision.purpose;
        actions.innerHTML=`<label class="nmda-inspector-purpose-field" data-review="${decision.needsReview?'1':'0'}"><span><strong>${decision.needsReview?'请选择文件用途':'调整文件用途'}</strong><small>${decision.needsReview?'看过下方内容后选择即可':'仅当自动分类确实不对时修改'}</small></span><select data-inspector-purpose-select aria-label="修改当前文件用途">${sourcePurposeOptions(selected)}</select></label>`;
        actions.querySelector('[data-inspector-purpose-select]')?.addEventListener('change',event=>{const purpose=event.currentTarget.value;if(purpose==='review')setSourceNeedsReview(decision.sourceName);else setSourcePurpose(decision.sourceName,purpose);});
      };
      if(decision.needsReview)mountPurposeSelect();
      else{
        actions.innerHTML=`<div class="nmda-inspector-auto-purpose" data-tone="${escapeHtml(visual.tone)}"><span class="nmda-inspector-auto-purpose-icon">${escapeHtml(visual.icon)}</span><span><strong>已识别为${escapeHtml(visual.label)}</strong><small>无需选择格式；系统会按此用途继续。</small></span><button type="button" data-edit-source-purpose>分类有误</button></div>`;
        actions.querySelector('[data-edit-source-purpose]')?.addEventListener('click',mountPurposeSelect);
      }
    }
    if(content)content.innerHTML=sourceInspectorContentHtml(decision);
    const pending=uniqueFiles(batch.dataset?.sourceFiles||[]).map(sourcePurposeDecision).filter(item=>item.needsReview&&item.sourceName!==decision.sourceName),next=$('nmda-source-next-review');
    if(next){next.hidden=!pending.length;next.dataset.nextSource=pending[0]?encodeURIComponent(pending[0].sourceName):'';next.textContent=pending.length?`下一个待确认 · 还剩 ${pending.length} 个 →`:'下一个待确认 →';}
  }

  function inspectSourceInPreflight(sourceName) {
    const related=sourceCollections(sourceName,String(sourceName||'').split('/').pop()||''),primary=related.filter(({collection})=>!collection.meta?.supplemental),items=primary.length?primary:related;
    if(!items.length)return;
    batch.sourceInspectName=sourceName;
    const first=items.find(({index})=>ensureCollectionConfig(index)?.purpose==='mail')||items[0];
    collectionSelectEl.innerHTML=items.map(({collection,index})=>{const config=ensureCollectionConfig(index),kind=collectionKind(collection,config?.purpose),detection=config?.detection||Importer.detectHeader(collection.rows||[]),records=Math.max(0,(collection.rows||[]).length-detection.index-1);return `<option value="${index}" ${index===first.index?'selected':''}>${escapeHtml(collection.name)} · ${escapeHtml(kind.label)} · ${records} 条</option>`;}).join('');
    $('nmda-collection-field').hidden=items.length<=1;
    configureCollection(first.index,false);
    const diagnostics=$('nmda-ingest-diagnostics');if(diagnostics){diagnostics.hidden=true;diagnostics.open=false;}
    renderPreflightSourceRoles();
  }

  function renderPreflightSourceRoles() {
    const details=$('nmda-preflight-source-routing'),list=$('nmda-preflight-source-routing-list'),summary=$('nmda-preflight-source-routing-summary'),chips=$('nmda-preflight-routing-chips'),dirNav=$('nmda-preflight-directory-nav');
    if(!details||!list||!summary)return;
    const files=uniqueFiles(batch.dataset?.sourceFiles||[]),decisions=files.map(sourcePurposeDecision);
    batch.preflightReviewOnly=false;
    const counts={mail:0,roster:0,attachment:0,ignored:0,review:0};
    for(const decision of decisions){if(decision.needsReview)counts.review++;else counts[decision.purpose]=(counts[decision.purpose]||0)+1;}
    const visible=sourceVisibleDecisions(decisions),folder=batch.preflightFolderPath||'',folderName=folder?folder.split('/').pop():'全部文件';
    const searchInput=$('nmda-preflight-source-search');if(searchInput&&searchInput.value!==String(batch.preflightSearch||''))searchInput.value=String(batch.preflightSearch||'');
    summary.textContent='文件列表';
    const subtitle=$('nmda-preflight-source-routing-subtitle');if(subtitle)subtitle.textContent=counts.review?`有 ${counts.review} 个待确认；点击文件查看内容并修改用途。`:'分类无误可直接继续。';
    const dirTitle=$('nmda-preflight-directory-title'),dirCount=$('nmda-preflight-directory-count');if(dirTitle)dirTitle.textContent=folderName;if(dirCount)dirCount.textContent=folder?`${visible.length}`:`${decisions.length}`;
    if(chips){
      const chip=(tone,label,count,icon)=>`<button type="button" data-preflight-filter="${tone}" data-tone="${tone}" class="${batch.preflightPurposeFilter===tone?'is-active':''}"><i>${icon}</i><span>${label}</span><b>${count}</b></button>`;
      chips.innerHTML=chip('mail','邮件',counts.mail,'✉')+chip('roster','总名单',counts.roster,'名')+chip('attachment','附件',counts.attachment,'附')+chip('review','待确认',counts.review,'!')+chip('ignored','暂不使用',counts.ignored,'×');
      chips.querySelectorAll('[data-preflight-filter]').forEach(button=>button.addEventListener('click',()=>{const value=button.dataset.preflightFilter||'';batch.preflightPurposeFilter=batch.preflightPurposeFilter===value?'':value;renderPreflightSourceRoles();}));
    }
    for(const key of Object.keys(counts)){const target=$('nmda-preflight-dropzones')?.querySelector(`[data-drop-count="${key}"]`);if(target)target.textContent=counts[key]||0;}
    if(dirNav){const tree=buildSourceFolderTree(decisions);dirNav.innerHTML=`<button class="nmda-classify-folder-row nmda-classify-folder-all${!batch.preflightFolderPath?' is-active':''}" type="button" data-preflight-folder=""><span class="nmda-classify-folder-icon">▦</span><span class="nmda-classify-folder-name">全部文件</span><b>${decisions.length}</b></button>${sourceFolderNavHtml(tree)}`;dirNav.querySelectorAll('[data-preflight-folder]').forEach(button=>button.addEventListener('click',()=>{batch.preflightFolderPath=decodeURIComponent(button.dataset.preflightFolder||'');renderPreflightSourceRoles();}));}
    details.hidden=!decisions.length;
    list.innerHTML=sourceFileRowsHtml(visible);
    list.querySelectorAll('[data-inspect-source]').forEach(row=>{
      row.addEventListener('click',event=>{if(event.target.closest('[data-source-drag]'))return;event.preventDefault();inspectSourceInPreflight(decodeURIComponent(row.dataset.inspectSource||''));});
      row.addEventListener('keydown',event=>{if(event.key!=='Enter'&&event.key!==' ')return;event.preventDefault();inspectSourceInPreflight(decodeURIComponent(row.dataset.inspectSource||''));});
    });
    list.querySelectorAll('[data-source-drag]').forEach(handle=>{
      handle.addEventListener('click',event=>event.stopPropagation());
      handle.addEventListener('dragstart',event=>{const source=decodeURIComponent(handle.dataset.sourceDrag||'');batch.sourceInspectName=source;event.dataTransfer?.setData('text/plain',source);if(event.dataTransfer)event.dataTransfer.effectAllowed='move';handle.closest('.nmda-classify-file-row')?.classList.add('is-dragging');document.querySelector('.nmda-classify-dialog')?.classList.add('is-drag-classifying');});
      handle.addEventListener('dragend',()=>{handle.closest('.nmda-classify-file-row')?.classList.remove('is-dragging');document.querySelector('.nmda-classify-dialog')?.classList.remove('is-drag-classifying');});
    });
    const selected=decisions.find(item=>item.sourceName===batch.sourceInspectName);renderSourceInspector(selected||null);
  }

  function attachmentAssetRowsHtml(entries,{compact=false}={}) {
    const totalTasks=(batch.tasks||[]).filter(task=>task.enabled&&!task.policyBlocked).length;
    return (entries||[]).map(entry=>{
      const policy=entry.policy||ensureAttachmentPolicy(entry.file,entry.kind);
      const scope=policy.mode==='all'?`全部 ${totalTasks} 封`:policy.mode==='selected'?`指定 ${(policy.targets||[]).length} 封`:(entry.used?`自动匹配 ${entry.used} 封`:'自动匹配 · 尚未命中');
      const tone=policy.mode==='smart'&&!entry.used?'warn':'ok';
      const targetButton=policy.mode==='selected'?`<button class="nmda-btn nmda-btn-small nmda-btn-quiet" type="button" data-attachment-target-config="${escapeHtml(encodeURIComponent(entry.identity))}">选择邮件</button>`:'';
      return `<div class="nmda-attachment-asset-row nmda-attachment-workspace-row${compact?' is-compact':''}" data-attachment-identity="${escapeHtml(encodeURIComponent(entry.identity))}"><span class="nmda-attachment-file-icon" aria-hidden="true">↗</span><div class="nmda-attachment-file-main"><strong title="${escapeHtml(entry.file.name||'附件')}">${escapeHtml(entry.file.name||'附件')}</strong><small>${escapeHtml(formatAttachmentSize(entry.file))} · ${escapeHtml(entry.source||'附件')}</small></div><div class="nmda-attachment-scope"><label><span>适用范围</span><select data-attachment-policy="${escapeHtml(encodeURIComponent(entry.identity))}"><option value="smart" ${policy.mode==='smart'?'selected':''}>自动匹配邮件需求</option><option value="all" ${policy.mode==='all'?'selected':''}>全部邮件</option><option value="selected" ${policy.mode==='selected'?'selected':''}>指定邮件…</option></select></label><span class="nmda-attachment-scope-state" data-tone="${tone}">${escapeHtml(scope)}</span></div><div class="nmda-attachment-asset-actions">${targetButton}<button class="nmda-text-action nmda-attachment-remove" type="button" data-attachment-remove="${escapeHtml(encodeURIComponent(entry.identity))}" aria-label="移除 ${escapeHtml(entry.file.name||'附件')}">移除</button></div></div>`;
    }).join('');
  }

  function attachmentRequirementOverview(){
    const map=new Map();
    for(const task of batch.tasks||[])for(const detail of task.attachmentDetails||[]){
      const key=Importer.normalizeFileKey(detail.ref);if(!key)continue;
      if(!map.has(key))map.set(key,{key,ref:String(detail.ref),total:0,matched:0,ambiguous:0,missing:0,files:new Set()});
      const item=map.get(key);item.total++;
      if(detail.status==='matched'){item.matched++;if(detail.file?.name)item.files.add(detail.file.name);}else if(detail.status==='ambiguous')item.ambiguous++;else item.missing++;
    }
    return [...map.values()];
  }

  function attachmentRequirementRowsHtml(){
    const items=attachmentRequirementOverview();if(!items.length)return '<div class="nmda-attachment-assets-empty">当前邮件没有点名附件要求。你仍可以把附件设置为“全部邮件”或“指定邮件”。</div>';
    const pool=allAttachmentFiles();
    return items.map(item=>{
      const complete=item.matched>=item.total,tone=complete?'ok':item.ambiguous?'warn':'danger';
      const status=complete?`已覆盖 ${item.matched}/${item.total}`:`待补 ${item.total-item.matched}/${item.total}`;
      let control='';
      if(!complete&&pool.length){
        const options=pool.map(file=>`<option value="${escapeHtml(Importer.fileIdentity(file))}">${escapeHtml(file.webkitRelativePath||file._nmdaPath||file.name)}</option>`).join('');
        control=`<select data-attachment-ref="${escapeHtml(item.key)}"><option value="">使用现有附件…</option>${options}</select>`;
      }
      return `<div class="nmda-attachment-requirement-row"><div><strong>${escapeHtml(item.ref)}</strong><small>${item.files.size?`已使用：${escapeHtml([...item.files].join('、'))}`:'邮件中明确要求此附件'}</small></div><span data-tone="${tone}">${escapeHtml(status)}</span>${control}</div>`;
    }).join('');
  }

  function renderAttachmentTargetEditor(){
    const wrap=$('nmda-attachment-target-editor'),list=$('nmda-attachment-target-list'),title=$('nmda-attachment-target-title'),search=$('nmda-attachment-target-search');if(!wrap||!list)return;
    const identity=batch.attachmentTargetEditing||'',file=allAttachmentFiles().find(item=>Importer.fileIdentity(item)===identity);
    if(!file){wrap.hidden=true;return;}
    const policy=ensureAttachmentPolicy(file,attachmentKindForFile(file));if(policy.mode!=='selected'){wrap.hidden=true;return;}
    wrap.hidden=false;if(title)title.textContent=`${file.name} · 指定邮件`;if(search&&search.value!==String(batch.attachmentTargetSearch||''))search.value=String(batch.attachmentTargetSearch||'');
    const q=normalizedSearchText(batch.attachmentTargetSearch||''),targets=new Set(policy.targets||[]);
    const tasks=(batch.tasks||[]).filter(task=>!q||normalizedSearchText([task.recipients,task.subject,task.school].join(' ')).includes(q));
    list.innerHTML=tasks.length?tasks.map(task=>`<label class="nmda-attachment-target-row"><input type="checkbox" data-attachment-target-task="${escapeHtml(encodeURIComponent(task.editKey))}" ${targets.has(task.editKey)?'checked':''}><span><strong>${escapeHtml(task.recipients||'未填写收件人')}</strong><small>${escapeHtml(task.subject||'无主题')}${task.school?` · ${escapeHtml(task.school)}`:''}</small></span></label>`).join(''):'<div class="nmda-attachment-assets-empty">没有匹配当前搜索的邮件。</div>';
    list.querySelectorAll('[data-attachment-target-task]').forEach(input=>input.addEventListener('change',()=>setAttachmentTarget(identity,decodeURIComponent(input.dataset.attachmentTargetTask||''),input.checked)));
  }

  function renderAttachmentAssetViews() {
    const entries=attachmentAssetEntries(),count=entries.length;
    const inline=$('nmda-preflight-attachment-assets'),inlineList=$('nmda-preflight-attachment-assets-list'),inlineCount=$('nmda-preflight-attachment-assets-count');
    if(inline){inline.hidden=!count;if(inlineList)inlineList.innerHTML=count?`<button class="nmda-attachment-assets-more" type="button" data-open-attachment-manager>${count} 个附件 · 打开工作台查看配置</button>`:'';if(inlineCount)inlineCount.textContent=`${count} 个`;}
    const manager=$('nmda-attachment-manager-overlay'),list=$('nmda-attachment-manager-list'),empty=$('nmda-attachment-manager-empty'),summary=$('nmda-attachment-manager-summary'),fileCount=$('nmda-attachment-manager-file-count');
    if(manager){manager.hidden=!batch.attachmentManagerOpen;manager.setAttribute('aria-hidden',batch.attachmentManagerOpen?'false':'true');}
    if(list)list.innerHTML=attachmentAssetRowsHtml(entries);
    if(fileCount)fileCount.textContent=`${count} 个`;
    if(empty)empty.hidden=!!count;
    const stats=typeof importAttachmentStats==='function'?importAttachmentStats():{total:0,matched:0,issues:0};
    const modes={smart:0,all:0,selected:0};for(const entry of entries)modes[entry.policy?.mode||'smart']=(modes[entry.policy?.mode||'smart']||0)+1;
    if(summary)summary.innerHTML=`<span><strong>${count}</strong><small>附件文件</small></span><span><strong>${stats.matched||0}/${stats.total||0}</strong><small>邮件要求已覆盖</small></span><span data-tone="${stats.issues?'warn':'ok'}"><strong>${stats.issues||0}</strong><small>仍待补</small></span><span><strong>${modes.smart}/${modes.all}/${modes.selected}</strong><small>自动 / 全部 / 指定</small></span>`;
    const req=$('nmda-attachment-manager-requirements'),reqCount=$('nmda-attachment-manager-requirements-count');if(req)req.innerHTML=attachmentRequirementRowsHtml();if(reqCount)reqCount.textContent=`${stats.total||0} 项`;
    list?.querySelectorAll('[data-attachment-policy]').forEach(select=>select.addEventListener('change',()=>{const id=decodeURIComponent(select.dataset.attachmentPolicy||'');setAttachmentPolicy(id,select.value);if(select.value==='selected'){batch.attachmentTargetEditing=id;batch.attachmentTargetSearch='';renderAttachmentAssetViews();}}));
    list?.querySelectorAll('[data-attachment-target-config]').forEach(button=>button.addEventListener('click',()=>{batch.attachmentTargetEditing=decodeURIComponent(button.dataset.attachmentTargetConfig||'');batch.attachmentTargetSearch='';renderAttachmentAssetViews();}));
    req?.querySelectorAll('select[data-attachment-ref]').forEach(select=>select.addEventListener('change',()=>{const file=allAttachmentFiles().find(item=>Importer.fileIdentity(item)===select.value);if(file)batch.attachmentOverrides.set(select.dataset.attachmentRef,file);else batch.attachmentOverrides.delete(select.dataset.attachmentRef);rebuildTasks();renderAttachmentAssetViews();}));
    renderAttachmentTargetEditor();syncModalState();
  }

  function openAttachmentManager() { batch.attachmentManagerOpen=true;renderAttachmentAssetViews(); }
  function closeAttachmentManager() { batch.attachmentManagerOpen=false;batch.attachmentTargetEditing='';batch.attachmentTargetSearch='';renderAttachmentAssetViews(); }

  function removeAttachmentAsset(identity) {
    if(!identity)return;
    const keep=file=>Importer.fileIdentity(file)!==identity;
    batch.ignoredAttachmentIdentities.add(identity);
    batch.directoryFiles=(batch.directoryFiles||[]).filter(keep);batch.taskFiles=(batch.taskFiles||[]).filter(keep);batch.routedAttachmentFiles=(batch.routedAttachmentFiles||[]).filter(keep);batch.sharedFiles=(batch.sharedFiles||[]).filter(keep);
    batch.attachmentPolicies?.delete(identity);if(batch.attachmentTargetEditing===identity)batch.attachmentTargetEditing='';
    batch.attachmentPrepChoice=attachmentPreparedFileCount()?'added':(batch.supplementPreflightDone?'skipped':'pending');
    refreshFileIndex(false);renderSupplementPreflight();renderAttachmentAssetViews();
  }

  function clearAttachmentAssets() {
    for(const file of batch.routedAttachmentFiles||[])batch.ignoredAttachmentIdentities.add(Importer.fileIdentity(file));
    if(dirEl)dirEl.value='';if(taskFilesEl)taskFilesEl.value='';if(sharedFilesEl)sharedFilesEl.value='';if(preSendMatchFilesEl)preSendMatchFilesEl.value='';if(preSendSharedFilesEl)preSendSharedFilesEl.value='';
    batch.directoryFiles=[];batch.taskFiles=[];batch.routedAttachmentFiles=[];batch.sharedFiles=[];batch.attachmentOverrides.clear();batch.attachmentPolicies=new Map();batch.attachmentTargetEditing='';
    batch.attachmentPrepChoice=batch.supplementPreflightDone?'skipped':'pending';refreshFileIndex(true);renderSupplementPreflight();renderAttachmentAssetViews();
  }

  function renderBatchPrepStrip() {
    const strip=$('nmda-batch-prep-strip');if(!strip)return;
    const hasBatch=!!batch.dataset&&!!(batch.tasks||[]).length;strip.hidden=!hasBatch;if(!hasBatch)return;
    const roster=$('nmda-prep-roster-state'),attachment=$('nmda-prep-attachment-state');
    const rState=rosterContextState(),aState=attachmentPreflightState(),rCount=referenceRosterCount(),aCount=attachmentPreparedFileCount(),stats=typeof importAttachmentStats==='function'?importAttachmentStats():{total:0,issues:0};
    if(roster){roster.dataset.state=rState;const strong=roster.querySelector('strong');if(strong)strong.textContent=rState==='added'?`${rCount} 条已加入`:rState==='skipped'?'未添加':'待确认';}
    if(attachment){attachment.dataset.state=aState;const strong=attachment.querySelector('strong');if(strong)strong.textContent=aCount?`${aCount} 个附件${stats.issues?` · ${stats.issues} 待匹配`:''}`:stats.issues?`${stats.issues} 项待补`:aState==='skipped'?'暂未添加':'待确认';}
    const manage=$('nmda-manage-attachments-strip');if(manage){manage.hidden=!aCount&&!stats.issues;manage.textContent=aCount?'查看 / 修改':'准备附件';}
    const button=$('nmda-edit-batch-prep');if(button)button.textContent=supplementPreflightNeedsDecision()?'继续准备':'补充资料';
  }

  function setPlanningView(view = 'rules') {
    const next=view==='mails'?'mails':'rules';
    batch.planningView=next;
    const card=$('nmda-preview-card');
    if(card)card.dataset.planningView=next;
    ui.querySelectorAll('[data-planning-view]').forEach(button=>{
      const active=button.dataset.planningView===next;
      button.classList.toggle('is-active',active);
      button.setAttribute('aria-current',active?'page':'false');
    });
  }

  function openScheduleModal() {
    if(!batch.handoffComplete || !(batch.tasks||[]).length){
      setBatchStatus('先完成邮件核验，再设置排期。','warn');
      return;
    }
    renderScheduleCenter();
    const overlay=$('nmda-schedule-modal');
    if(!overlay)return;
    overlay.hidden=false;
    syncModalState();
    requestAnimationFrame(()=>scheduleStartEl?.focus?.({preventScroll:true}));
  }

  function closeScheduleModal({restoreFocus=true} = {}) {
    const overlay=$('nmda-schedule-modal');
    if(!overlay || overlay.hidden)return;
    overlay.hidden=true;
    syncModalState();
    if(restoreFocus)requestAnimationFrame(()=>$('nmda-open-schedule-modal')?.focus?.({preventScroll:true}));
  }

  function setPreflightView(view = 'files') {
    const next=view==='support'?'support':'files';
    batch.preflightView=next;
    const workspace=$('nmda-supplement-preflight')?.querySelector('.nmda-classify-workspace');
    if(workspace)workspace.dataset.preflightView=next;
    ui.querySelectorAll('[data-preflight-view]').forEach(button=>{
      const active=button.dataset.preflightView===next;
      button.classList.toggle('is-active',active);
      button.setAttribute('aria-current',active?'step':'false');
    });
    ui.querySelectorAll('[data-preflight-panel]').forEach(panel=>{
      panel.hidden=panel.dataset.preflightPanel!==next;
    });
    const button=$('nmda-complete-supplement-preflight');
    if(button&&!button.textContent.includes('待确认'))button.textContent=next==='support'?'完成并继续 →':'继续 →';
  }

  function setSupportView(view = 'roster') {
    const next=view==='attachment'?'attachment':'roster';
    batch.supportView=next;
    const support=$('nmda-supplement-preflight')?.querySelector('.nmda-classify-support-view');
    if(support)support.dataset.supportView=next;
    ui.querySelectorAll('button[data-support-view]').forEach(button=>{
      const active=button.dataset.supportView===next;
      button.classList.toggle('is-active',active);
      button.setAttribute('aria-current',active?'page':'false');
    });
    ui.querySelectorAll('[data-support-pane]').forEach(pane=>{pane.hidden=pane.dataset.supportPane!==next;});
  }

  function renderSupplementPreflight() {
    const overlay=$('nmda-supplement-preflight');if(!overlay)return;
    const hasBatch=!!batch.dataset,visible=hasBatch&&!!batch.supplementPreflightOpen;
    overlay.hidden=!visible;overlay.setAttribute('aria-hidden',visible?'false':'true');syncModalState();
    renderBatchPrepStrip();
    if(!hasBatch)return;
    const sourceDecisions=uniqueFiles(batch.dataset?.sourceFiles||[]).map(sourcePurposeDecision),reviewCount=sourceDecisions.filter(item=>item.needsReview).length,taskCount=(batch.tasks||[]).length;
    const headIcon=overlay.querySelector('.nmda-supplement-head-icon'),kicker=overlay.querySelector('.nmda-supplement-kicker'),title=$('nmda-supplement-title');
    if(headIcon){const attention=!taskCount||reviewCount>0;headIcon.dataset.state=attention?'review':'ok';headIcon.textContent=attention?'!':'✓';}
    if(kicker)kicker.textContent=reviewCount?`${reviewCount} 个文件待确认`:'文件用途已整理';
    if(title)title.textContent='检查导入结果';
    const rosterBox=$('nmda-preflight-roster-box'),attachmentBox=$('nmda-preflight-attachment-box'),supplements=$('nmda-preflight-supplements');
    if(rosterBox)rosterBox.hidden=false;if(attachmentBox)attachmentBox.hidden=false;if(supplements)supplements.hidden=false;
    setPreflightView(batch.preflightView||'files');
    setSupportView(batch.supportView||'roster');
    const completeButton=$('nmda-complete-supplement-preflight');if(completeButton)completeButton.textContent=reviewCount?`处理完 ${reviewCount} 个待确认后继续 →`:batch.preflightView==='support'?'完成并继续 →':'继续 →';

    const rState=rosterContextState(),rCount=referenceRosterCount();
    const rBox=$('nmda-preflight-roster-box'),rTitle=$('nmda-preflight-roster-title'),rCopy=$('nmda-preflight-roster-copy'),rStatus=$('nmda-preflight-roster-status'),rSkip=$('nmda-preflight-roster-skip');
    if(rBox)rBox.dataset.state=rState;
    if(rTitle)rTitle.textContent=rState==='added'?`参考总名单 · ${rCount} 条`:'参考总名单';
    if(rCopy)rCopy.textContent=rState==='added'?'名单已加入。':'已有总名单时可加入。';
    if(rStatus)rStatus.textContent=rState==='added'?`已加入 ${rCount} 条`:rState==='skipped'?'本批次未使用':'尚未添加';
    if(rSkip){rSkip.hidden=rState==='added';rSkip.textContent=rState==='skipped'?'已跳过':'跳过';}

    const stats=typeof importAttachmentStats==='function'?importAttachmentStats():{total:0,matched:0,issues:0};
    const aState=attachmentPreflightState(),aCount=attachmentPreparedFileCount(),refs=attachmentRequirementRefs();
    const aBox=$('nmda-preflight-attachment-box'),aTitle=$('nmda-preflight-attachment-title'),aCopy=$('nmda-preflight-attachment-copy'),aStatus=$('nmda-preflight-attachment-status'),aReq=$('nmda-preflight-attachment-requirements'),aSkip=$('nmda-preflight-attachment-skip');
    if(aBox)aBox.dataset.state=aState;
    if(aTitle)aTitle.textContent=stats.total?`附件工作台 · ${stats.total} 项邮件要求`:'附件工作台';
    if(aCopy)aCopy.textContent=stats.total?`统一查看文件、匹配状态和发送范围。`:'需要附件时直接在工作台拖入并配置。';
    if(aReq){aReq.innerHTML=refs.length?refs.slice(0,3).map(ref=>`<span>${escapeHtml(ref)}</span>`).join('')+(refs.length>3?`<span>+${refs.length-3}</span>`:''):'';aReq.hidden=!refs.length;}
    if(aStatus)aStatus.textContent=aCount?`${aCount} 个文件${stats.issues?` · ${stats.issues} 项待处理`:' · 当前要求已覆盖'}`:aState==='skipped'?'本批次暂未添加':stats.issues?`${stats.issues} 项待补`:'尚未添加';
    if(aSkip){aSkip.hidden=!!aCount;aSkip.textContent=aState==='skipped'?'已跳过':'暂不添加';}

    renderAttachmentAssetViews();renderPreflightSourceRoles();
    const batchSummary=$('nmda-preflight-batch-summary');if(batchSummary){const currentTaskCount=(batch.tasks||[]).length;batchSummary.textContent=reviewCount?`${reviewCount} 个文件待确认`:currentTaskCount?'分类已确认，可以继续':'还没有识别到邮件，请调整文件用途';}
    if(visible&&!batch.sourceInspectName&&sourceDecisions.length&&window.matchMedia('(min-width: 821px)').matches){const first=sourceDecisions.find(item=>item.needsReview)||sourceDecisions[0];requestAnimationFrame(()=>{if(batch.supplementPreflightOpen&&!batch.sourceInspectName)inspectSourceInPreflight(first.sourceName);});}
  }

  function openSupplementPreflight(view = 'files') {
    if(!batch.dataset)return;
    batch.preflightView=view==='support'?'support':'files';
    batch.supplementPreflightOpen=true;
    renderSupplementPreflight();
  }

  function completeSupplementPreflight() {
    if(!batch.dataset)return;
    if(rosterContextState()==='pending')batch.rosterPromptChoice='skipped';
    if(attachmentPreflightState()==='pending')batch.attachmentPrepChoice='skipped';
    batch.supplementPreflightDone=true;batch.supplementPreflightOpen=false;
    renderImportLifecycleState();scheduleBatchRender({aux:true,force:true});
    const mailPending=typeof reviewTasks==='function'?reviewTasks().length:0;
    const stats=typeof importAttachmentStats==='function'?importAttachmentStats():{issues:0};
    const hasTasks=!!(batch.tasks||[]).length;
    setImportStatus(!hasTasks?'核验已完成，但当前仍没有可创建邮件。可继续调整资料用途或追加邮件资料。':mailPending||stats.issues?'批次资料已准备。现在继续处理邮件与附件待办。':'批次资料已准备，正在进入选择与安排。',!hasTasks?'warn':'ok');
    if(!hasTasks)return;
    batch.uiStep=2;
    renderProcessGuide();
    openReviewWorkspace({returnStep:2,pendingOnly:false});
    const missingCount=missingSubjectTasks().length;
    if(missingCount>=3)setImportStatus(`批次资料已准备。检测到 ${missingCount} 封邮件缺少主题，可先一键补齐，再处理其余待办。`,'warn');
    else if(mailPending||stats.issues)setImportStatus('批次资料已准备。先在邮件状态主界面处理待办；点击具体邮件时才打开完整审阅。','ok');
    else setImportStatus('批次资料已准备。已进入邮件状态主界面，可快速抽查后继续选择与安排。','ok');
    requestAnimationFrame(()=>openBulkSubjectPrompt({auto:true}));
  }

  function renderRosterContextCue() {
    const cue=$('nmda-roster-context-cue');if(!cue)return;
    const state=rosterContextState();cue.dataset.state=state;
    const eyebrow=$('nmda-roster-context-eyebrow'),title=$('nmda-roster-context-title'),copy=$('nmda-roster-context-copy'),status=$('nmda-roster-source-status'),upload=$('nmda-roster-upload-action'),skip=$('nmda-roster-skip'),remove=$('nmda-roster-remove'),benefits=$('nmda-roster-context-benefits');
    const count=referenceRosterCount();
    if(status)status.hidden=true;
    if(benefits)benefits.hidden=true;
    if(upload){upload.classList.toggle('nmda-btn-primary',state==='pending'||state==='prepare');upload.classList.toggle('nmda-btn-quiet',state==='added'||state==='skipped');}
    if(state==='prepare'){
      if(eyebrow)eyebrow.textContent='可选 · 参考名单';
      if(title)title.textContent='有参考总名单？可以一起加入';
      if(copy)copy.textContent='有名单可一起加入；没有也可以继续。';
      if(upload)upload.textContent='上传参考总名单';
      if(skip)skip.hidden=true;if(remove)remove.hidden=true;
    }else if(state==='pending'){
      if(eyebrow)eyebrow.textContent='可选增强';
      if(title)title.textContent='参考总名单可减少重复联系';
      if(copy)copy.textContent='有名单就加入；没有可直接跳过。';
      if(upload)upload.textContent='上传总名单';
      if(skip){skip.hidden=false;skip.textContent='暂不添加';}if(remove)remove.hidden=true;
    }else if(state==='added'){
      if(eyebrow)eyebrow.textContent='已加入';
      if(title)title.textContent=`参考总名单 · ${count} 条`;
      if(copy)copy.textContent='已加入本批次。';
      if(upload)upload.textContent='补充名单';
      if(skip)skip.hidden=true;if(remove){remove.hidden=false;remove.textContent='移除';}
    }else{
      if(eyebrow)eyebrow.textContent='已跳过';
      if(title)title.textContent='未使用参考总名单';
      if(copy)copy.textContent='需要时可随时补充。';
      if(upload)upload.textContent='补充名单';
      if(skip)skip.hidden=true;if(remove)remove.hidden=true;
    }
  }

  function renderAttachmentContextCue() {
    const cue=$('nmda-attachment-context-cue');if(!cue)return;
    const stats=typeof importAttachmentStats==='function'?importAttachmentStats():{total:0,matched:0,issues:0};
    const contextPending=typeof supplementPreflightNeedsDecision==='function'&&supplementPreflightNeedsDecision();
    const shouldShow=!!batch.dataset && stats.total>0 && stats.issues>0 && !batch.attachmentPromptDeferred && !contextPending;
    cue.hidden=!shouldShow;
    const bar=$('nmda-attachment-library-bar'),barTitle=$('nmda-attachment-library-bar-title'),barCopy=$('nmda-attachment-library-bar-copy'),prepared=attachmentPreparedFileCount();
    const showBar=!!batch.dataset&&!contextPending&&!shouldShow&&(prepared>0||stats.total>0);
    if(bar)bar.hidden=!showBar;
    if(showBar){if(barTitle)barTitle.textContent=`附件工作台 · ${prepared} 个文件`;if(barCopy)barCopy.textContent=stats.total?`邮件附件要求已覆盖 ${Math.max(0,stats.total-stats.issues)}/${stats.total}；发送范围可逐个文件调整。`:'附件发送范围可随时在同一工作台调整。';}
    if(!shouldShow)return;
    const title=$('nmda-attachment-context-title'),copy=$('nmda-attachment-context-copy'),later=$('nmda-attachment-later'),sendAction=$('nmda-attachment-send-action'),dirAction=$('nmda-attachment-dir-action');
    const mailPending=typeof reviewTasks==='function'&&reviewTasks().length>0;
    if(sendAction){sendAction.classList.add('nmda-btn-primary');sendAction.classList.remove('nmda-btn-quiet');}
    if(dirAction){dirAction.classList.remove('nmda-btn-primary');dirAction.classList.add('nmda-btn-quiet');}
    if(title)title.textContent=`还有 ${stats.issues} 项附件要求待处理`;
    if(copy)copy.textContent=mailPending
      ? `这是创建前必须完成的待办。打开附件工作台，拖入文件并确认每个文件的适用范围。`
      : `这是当前最后一项待办。补齐附件要求后会自动进入“选择与安排”。`;
    if(later)later.hidden=!mailPending;
  }

  function renderImportLifecycleState() {
    if (typeof renderProcessGuide === 'function') renderProcessGuide();
    const active = !!batch.dataset || !!batch.importBusy || !!batch.roster?.entries?.length;
    if (resetImportEl) resetImportEl.hidden = !active;
    if (importBusyBadgeEl) importBusyBadgeEl.hidden = !batch.importBusy;
    const sourceCard = $('nmda-import-card');
    if (sourceCard) {
      sourceCard.dataset.busy = batch.importBusy ? '1' : '0';
      sourceCard.dataset.loaded = batch.dataset ? '1' : '0';
      const title = $('nmda-import-card-title');
      const desc = $('nmda-import-card-desc');
      if (title) title.textContent = batch.dataset ? '邮件资料已导入' : '导入邮件资料';
      if (desc) desc.textContent = batch.dataset
        ? '邮件资料已加入，可继续添加或进入批次资料。'
        : '把本批次邮件资料放进来。';
      const fileAction=ui.querySelector('label.nmda-source-action[for="nmda-import-file"] strong');
      const dirAction=ui.querySelector('label.nmda-source-action[for="nmda-import-dir"] strong');
      const pasteAction=$('nmda-show-paste')?.querySelector('strong');
      if(fileAction)fileAction.textContent=batch.dataset?'添加文件':'选择文件';
      if(dirAction)dirAction.textContent=batch.dataset?'添加文件夹':'选择文件夹';
      if(pasteAction)pasteAction.textContent=batch.dataset?'粘贴补充':'粘贴内容';
    }
    const workbench = ui.querySelector('.nmda-bulk-workbench');
    if (workbench) {
      workbench.dataset.phase = !batch.dataset ? 'empty' : (batch.handoffComplete ? 'ready' : 'review');
      if(!batch.dataset)batch.uiStep=1;
    }
    const prepButton=$('nmda-open-supplement-preflight');if(prepButton)prepButton.hidden=!batch.dataset;
    renderRosterContextCue();
    renderAttachmentContextCue();
    renderBatchPrepStrip();
    renderSupplementPreflight();
    renderAttachmentAssetViews();
  }

  function beginImportSession(message) {
    // The reference roster is an independent master-data source. Replacing the mail source keeps it;
    // only explicit ‘重新开始’ / ‘移除总名单’ clears the reference source.
    const previousRoster=rosterState();
    const keepRoster = previousRoster.manualEntries?.length ? emptyRosterState({
      dataset:previousRoster.dataset,manualEntries:[...previousRoster.manualEntries],entries:[...previousRoster.manualEntries],manualWarnings:[...(previousRoster.manualWarnings||[])],warnings:[...(previousRoster.manualWarnings||[])],manualSourceNames:[...(previousRoster.manualSourceNames||[])],sourceNames:[...(previousRoster.manualSourceNames||[])],enabled:previousRoster.enabled!==false,autoSchool:previousRoster.autoSchool!==false,strict:!!previousRoster.strict
    }) : null;
    resetImportWorkspace({ keepStatus: true, invalidate: true });
    if (keepRoster) {
      batch.roster = keepRoster;
      batch.rosterPromptChoice='added';
      syncRosterParts();
      renderRosterAudit();
    }
    const token = batch.sessionId;
    batch.importBusy = true;
    if(schedulerCardEl)schedulerCardEl.open=true;
    if(schedulerToggleLabelEl)schedulerToggleLabelEl.textContent='收起';
    renderImportLifecycleState();
    setImportStatus(message || '正在读取来源…');
    return token;
  }

  function finishImportSession(token) {
    if (!isCurrentBatchSession(token)) return false;
    batch.importBusy = false;
    renderImportLifecycleState();
    return true;
  }

  function recordSets() { return batch.dataset?.recordSets || batch.dataset?.sheets || []; }

  function currentCollection() { return recordSets()[batch.collectionIndex] || null; }

  function ensureCollectionConfig(index, { reset = false } = {}) {
    const collection = recordSets()[Number(index) || 0];
    if (!collection) return null;
    let config = batch.collectionConfigs.get(Number(index) || 0);
    if (!config || reset) {
      const detection = Importer.detectHeader(collection.rows || []);
      const classified=String(collection.meta?.sourcePurpose||'ambiguous');
      const purpose=['mail','roster','attachment','ignored'].includes(classified)?classified:'ignored';
      config = { purpose, enabled: purpose==='mail', detection, mapping: { ...detection.mapping }, profileSuggestion: null };
      batch.collectionConfigs.set(Number(index) || 0, config);
    }
    return config;
  }

  function taskEditKey(collectionIndex, rowIndex) { return `${collectionIndex}:${rowIndex}`; }

  function sourceFileName(file) {
    return String(file?.webkitRelativePath || file?._nmdaPath || file?.name || '未命名来源');
  }

  function humanFileSize(bytes) {
    const n = Number(bytes || 0);
    if (!n) return '—';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
    return `${(n / 1024 / 1024).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  }

  function formatDisplayName(format) {
    const map = {
      'xlsx':'Excel / XLSX', 'ods':'OpenDocument / ODS', 'fods':'Flat ODS',
      'docx':'Word / DOCX', 'json':'JSON', 'ndjson':'JSONL / NDJSON',
      'delimited':'分隔文本', 'vertical-text':'字段式文本', 'html':'HTML 表格',
      'spreadsheetml':'Excel XML', 'mail-text':'邮件文本', 'mailbox-drafts':'网易草稿箱', 'attachment':'附件资料', 'nmda-zip':'ZIP 批次', 'multi':'混合来源'
    };
    return map[String(format || '').toLowerCase()] || String(format || '自动识别').toUpperCase();
  }

  function collectionKind(collection,overridePurpose='') {
    const meta = collection?.meta || {};
    const format = String(meta.format || batch.dataset?.format || '').toLowerCase();
    const purpose=String(overridePurpose||meta.sourcePurpose||'');
    if(purpose==='roster')return {label:'总名单',icon:'人',tone:'roster'};
    if(purpose==='attachment')return {label:'附件候选',icon:'⇧',tone:'attachment'};
    if(purpose==='ignored')return {label:'未使用资料',icon:'—',tone:'ignored'};
    if(purpose==='ambiguous')return {label:'待分类资料',icon:'?',tone:'ambiguous'};
    if (meta.mailboxDrafts) return { label:'草稿箱邮件', icon:'✉', tone:'mail' };
    if (meta.mailFrames) return { label:'邮件内容', icon:'✉', tone:'mail' };
    if(purpose==='mail')return {label:'邮件任务',icon:'✉',tone:'mail'};
    if (meta.word) {
      if (meta.merged) return { label:'Word 邮件批次', icon:'W', tone:'word' };
      if (meta.kind === 'table') return { label:'Word 表格', icon:'W', tone:'word' };
      if (meta.kind === 'records') return { label:'Word 字段记录', icon:'W', tone:'word' };
      if (meta.kind === 'document') return { label:'Word 文档邮件', icon:'W', tone:'word' };
      return { label:'Word 内容', icon:'W', tone:'word' };
    }
    if (format.includes('json')) return { label:'JSON 记录', icon:'{}', tone:'json' };
    if (format === 'vertical-text') return { label:'字段式文本', icon:'¶', tone:'text' };
    if (format === 'delimited') return { label:'文本记录', icon:'≡', tone:'text' };
    if (format === 'html') return { label:'HTML 表格', icon:'<>', tone:'web' };
    if (format === 'spreadsheetml') return { label:'XML 记录', icon:'XML', tone:'xml' };
    if (meta.package) return { label:'批次包内容', icon:'ZIP', tone:'package' };
    if (['xlsx','ods','fods'].includes(format)) return { label:'表格记录', icon:'▦', tone:'table' };
    return { label:'标准化记录', icon:'◇', tone:'default' };
  }

  function renderSourceInventory() {
    const box = $('nmda-source-inventory');
    if (!box) return;
    const dataset = batch.dataset;
    if (!dataset) { box.hidden = true; box.innerHTML = ''; return; }
    const sets = recordSets();
    const sources = [...(dataset.sourceFiles || [])];
    const containerFiles=[...(dataset.meta?.containerFiles||[])];
    const duplicateSourceCount=Number(dataset.meta?.duplicateSourceCount||0);
    const embeddedCount = (dataset.embeddedFiles || []).length;
    const warnings = dataset.warnings || [];
    const purposeLabel=purpose=>({mail:'邮件',roster:'参考名单',attachment:'附件',ignored:'未使用'}[purpose]||'未使用');
    const sourceRows = sources.length ? sources.map((file, index) => {
      const name = sourceFileName(file);
      const related = sets.map((rs,setIndex)=>({rs,setIndex})).filter(({rs}) => {
        const members=rs.meta?.sourceMembers||[];return String(rs.source||'')===String(file.name||'')||String(rs.source||'')===name||members.includes(file.name)||members.includes(name);
      });
      const purposes=[...new Set(related.map(({setIndex})=>ensureCollectionConfig(setIndex)?.purpose||'ignored'))];
      const formats = [...new Set(related.map(({rs}) => rs.meta?.format).filter(Boolean))];
      const format = formats.length ? formats.map(formatDisplayName).join(' + ') : formatDisplayName(dataset.format);
      const roleText=purposes.length?purposes.map(purposeLabel).join(' + '):'来源文件';
      const firstRelated=related.find(({rs})=>!rs.meta?.supplemental)||related[0];const kind=collectionKind(firstRelated?.rs,firstRelated?ensureCollectionConfig(firstRelated.setIndex)?.purpose:'ignored');
      const confidence=Number(firstRelated?.rs?.meta?.purposeConfidence||0),decision=confidence?` · ${roleConfidenceText(confidence)}`:'';
      return `<div class="nmda-source-item"><div class="nmda-source-item-icon">${escapeHtml(kind.icon)}</div><div class="nmda-source-item-main"><strong title="${escapeHtml(name)}">${escapeHtml(name)}</strong><small>${escapeHtml(format)} · ${humanFileSize(file.size)}${escapeHtml(decision)}</small></div><span class="nmda-source-purpose" data-purpose="${escapeHtml(purposes[0]||'ignored')}">${escapeHtml(roleText)}</span><span class="nmda-source-item-index">${index + 1}</span></div>`;
    }).join('') : `<div class="nmda-source-item"><div class="nmda-source-item-icon">◇</div><div class="nmda-source-item-main"><strong>粘贴内容</strong><small>${escapeHtml(formatDisplayName(dataset.format))}</small></div></div>`;
    const fileCount=sources.length || (containerFiles.length?0:1);
    const taskCount=(batch.tasks||[]).length;
    const rosterCount=referenceRosterCount();
    const attachmentStats=typeof importAttachmentStats==='function'?importAttachmentStats():{total:0,issues:0};
    const summaryParts=[containerFiles.length?`资料包 ${containerFiles.length} 个`:'',fileCount?`内容文件 ${fileCount} 个`:'',taskCount?`${taskCount} 封邮件`:''];
    if(rosterCount)summaryParts.push(`参考名单 ${rosterCount} 条`);
    if(duplicateSourceCount)summaryParts.push(`已忽略 ${duplicateSourceCount} 个重复副本`);
    if(attachmentStats.issues)summaryParts.push(`${attachmentStats.issues} 个附件待补`);
    const containerHtml=containerFiles.length?`<div class="nmda-source-container-note"><span>ZIP</span><div><strong>${escapeHtml(containerFiles.map(file=>file.name||'资料包').join('、'))}</strong><small>已自动展开；资料包只是容器，不参与“邮件 / 总名单 / 附件”用途选择。</small></div></div>`:'';
    const dedupeHtml=duplicateSourceCount?`<div class="nmda-source-detail-note is-dedupe">检测到 ${duplicateSourceCount} 个内容完全相同的重复来源，已在解析前自动合并，不会进入邮件查重。</div>`:'';
    const warningHtml = warnings.length ? `<details class="nmda-ingest-warnings"><summary>读取细节（${warnings.length}）</summary>${warnings.slice(0,20).map(w => `<div>${escapeHtml(w)}</div>`).join('')}${warnings.length > 20 ? `<div>另有 ${warnings.length - 20} 条未展开。</div>` : ''}</details>` : '';
    box.innerHTML = `<details class="nmda-source-inventory-details"><summary><span><strong>导入详情</strong><small>${summaryParts.filter(Boolean).join(' · ')}</small></span><span class="nmda-source-inventory-open">查看</span></summary>${containerHtml}<div class="nmda-source-list">${sourceRows}</div>${dedupeHtml}${embeddedCount?`<div class="nmda-source-detail-note">已从资料包中加入 ${embeddedCount} 个附件文件。</div>`:''}${warningHtml}</details>`;
    box.hidden = false;
  }

  function renderCollectionList() {
    const box = $('nmda-collection-list');
    if (!box) return;
    const sets = recordSets();
    const focus=String(batch.sourceInspectName||'');
    const visible=sets.map((collection,index)=>({collection,index})).filter(({collection})=>!focus||collectionMatchesSource(collection,focus,focus.split('/').pop()||''));
    box.innerHTML = visible.map(({collection,index}) => {
      const config = ensureCollectionConfig(index);
      const kind = collectionKind(collection,config?.purpose);
      const detection = config?.detection || Importer.detectHeader(collection.rows || []);
      const count = Math.max(0, (collection.rows || []).length - detection.index - 1);
      const active = index === batch.collectionIndex;
      const scan = collection.meta?.mailScan;
      const detail = config?.purpose==='mail'&&collection.meta?.mailFrames && scan
        ? `${kind.label} · ${scan.records || count} 封 · ${scan.complete || 0} 可用 · ${scan.missingRecipients || 0} 待补邮箱`
        : `${kind.label} · ${count} 条记录${collection.meta?.sourcePurpose==='ambiguous'&&config?.purpose==='ignored'?' · 自动识别未采用':''}`;
      const option=(value,label)=>`<option value="${value}" ${config?.purpose===value?'selected':''}>${label}</option>`;
      const purposeControl=focus?'':`<label class="nmda-source-purpose-control"><span class="sr-only">资料用途</span><select data-source-purpose="${index}">${option('mail','作为邮件')}${option('roster','作为总名单')}${option('attachment','作为附件候选')}${option('ignored','暂不使用')}</select></label>`;
      return `<div class="nmda-collection-row ${active ? 'is-active' : ''}" data-purpose="${escapeHtml(config?.purpose||'ignored')}"><span class="nmda-collection-kind">${escapeHtml(kind.icon)}</span><span class="nmda-collection-main"><strong>${escapeHtml(collection.name || `内容 ${index + 1}`)}</strong><small>${escapeHtml(detail)}</small></span>${purposeControl}<button type="button" class="nmda-btn nmda-btn-small" data-inspect-collection="${index}">${active ? '正在查看' : '查看'}</button></div>`;
    }).join('')||'<div class="nmda-empty-inline">这个文件没有可展开的结构化内容。</div>';
    box.querySelectorAll('[data-source-purpose]').forEach(input => input.addEventListener('change', () => {
      const index = Number(input.dataset.sourcePurpose);
      const config = ensureCollectionConfig(index);
      if (!config) return;
      config.purpose=input.value;config.enabled=config.purpose==='mail';
      batch.handoffComplete=false;
      syncRoutedSources();refreshFileIndex(false);configureCollection(index,false);renderSourceInventory();renderCollectionList();renderPreflightSourceRoles();
    }));
    box.querySelectorAll('[data-inspect-collection]').forEach(button => button.addEventListener('click', () => {
      const index = Number(button.dataset.inspectCollection);
      collectionSelectEl.value = String(index);configureCollection(index, false);renderCollectionList();
    }));
  }

  function renderCollectionOverview() {
    const collection = currentCollection();
    const summary = $('nmda-structure-summary');
    const preview = $('nmda-structure-preview');
    if (!collection || !summary || !preview) return;
    const kind = collectionKind(collection,ensureCollectionConfig(batch.collectionIndex)?.purpose);
    const rows = collection.rows || [];
    const detection = batch.detection || Importer.detectHeader(rows);
    const dataCount = Math.max(0, rows.length - (detection.index + 1));
    const width = Math.max(0, ...rows.slice(0, 50).map(row => row?.length || 0));
    const source = collection.source || sourceFileName(batch.dataset?.sourceFiles?.[0]);
    const scan = collection.meta?.mailScan;
    const metricHtml = collection.meta?.mailFrames && scan
      ? `<span><strong>${scan.records || dataCount}</strong> 封邮件</span><span><strong>${scan.complete || 0}</strong> 可用</span><span><strong>${scan.missingRecipients || 0}</strong> 待补邮箱</span>`
      : `<span><strong>${dataCount}</strong> 条候选记录</span><span><strong>${width}</strong> 个来源字段</span>`;
    summary.innerHTML = `
      <div class="nmda-structure-identity" data-tone="${escapeHtml(kind.tone)}"><span>${escapeHtml(kind.icon)}</span><div><strong>${escapeHtml(kind.label)}</strong><small>${escapeHtml(collection.name || '未命名内容')}</small></div></div>
      <div class="nmda-structure-metrics">${metricHtml}<span title="${escapeHtml(String(source || ''))}"><strong>来源</strong> ${escapeHtml(String(source || '—'))}</span></div>`;
    const rawStart = Math.max(0, Math.min(detection.index, rows.length - 1));
    const sampleRows = rows.slice(rawStart, rawStart + 6);
    if (!sampleRows.length) { preview.innerHTML = '<div class="nmda-empty-inline">这里没有可预览的内容。</div>'; return; }
    const maxCols = Math.min(8, Math.max(...sampleRows.map(r => r?.length || 0), 1));
    preview.innerHTML = `<table><tbody>${sampleRows.map((row, ri) => `<tr class="${ri === 0 ? 'is-structure-head' : ''}">${Array.from({length:maxCols},(_,ci)=>`<td title="${escapeHtml(String(row?.[ci] ?? ''))}">${escapeHtml(String(row?.[ci] ?? '') || '—')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }

  function renderSemanticSummary() {
    const box = $('nmda-semantic-summary');
    if (!box || !batch.detection) return;
    const headers = batch.detection.headers || [];
    const mapping = batch.mapping || {};
    const confidence = batch.detection.confidence || {};
    const items = Importer.FIELD_DEFS.map(field => {
      const index = mapping[field.key];
      const mapped = index != null;
      const score = mapped ? Number(confidence[field.key] || 0) : 0;
      const tone = !mapped ? 'none' : score >= 90 ? 'high' : score >= 70 ? 'medium' : 'low';
      return `<div class="nmda-semantic-item" data-confidence="${tone}"><span>${escapeHtml(field.label)}</span><strong>${mapped ? escapeHtml(headers[index] || `来源字段 ${Number(index)+1}`) : '未映射'}</strong>${mapped ? `<small>${score ? '已匹配' : '已设置'}</small>` : '<small>不会写入任务</small>'}</div>`;
    });
    box.innerHTML = items.join('');
  }

  function recipientLooksValid(value) {
    const raw = String(value || '').trim();
    if (!raw) return false;
    const direct=/\b[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}(?![A-Z0-9.\-])/i.test(raw);
    if (direct) return true;
    const parsed = Contacts?.parseRecipients?.(raw) || [];
    return parsed.some(item => /@/.test(String(item?.email || item || '')));
  }

  function isAutoResolvableReviewIssue(issue) {
    const text=String(issue||'');
    return /^(缺少收件人|收件人邮箱格式无效|缺少主题|缺少正文)$/.test(text)
      || /未定位收件人|主题为空|正文过短/.test(text);
  }

  function effectiveImportConfidence(task) {
    let score=Number(task?.importConfidence||0);
    const issues=(task?.importIssues||[]).map(issue=>String(issue||''));
    if(String(task?.subject||'').trim() && issues.some(issue=>/主题为空|未找到 Subject/.test(issue))) score+=30;
    if(recipientLooksValid(task?.recipients||'') && issues.some(issue=>/未定位收件人|无收件人/.test(issue))) score+=15;
    if(String(task?.body||'').trim().length>=80 && issues.some(issue=>/正文过短/.test(issue))) score+=6;
    return Math.max(0,Math.min(100,score));
  }

  function unresolvedImportIssues(task) {
    const out=[];
    const effectiveConfidence=effectiveImportConfidence(task);
    if (!String(task?.recipients||'').trim()) out.push('缺少收件人');
    else if (!recipientLooksValid(task.recipients)) out.push('收件人邮箱格式无效');
    if (!String(task?.subject||'').trim()) out.push('缺少主题');
    if (!String(task?.body||'').trim()) out.push('缺少正文');
    // Human confirmation is scoped: deterministic missing fields disappear as soon as they are fixed.
    // Only ambiguous parsing / manual edits / roster conflicts require an explicit confirmation.
    if (!task?.reviewConfirmed) {
      if (effectiveConfidence && effectiveConfidence < 70) out.push('请检查邮件内容');
      for (const issue of task?.importIssues || []) {
        if (/未定位收件人/.test(issue) && task.recipients) continue;
        if (/主题为空|未找到 Subject/.test(issue) && task.subject) continue;
        if (/正文过短/.test(issue) && String(task.body||'').length>=40) continue;
        if (/置信度/.test(issue) && effectiveConfidence>=70) continue;
        if (/未找到邮件落款|未找到邮件称呼/.test(issue) && effectiveConfidence >= 80) continue;
        if (!out.includes(issue)) out.push(issue);
      }
    }
    if (task?.reviewDraftPending && !out.includes('修改待确认')) out.push('修改待确认');
    const duplicateConfirmed=new Set(task?.duplicateConfirmedGroups||[]);
    for(const item of task?.duplicateIssues||[]){
      const id=String(item?.id||''),message=String(item?.message||item||'');
      if(message && (!id || !duplicateConfirmed.has(id)) && !out.includes(message))out.push(message);
    }
    if (!task?.rosterConfirmed) for (const issue of task?.rosterIssues || []) if (!out.includes(issue)) out.push(issue);
    return out;
  }

  function taskIssueState(task) {
    const reviewIssues=unresolvedImportIssues(task);
    const content=reviewIssues.filter(isAutoResolvableReviewIssue);
    const review=reviewIssues.filter(issue=>!isAutoResolvableReviewIssue(issue));
    const attachment=[]; const schedule=[]; const policy=[]; const other=[];
    for(const error of task?.errors||[]){
      const text=String(error||'');
      if(/^(缺少收件人|收件人邮箱格式无效|缺少主题|缺少正文)$/.test(text))continue;
      if(/^缺少附件：|^附件同名冲突：/.test(text)){attachment.push(text);continue;}
      if(/^定时时间无法识别：/.test(text)){schedule.push(text);continue;}
      if(/^联系策略：/.test(text)){policy.push(text);continue;}
      if((task?.rosterIssues||[]).includes(text))continue;
      other.push(text);
    }
    return {content,review,attachment,schedule,policy,other,reviewIssues};
  }

  function taskNeedsImportReview(task) { return !task?.importExcluded && unresolvedImportIssues(task).length > 0; }
  function taskCoreValid(task) { return recipientLooksValid(task?.recipients||'') && !!String(task?.subject||'').trim() && !!String(task?.body||'').trim(); }
  function directCorrectionFields(task) {
    if(!task || task?.importExcluded)return [];
    const issues=unresolvedImportIssues(task);
    const issueText=issues.join('；');
    const fields=[];
    if(!recipientLooksValid(task?.recipients||'') && /收件人|邮箱/.test(issueText))fields.push('recipients');
    if(!String(task?.subject||'').trim() && /主题|Subject/.test(issueText))fields.push('subject');
    if(!String(task?.body||'').trim() && /正文/.test(issueText))fields.push('body');
    return fields;
  }
  function taskNeedsDirectCorrection(task) { return directCorrectionFields(task).length>0; }
  function unresolvedDuplicateGroups(task) {
    if(!task)return [];
    const confirmed=new Set(task.duplicateConfirmedGroups||[]);
    const ids=new Set(task.duplicateGroupIds||[]);
    return (batch.duplicateAudit?.groups||[]).filter(group=>ids.has(group.id)&&!confirmed.has(group.id));
  }
  function taskHasUnresolvedDuplicate(task) { return unresolvedDuplicateGroups(task).length>0; }
  function taskNeedsExplicitConfirmation(task) {
    if(!task || task.importExcluded)return false;
    const issues=unresolvedImportIssues(task);
    return !!task.reviewDraftPending || issues.some(issue=>!isAutoResolvableReviewIssue(issue));
  }
  // Duplicate groups require an explicit group decision. They must never disappear through the
  // generic "confirm selected" path, otherwise users can accidentally keep every duplicate.
  function taskCanBatchConfirm(task) { return taskCoreValid(task) && taskNeedsExplicitConfirmation(task) && !taskHasUnresolvedDuplicate(task); }
  function taskHasBlockingIssue(task) {
    if(!task || task.importExcluded || task.policyBlocked)return false;
    const state=taskIssueState(task);
    return state.content.length>0 || state.review.length>0 || state.attachment.length>0 || state.schedule.length>0 || state.other.length>0;
  }
  function taskHasPrePlanningBlocker(task) {
    if(!task || task.importExcluded || task.policyBlocked)return false;
    const state=taskIssueState(task);
    return state.content.length>0 || state.review.length>0 || state.schedule.length>0 || state.other.length>0;
  }

  function excludedImportCount() {
    let count=0;
    for (const edit of batch.taskEdits.values()) if (edit?.importExcluded) count++;
    return count;
  }

  function taskSourceMeta(task) {
    const collection=recordSets()[Number(task?.collectionIndex)||0];
    const rowMeta=collection?.meta?.rowMeta?.[task?.rowIndex] || null;
    const sourceBlocks=rowMeta?.sourceContext?.length ? rowMeta.sourceContext : (collection?.meta?.sourceBlocks || []);
    const contextOffset=rowMeta?.sourceContext?.length ? Number(rowMeta.sourceContextStart||0) : 0;
    return {collection,rowMeta,sourceBlocks,contextOffset};
  }

  function reviewTaskPriority(task) {
    const issues=unresolvedImportIssues(task);
    if(issues.some(issue=>/收件人|邮箱/.test(issue)))return 0;
    if(issues.some(issue=>/缺少主题|主题为空|Subject|缺少正文/.test(issue)))return 1;
    if(issues.some(issue=>/^当前批次(?:疑似)?重复：/.test(issue)))return 2;
    if(issues.some(issue=>/总名单|联系人|院校/.test(issue)))return 3;
    if(issues.some(issue=>/边界|称呼|落款|置信度|请检查/.test(issue)))return 4;
    return 5;
  }

  function reviewTasks() {
    return (batch.tasks||[]).filter(taskNeedsImportReview).sort((a,b)=>reviewTaskPriority(a)-reviewTaskPriority(b) || String(a.editKey).localeCompare(String(b.editKey)));
  }

  function reviewVisibleTasks() {
    const tasks=(batch.tasks||[]).filter(task=>!task?.importExcluded);
    const filter=String(batch.reviewFilter||'all');
    let scoped=tasks;
    if(filter!=='all'){
      scoped=tasks.filter(task=>{
        const visual=reviewVisualState(task);
        if(filter==='pending')return visual.key==='action';
        if(filter==='decision')return visual.key==='decision';
        if(filter==='confirmed')return visual.key==='confirmed';
        if(filter==='auto')return visual.key==='auto';
        return true;
      });
    }
    if(filter==='pending'||filter==='decision')scoped.sort((a,b)=>reviewTaskPriority(a)-reviewTaskPriority(b) || String(a.editKey).localeCompare(String(b.editKey)));
    const query=String(batch.reviewSearch||'').trim().toLowerCase();
    if(!query)return scoped;
    return scoped.filter(task=>[task.id,task.collectionName,task.recipients,task.subject,task.sourceFile].some(value=>String(value||'').toLowerCase().includes(query)));
  }

  function selectedReviewTasks() {
    const selected=batch.reviewSelected instanceof Set ? batch.reviewSelected : new Set();
    return (batch.tasks||[]).filter(task=>!task?.importExcluded && selected.has(task.editKey));
  }

  function pruneReviewSelection() {
    if(!(batch.reviewSelected instanceof Set)) batch.reviewSelected=new Set();
    const valid=new Set((batch.tasks||[]).filter(task=>!task?.importExcluded).map(task=>task.editKey));
    for(const key of [...batch.reviewSelected]) if(!valid.has(key)) batch.reviewSelected.delete(key);
  }

  function missingSubjectTasks({selectedOnly=false}={}) {
    const pool=selectedOnly ? selectedReviewTasks() : (batch.tasks||[]).filter(task=>!task?.importExcluded);
    return pool.filter(task=>!String(task?.subject||'').trim());
  }

  function suggestedBulkSubject() {
    const counts=new Map();
    for(const task of (batch.tasks||[])){
      if(task?.importExcluded)continue;
      const subject=String(task?.subject||'').trim();
      if(!subject)continue;
      counts.set(subject,(counts.get(subject)||0)+1);
    }
    const ranked=[...counts.entries()].sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0]));
    const [subject,count]=ranked[0]||['',0];
    const filled=[...(batch.tasks||[])].filter(task=>!task?.importExcluded&&String(task?.subject||'').trim()).length;
    return subject && filled>0 && (count/filled)>=0.7 ? subject : '';
  }

  function bulkSubjectPromptShouldAutoOpen() {
    const missing=missingSubjectTasks().length;
    return missing>=3 && !batch.bulkSubjectPromptAutoShown && !batch.bulkSubjectPromptDismissed;
  }

  function hideBulkSubjectPrompt({dismiss=false}={}) {
    if(reviewSubjectPromptEl)reviewSubjectPromptEl.hidden=true;
    if(dismiss)batch.bulkSubjectPromptDismissed=true;
  }

  function openBulkSubjectPrompt({auto=false}={}) {
    const missing=missingSubjectTasks();
    if(!missing.length){hideBulkSubjectPrompt();return false;}
    if(auto){
      if(!bulkSubjectPromptShouldAutoOpen())return false;
      batch.bulkSubjectPromptAutoShown=true;
    }
    batch.bulkSubjectPromptDismissed=false;
    if(reviewSubjectPromptTitleEl)reviewSubjectPromptTitleEl.textContent=missing.length>=3?`检测到 ${missing.length} 封邮件缺少主题`:`还有 ${missing.length} 封邮件缺少主题`;
    if(reviewSubjectPromptCopyEl)reviewSubjectPromptCopyEl.textContent='输入一次，只补齐缺少主题的邮件，不覆盖已有主题；补齐后会立即重新核验待办状态。';
    const suggestion=suggestedBulkSubject();
    if(reviewBulkSubjectInputEl && !String(reviewBulkSubjectInputEl.value||'').trim())reviewBulkSubjectInputEl.value=suggestion;
    if(reviewBulkSubjectApplyEl)reviewBulkSubjectApplyEl.textContent=`一键补齐 ${missing.length} 封`;
    if(reviewSubjectPromptEl)reviewSubjectPromptEl.hidden=false;
    requestAnimationFrame(()=>reviewBulkSubjectInputEl?.focus?.({preventScroll:true}));
    return true;
  }

  async function applyBulkSubjects() {
    const subject=String(reviewBulkSubjectInputEl?.value||'').trim();
    const missing=missingSubjectTasks();
    if(!missing.length){hideBulkSubjectPrompt();renderReviewPageOverview();return;}
    if(!subject){
      reviewBulkSubjectInputEl?.focus?.();
      if(reviewSubjectPromptEl)reviewSubjectPromptEl.dataset.error='1';
      setImportStatus('请先输入要统一补齐的主题。','warn');
      return;
    }
    if(reviewSubjectPromptEl)delete reviewSubjectPromptEl.dataset.error;
    const keys=missing.map(task=>task.editKey);
    for(const task of missing)setTaskEdit(task,{subject});
    batch.handoffComplete=false;
    rebuildTasks();
    const current=new Map((batch.tasks||[]).map(task=>[task.editKey,task]));
    const resolved=keys.filter(key=>current.has(key)&&!taskNeedsImportReview(current.get(key))).length;
    const remaining=keys.filter(key=>current.has(key)&&taskNeedsImportReview(current.get(key))).length;
    hideBulkSubjectPrompt();
    renderImportTaskPreview();renderImportHandoff();renderReviewPageOverview();renderProcessGuide();
    const extra=remaining?`；其中 ${remaining} 封还有其他内容待处理`:`；${resolved||missing.length} 封已解除“缺主题”待办`;
    setImportStatus(`已为 ${missing.length} 封邮件补齐主题“${subject}”${extra}。`,'ok');
  }

  function renderReviewBatchActions() {
    pruneReviewSelection();
    const selected=selectedReviewTasks().filter(taskCanBatchConfirm);
    const batchMode=batch.reviewFilter==='pending' && reviewTasks().length>0;
    if(reviewBatchbarEl) reviewBatchbarEl.hidden=!batchMode||!selected.length;
    if(reviewSelectedCountEl) reviewSelectedCountEl.textContent=selected.length?`已选 ${selected.length} 封需确认邮件`:'已选 0 封';
  }

  function reviewCurrentTask(){
    const key=importEditorOverlayEl?.dataset.editKey;
    return key ? (batch.tasks||[]).find(task=>task.editKey===key) || null : null;
  }

  function otherMissingSubjectTasks(currentKey='') {
    return (batch.tasks||[]).filter(task=>!task?.importExcluded && task.editKey!==currentKey && !String(task?.subject||'').trim());
  }

  function hideSubjectAssist(){
    if(subjectAssistEl) subjectAssistEl.hidden=true;
  }

  function autoSizeReviewBody(){
    if(!importEditBodyEl || importEditorOverlayEl?.hidden) return;
    requestAnimationFrame(()=>{
      const mode=importEditorOverlayEl?.dataset.mode||'audit';
      const correctionMode=mode==='correction';
      const directMode=mode==='direct';
      const duplicateActive=importEditorOverlayEl?.classList.contains('has-duplicate-decision');
      if(correctionMode||directMode){
        importEditBodyEl.style.height='auto';
        const minimum=directMode?130:280;
        const target=Math.max(minimum,importEditBodyEl.scrollHeight+2);
        importEditBodyEl.style.height=`${target}px`;
        importEditBodyEl.style.overflowY='hidden';
        importEditBodyEl.dataset.longBody='0';
        return;
      }
      const viewportCap=Math.max(210,Math.round(window.innerHeight*(duplicateActive ? .26 : .38)));
      const target=Math.min(Math.max(210,importEditBodyEl.scrollHeight+2),viewportCap);
      importEditBodyEl.style.height=`${target}px`;
      importEditBodyEl.style.overflowY=importEditBodyEl.scrollHeight>target?'auto':'hidden';
      importEditBodyEl.dataset.longBody=importEditBodyEl.scrollHeight>target?'1':'0';
    });
  }

  function stashCurrentReviewDraft(){
    const task=reviewCurrentTask(); if(!task)return null;
    const patch={
      recipients:String(importEditRecipientsEl?.value||'').trim(),
      subject:String(importEditSubjectEl?.value||'').trim(),
      body:String(importEditBodyEl?.value||''),
      attachments:String(importEditAttachmentsEl?.value||'').trim(),
      scheduleAt:String(importEditScheduleEl?.value||''),
      tags:String(importEditTagsEl?.value||'')
    };
    const currentAttachments=(task.attachmentRefs||[]).join('; ');
    const currentTags=(task.tags||[]).join('; ');
    const changed=patch.recipients!==String(task.recipients||'').trim()
      || patch.subject!==String(task.subject||'').trim()
      || patch.body!==String(task.body||'')
      || patch.attachments!==currentAttachments
      || patch.scheduleAt!==String(task.scheduleAt||'')
      || patch.tags!==currentTags;
    if(changed){setTaskEdit(task,patch);batch.handoffComplete=false;}
    return task;
  }

  function maybeOfferSubjectAssist(){
    const task=reviewCurrentTask();
    const subject=String(importEditSubjectEl?.value||'').trim();
    if(!task || !subject || importEditSubjectEl?.dataset.startedBlank!=='1'){hideSubjectAssist();return;}
    stashCurrentReviewDraft();
    const missing=otherMissingSubjectTasks(task.editKey);
    if(!missing.length){hideSubjectAssist();return;}
    if(subjectAssistTitleEl)subjectAssistTitleEl.textContent=`还有 ${missing.length} 封邮件缺少主题`;
    if(subjectAssistCopyEl)subjectAssistCopyEl.textContent=`是否也填写为“${subject.length>42?`${subject.slice(0,42)}…`:subject}”？不会覆盖已有主题。`;
    if(subjectAssistEl)subjectAssistEl.hidden=false;
  }

  async function applySubjectAssist(){
    if(subjectAssistTimer){clearTimeout(subjectAssistTimer);subjectAssistTimer=null;}
    const task=reviewCurrentTask();
    const subject=String(importEditSubjectEl?.value||'').trim();
    if(!task||!subject)return;
    stashCurrentReviewDraft();
    const missing=otherMissingSubjectTasks(task.editKey);
    const missingKeys=missing.map(item=>item.editKey);
    const pendingBefore=new Set(missing.filter(taskNeedsImportReview).map(item=>item.editKey));
    for(const item of missing)setTaskEdit(item,{subject});
    rebuildTasks();
    const currentMap=new Map((batch.tasks||[]).map(item=>[item.editKey,item]));
    const autoResolved=missingKeys.filter(key=>pendingBefore.has(key)&&currentMap.has(key)&&!taskNeedsImportReview(currentMap.get(key))).length;
    const stillPending=missingKeys.filter(key=>currentMap.has(key)&&taskNeedsImportReview(currentMap.get(key))).length;
    hideSubjectAssist();
    importEditSubjectEl.dataset.startedBlank='0';
    renderImportTaskPreview();
    renderImportHandoff();
    renderReviewPageOverview();
    const resolvedText=autoResolved?`，其中 ${autoResolved} 封已自动通过` : '';
    const pendingText=stillPending?`；${stillPending} 封还有其他内容需要处理` : '';
    setImportStatus(`已为另外 ${missing.length} 封缺少主题的邮件填写同一主题${resolvedText}${pendingText}。`,'ok');
    await continueAfterReviewResolution(missing.length?'主题已补齐':'当前主题已补齐');
  }

  async function confirmSelectedReviewTasks() {
    const selected=selectedReviewTasks().filter(taskCanBatchConfirm);
    if(!selected.length)return;
    batch.handoffComplete=false;
    let confirmed=0,blocked=0;
    for(const task of selected){
      const coreValid=taskCoreValid(task);
      if(!coreValid){blocked++;continue;}
      const prev=batch.taskEdits.get(task.editKey)||{};
      batch.taskEdits.set(task.editKey,{...prev,reviewConfirmed:true,reviewDraftPending:false,rosterConfirmed:(task.rosterIssues||[]).length?true:!!prev.rosterConfirmed});
      confirmed++;
    }
    batch.reviewSelected.clear();
    rebuildTasks();
    renderReviewPageOverview();
    const message=blocked
      ? `已保存 ${confirmed} 封；${blocked} 封仍缺少收件人、主题或正文。`
      : `已保存 ${confirmed} 封邮件。`;
    setImportStatus(message,blocked?'warn':'ok');
    if(!blocked)await continueAfterReviewResolution('所选邮件已确认');
  }

  function selectVisibleReviewTasks() {
    if(!(batch.reviewSelected instanceof Set))batch.reviewSelected=new Set();
    const visible=reviewVisibleTasks().filter(taskCanBatchConfirm);
    const allSelected=visible.length&&visible.every(task=>batch.reviewSelected.has(task.editKey));
    if(allSelected) for(const task of visible)batch.reviewSelected.delete(task.editKey);
    else for(const task of visible)batch.reviewSelected.add(task.editKey);
    renderReviewQueue(importEditorOverlayEl?.dataset.editKey||'');
    renderReviewBatchActions();
    const button=$('nmda-review-select-filtered');if(button)button.textContent=allSelected?`批量确认 ${visible.length} 封…`:'取消批量选择';
  }


  function duplicateCandidateScore(task) {
    if(!task)return -9999;
    let score=0;
    if(recipientLooksValid(task.recipients||''))score+=22;
    if(String(task.subject||'').trim())score+=18;
    const bodyLength=String(task.body||'').trim().length;
    score+=Math.min(28,bodyLength/18);
    score+=Math.min(25,Math.max(0,Number(task.importConfidence||0))*.25);
    if(task.manuallyEdited)score+=3;
    score-=(task.errors||[]).length*16;
    score-=(task.attachmentDetails||[]).filter(item=>item.status!=='matched').length*10;
    return score;
  }

  function recommendedDuplicateTask(group) {
    return [...(group?.tasks||[])].sort((a,b)=>duplicateCandidateScore(b)-duplicateCandidateScore(a) || String(a.editKey).localeCompare(String(b.editKey)))[0]||null;
  }

  function duplicateDecisionGroup(task) {
    return unresolvedDuplicateGroups(task)[0]||null;
  }

  function duplicateCandidateMeta(task) {
    const bits=[];
    if(task.sourceFile)bits.push(`来源 ${task.sourceFile}`);
    const bodyLength=String(task.body||'').trim().length;
    bits.push(`正文 ${bodyLength} 字`);
    if(task.files?.length)bits.push(`附件 ${task.files.length}`);
    return bits.join(' · ');
  }

  function reviewIssueLabel(issue) {
    const text=String(issue||'');
    if(/^当前批次(?:疑似)?重复：/.test(text))return '重复/冲突';
    if(/收件人存在多个|多个相近候选/.test(text))return '收件人待核对';
    if(/未定位收件人|收件人邮箱|缺少收件人/.test(text))return '缺收件人';
    if(/主题为空|未找到 Subject|缺少主题/.test(text))return '缺主题';
    if(/缺少正文|正文过短/.test(text))return '正文缺失';
    if(/邮件落款后|邮件边界|称呼|落款|置信度|请检查/.test(text))return '正文边界待核对';
    if(/总名单|联系人|院校/.test(text))return '联系人待核对';
    return text==='修改待确认'?'修改待确认':text;
  }

  function primaryReviewIssue(task){
    const issues=unresolvedImportIssues(task);
    const patterns=[/收件人存在多个|多个相近候选/,/未定位收件人|收件人邮箱|缺少收件人/,/主题为空|未找到 Subject|缺少主题/,/缺少正文|正文过短/,/^当前批次(?:疑似)?重复：/,/总名单|联系人|院校/,/邮件落款后|邮件边界|称呼|落款|置信度|请检查/,/修改待确认/];
    for(const pattern of patterns){const found=issues.find(issue=>pattern.test(String(issue||'')));if(found)return found;}
    return issues[0]||'';
  }

  function renderDuplicateDecision(task) {
    if(!duplicateDecisionEl||!duplicateCandidatesEl)return;
    const group=duplicateDecisionGroup(task);
    if(!group){duplicateDecisionEl.hidden=true;delete duplicateDecisionEl.dataset.groupId;importEditorOverlayEl?.classList.remove('has-duplicate-decision');return;}
    const recommended=recommendedDuplicateTask(group);
    const validKeys=new Set((group.tasks||[]).map(item=>item.editKey));
    const savedRaw=batch.duplicateSelections?.get?.(group.id);
    const savedList=Array.isArray(savedRaw)?savedRaw:(savedRaw?[savedRaw]:[]);
    const selectedKeys=new Set(savedList.filter(key=>validKeys.has(key)));
    if(!selectedKeys.size){const fallback=recommended?.editKey||group.tasks?.[0]?.editKey||'';if(fallback)selectedKeys.add(fallback);}
    if(batch.duplicateSelections instanceof Map)batch.duplicateSelections.set(group.id,[...selectedKeys]);
    if(duplicateKeepSelectedEl)duplicateKeepSelectedEl.textContent=`保留所选（${selectedKeys.size}）`;
    duplicateDecisionEl.hidden=false;
    duplicateDecisionEl.dataset.groupId=group.id;
    importEditorOverlayEl?.classList.add('has-duplicate-decision');
    if(duplicateDecisionKindEl){duplicateDecisionKindEl.textContent=group.type==='exact-email'?'同一邮箱':'疑似同一联系人';duplicateDecisionKindEl.dataset.tone=group.type==='exact-email'?'strong':'soft';}
    if(duplicateKeepAllEl)duplicateKeepAllEl.textContent=group.type==='exact-email'?'全部保留':'不是同一联系人，全部保留';
    if(duplicateDecisionTitleEl)duplicateDecisionTitleEl.textContent=group.type==='exact-email'
      ? `同一收件人有 ${group.tasks?.length||0} 封邮件`
      : `可能是同一联系人：${group.tasks?.length||0} 封邮件`;
    if(duplicateDecisionCopyEl)duplicateDecisionCopyEl.textContent=group.type==='exact-email'
      ? `${group.email||group.label||'该收件人'}。下面已并排展示所有版本，请直接比较正文后勾选要创建的邮件。`
      : `${group.label||'姓名与院校相同'}。下面已并排展示所有候选，请根据正文和收件人直接决定保留哪些。`;
    const unresolvedCount=unresolvedDuplicateGroups(task).length;
    if(duplicateDecisionHintEl)duplicateDecisionHintEl.textContent=unresolvedCount>1
      ? `此封邮件还涉及 ${unresolvedCount-1} 组重复；处理本组后会继续提示。`
      : '默认勾选信息更完整的一封；你可以在同一视图里改成保留任意一封或多封。';
    const compareTasks=group.tasks||[];
    duplicateCandidatesEl.dataset.count=String(compareTasks.length);
    duplicateCandidatesEl.innerHTML=compareTasks.map((candidate,index)=>{
      const isRecommended=candidate.editKey===recommended?.editKey;
      const isSelected=selectedKeys.has(candidate.editKey);
      const body=String(candidate.body||'').trim();
      const title=String(candidate.subject||candidate.id||`邮件 ${index+1}`).trim()||`邮件 ${index+1}`;
      const recipient=String(candidate.recipients||'').trim()||'未填写收件人';
      return `<article class="nmda-duplicate-candidate ${isSelected?'is-selected':''} ${candidate.editKey===task.editKey?'is-current':''}" data-duplicate-row="${escapeHtml(candidate.editKey)}">
        <label class="nmda-duplicate-pick-line"><input type="checkbox" data-duplicate-pick="${escapeHtml(candidate.editKey)}" ${isSelected?'checked':''}><span><strong>保留此封</strong><small>${escapeHtml(duplicateCandidateMeta(candidate))}</small></span></label>
        <div class="nmda-duplicate-preview-head"><div class="nmda-duplicate-candidate-title"><strong>${escapeHtml(title)}</strong>${isRecommended?'<em>信息更完整</em>':''}${candidate.editKey===task.editKey?'<small>正在编辑</small>':''}</div><span class="nmda-duplicate-preview-recipient">${escapeHtml(recipient)}</span></div>
        <div class="nmda-duplicate-preview-body"><pre>${escapeHtml(body||'正文为空')}</pre></div>
        <button type="button" class="nmda-btn nmda-btn-small nmda-btn-quiet nmda-duplicate-edit" data-duplicate-open="${escapeHtml(candidate.editKey)}">定位此版本</button>
      </article>`;
    }).join('');
  }

  async function keepSelectedDuplicateCandidate() {
    const groupId=duplicateDecisionEl?.dataset.groupId||'';
    if(!groupId)return;
    const selectedKeys=[...(duplicateCandidatesEl?.querySelectorAll('input[data-duplicate-pick]:checked')||[])].map(input=>input.dataset.duplicatePick).filter(Boolean);
    if(!selectedKeys.length){if(duplicateDecisionHintEl)duplicateDecisionHintEl.textContent='至少保留一封邮件；如本组全部不需要，请逐封排除或返回修改身份信息。';return;}
    const selectedSet=new Set(selectedKeys);
    const activeKey=importEditorOverlayEl?.dataset.editKey||'';
    stashCurrentReviewDraft();
    rebuildTasks();
    const group=(batch.duplicateAudit?.groups||[]).find(item=>item.id===groupId);
    if(!group){renderReviewPageOverview();await continueAfterReviewResolution('重复信息已变化，已重新核验');return;}
    const retained=(group.tasks||[]).filter(item=>selectedSet.has(item.editKey));
    if(!retained.length)return;
    for(const candidate of group.tasks||[]){
      if(selectedSet.has(candidate.editKey)){
        const prev=batch.taskEdits.get(candidate.editKey)||{};
        setTaskEdit(candidate,{duplicateConfirmedGroups:[...new Set([...(prev.duplicateConfirmedGroups||[]),groupId])]});
      }else setTaskEdit(candidate,{importExcluded:true});
    }
    batch.duplicateSelections?.delete?.(groupId);
    batch.reviewSelected?.clear?.();
    rebuildTasks();
    renderImportTaskPreview();renderImportHandoff();renderRosterAudit();renderReviewPageOverview();
    const kept=(batch.tasks||[]).find(item=>item.editKey===retained[0].editKey);
    const excludedCount=Math.max(0,(group.tasks?.length||0)-retained.length);
    const decisionSummary=`重复组已处理：保留 ${retained.length} 封${excludedCount?`，排除 ${excludedCount} 封`:''}`;
    setImportStatus(`${decisionSummary}。`,'ok');
    if(kept&&taskNeedsImportReview(kept))openImportTaskEditor(kept);
    else if(reviewTasks().length)openImportTaskEditor(reviewTasks()[0]);
    else await continueAfterReviewResolution(decisionSummary);
  }

  async function keepAllDuplicateCandidates() {
    const groupId=duplicateDecisionEl?.dataset.groupId||'';
    if(!groupId)return;
    stashCurrentReviewDraft();
    rebuildTasks();
    const group=(batch.duplicateAudit?.groups||[]).find(item=>item.id===groupId);
    if(!group){renderReviewPageOverview();await continueAfterReviewResolution('重复信息已变化，已重新核验');return;}
    for(const candidate of group.tasks||[]){
      const prev=batch.taskEdits.get(candidate.editKey)||{};
      setTaskEdit(candidate,{duplicateConfirmedGroups:[...new Set([...(prev.duplicateConfirmedGroups||[]),groupId])]});
    }
    batch.duplicateSelections?.delete?.(groupId);
    batch.reviewSelected?.clear?.();
    rebuildTasks();
    renderImportTaskPreview();renderImportHandoff();renderRosterAudit();renderReviewPageOverview();
    const decisionSummary=`已明确保留该组 ${group.tasks?.length||0} 封邮件（有意重复）`;
    setImportStatus(`${decisionSummary}；后续不再阻塞。`,'ok');
    const current=(batch.tasks||[]).find(item=>item.editKey===importEditorOverlayEl?.dataset.editKey);
    if(current&&taskNeedsImportReview(current))openImportTaskEditor(current);
    else if(reviewTasks().length)openImportTaskEditor(reviewTasks()[0]);
    else await continueAfterReviewResolution(decisionSummary);
  }

  function renderReviewPageOverview() {
    const tasks=(batch.tasks||[]).filter(task=>!task?.importExcluded);
    let checked=0,decisionTaskCount=0,actionCount=0,autoPassed=0;
    for(const task of tasks){
      const visual=reviewVisualState(task);
      if(visual.key==='decision')decisionTaskCount++;
      else if(visual.key==='action')actionCount++;
      else if(visual.key==='confirmed')checked++;
      else autoPassed++;
    }
    const decisionCount=unresolvedDuplicateGroupCount();
    const pendingCount=actionCount+decisionCount;
    if(reviewWorkspaceTitleEl)reviewWorkspaceTitleEl.textContent='邮件审阅';
    if(reviewWorkspaceDescEl)reviewWorkspaceDescEl.textContent=pendingCount
      ? `先浏览全部邮件状态；当前有 ${actionCount} 封需处理、${decisionCount} 组重复需取舍。`
      : '所有邮件都已满足创建条件；可以快速抽查，无需逐封确认。';
    if(reviewExitEl)reviewExitEl.textContent=batch.handoffComplete?'返回选择与安排':'完成审阅';
    if(reviewNavCountEl){reviewNavCountEl.hidden=!pendingCount;reviewNavCountEl.textContent=String(pendingCount);}
    if(reviewPageSummaryEl)reviewPageSummaryEl.innerHTML=tasks.length
      ? `<span class="nmda-review-metric" data-tone="all"><small>全部邮件</small><strong>${tasks.length}</strong></span><span class="nmda-review-metric" data-tone="auto"><small>自动通过</small><strong>${autoPassed}</strong></span><span class="nmda-review-metric" data-tone="action"><small>需处理</small><strong>${actionCount}</strong></span><span class="nmda-review-metric" data-tone="decision"><small>重复组</small><strong>${decisionCount}</strong></span><span class="nmda-review-metric" data-tone="confirmed"><small>已确认</small><strong>${checked}</strong></span>`
      : '<span class="nmda-review-metric" data-tone="all"><small>全部邮件</small><strong>0</strong></span>';
    if(reviewPageEmptyEl)reviewPageEmptyEl.hidden=!!tasks.length;
    const nextPendingBtn=$('nmda-review-next-pending');
    if(nextPendingBtn){
      const attachmentStats=typeof importAttachmentStats==='function'?importAttachmentStats():{issues:0};
      const canContinue=pendingCount===0&&!batch.handoffComplete&&tasks.length>0;
      nextPendingBtn.hidden=!canContinue;
      nextPendingBtn.dataset.mode=canContinue?'continue':'next';
      nextPendingBtn.textContent=attachmentStats.issues?`继续：选择与安排 · 附件稍后补 ${attachmentStats.issues}`:'继续：选择与安排';
    }
    if(reviewFilterEl)reviewFilterEl.hidden=false;
    if(reviewQueueTitleEl)reviewQueueTitleEl.textContent=pendingCount?'邮件状态':'邮件状态 · 全部可用';
    ui.querySelectorAll('[data-review-filter]').forEach(button=>button.classList.toggle('is-active',button.dataset.reviewFilter===batch.reviewFilter));
    if(reviewQueueCaptionEl)reviewQueueCaptionEl.textContent=batch.reviewFilter==='pending'?'缺失项点击后直接可填；不确定项进入完整审阅':'普通邮件点击完整审阅；重复邮件合并成一张版本堆叠卡，集中比较取舍。';
    if(reviewSearchEl && reviewSearchEl.value!==String(batch.reviewSearch||''))reviewSearchEl.value=String(batch.reviewSearch||'');
    const missingSubjects=missingSubjectTasks();
    if(reviewFillSubjectsEl){reviewFillSubjectsEl.hidden=!missingSubjects.length;reviewFillSubjectsEl.textContent=missingSubjects.length?`一键补主题 · ${missingSubjects.length}`:'一键补主题';}
    if(!missingSubjects.length)hideBulkSubjectPrompt();
    else if(reviewSubjectPromptEl && !reviewSubjectPromptEl.hidden){
      if(reviewSubjectPromptTitleEl)reviewSubjectPromptTitleEl.textContent=missingSubjects.length>=3?`检测到 ${missingSubjects.length} 封邮件缺少主题`:`还有 ${missingSubjects.length} 封邮件缺少主题`;
      if(reviewBulkSubjectApplyEl)reviewBulkSubjectApplyEl.textContent=`一键补齐 ${missingSubjects.length} 封`;
    }
    if(!tasks.length){if(importEditorOverlayEl)importEditorOverlayEl.hidden=true;renderReviewBatchActions();return;}
    renderReviewBatchActions();
    if(reviewInlineEl && !reviewInlineEl.hidden)renderReviewQueue(importEditorOverlayEl?.dataset.editKey||'');
  }

  function openReviewWorkspace(options = {}) {
    const requestedReturn=Number(options.returnStep || batch.uiStep || 2);
    batch.reviewReturnStep=requestedReturn;
    if(requestedReturn < 3) batch.uiStep=2;
    batch.reviewFilter=options.pendingOnly?'pending':'all';
    renderProcessGuide();
    setWorkbenchTab('batch');
    reviewInlineEl?.closest('.nmda-bulk-workbench')?.classList.add('is-review-focus');
    reviewInlineEl?.closest('.nmda-page')?.classList.add('is-review-page-focus');
    ui.querySelector('[data-page-head="batch"]')?.classList.add('nmda-review-head-hidden');
    if(reviewInlineEl) reviewInlineEl.hidden=false;
    closeImportTaskEditor();
    renderReviewPageOverview();
    if(options.taskKey){const target=(batch.tasks||[]).find(task=>String(task.editKey)===String(options.taskKey));if(target)openImportTaskEditor(target);}
    syncModalState();
  }

  function closeReviewWorkspace() {
    reviewInlineEl?.closest('.nmda-bulk-workbench')?.classList.remove('is-review-focus');
    reviewInlineEl?.closest('.nmda-page')?.classList.remove('is-review-page-focus');
    ui.querySelector('[data-page-head="batch"]')?.classList.remove('nmda-review-head-hidden');
    if(reviewInlineEl) reviewInlineEl.hidden=true;
    closeImportTaskEditor();
    const returnStep=Number(batch.reviewReturnStep || (batch.handoffComplete?3:2));
    batch.uiStep=returnStep;
    renderProcessGuide();
    if(batch.handoffComplete) scheduleBatchRender({aux:true,force:true});
    else scheduleBatchRender({aux:true,force:true});
    syncModalState();
  }

  function hideReviewWorkspaceWithoutStash() {
    hideSubjectAssist();
    reviewInlineEl?.closest('.nmda-bulk-workbench')?.classList.remove('is-review-focus');
    reviewInlineEl?.closest('.nmda-page')?.classList.remove('is-review-page-focus');
    ui.querySelector('[data-page-head="batch"]')?.classList.remove('nmda-review-head-hidden');
    if(duplicateDecisionEl){duplicateDecisionEl.hidden=true;delete duplicateDecisionEl.dataset.groupId;}
    if(reviewInlineEl)reviewInlineEl.hidden=true;
    if(importEditorOverlayEl){importEditorOverlayEl.hidden=true;delete importEditorOverlayEl.dataset.editKey;}
  }

  async function enterSelectionAndSchedule(reason='检查完成') {
    if(!batch.dataset || !batch.tasks?.length || batch.running || batch.autoAdvancing)return false;
    if((batch.tasks||[]).some(taskHasPrePlanningBlocker))return false;
    if(supplementPreflightNeedsDecision()){
      openSupplementPreflight();
      setImportStatus('邮件已导入；先完成一次批次准备，再进入后续处理。','warn');
      return false;
    }
    if(batch.handoffComplete){
      batch.uiStep=3;
      if(!batch.planningView)batch.planningView='rules';
      setWorkbenchTab('batch');
      scheduleBatchRender({aux:true,force:true});
      requestAnimationFrame(()=>requestAnimationFrame(()=>$('nmda-stage-execute')?.scrollIntoView?.({behavior:'smooth',block:'start'})));
      return true;
    }
    const token=batch.sessionId;
    batch.autoAdvancing=true;
    try{
      await registerCurrentBatchContacts(token);
      if(!isCurrentBatchSession(token)||(batch.tasks||[]).some(taskHasPrePlanningBlocker))return false;
      batch.handoffComplete=true;
      batch.uiStep=3;
      batch.planningView='rules';
      hideReviewWorkspaceWithoutStash();
      setWorkbenchTab('batch');
      setBatchStatus(`${reason}，已自动进入选择与安排。`,'ok');
      setImportStatus(`${reason}。下一步已为你展开，可以直接选择邮件和时间。`,'ok');
      scheduleBatchRender({aux:true,force:true});
      requestAnimationFrame(()=>requestAnimationFrame(()=>$('nmda-stage-execute')?.scrollIntoView?.({behavior:'smooth',block:'start'})));
      return true;
    }finally{
      batch.autoAdvancing=false;
      renderImportHandoff();
    }
  }

  async function continueAfterReviewResolution(reason='邮件检查完成') {
    const pending=reviewTasks();
    if(pending.length){
      if(batch.reviewFilter==='pending')openImportTaskEditor(pending[0]);
      else renderReviewPageOverview();
      return false;
    }
    const attachmentStats=importAttachmentStats();
    const other=(batch.tasks||[]).filter(task=>taskHasPrePlanningBlocker(task));
    if(other.length){
      hideReviewWorkspaceWithoutStash();
      setImportStatus(`邮件内容已处理完成；还有 ${other.length} 封存在其他待办。`,'warn');
      requestAnimationFrame(()=>$('nmda-ingest-result-card')?.scrollIntoView?.({behavior:'smooth',block:'center'}));
      return false;
    }
    if(attachmentStats.issues)setImportStatus(`邮件内容已处理完成；${attachmentStats.issues} 项附件已移到“发送前”处理，不再阻塞排期。`,'warn');
    return enterSelectionAndSchedule(reason);
  }

  function unresolvedDuplicateGroupCount(){
    const ids=new Set();
    for(const task of (batch.tasks||[])){
      if(task?.importExcluded)continue;
      for(const group of unresolvedDuplicateGroups(task))if(group?.id)ids.add(group.id);
    }
    return ids.size;
  }

  function openNextBlockingIssue(preferred=''){
    setWorkbenchTab('batch');
    const reviewPending=reviewTasks();
    const attachmentStats=importAttachmentStats();
    if(preferred==='attachments' && attachmentStats.issues){
      hideReviewWorkspaceWithoutStash();
      const card=$('nmda-attachments-card');
      if(card){card.hidden=false;card.open=true;batch.attachmentAttentionShown=true;requestAnimationFrame(()=>card.scrollIntoView?.({behavior:'smooth',block:'start'}));}
      return true;
    }
    if(reviewPending.length){
      openReviewWorkspace();
      const target=reviewPending[0];
      if(target)openImportTaskEditor(target);
      return true;
    }
    if(attachmentStats.issues){
      const card=$('nmda-attachments-card');
      if(card){card.hidden=false;card.open=true;batch.attachmentAttentionShown=true;requestAnimationFrame(()=>card.scrollIntoView?.({behavior:'smooth',block:'start'}));}
      return true;
    }
    const other=(batch.tasks||[]).find(task=>taskHasBlockingIssue(task));
    if(other){
      setImportStatus('还有一项无法自动归类的待办，请查看待办中心说明。','warn');
      requestAnimationFrame(()=>$('nmda-ingest-result-card')?.scrollIntoView?.({behavior:'smooth',block:'center'}));
      return true;
    }
    return enterSelectionAndSchedule('待办已完成');
  }

  function openNextReviewTask(){
    const current=reviewCurrentTask();
    stashCurrentReviewDraft();
    rebuildTasks();
    const pending=reviewTasks();
    if(!pending.length){void continueAfterReviewResolution('邮件待办已完成');return;}
    const currentIndex=current?pending.findIndex(task=>task.editKey===current.editKey):-1;
    const next=pending[currentIndex>=0&&pending.length>1?(currentIndex+1)%pending.length:0]||pending[0];
    if(next)openImportTaskEditor(next);
  }

  function reviewCandidateEmails(task) {
    const {rowMeta,sourceBlocks,contextOffset=0}=taskSourceMeta(task);
    const candidates=[];
    const seen=new Set();
    const identityText=`${rowMeta?.heading||''} ${rowMeta?.salutation||''}`.toLowerCase();
    const identityTokens=identityText.replace(/[^a-z0-9\p{L}]+/gu,' ').split(/\s+/).filter(token=>token.length>=3&&!['dear','prof','professor','doctor','university','subject'].includes(token));
    const add=(email,index,score,reason,text='')=>{
      const key=String(email||'').toLowerCase();
      if(!key||seen.has(key))return;
      let adjusted=Number(score||0); const local=key.split('@')[0];
      if(identityTokens.some(token=>local.includes(token)))adjusted+=24;
      else if(Number.isFinite(index)&&rowMeta&&index>Number(rowMeta.endBlock??rowMeta.startBlock??0))adjusted-=36;
      if(reason==='当前邮件线索')adjusted+=20;
      if(adjusted<55)return;
      seen.add(key);
      candidates.push({email,index:Number.isFinite(index)?index:null,score:adjusted,reason,text});
    };
    for(const c of rowMeta?.recipientCandidates||[]) add(c.email,c.index,c.score,'原文附近',c.text||'');
    if(rowMeta?.recipientEvidence?.email) add(rowMeta.recipientEvidence.email,rowMeta.recipientEvidence.index,rowMeta.recipientEvidence.score,'当前邮件线索',rowMeta.recipientEvidence.text||'');
    if(sourceBlocks.length && rowMeta){
      const localStart=Math.max(0,Number(rowMeta.startBlock||0)-contextOffset-10), localEnd=Math.min(sourceBlocks.length-1,Number(rowMeta.endBlock ?? rowMeta.startBlock ?? 0)-contextOffset+10);
      // Reuse the recognizer's canonical recipient scoring instead of maintaining a second,
      // drifting email detector in the review UI. The UI may widen the evidence window for
      // manual recovery, but candidate semantics and penalties stay identical to parsing.
      const resolved=MailRecognizer?.resolveRecipientContext?.(sourceBlocks,localStart,localEnd,rowMeta?.salutation||'',{indexOffset:contextOffset});
      for(const c of resolved?.candidates||[]){
        const absolute=Number(c.index),reason=absolute<Number(rowMeta.startBlock||0)?'邮件前文附近':absolute>Number(rowMeta.endBlock??rowMeta.startBlock??0)?'邮件后文附近':'邮件正文范围';
        add(c.email,absolute,c.score,reason,c.text||'');
      }
    }
    if(task?.rosterEmailCandidate) add(task.rosterEmailCandidate,null,112,'总套磁名单唯一匹配',task?.rosterReference?.name||task?.rosterReference?.school||'总名单参考记录');
    return candidates.sort((a,b)=>b.score-a.score).slice(0,8);
  }

  function reviewVisualState(task) {
    const issues=unresolvedImportIssues(task);
    const duplicate=taskHasUnresolvedDuplicate(task);
    const direct=directCorrectionFields(task);
    if(duplicate)return {key:'decision',label:'重复组',detail:'比较版本后一次取舍',icon:'◆',issues};
    if(direct.length)return {key:'action',label:'信息缺失',detail:'点击后直接补齐',icon:'!',issues,direct};
    if(issues.length)return {key:'action',label:'需核对',detail:'点击审阅完整邮件',icon:'!',issues,direct:[]};
    if(task.reviewConfirmed||task.rosterConfirmed)return {key:'confirmed',label:'已确认',detail:'已人工核验',icon:'✓',issues:[]};
    return {key:'auto',label:'自动通过',detail:'识别完整',icon:'✓',issues:[]};
  }

  function reviewQueueItems(tasks=[]) {
    const items=[];
    const seenGroups=new Set();
    for(const task of tasks){
      const group=duplicateDecisionGroup(task);
      if(group?.id){
        if(seenGroups.has(group.id))continue;
        seenGroups.add(group.id);
        const members=(group.tasks||[]).filter(item=>!item?.importExcluded);
        const representative=members.find(item=>item.editKey===task.editKey)||members[0]||task;
        items.push({kind:'duplicate',task:representative,group,members});
      }else items.push({kind:'mail',task});
    }
    return items;
  }

  function duplicateBoardCard(item,index,activeKey='') {
    const {task,group,members=[]}=item;
    const recommended=recommendedDuplicateTask(group);
    const exact=group?.type==='exact-email';
    const groupLabel=exact?(group.email||group.label||'同一收件人'):(group.label||'疑似同一联系人');
    const samples=members.slice(0,2).map((candidate,i)=>{
      const subject=String(candidate.subject||'未识别主题').trim()||'未识别主题';
      const recipient=String(candidate.recipients||'').trim()||'未识别收件人';
      const isRecommended=candidate.editKey===recommended?.editKey;
      return `<span class="nmda-duplicate-stack-line ${isRecommended?'is-recommended':''}"><i>${String(i+1).padStart(2,'0')}</i><b>${escapeHtml(subject)}</b><small>${escapeHtml(recipient)}</small></span>`;
    }).join('');
    const extra=Math.max(0,members.length-2);
    const active=members.some(candidate=>candidate.editKey===activeKey);
    return `<article class="nmda-mail-review-card nmda-duplicate-stack-card ${active?'is-active':''}" data-review-row="${escapeHtml(task.editKey)}" data-state="decision" data-duplicate-group="${escapeHtml(group?.id||'')}">
      <span class="nmda-duplicate-stack-sheet sheet-a" aria-hidden="true"></span><span class="nmda-duplicate-stack-sheet sheet-b" aria-hidden="true"></span>
      <button class="nmda-duplicate-stack-main" type="button" data-review-key="${escapeHtml(task.editKey)}" aria-label="比较重复邮件组 ${escapeHtml(groupLabel)}">
        <span class="nmda-duplicate-stack-head"><span class="nmda-mail-state-shape" aria-hidden="true">◆</span><span><strong>${escapeHtml(exact?'同一收件人 · 多个版本':'疑似同一联系人')}</strong><small>${escapeHtml(groupLabel)}</small></span><em>${members.length} 封</em></span>
        <span class="nmda-duplicate-stack-list">${samples}${extra?`<span class="nmda-duplicate-stack-more">+${extra} 个版本</span>`:''}</span>
        <span class="nmda-duplicate-stack-foot"><small>${recommended?'已标记信息更完整版本':'需要人工比较'}</small><strong>比较并取舍 <i>→</i></strong></span>
      </button>
    </article>`;
  }

  function renderReviewQueue(activeKey='') {
    if(!reviewQueueEl)return;
    pruneReviewSelection();
    const visibleTasks=reviewVisibleTasks();
    const allItems=reviewQueueItems(visibleTasks);
    const list=allItems.slice(0,Math.max(50,viewPerf.reviewRenderLimit||250));
    const pendingCount=reviewTasks().length;
    const pendingUnits=reviewQueueItems(reviewTasks()).length;
    if(reviewProgressEl) reviewProgressEl.textContent=pendingUnits?`${pendingUnits} 项待处理`:'没有待处理邮件';
    reviewQueueEl.innerHTML=list.length?list.map((item,index)=>{
      if(item.kind==='duplicate')return duplicateBoardCard(item,index,activeKey);
      const task=item.task;
      const visual=reviewVisualState(task);
      const pending=visual.issues.length>0;
      const confirmable=taskCanBatchConfirm(task);
      const checked=confirmable&&batch.reviewSelected?.has(task.editKey)?'checked':'';
      const recipient=String(task.recipients||'').trim()||'未识别收件人';
      const subject=String(task.subject||'').trim()||'未识别主题';
      const label=String(task.id||task.collectionName||recipient||`邮件 ${index+1}`);
      const issueLabels=[...new Set(visual.issues.map(issue=>reviewIssueLabel(issue)).filter(Boolean))];
      const issueChips=issueLabels.slice(0,2).map(issue=>`<span>${escapeHtml(issue)}</span>`).join('');
      const moreCount=Math.max(0,issueLabels.length-2);
      const selectHtml=confirmable?`<label class="nmda-mail-card-select" title="加入批量确认"><input type="checkbox" data-review-select="${escapeHtml(task.editKey)}" ${checked} aria-label="选择 ${escapeHtml(label)}"><span></span></label>`:'';
      const stateLine=pending
        ? `<span class="nmda-mail-card-issues">${issueChips}${moreCount?`<span>+${moreCount}</span>`:''}</span>`
        : `<span class="nmda-mail-card-auto-note"><span>✓</span>${visual.key==='confirmed'?'人工核验完成':'收件人、主题、正文已识别'}</span>`;
      const openLabel=visual.direct?.length?'直接补齐':'审阅';
      return `<article class="nmda-mail-review-card ${checked?'is-selected':''} ${task.editKey===activeKey?'is-active':''}" data-review-row="${escapeHtml(task.editKey)}" data-state="${escapeHtml(visual.key)}">
        <div class="nmda-mail-card-status"><span class="nmda-mail-state-shape" aria-hidden="true">${visual.icon}</span><span><strong>${escapeHtml(visual.label)}</strong><small>${escapeHtml(visual.detail)}</small></span>${selectHtml}</div>
        <button class="nmda-mail-card-main" type="button" data-review-key="${escapeHtml(task.editKey)}" aria-label="审阅 ${escapeHtml(label)}">
          <span class="nmda-mail-card-index">${String(index+1).padStart(2,'0')}</span>
          <span class="nmda-mail-card-copy"><strong>${escapeHtml(label)}</strong><small>${escapeHtml(recipient)}</small><b>${escapeHtml(subject)}</b>${stateLine}</span>
          <span class="nmda-mail-card-open">${openLabel} <i>→</i></span>
        </button>
      </article>`;
    }).join(''):`<div class="nmda-review-empty">${batch.reviewFilter==='pending'?'当前没有需要人工处理的邮件。':batch.reviewFilter==='decision'?'当前没有冲突或重复邮件。':'当前没有可查看的邮件。'}</div>`;
    if(allItems.length>list.length)reviewQueueEl.insertAdjacentHTML('beforeend',`<button type="button" class="nmda-review-load-more" data-review-load-more>继续显示（${list.length}/${allItems.length}）</button>`);
    renderReviewBatchActions();
    const visible=reviewVisibleTasks().filter(taskCanBatchConfirm);const allSelected=visible.length&&visible.every(task=>batch.reviewSelected.has(task.editKey));
    const selectButton=$('nmda-review-select-filtered');if(selectButton){const batchMode=batch.reviewFilter==='pending'&&pendingCount>0;selectButton.hidden=!batchMode||visible.length<2;selectButton.textContent=allSelected?'取消批量选择':`批量确认 ${visible.length} 封…`;}
    if(activeKey)requestAnimationFrame(()=>reviewQueueEl.querySelector(`[data-review-row="${CSS.escape(activeKey)}"]`)?.scrollIntoView?.({block:'nearest'}));
  }

  function reviewBodyAuditSlices(value) {
    const body=String(value||'').replace(/\r\n?/g,'\n').trim();
    if(!body)return {opening:'正文为空',closing:'正文为空',full:'正文为空'};
    let blocks=body.split(/\n\s*\n+/).map(item=>item.trim()).filter(Boolean);
    if(blocks.length<3){
      const lines=body.split(/\n+/).map(item=>item.trim()).filter(Boolean);
      if(lines.length>=3)blocks=lines;
    }
    const clip=(text,max=700)=>text.length>max?`${text.slice(0,max).trim()}…`:text;
    if(blocks.length>=4){
      const opening=blocks.slice(0,2).join('\n\n');
      const closing=blocks.slice(-2).join('\n\n');
      return {opening:clip(opening),closing:clip(closing),full:body};
    }
    if(blocks.length>=2)return {opening:clip(blocks[0]),closing:clip(blocks[blocks.length-1]),full:body};
    const sentenceParts=body.split(/(?<=[.!?。！？])\s+/).filter(Boolean);
    if(sentenceParts.length>=4)return {opening:clip(sentenceParts.slice(0,2).join(' ')),closing:clip(sentenceParts.slice(-2).join(' ')),full:body};
    const edge=Math.min(520,Math.max(180,Math.round(body.length*.36)));
    return {opening:clip(body.slice(0,edge)),closing:clip(body.slice(Math.max(0,body.length-edge))),full:body};
  }

  function reviewBoundarySignals(task) {
    const {rowMeta}=taskSourceMeta(task);
    const evidence=new Set(task?.importEvidence||[]);
    const roles=new Set((rowMeta?.blockRoles||[]).flatMap(item=>(item.roles||[]).map(role=>role.role)));
    const body=String(task?.body||'');
    const slices=reviewBodyAuditSlices(body);
    const hasOpening=roles.has('salutation')||evidence.has('salutation')||/(?:^|\n)\s*(?:dear|hello|hi)\b|尊敬的|老师.{0,8}您好|教授.{0,8}您好/iu.test(slices.opening);
    const hasClosing=roles.has('closing')||evidence.has('closing')||/(?:sincerely|best\s+regards|kind\s+regards|regards|yours\s+sincerely|此致\s*敬礼|祝好)/iu.test(slices.closing);
    const hasSignature=roles.has('signature')||evidence.has('signature')||hasClosing;
    return {hasOpening,hasClosing,hasSignature,slices};
  }

  function setAuditCheck(id,state,text) {
    const el=$(id);if(!el)return;
    el.dataset.state=state;
    const strong=el.querySelector('strong');if(strong)strong.textContent=text;
  }

  function escapeRegex(value) {
    return String(value||'').replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  }

  function reviewSemanticModel(task) {
    const body=String(task?.body||'');
    const recipient=String(task?.recipients||'');
    const advisors=new Set(),students=new Set(),institutions=new Set();
    const angle=recipient.match(/^\s*([^<>;,]+?)\s*<[^>]+>/);
    if(angle?.[1] && !/@/.test(angle[1]))advisors.add(angle[1].trim());
    const greeting=body.match(/(?:^|\n)\s*(?:Dear|Hello|Hi)\s+(?:(?:Professor|Prof\.?|Dr\.?)\s+)?([A-Z][A-Za-z.'’-]+(?:\s+[A-Z][A-Za-z.'’-]+){0,2})(?=\s*[,!:：\n])/m);
    if(greeting?.[1] && greeting[1].length<70)advisors.add(greeting[1].trim());
    const intro=body.match(/\bMy name is\s+([A-Z][A-Za-z.'’-]+(?:\s+[A-Z][A-Za-z.'’-]+){1,3})\b/);
    if(intro?.[1])students.add(intro[1].trim());
    const lines=body.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
    const signoffIndex=lines.findIndex(line=>/^(?:Best|Kind|Warm)?\s*Regards[,.!]?|^Sincerely[,.!]?|^Yours sincerely[,.!]?$/i.test(line));
    if(signoffIndex>=0){
      const candidate=lines[signoffIndex+1]||'';
      if(/^[A-Z][A-Za-z.'’-]+(?:\s+[A-Z][A-Za-z.'’-]+){1,3}$/.test(candidate)&&candidate.length<70)students.add(candidate);
    }
    if(task?.school)institutions.add(String(task.school).trim());
    const instRe=/\b(?:at|from)\s+((?:[A-Z][A-Za-z&.'’()-]*\s+){1,8}(?:University|College|Institute|School))\b/g;
    for(const match of body.matchAll(instRe)){if(match[1]?.length<100)institutions.add(match[1].trim());}
    return {advisors:[...advisors].filter(Boolean),students:[...students].filter(Boolean),institutions:[...institutions].filter(Boolean)};
  }

  function reviewSemanticRanges(text,task) {
    const source=String(text||'');
    const model=reviewSemanticModel(task),ranges=[];
    const add=(start,end,type,label,priority=5)=>{if(start>=0&&end>start)ranges.push({start,end,type,label,priority});};
    const addExact=(value,type,label,priority=10)=>{
      const needle=String(value||'').trim();if(needle.length<2)return;
      const re=new RegExp(escapeRegex(needle),'gi');let m;
      while((m=re.exec(source))){add(m.index,m.index+m[0].length,type,label,priority);if(!m[0].length)re.lastIndex++;}
    };
    model.advisors.forEach(value=>addExact(value,'advisor','导师名',12));
    model.students.forEach(value=>addExact(value,'student','学生名',12));
    model.institutions.forEach(value=>addExact(value,'institution','学校 / 机构',11));
    const patterns=[
      {re:/\b(?:Dear|Hello|Hi)\b/gi,type:'anchor',label:'称呼'},
      {re:/\bMy name is\b/gi,type:'anchor',label:'身份介绍'},
      {re:/\b(?:I(?:'m| am) writing to|I would like to|I hope to)\b/gi,type:'anchor',label:'联系意图'},
      {re:/\b(?:Best Regards|Kind Regards|Warm Regards|Sincerely|Yours sincerely)\b/gi,type:'anchor',label:'落款'},
      {re:/\b(?:Ph\.?D\.?|MSc|M\.Sc\.?|Master(?:'s)?|Bachelor(?:'s)?|Fall\s+20\d{2}|Spring\s+20\d{2})\b/gi,type:'degree',label:'学位 / 时间'}
    ];
    for(const item of patterns){let m;while((m=item.re.exec(source))){add(m.index,m.index+m[0].length,item.type,item.label,4);if(!m[0].length)item.re.lastIndex++;}}
    ranges.sort((a,b)=>a.start-b.start||b.priority-a.priority||(b.end-b.start)-(a.end-a.start));
    const chosen=[];let cursor=-1;
    for(const range of ranges){if(range.start<cursor)continue;chosen.push(range);cursor=range.end;}
    return {model,ranges:chosen};
  }

  function semanticHighlightHtml(text,task) {
    const source=String(text??'');
    const {ranges}=reviewSemanticRanges(source,task);
    if(!ranges.length)return escapeHtml(source);
    let out='',cursor=0;
    for(const range of ranges){
      out+=escapeHtml(source.slice(cursor,range.start));
      out+=`<mark class="nmda-semantic-mark" data-semantic="${range.type}" title="${escapeHtml(range.label)}">${escapeHtml(source.slice(range.start,range.end))}</mark>`;
      cursor=range.end;
    }
    out+=escapeHtml(source.slice(cursor));return out;
  }

  function renderReviewSemanticLegend(task) {
    const el=$('nmda-review-semantic-legend');if(!el)return;
    const model=reviewSemanticModel(task),items=[];
    if(model.advisors[0])items.push({type:'advisor',label:'导师',value:model.advisors[0]});
    if(model.students[0])items.push({type:'student',label:'学生',value:model.students[0]});
    if(model.institutions[0])items.push({type:'institution',label:'学校 / 机构',value:model.institutions[0]});
    items.push({type:'anchor',label:'语义锚点',value:'称呼 · 身份 · 意图 · 落款'});
    if(/\b(?:Ph\.?D\.?|MSc|Master(?:'s)?|Bachelor(?:'s)?|Fall\s+20\d{2}|Spring\s+20\d{2})\b/i.test(String(task?.body||'')+' '+String(task?.subject||'')))items.push({type:'degree',label:'学位 / 时间',value:'自动定位'});
    el.innerHTML=items.map(item=>`<span class="nmda-semantic-legend-item" data-semantic="${item.type}"><i></i><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.value)}</small></span>`).join('');
  }

  function renderReviewAudit(task) {
    if(!task)return;
    const issues=unresolvedImportIssues(task);
    const issueText=issues.join('；');
    const recipient=String(task.recipients||'').trim();
    const subject=String(task.subject||'').trim();
    const body=String(task.body||'');
    const boundary=reviewBoundarySignals(task);
    const recipientOk=recipientLooksValid(recipient);
    const subjectOk=!!subject;
    const bodyOk=!!body.trim();
    const openingWarn=/称呼|邮件起点|开头|边界|请检查/.test(issueText)&&!task.reviewConfirmed;
    const closingWarn=/落款|邮件终点|结尾|边界|请检查/.test(issueText)&&!task.reviewConfirmed;
    const attachmentCount=(task.files||[]).length || (task.attachmentRefs||[]).length;
    const attachmentIssues=taskIssueState(task).attachment.length || (task.attachmentDetails||[]).filter(item=>item?.status&&item.status!=='matched').length;
    setAuditCheck('nmda-audit-check-recipient',recipientOk?'ok':'warn',recipientOk?'已识别':'需修正');
    setAuditCheck('nmda-audit-check-subject',subjectOk?'ok':'warn',subjectOk?'已识别':'缺失');
    setAuditCheck('nmda-audit-check-opening',bodyOk&&boundary.hasOpening&&!openingWarn?'ok':bodyOk?'review':'warn',bodyOk?(boundary.hasOpening&&!openingWarn?'称呼已定位':'重点核对'):'正文缺失');
    setAuditCheck('nmda-audit-check-closing',bodyOk&&boundary.hasClosing&&!closingWarn?'ok':bodyOk?'review':'warn',bodyOk?(boundary.hasClosing&&!closingWarn?'收尾已定位':'重点核对'):'正文缺失');
    const remoteAttachmentCount=(task.remoteAttachments||[]).length;
    const attachmentOkText=remoteAttachmentCount?`原草稿 ${remoteAttachmentCount} 个`:attachmentCount?`${attachmentCount} 个附件`:'无附件';
    setAuditCheck('nmda-audit-check-attachment',attachmentIssues?'warn':'ok',attachmentIssues?`${attachmentIssues} 项异常`:attachmentOkText);
    const recipientEl=$('nmda-audit-recipient'),subjectEl=$('nmda-audit-subject'),openingEl=$('nmda-audit-opening'),closingEl=$('nmda-audit-closing'),fullEl=$('nmda-audit-full-body');
    renderReviewSemanticLegend(task);
    if(recipientEl)recipientEl.innerHTML=semanticHighlightHtml(recipient||'未识别收件人',task);
    if(subjectEl)subjectEl.innerHTML=semanticHighlightHtml(subject||'未识别主题',task);
    if(openingEl)openingEl.innerHTML=semanticHighlightHtml(boundary.slices.opening,task);
    if(closingEl)closingEl.innerHTML=semanticHighlightHtml(boundary.slices.closing,task);
    if(fullEl)fullEl.innerHTML=semanticHighlightHtml(boundary.slices.full,task);
    const openingCard=$('nmda-audit-opening')?.closest('.nmda-review-edge-card');
    const closingCard=$('nmda-audit-closing')?.closest('.nmda-review-edge-card');
    if(openingCard)openingCard.dataset.state=bodyOk&&boundary.hasOpening&&!openingWarn?'ok':'review';
    if(closingCard)closingCard.dataset.state=bodyOk&&boundary.hasClosing&&!closingWarn?'ok':'review';
  }

  function setReviewCorrectionMode(mode='audit',task=reviewCurrentTask()) {
    if(mode===true)mode='correction';
    if(mode===false)mode='audit';
    mode=['audit','correction','direct'].includes(mode)?mode:'audit';
    const audit=$('nmda-review-audit-view'),panel=$('nmda-review-correction-panel'),back=$('nmda-review-back-audit'),correct=$('nmda-review-correct');
    const duplicate=!!task&&taskHasUnresolvedDuplicate(task);
    const direct=mode==='direct'&&!duplicate;
    const correction=mode==='correction'&&!duplicate;
    const fields=directCorrectionFields(task);
    if(importEditorOverlayEl){
      importEditorOverlayEl.dataset.mode=duplicate?'decision':mode;
      importEditorOverlayEl.classList.toggle('is-direct-correction',direct);
    }
    if(audit)audit.hidden=duplicate||correction;
    if(panel)panel.hidden=duplicate||(!correction&&!direct);
    if(back)back.hidden=duplicate||!correction;
    if(correct)correct.hidden=duplicate||correction||direct;
    const fieldMap={recipients:$('nmda-review-field-recipients'),subject:$('nmda-review-field-subject'),body:$('nmda-review-field-body')};
    for(const [key,el] of Object.entries(fieldMap)){if(el)el.hidden=direct&&!fields.includes(key);}
    const assist=$('nmda-subject-assist');
    if(assist&&direct&&!fields.includes('subject'))assist.hidden=true;
    const head=panel?.querySelector('.nmda-review-correction-head');
    const headStrong=head?.querySelector('strong'),headSmall=head?.querySelector('small');
    if(headStrong)headStrong.textContent=direct?'直接补齐缺失信息':'修正识别结果';
    if(headSmall)headSmall.textContent=direct?'系统已定位确定性缺失项，可直接填写；下方仍保留完整邮件审阅。':'只在发现错误时修改；返回审阅后重新核对完整邮件。';
    if((direct||correction)&&task){
      if(importEditRecipientsEl)importEditRecipientsEl.value=task?.recipients||'';
      if(importEditSubjectEl)importEditSubjectEl.value=task?.subject||'';
      if(importEditBodyEl)importEditBodyEl.value=task?.body||'';
      autoSizeReviewBody();
      if(direct)requestAnimationFrame(()=>{
        const first=fields.map(key=>fieldMap[key]?.querySelector('input,textarea')).find(Boolean);
        first?.focus?.({preventScroll:true});
      });
    }
    updateReviewConfirmationControls(task);
  }

  function returnToReviewAudit() {
    const task=reviewCurrentTask();if(!task)return;
    stashCurrentReviewDraft();
    rebuildTasks();
    const current=(batch.tasks||[]).find(item=>item.editKey===task.editKey);
    if(current)openImportTaskEditor(current);
  }

  function renderReviewSource(task) {
    const issues=unresolvedImportIssues(task);
    const candidates=reviewCandidateEmails(task);
    const recipientAssist=$('nmda-recipient-assist');
    if(recipientAssist){
      const needsRecipient=issues.some(x=>/收件人|邮箱/.test(x))&&!recipientLooksValid(task.recipients);
      recipientAssist.hidden=!(needsRecipient&&candidates.length);
      recipientAssist.innerHTML=needsRecipient&&candidates.length
        ? `<span>可选收件人：</span>${candidates.slice(0,5).map(c=>`<button type="button" data-recipient-suggestion="${escapeHtml(c.email)}" title="${escapeHtml(c.reason||'')}" >${escapeHtml(c.email)}</button>`).join('')}`
        : '';
      recipientAssist.querySelectorAll('[data-recipient-suggestion]').forEach(button=>button.addEventListener('click',()=>{
        importEditRecipientsEl.value=button.dataset.recipientSuggestion||'';
        importEditRecipientsEl.dispatchEvent(new Event('input',{bubbles:true}));
        importEditRecipientsEl.dispatchEvent(new Event('change',{bubbles:true}));
      }));
    }
    // 用户决策界面只展示做决定所需的信息；解析证据保留在内部状态/诊断层，不进入邮件审阅主流程。
    if(!reviewSourceContextEl||!reviewSourceMetaEl||!reviewCandidatesEl)return;
    const {collection,rowMeta,sourceBlocks,contextOffset=0}=taskSourceMeta(task);
    const evidenceSet=new Set(task?.importEvidence||[]);
    const effectiveConfidence=effectiveImportConfidence(task);
    const excludedBlocks=rowMeta?.excludedBlocks||[];
    const recognizedRoles=new Set((rowMeta?.blockRoles||[]).flatMap(item=>(item.roles||[]).map(role=>role.role)));
    const hasSalutation=recognizedRoles.has('salutation')||evidenceSet.has('salutation');
    const hasClosing=recognizedRoles.has('closing')||evidenceSet.has('closing');
    const hasSignature=recognizedRoles.has('signature')||evidenceSet.has('signature');
    const boundaryLocated=Number.isFinite(Number(rowMeta?.structure?.mailEndBlock??rowMeta?.endBlock))&&(hasClosing||evidenceSet.has('tail-boundary'));
    reviewSourceMetaEl.innerHTML=`<div class="nmda-parse-steps"><span data-ok="${recipientLooksValid(task.recipients)?'1':'0'}">收件人</span><span data-ok="${String(task.subject||'').trim()?'1':'0'}">主题</span><span data-ok="${hasSalutation?'1':'0'}">称呼</span><span data-ok="${String(task.body||'').trim()?'1':'0'}">正文</span><span data-ok="${hasClosing?'1':'0'}">结束语</span><span data-ok="${hasSignature?'1':'0'}">署名</span><span data-ok="${boundaryLocated?'1':'0'}">边界</span></div><span><strong>${escapeHtml(task.sourceFile||collection?.source||'来源')}</strong></span><span>${escapeHtml(task.collectionName||collection?.name||'')}</span><span>识别 ${Math.round(effectiveConfidence)}%</span>${excludedBlocks.length?`<span>已隔离 ${excludedBlocks.length} 段非正文</span>`:''}${rowMeta?.heading?`<span title="${escapeHtml(rowMeta.heading)}">对象线索：${escapeHtml(rowMeta.heading)}</span>`:''}`;
    if(!sourceBlocks.length||!rowMeta){
      reviewSourceContextEl.innerHTML=`<div class="nmda-review-fallback"><strong>来源未提供原始块定位。</strong><p>${escapeHtml(task.subject||'')}</p><pre>${escapeHtml(task.body||'')}</pre></div>`; return;
    }
    const start=Math.max(0,Number(rowMeta.startBlock||0)-contextOffset-8), end=Math.min(sourceBlocks.length-1,Number(rowMeta.consumedEndBlock ?? rowMeta.endBlock ?? rowMeta.startBlock ?? 0)-contextOffset+8);
    const emailRe=/\b[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}(?![A-Z0-9.\-])/i;
    const subjectRe=/(?:^|[\s>*#\-])(?:\*{0,2})\s*(?:subject|主题|邮件主题|邮件标题)\s*[:：]/i;
    const salutationRe=/(?:\b(?:dear|hello|hi)\s+|尊敬的|敬爱的|教授.{0,10}您好|老师.{0,10}您好)/iu;
    const closeRe=/(?:yours\s+sincerely|sincerely|best\s+regards|kind\s+regards|此致\s*敬礼|祝好)/iu;
    const html=[];
    const excludedByIndex=new Map();
    for(const item of excludedBlocks){const index=Number(item.index),list=excludedByIndex.get(index)||[];list.push(item);excludedByIndex.set(index,list);}
    const rolesByIndex=new Map((rowMeta.blockRoles||[]).map(item=>[Number(item.index),item.roles||[]]));
    const hasStructuredRoles=rolesByIndex.size>0;
    for(let i=start;i<=end;i++){
      const block=sourceBlocks[i]||{}; const text=String(block.text||'');
      const labels=[];
      const absolute=i+contextOffset,excluded=excludedByIndex.get(absolute)||[],roles=rolesByIndex.get(absolute)||[];
      if(absolute===rowMeta.startBlock)labels.push('邮件起点'); if(absolute===rowMeta.endBlock)labels.push('邮件终点');
      if(hasStructuredRoles){for(const role of roles)if(role?.label)labels.push(role.label);}
      else{
        if(subjectRe.test(text))labels.push('主题'); if(salutationRe.test(text))labels.push('称呼'); if(closeRe.test(text))labels.push('结束语'); if(emailRe.test(text))labels.push('邮箱线索');
        for(const item of excluded)labels.push(`已排除·${item.label||'非正文'}`);
      }
      const uniqueLabels=[...new Set(labels)];
      const inside=absolute>=rowMeta.startBlock&&absolute<=rowMeta.endBlock;
      const hasRecipientRole=roles.some(role=>role.role==='recipient'||role.role==='recipient-candidate')||(!hasStructuredRoles&&emailRe.test(text));
      html.push(`<div class="nmda-source-block ${inside?'is-mail-range':'is-context'} ${hasRecipientRole?'has-email':''} ${excluded.length?'is-excluded':''}"><div class="nmda-source-block-gutter"><span>${absolute+1}</span>${uniqueLabels.map(x=>`<em>${escapeHtml(x)}</em>`).join('')}</div><pre>${escapeHtml(text)}</pre></div>`);
    }
    reviewSourceContextEl.innerHTML=html.join('');
    const firstAnchor=reviewSourceContextEl.querySelector('.is-mail-range'); firstAnchor?.scrollIntoView?.({block:'nearest'});
  }

  function updateReviewConfirmationControls(task) {
    const duplicateActive=!!task&&taskHasUnresolvedDuplicate(task);
    const mode=importEditorOverlayEl?.dataset.mode||'audit';
    const correctionMode=mode==='correction';
    const directMode=mode==='direct';
    const editing=correctionMode||directMode;
    const coreValid=editing
      ? recipientLooksValid(importEditRecipientsEl?.value||'') && !!String(importEditSubjectEl?.value||'').trim() && !!String(importEditBodyEl?.value||'').trim()
      : !!task&&taskCoreValid(task);
    const save=$('nmda-import-editor-save'), next=$('nmda-import-editor-next'), correct=$('nmda-review-correct'), back=$('nmda-review-back-audit');
    if(reviewActionsEl)reviewActionsEl.hidden=duplicateActive;
    if(save){save.hidden=duplicateActive;save.disabled=!coreValid;save.textContent=editing?'保存修正':'确认无误';}
    if(next){next.hidden=duplicateActive;next.disabled=!coreValid;next.textContent=editing?'保存并下一项':'确认无误，下一封';}
    if(correct){correct.hidden=duplicateActive||editing;correct.classList.toggle('nmda-btn-primary',!coreValid);}
    if(back)back.hidden=duplicateActive||!correctionMode;
    const copy=reviewActionsEl?.querySelector('.nmda-review-action-copy');
    if(copy)copy.textContent=duplicateActive?'先完成重复邮件取舍。':directMode?'缺失项已直接展开；补齐后保存，系统会立即重新核验。':correctionMode?'修正后保存，再返回完整审阅结果。':coreValid?'重点核对开头称呼、结尾署名及邮件边界；确认无误后继续。':'识别到必填内容缺失，已直接展开可修正字段。';
  }

  function updateReviewFieldStates(task) {
    const issues=unresolvedImportIssues(task);
    const map=[['recipients','nmda-review-field-recipients',/收件人|邮箱/],['subject','nmda-review-field-subject',/主题|Subject/],['body','nmda-review-field-body',/正文|邮件称呼|邮件落款|边界/]];
    for(const [,id,re] of map){const el=$(id); if(el)el.dataset.issue=issues.some(x=>re.test(x))?'1':'0';}
    if(reviewProblemSummaryEl){
      const labels=[...new Set(issues.map(reviewIssueLabel).filter(Boolean))];
      const strip=reviewProblemSummaryEl.closest('.nmda-review-problem-strip'),shape=strip?.querySelector('.nmda-review-problem-shape');
      if(strip)strip.dataset.state=issues.length?'warn':'ok';
      if(shape)shape.textContent=issues.length?'!':'✓';
      reviewProblemSummaryEl.textContent=issues.length?(issues.every(issue=>issue==='修改待确认')?'修改已保留；请重新核对完整邮件后确认。':`识别提示：${labels.join(' · ')}`):'自动识别未发现明显问题；重点核对开头称呼与结尾署名。';
    }
    renderDuplicateDecision(task);
    updateReviewConfirmationControls(task);
  }

  function refreshReviewDraftIndicators() {
    if(importEditorOverlayEl?.hidden)return;
    const problems=[];
    const recipientOk=recipientLooksValid(importEditRecipientsEl?.value||'');
    const subjectOk=!!String(importEditSubjectEl?.value||'').trim();
    const bodyOk=!!String(importEditBodyEl?.value||'').trim();
    const states=[['nmda-review-field-recipients',recipientOk,'收件人邮箱'],['nmda-review-field-subject',subjectOk,'主题'],['nmda-review-field-body',bodyOk,'正文']];
    for(const [id,ok,label] of states){const el=$(id);if(el){el.dataset.issue=ok?'0':'1';el.dataset.resolved=ok?'1':'0';}if(!ok)problems.push(label);}
    if(reviewProblemSummaryEl){
      const key=importEditorOverlayEl?.dataset.editKey;const task=(batch.tasks||[]).find(t=>t.editKey===key);const soft=(task?unresolvedImportIssues(task):[]).filter(x=>!/(收件人|邮箱|缺少主题|缺少正文)/.test(x));
      const softLabels=[...new Set(soft.filter(x=>x!=='修改待确认').map(reviewIssueLabel).filter(Boolean))];
      const strip=reviewProblemSummaryEl.closest('.nmda-review-problem-strip'),shape=strip?.querySelector('.nmda-review-problem-shape');
      const hasProblem=problems.length||task?.reviewDraftPending||softLabels.length;
      if(strip)strip.dataset.state=hasProblem?'warn':'ok';
      if(shape)shape.textContent=hasProblem?'!':'✓';
      reviewProblemSummaryEl.textContent=problems.length?`仍需修正：${problems.join('、')}`:task?.reviewDraftPending?'修改已保留；请返回审阅完整邮件。':softLabels.length?`仍需核对：${softLabels.join(' · ')}`:'必填内容完整；返回审阅后重点核对开头与结尾。';
      updateReviewConfirmationControls(task);
    }
    if(reviewFeedbackEl)reviewFeedbackEl.hidden=true;
  }

  function renderImportTaskPreview() {
    if (typeof renderProcessGuide === 'function') renderProcessGuide();
    const resultCard=$('nmda-ingest-result-card');
    const tasks=batch.tasks||[];
    if(!batch.dataset){if(resultCard)resultCard.hidden=true;return;}
    if(resultCard)resultCard.hidden=false;
    let contentPending=0,reviewPending=0,otherBlocked=0,autoPassed=0,policyBlocked=0;
    for(const task of tasks){
      const state=taskIssueState(task);
      if(state.content.length)contentPending++;
      if(state.review.some(issue=>!/^当前批次(?:疑似)?重复：/.test(String(issue||''))))reviewPending++;
      if(state.other.length)otherBlocked++;
      if(task.policyBlocked)policyBlocked++;
      if(!taskHasBlockingIssue(task)&&!task.policyBlocked)autoPassed++;
    }
    const reviewTotal=tasks.filter(taskNeedsImportReview).length;
    const duplicateGroups=unresolvedDuplicateGroupCount();
    const stats=importAttachmentStats();
    const excluded=excludedImportCount();
    const totalDetected=tasks.length+excluded;
    const blockerTasks=tasks.filter(task=>taskHasBlockingIssue(task)).length;
    const metrics=[
      `<div class="nmda-health-metric is-total"><strong>${totalDetected}</strong><span>邮件</span></div>`,
      `<div class="nmda-health-metric is-ok"><strong>${autoPassed}</strong><span>可直接使用</span></div>`
    ];
    if(contentPending)metrics.push(`<div class="nmda-health-metric is-warn"><strong>${contentPending}</strong><span>需补内容</span></div>`);
    if(duplicateGroups)metrics.push(`<div class="nmda-health-metric is-warn"><strong>${duplicateGroups}</strong><span>重复组待选</span></div>`);
    if(reviewPending)metrics.push(`<div class="nmda-health-metric is-warn"><strong>${reviewPending}</strong><span>需人工核对</span></div>`);
    if(stats.issues)metrics.push(`<div class="nmda-health-metric is-warn is-attachment"><strong>${stats.issues}</strong><span>附件待补</span></div>`);
    if(otherBlocked)metrics.push(`<div class="nmda-health-metric is-error"><strong>${otherBlocked}</strong><span>其他阻塞</span></div>`);
    if(policyBlocked)metrics.push(`<div class="nmda-health-metric"><strong>${policyBlocked}</strong><span>联系限制</span></div>`);
    if(excluded)metrics.push(`<div class="nmda-health-metric"><strong>${excluded}</strong><span>已排除</span></div>`);
    if(importPreviewSummaryEl) importPreviewSummaryEl.innerHTML=metrics.join('');

    const guide=$('nmda-review-guidance');
    const contextPending=supplementPreflightNeedsDecision();
    if(guide){
      if(contextPending){
        guide.innerHTML='<span class="nmda-guidance-main"><strong>先完成批次准备</strong><small>参考总名单与附件会在导入后一次提示；没有的项目可以直接跳过。</small></span>';
        guide.dataset.state='context';
      }else if(blockerTasks||stats.issues){
        const parts=[];
        if(contentPending)parts.push(`${contentPending} 封先补收件人 / 主题 / 正文`);
        if(reviewPending)parts.push(`${reviewPending} 封需要人工核对`);
        if(duplicateGroups)parts.push(`${duplicateGroups} 组重复需要取舍`);
        if(stats.issues)parts.push(`${stats.issues} 个附件最后补齐`);
        if(otherBlocked)parts.push(`${otherBlocked} 封存在其他阻塞`);
        const mailBlockers=contentPending+reviewPending+duplicateGroups+otherBlocked;
        const titleText=mailBlockers?'建议先处理邮件内容':'补齐附件后即可继续';
        const nextText=mailBlockers&&stats.issues?`${parts.filter(x=>!x.includes('附件')).join('；')}；附件可最后统一补齐。`:parts.join('；');
        guide.innerHTML=`<span class="nmda-guidance-main"><strong>${titleText}</strong><small>${nextText}。</small></span>`;
        guide.dataset.state='pending';
      }else{
        guide.innerHTML='<span class="nmda-guidance-main"><strong>已准备好进入下一步</strong><small>选择本次要创建的邮件并设置时间。</small></span>';
        guide.dataset.state='ready';
      }
    }
    if(importReviewBtnEl){
      importReviewBtnEl.hidden=!tasks.length||contextPending;
      importReviewBtnEl.textContent=(blockerTasks||stats.issues)?`继续处理待办`:'查看邮件';
      importReviewBtnEl.dataset.mode=(blockerTasks||stats.issues)?'issues':'review';
    }
    const restoreExcluded=$('nmda-restore-excluded');
    if(restoreExcluded){restoreExcluded.hidden=!excluded;restoreExcluded.textContent=excluded?`恢复已排除（${excluded}）`:'恢复已排除';}
    renderAttachmentContextCue();
  }

  function updateReviewMailNavigation(task) {
    let visible=reviewVisibleTasks();
    let index=visible.findIndex(item=>item.editKey===task?.editKey);
    if(index<0){
      visible=(batch.tasks||[]).filter(item=>!item?.importExcluded);
      index=visible.findIndex(item=>item.editKey===task?.editKey);
    }
    const total=visible.length;
    if(reviewMailTitleEl)reviewMailTitleEl.textContent=String(task?.id||task?.collectionName||task?.recipients||'邮件内容');
    if(reviewPositionEl)reviewPositionEl.textContent=index>=0&&total?`${index+1} / ${total}`:`${total||0} 封`;
    if(reviewPrevEl){reviewPrevEl.disabled=index<=0;reviewPrevEl.title=index>0?'上一封邮件':'已经是第一封';}
    if(reviewNextEl){reviewNextEl.disabled=index<0||index>=total-1;reviewNextEl.title=index>=0&&index<total-1?'下一封邮件':'已经是最后一封';}
  }

  function navigateReviewMail(delta) {
    const current=reviewCurrentTask();
    if(!current)return;
    const visibleBefore=reviewVisibleTasks();
    const beforeIndex=visibleBefore.findIndex(item=>item.editKey===current.editKey);
    if(beforeIndex<0)return;
    const targetBefore=visibleBefore[beforeIndex+Number(delta||0)];
    if(!targetBefore)return;
    stashCurrentReviewDraft();
    rebuildTasks();
    renderReviewPageOverview();
    const target=(batch.tasks||[]).find(item=>item.editKey===targetBefore.editKey && !item?.importExcluded);
    if(target)openImportTaskEditor(target);
  }

  function openImportTaskEditor(task) {
    if (!task || !importEditorOverlayEl) return;
    if(subjectAssistTimer){clearTimeout(subjectAssistTimer);subjectAssistTimer=null;}
    if(reviewMoreMenuEl)reviewMoreMenuEl.open=false;
    setWorkbenchTab('batch');
    if(reviewInlineEl) reviewInlineEl.hidden=false;
    importEditorOverlayEl.dataset.editKey=task.editKey;
    importEditorOverlayEl.dataset.mode='audit';
    importEditRecipientsEl.value=task.recipients||'';
    importEditSubjectEl.value=task.subject||'';
    importEditSubjectEl.dataset.startedBlank=String(task.subject||'').trim()?'0':'1';
    importEditBodyEl.value=task.body||'';
    hideSubjectAssist();
    importEditAttachmentsEl.value=(task.attachmentRefs||[]).join('; ');
    importEditScheduleEl.value=task.scheduleAt||'';
    importEditTagsEl.value=(task.tags||[]).join('; ');
    const issues=unresolvedImportIssues(task);
    const issueLabels=[...new Set(issues.map(reviewIssueLabel).filter(Boolean))];
    const editorTitle=$('nmda-import-editor-title');
    if(editorTitle)editorTitle.textContent=`审阅邮件 · ${task.id||task.collectionName||'当前邮件'}`;
    const directFields=directCorrectionFields(task);
    if(importEditorEvidenceEl){
      const scheduleNote=task.scheduleAt?`${scheduleSourceLabel(task)}：${String(task.scheduleAt).replace('T',' ')}`:'';
      importEditorEvidenceEl.textContent=directFields.length
        ? `系统已定位缺失：${directFields.map(key=>({recipients:'收件人',subject:'主题',body:'正文'}[key]||key)).join(' · ')}；无需再点“修正”，可直接补齐。${scheduleNote?` ${scheduleNote}。`:''}`
        : issues.length
          ? `识别到 ${issueLabels.length} 类待核验项：${issueLabels.join(' · ')}${scheduleNote?`；${scheduleNote}`:''}`
          : scheduleNote
            ? `自动识别未发现明显问题；${scheduleNote}。`
            : '自动识别未发现明显问题；建议重点抽查开头与结尾。';
    }
    if(reviewFeedbackEl){reviewFeedbackEl.hidden=true;reviewFeedbackEl.textContent='';}
    updateReviewFieldStates(task);
    renderReviewSource(task);
    renderReviewAudit(task);
    importEditorOverlayEl.hidden=false;
    importEditorOverlayEl.setAttribute('aria-hidden','false');
    setReviewCorrectionMode(directFields.length?'direct':'audit',task);
    syncModalState();
    renderReviewQueue(task.editKey);
    updateReviewMailNavigation(task);
    requestAnimationFrame(()=>$(directFields.length?'nmda-review-correction-panel':'nmda-review-audit-view')?.scrollIntoView?.({block:'start'}));
  }

  function closeImportTaskEditor(){
    if(subjectAssistTimer){clearTimeout(subjectAssistTimer);subjectAssistTimer=null;}
    stashCurrentReviewDraft();
    hideSubjectAssist();
    if(importEditorOverlayEl){importEditorOverlayEl.hidden=true;importEditorOverlayEl.setAttribute('aria-hidden','true');delete importEditorOverlayEl.dataset.editKey;}
    syncModalState();
    renderReviewQueue('');
  }

  async function saveImportTaskEditor(goNext=false) {
    if(!importEditorOverlayEl)return;
    batch.handoffComplete=false;
    const key=importEditorOverlayEl.dataset.editKey;
    const mode=importEditorOverlayEl.dataset.mode||'audit';
    const task=(batch.tasks||[]).find(t=>t.editKey===key); if(!task){closeImportTaskEditor();return;}
    const recipients=importEditRecipientsEl.value.trim(), subject=importEditSubjectEl.value.trim(), body=importEditBodyEl.value;
    const coreValid=recipientLooksValid(recipients)&&!!subject&&!!String(body||'').trim();
    stashCurrentReviewDraft();
    rebuildTasks();
    let current=(batch.tasks||[]).find(t=>t.editKey===key);

    // Deterministic gaps are a repair operation, not a human approval shortcut.
    // After the missing values are filled, unresolved soft/ambiguous issues must return to
    // the read-first audit instead of being silently marked confirmed.
    if(mode==='direct'){
      if(!coreValid || (current&&taskNeedsDirectCorrection(current))){
        if(reviewFeedbackEl){reviewFeedbackEl.hidden=false;reviewFeedbackEl.textContent='仍有必填信息未补齐，请直接完成上方缺失项。';}
        if(current)openImportTaskEditor(current);
        return;
      }
      if(current&&taskNeedsImportReview(current)){
        openImportTaskEditor(current);
        setImportStatus('缺失信息已补齐；仍有不确定项，请继续核对完整邮件。','warn');
        return;
      }
      renderReviewPageOverview();
      if(!goNext){
        closeImportTaskEditor();
        setImportStatus('缺失信息已补齐并通过重新校验。','ok');
        return;
      }
      const next=reviewTasks()[0]||null;
      if(next)openImportTaskEditor(next);
      else{closeImportTaskEditor();renderReviewPageOverview();setImportStatus('缺失信息已补齐；当前没有其他邮件待处理。','ok');}
      return;
    }

    const previousEdit=batch.taskEdits.get(key)||{};
    setTaskEdit(current||task,{
      reviewConfirmed:coreValid,
      rosterConfirmed: coreValid && !!((current||task).rosterIssues||[]).length ? true : (previousEdit.rosterConfirmed||false),
      duplicateConfirmedGroups:[...(previousEdit.duplicateConfirmedGroups||[])]
    });
    rebuildTasks();
    current=(batch.tasks||[]).find(t=>t.editKey===key);
    if(current && taskNeedsImportReview(current)){
      if(reviewFeedbackEl){reviewFeedbackEl.hidden=false;reviewFeedbackEl.textContent=`仍需处理：${unresolvedImportIssues(current).join('；')}`;}
      openImportTaskEditor(current); return;
    }
    renderReviewPageOverview();
    if(!goNext){
      closeImportTaskEditor();
      setImportStatus('已确认本封；返回邮件状态板继续抽查或处理其他异常。','ok');
      return;
    }
    const next=reviewTasks()[0]||null;
    if(next)openImportTaskEditor(next);
    else{
      closeImportTaskEditor();
      renderReviewPageOverview();
      setImportStatus('邮件审阅完成；如需抽查仍可点击任意邮件。','ok');
    }
  }

  async function excludeCurrentReviewTask() {
    batch.handoffComplete=false;
    const key=importEditorOverlayEl?.dataset.editKey; if(!key)return;
    const task=(batch.tasks||[]).find(t=>t.editKey===key); if(!task)return;
    const label=String(task.subject||task.recipients||task.id||'这封邮件').trim();
    if(reviewMoreMenuEl)reviewMoreMenuEl.open=false;
    batch.reviewSelected?.delete?.(key);
    setTaskEdit(task,{importExcluded:true});
    rebuildTasks();
    setImportStatus(`已排除「${label}」；需要时可在待办中心恢复。`,'ok');
    const next=reviewVisibleTasks()[0]||null;
    if(next)openImportTaskEditor(next);else await continueAfterReviewResolution('待处理邮件已完成');
  }

  async function registerCurrentBatchContacts(sessionToken = batch.sessionId) {
    if (!Contacts || !(batch.tasks || []).length || !isCurrentBatchSession(sessionToken)) return 0;
    try {
      await ensureContactBook();
      if (!isCurrentBatchSession(sessionToken)) return 0;
      const recipients = [];
      for (const task of batch.tasks || []) recipients.push(...Contacts.parseRecipients(task.recipients));
      if (!isCurrentBatchSession(sessionToken)) return 0;
      const added = Contacts.mergeRecipientList(contactBook.contacts, recipients, '未联系');
      if (!isCurrentBatchSession(sessionToken)) return 0;
      if (added) markContactsChanged();
      await persistContacts();
      if (!isCurrentBatchSession(sessionToken)) return added;
      if (added) scheduleContactsRender();
      if (batch.dataset && added) scheduleBatchRender({aux:false});
      return added;
    } catch (error) {
      console.warn(`[${APP}] contact registration failed`, error);
      return 0;
    }
  }

  function parseTaskClassifications(value) {
    const items = Contacts?.parseTags?.(value) || [];
    const reserved = new Set((Contacts?.SYSTEM_CLASSIFICATIONS || []).map(item => item.toLocaleLowerCase('zh-CN')));
    return items.filter(item => !reserved.has(item.toLocaleLowerCase('zh-CN')));
  }

  function taskContactSnapshot(task) {
    if (!task) return { state:{stage:'未联系',stages:['未联系'],followUp:false,policies:[],blocked:false}, tags:[], classifications:[] };
    const recipients = task.recipients || '';
    if (task._contactSnapshotVersion === viewPerf.contactVersion && task._contactSnapshotRecipients === recipients && task._contactSnapshot) return task._contactSnapshot;
    const snapshot = {
      state: contactStateForRecipients(recipients),
      tags: contactTagsForRecipients(recipients),
      classifications: contactClassificationsForRecipients(recipients)
    };
    task._contactSnapshotVersion = viewPerf.contactVersion;
    task._contactSnapshotRecipients = recipients;
    task._contactSnapshot = snapshot;
    return snapshot;
  }

  function taskEffectiveClassifications(task) {
    const own = parseTaskClassifications(task.tags || []);
    return Contacts ? Contacts.mergeTags(taskContactSnapshot(task).classifications, own) : own;
  }

  // Backward-compatible internal alias: v0.7 stored task custom classifications in `tags`.
  function taskEffectiveTags(task) { return taskEffectiveClassifications(task); }

  function normalizedSearchText(value) {
    return String(value || '').toLocaleLowerCase('zh-CN').replace(/\s+/g, ' ').trim();
  }

  function taskMatchesSearch(task) {
    const query = normalizedSearchText(batchSearchEl?.value || '');
    if (!query) return true;
    const state = taskContactSnapshot(task).state;
    const dynamic = normalizedSearchText([
      state.stages.join(' '),
      state.followUp ? '待跟进' : '',
      taskBusinessTags(task).join(' '),
      statusLabel(task)
    ].join(' '));
    const haystack = `${task._searchStatic || ''} ${dynamic}`;
    return query.split(/\s+/).filter(Boolean).every(token => haystack.includes(token));
  }

  function normalizedTagSet(tags) {
    return new Set((Contacts?.parseTags?.(tags) || []).map(tag => tag.toLocaleLowerCase('zh-CN')));
  }

  function taskMatchesTagFilter(task) {
    if (!taskMatchesSearch(task)) return false;
    const stageFilter=String(batchStageFilterEl?.value || '').trim();
    if(stageFilter){
      const state=taskContactSnapshot(task).state;
      if(!state.stages.includes(stageFilter)) return false;
    }
    const include = Contacts?.parseTags?.(batchTagIncludeEl?.value || '') || [];
    if (!include.length) return true;
    const own = normalizedTagSet(taskBusinessTags(task));
    const includeKeys = include.map(tag => tag.toLocaleLowerCase('zh-CN'));
    return includeKeys.every(tag => own.has(tag));
  }

  function filteredBatchTasks() {
    return (batch.tasks || []).filter(taskMatchesTagFilter);
  }

  function refreshTaskCoreValidation(task) {
    if(!task)return;
    const errors=(task.errors||[]).filter(error=>!/^(缺少收件人|收件人邮箱格式无效|缺少主题|缺少正文)$/.test(String(error||'')));
    if(!String(task.recipients||'').trim())errors.push('缺少收件人');
    else if(!recipientLooksValid(task.recipients))errors.push('收件人邮箱格式无效');
    if(!String(task.subject||'').trim())errors.push('缺少主题');
    if(!String(task.body||'').trim())errors.push('缺少正文');
    task.errors=[...new Set(errors)];
    task.warnings=(task.warnings||[]).filter(warning=>{
      const text=String(warning||'');
      if(/主题为空/.test(text)&&String(task.subject||'').trim())return false;
      if(/未定位收件人|无收件人/.test(text)&&recipientLooksValid(task.recipients))return false;
      if(/正文过短/.test(text)&&String(task.body||'').length>=40)return false;
      return true;
    });
    if(task.status==='ready'||task.status==='error')task.status=task.errors.length?'error':'ready';
  }

  function setTaskEdit(task, patch) {
    const prev = batch.taskEdits.get(task.editKey) || {};
    const beforeReviewIssues=unresolvedImportIssues(task);
    const coreChanged=(patch.recipients!=null && String(patch.recipients||'').trim()!==String(task.recipients||'').trim())
      || (patch.subject!=null && String(patch.subject||'').trim()!==String(task.subject||'').trim())
      || (patch.body!=null && String(patch.body||'')!==String(task.body||''));
    const next = { ...prev, ...patch };
    const duplicateIdentityChanged=(patch.recipients!=null && String(patch.recipients||'').trim()!==String(task.recipients||'').trim())
      || (patch.school!=null && String(patch.school||'').trim()!==String(task.school||'').trim());
    if(duplicateIdentityChanged && patch.duplicateConfirmedGroups==null)next.duplicateConfirmedGroups=[];
    let deterministicRepairClearsAll=false;
    if(coreChanged && patch.reviewConfirmed==null && beforeReviewIssues.length){
      const hadDeterministicGap=beforeReviewIssues.some(isAutoResolvableReviewIssue)
        || !recipientLooksValid(task.recipients||'') || !String(task.subject||'').trim() || !String(task.body||'').trim();
      if(hadDeterministicGap){
        const prospective={...task,...patch,reviewConfirmed:false,reviewDraftPending:false};
        deterministicRepairClearsAll=unresolvedImportIssues(prospective).length===0;
      }
    }
    if(coreChanged && patch.reviewConfirmed==null){
      next.reviewConfirmed=false;
      // Missing-field repairs are evaluated against the resulting current facts. If the repair
      // removes every remaining review reason, no second confirmation is required. Editing a
      // previously clean mail or a genuinely ambiguous parse still needs explicit confirmation.
      next.reviewDraftPending=!deterministicRepairClearsAll;
    }
    if(patch.reviewConfirmed===true)next.reviewDraftPending=false;
    if (patch.tags != null) next.tags = parseTaskClassifications(patch.tags);
    batch.taskEdits.set(task.editKey, next);
    if (patch.enabled != null || patch.school != null || patch.scheduleAt != null) batch.schedulePlan = null;
    if (patch.enabled != null) task.enabled = !!patch.enabled;
    if(coreChanged && patch.reviewConfirmed==null){task.reviewConfirmed=false;task.reviewDraftPending=!deterministicRepairClearsAll;}
    if(patch.reviewConfirmed===true){task.reviewConfirmed=true;task.reviewDraftPending=false;}
    if(patch.duplicateConfirmedGroups!=null)task.duplicateConfirmedGroups=[...(patch.duplicateConfirmedGroups||[])];
    else if(duplicateIdentityChanged)task.duplicateConfirmedGroups=[];
    if (patch.recipients != null) task.recipients = String(patch.recipients || '').trim();
    if (patch.subject != null) task.subject = String(patch.subject || '').trim();
    if (patch.body != null) task.body = String(patch.body || '');
    if (patch.tags != null) task.tags = parseTaskClassifications(patch.tags);
    if (patch.school != null) task.school = String(patch.school || '').trim();
    if (patch.scheduleAt != null) task.scheduleAt = String(patch.scheduleAt || '');
    if (patch.scheduleSource != null) task.scheduleSource = String(patch.scheduleSource || '');
    if (patch.scheduleReason != null) task.scheduleReason = String(patch.scheduleReason || '');
    if (patch.recipients != null || patch.subject != null || patch.body != null) refreshTaskCoreValidation(task);
    if (patch.recipients != null || patch.subject != null || patch.body != null || patch.school != null || patch.scheduleAt != null || patch.tags != null) refreshTaskSearchStatic(task);
  }

  function mappingSelectHtml(field, headers) {
    const selected = batch.mapping[field.key];
    const options = [`<option value="">— 不导入 —</option>`, ...headers.map((header, index) => `<option value="${index}" ${Number(selected) === index ? 'selected' : ''}>${escapeHtml(header || `来源字段${index + 1}`)}</option>`)].join('');
    return `<label class="nmda-map-row"><span>${escapeHtml(field.label)}</span><select data-map-field="${field.key}">${options}</select></label>`;
  }

  function setMappingEditorOpen(open) {
    if (!mappingEl || !mappingToggleEl) return;
    const isOpen = !!open;
    mappingEl.hidden = !isOpen;
    mappingToggleEl.setAttribute('aria-expanded', String(isOpen));
    mappingToggleEl.textContent = isOpen ? '收起调整' : '调整对应内容';
  }

  function configureCollection(index, useAuto = true) {
    batch.collectionIndex = Number(index) || 0;
    const collection = currentCollection();
    if (!collection) return;
    const config = ensureCollectionConfig(batch.collectionIndex, { reset: useAuto });
    batch.detection = config.detection;
    batch.mapping = config.mapping;
    const headers = batch.detection.headers || [];
    const detectedCount = Object.keys(batch.mapping || {}).length;
    const hasCore = batch.mapping.recipients != null && (batch.mapping.subject != null || batch.mapping.body != null);
    const avgConfidence = Math.round(batch.detection.avgConfidence || 0);
    const lowFields = Object.entries(batch.detection.confidence || {}).filter(([key, score]) => batch.mapping[key] != null && score < 70).map(([key]) => Importer.FIELD_DEFS.find(x => x.key === key)?.label || key);
    const kind = collectionKind(collection,config.purpose);
    const isMail=config.purpose==='mail';
    const advancedMappingCard=$('nmda-mapping-card'); if(advancedMappingCard)advancedMappingCard.hidden=!isMail||!!collection.meta?.mailFrames;
    const originWord = collection.meta?.wordTaskRows;
    const mailScan = collection.meta?.mailScan;
    const originText = collection.meta?.mailFrames
      ? `已整理邮件内容${mailScan ? `（${mailScan.records || 0} 封）` : ''}`
      : originWord ? '已整理来源内容' : '已找到可用内容';
    $('nmda-header-info').textContent = isMail
      ? `${kind.label} · 已识别 ${detectedCount} 项内容${lowFields.length ? `；建议检查：${lowFields.join('、')}` : ''}${hasCore ? '。' : '；收件人、主题或正文仍需调整。'}`
      : `${kind.label} · ${(collection.meta?.purposeReasons||[]).join('；')||'该组内容不会生成邮件任务。'}`;
    mappingEl.innerHTML = isMail?Importer.FIELD_DEFS.map(field => mappingSelectHtml(field, headers)).join(''):'';
    const format = collection.meta?.format || batch.dataset?.format || '';
    config.profileSuggestion = isMail?(Importer.suggestProfile?.({ format, headers }) || null):null;
    batch.profileSuggestion = config.profileSuggestion;
    const applyProfileBtn = $('nmda-apply-profile');
    const profileInfo = $('nmda-profile-info');
    if (applyProfileBtn) applyProfileBtn.hidden = !(config.profileSuggestion?.score >= 0.72);
    if (profileInfo) profileInfo.textContent = config.profileSuggestion?.score >= 0.72 ? `可以使用已保存设置“${config.profileSuggestion.profile.name}”。` : '';
    setMappingEditorOpen(isMail&&(!hasCore || lowFields.length > 0));
    renderCollectionList();
    renderCollectionOverview();
    renderSemanticSummary();
    mappingEl.querySelectorAll('select[data-map-field]').forEach(select => select.addEventListener('change', () => {
      const field = select.dataset.mapField;
      if (select.value === '') delete config.mapping[field]; else config.mapping[field] = Number(select.value);
      batch.mapping = config.mapping;
      batch.handoffComplete=false;
      renderSemanticSummary();
      rebuildTasks();
    }));
    rebuildTasks();
  }

  function allAttachmentFiles() {
    syncAttachmentPolicies();
    return uniqueFiles([...batch.directoryFiles, ...batch.taskFiles, ...batch.routedAttachmentFiles, ...batch.sharedFiles]);
  }

  function attachmentFileEligibleForTask(file,taskKey){
    const policy=attachmentPolicyForFile(file);
    if(policy.mode==='selected')return (policy.targets||[]).includes(taskKey);
    return true;
  }

  function attachmentPoolFiles(taskKey='') {
    return allAttachmentFiles().filter(file=>!taskKey||attachmentFileEligibleForTask(file,taskKey));
  }

  function attachmentExtraFilesForTask(taskKey){
    return allAttachmentFiles().filter(file=>{const policy=attachmentPolicyForFile(file);return policy.mode==='all'||(policy.mode==='selected'&&(policy.targets||[]).includes(taskKey));});
  }

  function clearStaleOverrides() {
    const valid = new Set(allAttachmentFiles().map(file => Importer.fileIdentity(file)));
    for (const [key, file] of batch.attachmentOverrides) if (!valid.has(Importer.fileIdentity(file))) batch.attachmentOverrides.delete(key);
  }

  function refreshFileIndex(resetOverrides = false) {
    if(batch.handoffComplete) batch.handoffComplete=false;
    if (resetOverrides) batch.attachmentOverrides.clear();
    clearStaleOverrides();
    const files = allAttachmentFiles();
    batch.fileIndex = Importer.buildFileIndex(files);
    const counts={smart:0,all:0,selected:0};for(const file of files){const mode=attachmentPolicyForFile(file).mode||'smart';counts[mode]=(counts[mode]||0)+1;}
    const totalBytes = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
    const sizeText = totalBytes < 1024 * 1024 ? `${Math.round(totalBytes / 1024)} KB` : `${(totalBytes / 1024 / 1024).toFixed(1)} MB`;
    const info=$('nmda-file-index-info');if(info)info.textContent=files.length?`已准备 ${files.length} 个附件（自动 ${counts.smart} / 全部 ${counts.all} / 指定 ${counts.selected}，共 ${sizeText}）。`:'尚未选择本地附件。';
    rebuildTasks();renderAttachmentAssetViews();
    if(batch.tasks.length){ if(batch.dataset&&!batch.importBusy)void enterSelectionAndSchedule('资料已补齐'); }
  }

  function mergeTaskFiles(resolvedFiles,taskKey) {
    return uniqueFiles([...(resolvedFiles || []), ...attachmentExtraFilesForTask(taskKey)]);
  }

  function resolveAttachmentRefs(refs,taskKey='') {
    const pool=attachmentPoolFiles(taskKey),index=Importer.buildFileIndex(pool);
    const resolved = Importer.resolveFiles(refs, index);
    const files = [],missing = [],ambiguous = [],details = [];
    for (const detail of resolved.details || []) {
      const key = Importer.normalizeFileKey(detail.ref),override = batch.attachmentOverrides.get(key);
      if (override && (!taskKey || attachmentFileEligibleForTask(override,taskKey))) {
        files.push(override);details.push({ ...detail, status: 'matched', file: override, method: 'manual' });
      } else if (detail.status === 'matched') { files.push(detail.file); details.push(detail); }
      else { details.push(detail); if (detail.status === 'missing') missing.push(detail.ref); else ambiguous.push(detail.ref); }
    }
    return { files: uniqueFiles(files), missing, ambiguous, details };
  }

  function actionableAttachmentRefs(refs) {
    const nonRequirements=/^(?:https?:\/\/|www\.|source|sources|reference|references|profile|homepage|website|link|url|来源|参考资料|导师主页|教授主页|学校主页|网页链接)$/iu;
    return (refs||[]).map(ref=>String(ref||'').trim()).filter(ref=>{
      if(!ref||nonRequirements.test(ref))return false;
      if(/^(?:https?:\/\/|www\.)/iu.test(ref)){
        const clean=ref.split(/[?#]/)[0];
        return /\.(?:pdf|docx?|xlsx?|pptx?|zip|rar)$/iu.test(clean);
      }
      return true;
    });
  }

  function emptyRosterState(overrides={}) {
    return {dataset:null,entries:[],manualEntries:[],routedEntries:[],audit:null,warnings:[],manualWarnings:[],routedWarnings:[],enabled:true,autoSchool:true,strict:false,sourceNames:[],manualSourceNames:[],routedSourceNames:[],...overrides};
  }

  function rosterState() {
    if (!batch.roster) batch.roster=emptyRosterState();
    const state=batch.roster;
    if(!Array.isArray(state.manualEntries))state.manualEntries=state.routedEntries?.length?[]:[...(state.entries||[])];
    if(!Array.isArray(state.routedEntries))state.routedEntries=[];
    if(!Array.isArray(state.manualSourceNames))state.manualSourceNames=state.routedSourceNames?.length?[]:[...(state.sourceNames||[])];
    if(!Array.isArray(state.routedSourceNames))state.routedSourceNames=[];
    if(!Array.isArray(state.manualWarnings))state.manualWarnings=state.routedWarnings?.length?[]:[...(state.warnings||[])];
    if(!Array.isArray(state.routedWarnings))state.routedWarnings=[];
    return state;
  }

  function mergeUniqueRosterEntries(entries){
    const out=[],seen=new Set();
    for(const entry of entries||[]){
      const key=[String(entry?.email||'').toLowerCase(),Roster?.normalizeName?.(entry?.name||'')||'',String(entry?.schoolKey||entry?.school||'').toLowerCase()].join('|');
      if(key!=='||'&&seen.has(key))continue;if(key!=='||')seen.add(key);out.push(entry);
    }
    return out;
  }

  function syncRosterParts(){
    const state=rosterState();
    state.entries=mergeUniqueRosterEntries([...(state.manualEntries||[]),...(state.routedEntries||[])]);
    state.sourceNames=[...new Set([...(state.manualSourceNames||[]),...(state.routedSourceNames||[])])];
    state.warnings=[...new Set([...(state.manualWarnings||[]),...(state.routedWarnings||[])])];
    state.audit=null;
    const status=$('nmda-roster-source-status');
    if(status)status.textContent=state.entries.length?`已添加 ${state.entries.length} 条参考名单${state.sourceNames.length?` · ${state.sourceNames.join('、')}`:''}`:'未添加总名单。';
    const remove=$('nmda-roster-remove');if(remove)remove.hidden=!state.entries.length;
  }

  function syncRoutedSources(){
    const sets=recordSets(),rosterSets=[],attachmentSources=new Set();
    for(let index=0;index<sets.length;index++){
      const collection=sets[index],config=ensureCollectionConfig(index);if(!collection||!config)continue;
      if(config.purpose==='roster')rosterSets.push(collection);
      if(config.purpose==='attachment')for(const source of (collection.meta?.sourceMembers?.length?collection.meta.sourceMembers:[collection.source]))attachmentSources.add(String(source||''));
    }
    const state=rosterState();
    if(Roster&&rosterSets.length){
      const parsed=Roster.parseDataset({recordSets:rosterSets,sheets:rosterSets});
      state.routedEntries=parsed.entries||[];state.routedWarnings=parsed.warnings||[];state.routedSourceNames=[...new Set(rosterSets.map(set=>String(set.source||set.name||'')).filter(Boolean))];
    }else{state.routedEntries=[];state.routedWarnings=[];state.routedSourceNames=[];}
    syncRosterParts();
    batch.routedAttachmentFiles=uniqueFiles((batch.dataset?.sourceFiles||[]).filter(file=>(attachmentSources.has(sourceFileName(file))||attachmentSources.has(String(file?.name||'')))&&!batch.ignoredAttachmentIdentities.has(Importer.fileIdentity(file))));
  }

  function applyBatchDuplicateAudit(tasks){
    for(const task of tasks||[]){task.duplicateIssues=[];task.duplicateGroupIds=[];task.batchDuplicate=false;}
    const audit=Roster?.auditTaskDuplicates?.(tasks||[])||{groups:[],summary:{tasks:(tasks||[]).length,groups:0,exact:0,probable:0,affectedTasks:0}};
    for(const group of audit.groups||[]){
      const count=group.tasks?.length||0;
      const message=group.type==='exact-email'
        ? `当前批次重复：${group.email||group.label||'同一收件人'} 有 ${count} 封邮件，需选择保留版本`
        : `当前批次疑似重复：${group.label||'同一联系人'} 有 ${count} 封邮件，需确认是否为同一联系人`;
      for(const task of group.tasks||[]){
        if(!task)continue;task.batchDuplicate=true;
        if(!task.duplicateGroupIds.includes(group.id))task.duplicateGroupIds.push(group.id);
        if(!task.duplicateIssues.some(item=>item.id===group.id))task.duplicateIssues.push({id:group.id,message,type:group.type});
      }
    }
    batch.duplicateAudit=audit;
    return audit;
  }

  function applyRosterCrossCheck(tasks) {
    const state=rosterState();
    if(!Roster || !state.enabled || !state.entries.length){state.audit=null;return null;}
    const audit=Roster.crossCheck(tasks,state.entries);
    const byKey=new Map((tasks||[]).map(t=>[t.editKey,t]));
    for(const match of audit.matches){
      const task=match.task;if(!task)continue;
      const edit=batch.taskEdits.get(task.editKey)||{};
      task.rosterMatchStatus=match.status;
      task.rosterMatchScore=Number(match.score||0);
      task.rosterMatchBy=match.by||'';
      task.rosterReference=match.entry?{...match.entry}:null;
      task.rosterEmailCandidate=match.emailCandidate||'';
      task.rosterIssues=[];
      if(match.status==='conflict'&&match.entry?.school){
        task.scheduleGroupNotice=`院校信息不一致，排程已使用总名单中的“${match.entry.school}”`;
        if(state.autoSchool){task.school=match.entry.school;task.schoolSource='roster';}
      }
      if(match.schoolSupplement && state.autoSchool && match.entry?.school && !task.school){
        task.school=match.entry.school;task.schoolSource='roster';task.rosterSchoolSupplemented=true;
      }
      if(!edit.rosterConfirmed){
        if(match.status==='ambiguous')task.rosterIssues.push('总名单中找到多条相似记录，请检查联系人');
        if(match.status==='off-roster' && state.strict)task.rosterIssues.push('当前邮件未在总套磁名单中找到对应导师');
      }
      if(match.entry){
        task.rosterMeta={country:match.entry.country||'',batch:match.entry.batch||'',status:match.entry.status||'',priority:match.entry.priority||'',priorityOrder:match.entry.priorityOrder!=null&&String(match.entry.priorityOrder).trim()!==''&&Number.isFinite(Number(match.entry.priorityOrder))?Number(match.entry.priorityOrder):null,tags:[...(match.entry.tags||[])],notes:match.entry.notes||''};
      }
    }
    for(const dup of audit.duplicateMatches||[]){
      for(const m of dup.matches||[]){
        const task=byKey.get(m.task?.editKey);if(!task)continue;
        const edit=batch.taskEdits.get(task.editKey)||{};
        task.rosterDuplicate=true;
        if(!task.batchDuplicate && !edit.rosterConfirmed && !task.rosterIssues.includes('总名单核验：同一导师对应多封当前邮件'))task.rosterIssues.push('总名单核验：同一导师对应多封当前邮件');
      }
    }
    for(const task of tasks||[]){
      if(task.rosterMatchStatus==='off-roster' && !state.strict) task.warnings=[...new Set([...(task.warnings||[]),'总名单：当前邮件未匹配到参考名单（仅提示）'])];
      if((task.rosterIssues||[]).length){task.errors=[...new Set([...(task.errors||[]),...task.rosterIssues])];task.status='error';}
    }
    state.audit=audit;
    return audit;
  }

  function rosterEntryLabel(entry){
    if(!entry)return '未知记录';
    return [entry.name,entry.school,entry.email].filter(Boolean).join(' · ')||`第 ${entry.sourceRow||'?'} 行`;
  }

  function contactHistoryAudit(tasks){
    if(!Contacts||!contactBook.loaded)return {loaded:false,rows:[],affectedTasks:0,sentTasks:0,draftTasks:0};
    const rows=[];const affected=new Set(),sentTasks=new Set(),draftTasks=new Set();
    for(const task of tasks||[]){
      const taskKey=String(task?.editKey||task?.id||'');
      for(const recipient of Contacts.parseRecipients(task?.recipients||'')){
        const contact=contactBook.contacts?.[recipient.email];if(!contact)continue;
        const sentCount=Number(contact.sentCount||0),draftCount=Number(contact.draftCount||0);
        if(!sentCount&&!draftCount)continue;
        affected.add(taskKey);if(sentCount)sentTasks.add(taskKey);if(draftCount)draftTasks.add(taskKey);
        rows.push({task,email:recipient.email,sentCount,draftCount,lastSentAt:contact.lastSentAt||'',lastDraftAt:contact.lastDraftAt||'',lastSubject:contact.lastSubject||'',lastDraftSubject:contact.lastDraftSubject||''});
      }
    }
    return {loaded:true,rows,affectedTasks:affected.size,sentTasks:sentTasks.size,draftTasks:draftTasks.size};
  }

  function renderRosterAudit(){
    const state=rosterState(),card=$('nmda-roster-audit-card'),summary=$('nmda-roster-audit-summary'),note=$('nmda-roster-audit-note'),details=$('nmda-roster-audit-details');
    const enabledEl=$('nmda-roster-enabled'),schoolEl=$('nmda-roster-auto-school'),strictEl=$('nmda-roster-strict');
    if(enabledEl)enabledEl.checked=state.enabled!==false;if(schoolEl)schoolEl.checked=state.autoSchool!==false;if(strictEl)strictEl.checked=!!state.strict;
    if(!card)return;
    const tasks=batch.tasks||[];
    card.hidden=!tasks.length&&!state.entries.length;
    if(card.hidden)return;

    const duplicateAudit=batch.duplicateAudit || Roster?.auditTaskDuplicates?.(tasks) || {groups:[],summary:{tasks:tasks.length,groups:0,exact:0,probable:0,affectedTasks:0}};
    const history=contactHistoryAudit(tasks);
    const rosterAudit=state.entries.length ? (state.audit || (Roster&&tasks.length?Roster.crossCheck(tasks,state.entries):null)) : null;
    const dx=duplicateAudit.summary||{};
    const metrics=[];
    if(tasks.length)metrics.push(`<div class="nmda-import-metric"><strong>${tasks.length}</strong><span>当前邮件</span></div>`);
    metrics.push(`<div class="nmda-import-metric ${dx.groups?'is-warn':''}"><strong>${dx.groups||0}</strong><span>批次重复</span></div>`);
    if(history.loaded&&history.affectedTasks)metrics.push(`<div class="nmda-import-metric"><strong>${history.affectedTasks}</strong><span>已有记录</span></div>`);
    if(state.entries.length)metrics.push(`<div class="nmda-import-metric"><strong>${state.entries.length}</strong><span>参考名单</span></div>`);
    if(rosterAudit){
      const x=rosterAudit.summary||{};
      metrics.push(`<div class="nmda-import-metric"><strong>${x.matched||0}</strong><span>名单匹配</span></div>`);
      if(x.unwritten)metrics.push(`<div class="nmda-import-metric"><strong>${x.unwritten}</strong><span>尚未加入</span></div>`);
      if(x.ambiguous||x.duplicates)metrics.push(`<div class="nmda-import-metric is-warn"><strong>${(x.ambiguous||0)+(x.duplicates||0)}</strong><span>名单待核对</span></div>`);
    }
    if(summary)summary.innerHTML=metrics.join('');

    if(note){
      const parts=[];
      if(dx.groups)parts.push(`发现 <strong>${dx.groups}</strong> 组当前批次重复，请在“检查邮件”中选择保留版本；需要多封时可明确“全部保留”`);
      else if(tasks.length)parts.push('当前批次未发现重复联系人；无需总名单也会自动完成这一步');
      if(history.loaded&&history.affectedTasks)parts.push(`<strong>${history.affectedTasks}</strong> 封对应联系人已有邮箱发送或草稿记录，仅作提醒`);
      if(rosterAudit){
        const x=rosterAudit.summary||{};
        const rosterParts=[];
        if(x.schoolSupplements)rosterParts.push(`补充 ${x.schoolSupplements} 条院校信息`);
        if(x.emailCandidates)rosterParts.push(`找到 ${x.emailCandidates} 个缺失邮箱候选`);
        if(x.unwritten)rosterParts.push(`${x.unwritten} 位名单联系人尚未加入本批次`);
        parts.push(`参考总名单${rosterParts.length?`额外${rosterParts.join('、')}`:'已完成交叉核对'}`);
      }else if(state.entries.length&&!tasks.length)parts.push('参考总名单已就绪；加入邮件后会自动进行交叉核对');
      note.innerHTML=parts.length?`${parts.join('；')}。`:'核验将在加入邮件后自动开始。';
    }

    if(details){
      const section=(title,items,render,more=0)=>`<div class="nmda-roster-diff-section"><strong>${escapeHtml(title)}</strong>${items.length?`<div>${items.map(render).join('')}</div>`:'<small>无</small>'}${more>items.length?`<small>另有 ${more-items.length} 条未展开</small>`:''}</div>`;
      let html='';
      const duplicateGroups=(duplicateAudit.groups||[]).slice(0,12);
      html+=section('当前批次查重',duplicateGroups,g=>{
        const ids=(g.tasks||[]).map(task=>task.id||task.recipients||'邮件').slice(0,4).join('、');
        const kind=g.type==='exact-email'?'同一邮箱':'同名同院校';
        return `<span>${escapeHtml(g.label||g.email||'联系人')} · ${escapeHtml(kind)} · ${g.tasks?.length||0} 封${ids?` · ${escapeHtml(ids)}`:''}</span>`;
      },duplicateAudit.groups?.length||0);
      if(history.loaded){
        const historyRows=history.rows.slice(0,12);
        html+=section('邮箱历史（提示）',historyRows,row=>{
          const fact=[row.sentCount?`已发送 ${row.sentCount}`:'',row.draftCount?`已有草稿 ${row.draftCount}`:''].filter(Boolean).join(' · ');
          const subject=row.lastDraftSubject||row.lastSubject||'';
          return `<span>${escapeHtml(row.email)} · ${escapeHtml(fact)}${subject?` · ${escapeHtml(subject)}`:''}</span>`;
        },history.rows.length);
      }
      if(rosterAudit){
        const off=(rosterAudit.matches||[]).filter(m=>m.status==='off-roster').slice(0,12);
        const ambiguities=(rosterAudit.matches||[]).filter(m=>m.status==='ambiguous').slice(0,12);
        const scheduleDiffs=(rosterAudit.matches||[]).filter(m=>m.status==='conflict').slice(0,12);
        const unwritten=(rosterAudit.unwritten||[]).slice(0,12);
        const rosterDups=(rosterAudit.duplicateMatches||[]).slice(0,8);
        html+=section('尚未加入本批次',unwritten,e=>`<span>${escapeHtml(rosterEntryLabel(e))}${e.batch?` · ${escapeHtml(e.batch)}`:''}</span>`,rosterAudit.unwritten?.length||0);
        html+=section('不在参考名单',off,m=>`<span>${escapeHtml(m.task?.id||m.task?.recipients||'邮件')} · ${escapeHtml(m.task?.recipients||'')}</span>`,(rosterAudit.matches||[]).filter(m=>m.status==='off-roster').length);
        html+=section('名单匹配待核对',ambiguities,m=>`<span>${escapeHtml(m.task?.id||'邮件')} → 多个参考名单候选</span>`,(rosterAudit.matches||[]).filter(m=>m.status==='ambiguous').length);
        html+=section('排程参考（不影响邮件）',scheduleDiffs,m=>`<span>${escapeHtml(m.task?.id||'邮件')} → ${escapeHtml(rosterEntryLabel(m.entry))}</span>`,(rosterAudit.matches||[]).filter(m=>m.status==='conflict').length);
        html+=section('名单映射重复',rosterDups,d=>`<span>${escapeHtml(rosterEntryLabel(d.entry))} · ${d.matches?.length||0} 封邮件</span>`,rosterAudit.duplicateMatches?.length||0);
      }
      details.innerHTML=html;
    }
  }

  async function loadRosterFiles(files){
    const list=[...(files||[])].filter(Boolean);if(!list.length||!Importer||!Roster)return;
    const token=batch.sessionId;const status=$('nmda-roster-source-status');
    if(status)status.textContent=`正在读取总套磁名单（${list.length} 个文件）…`;
    try{
      const dataset=list.length===1?await Importer.parseFile(list[0]):await Importer.parseFiles(list,{ignoreUnsupported:true});
      if(!isCurrentBatchSession(token))return;
      const parsed=Roster.parseDataset(dataset);
      if(!parsed.entries.length)throw new Error('总名单中没有找到可用导师信息。请至少提供姓名、邮箱或学校中的一项。');
      for(const [key,edit] of batch.taskEdits.entries()){if(edit?.rosterConfirmed){const next={...edit};delete next.rosterConfirmed;batch.taskEdits.set(key,next);}}
      batch.handoffComplete=false;
      const state=rosterState();state.dataset=dataset;state.manualEntries=parsed.entries;state.manualWarnings=parsed.warnings||[];state.manualSourceNames=list.map(f=>f.name);syncRosterParts();
      batch.rosterPromptChoice='added';
      if(status)status.textContent=`已添加 ${state.entries.length} 条参考名单${parsed.stats.invalidEmails?` · ${parsed.stats.invalidEmails} 条邮箱待检查`:''}${parsed.stats.duplicates?` · ${parsed.stats.duplicates} 条重复`:''}`;
      if(batch.dataset)rebuildTasks();else renderRosterAudit();
      renderImportLifecycleState();
      renderSupplementPreflight();
      if(batch.dataset&&batch.supplementPreflightDone)setTimeout(()=>void enterSelectionAndSchedule('参考总名单已加入'),0);
    }catch(error){console.error(`[${APP}] roster`,error);if(status)status.textContent=`总名单读取失败：${error.message}`;}
    finally{if(rosterFileEl)rosterFileEl.value='';}
  }

  function removeRoster(){
    batch.handoffComplete=false;
    for(const [key,edit] of batch.taskEdits.entries()){if(edit?.rosterConfirmed){const next={...edit};delete next.rosterConfirmed;batch.taskEdits.set(key,next);}}
    for(const config of batch.collectionConfigs.values())if(config.purpose==='roster'){config.purpose='ignored';config.enabled=false;}
    batch.roster=emptyRosterState();
    batch.rosterPromptChoice=batch.dataset&&batch.tasks?.length?'pending':'idle';
    const status=$('nmda-roster-source-status');if(status)status.textContent='未添加参考总名单。';
    const remove=$('nmda-roster-remove');if(remove)remove.hidden=true;
    if(batch.dataset){rebuildTasks();renderSourceInventory();renderCollectionList();}else renderRosterAudit();
    renderImportLifecycleState();
  }

  function mergedRowSourcePurpose(sourceFile) {
    const source=sourceIdentityKey(sourceFile),leaf=String(source).split('/').pop();
    const candidates=recordSets().map((collection,index)=>({collection,index})).filter(({collection})=>collection.meta?.taskShadow&&collectionDirectMatchesSource(collection,source,leaf));
    if(!candidates.length)return'mail';
    const config=ensureCollectionConfig(candidates[0].index);
    return config?.enabled===false?'ignored':String(config?.purpose||'ignored');
  }

  function importedScheduleEvidence(collection, detection, row, getValue) {
    const core=globalThis.NMDAImportCore;
    const headers=collection?.rows?.[detection?.index] || [];
    const normalize=value=>core?.normalizeHeader ? core.normalizeHeader(value) : String(value??'').trim().toLowerCase().replace(/\s+/g,'');
    const values=(row||[]).map(value=>String(value??'').trim());
    const mapped=String(getValue(row,'scheduleAt') ?? '').trim();
    let datePart='',timePart='',dateHeader='',timeHeader='';
    const dateRe=/^(?:发送|定时(?:发送)?|计划发送|预约发送|预定发送|排期|投递)?日期$|^(?:send|scheduled|schedule|delivery|planned(?:send|delivery)?)date$/i;
    const timeRe=/^(?:发送|定时(?:发送)?|计划发送|预约发送|预定发送|排期|投递)?(?:时刻|时间)$|^(?:send|scheduled|schedule|delivery|planned(?:send|delivery)?)(?:time|clock)$/i;
    const genericDateRe=/^日期$|^date$/i, genericTimeRe=/^(?:时间|时刻)$|^time$/i;
    for(let i=0;i<headers.length;i++){
      const h=normalize(headers[i]); if(!h)continue;
      const value=values[i]||''; if(!value)continue;
      if(!datePart && dateRe.test(h)){datePart=value;dateHeader=String(headers[i]||'');continue;}
      if(!timePart && timeRe.test(h)){timePart=value;timeHeader=String(headers[i]||'');continue;}
    }
    if(!datePart || !timePart){
      let genericDate='',genericTime='',genericDateHeader='',genericTimeHeader='';
      for(let i=0;i<headers.length;i++){
        const h=normalize(headers[i]),value=values[i]||'';if(!value)continue;
        if(!genericDate&&genericDateRe.test(h)){genericDate=value;genericDateHeader=String(headers[i]||'');}
        if(!genericTime&&genericTimeRe.test(h)){genericTime=value;genericTimeHeader=String(headers[i]||'');}
      }
      // Plain “日期 + 时间” is accepted only as a pair so an unrelated single
      // date column is never silently treated as a mail schedule.
      if(genericDate&&genericTime){
        if(!datePart){datePart=genericDate;dateHeader=genericDateHeader;}
        if(!timePart){timePart=genericTime;timeHeader=genericTimeHeader;}
      }
    }
    let raw=mapped;
    const dateOnly=value=>/^\s*\d{4}[年\/.\-]\d{1,2}(?:月|[\/.\-])\d{1,2}日?\s*$/.test(String(value||''));
    const timeOnly=value=>/^\s*\d{1,2}:\d{2}(?::\d{2})?\s*$/.test(String(value||''));
    if(raw && dateOnly(raw) && timePart) raw=`${raw} ${timePart}`;
    else if(raw && timeOnly(raw) && datePart) raw=`${datePart} ${raw}`;
    else if(!raw && datePart) raw=timePart?`${datePart} ${timePart}`:datePart;
    return {raw, mapped, datePart, timePart, headers:[dateHeader,timeHeader].filter(Boolean)};
  }

  function rebuildTasks() {
    if (!batch.dataset) { batch.tasks = []; scheduleBatchRender({aux:true}); return; }
    const tasks = [];
    const sets = recordSets();
    for (let collectionIndex = 0; collectionIndex < sets.length; collectionIndex++) {
      const collection = sets[collectionIndex];
      const config = ensureCollectionConfig(collectionIndex);
      if (!collection || !config || config.purpose !== 'mail' || config.enabled === false || collection.meta?.taskShadow) continue;
      const detection = config.detection;
      const mapping = config.mapping || {};
      const start = detection.index + 1;
      const getValue = (row, field) => { const col = mapping[field]; return col == null ? '' : (row?.[col] ?? ''); };
      for (let rowIndex = start; rowIndex < collection.rows.length; rowIndex++) {
        const row = collection.rows[rowIndex] || [];
        const editKey = taskEditKey(collectionIndex, rowIndex);
        const edit = batch.taskEdits.get(editKey) || {};
        if (edit.importExcluded === true) continue;
        const rowMeta = collection.meta?.rowMeta?.[rowIndex] || null;
        const mailboxDraft = rowMeta?.mailboxDraft || null;
        const mailboxCc = String(mailboxDraft?.cc || '').trim();
        const mailboxBcc = String(mailboxDraft?.bcc || '').trim();
        const mailboxBodyHtml = String(mailboxDraft?.bodyHtml || '');
        const mailboxBodyIsHtml = mailboxDraft?.isHtml !== false && !!mailboxBodyHtml;
        const mailboxPriority = Number(mailboxDraft?.priority || 0) || 0;
        const mailboxReadReceipt = !!mailboxDraft?.requestReadReceipt;
        const rowSourceFile=String(rowMeta?.sourceFile||(collection.meta?.wordTaskRows?row?.[8]:'')||collection.source||'').trim();
        if(collection.meta?.merged&&rowSourceFile&&mergedRowSourcePurpose(rowSourceFile)!=='mail')continue;
        const sourceRecipients = String(getValue(row, 'recipients') ?? '').trim();
        const sourceSchoolRaw = String(getValue(row, 'school') ?? rowMeta?.school ?? '').trim();
        const sourceSubject = String(getValue(row, 'subject') ?? '').trim();
        const sourceBodyRaw = String(getValue(row, 'body') ?? '');
        const sourceBody = collection.meta?.mailFrames&&MailRecognizer?.sanitizeRecognizedBody
          ? MailRecognizer.sanitizeRecognizedBody(sourceBodyRaw).text
          : sourceBodyRaw;
        const sourceAttachmentRaw = getValue(row, 'attachments');
        const scheduleEvidence = importedScheduleEvidence(collection,detection,row,getValue);
        // Mailbox metadata is authoritative even if a future import-mapping change
        // fails to map the synthetic “定时时间” column.
        const sourceScheduleRaw = String(mailboxDraft?.scheduleAt || scheduleEvidence.raw || '').trim();
        const sourceTags = getValue(row, 'tags');
        const recipients = String(edit.recipients != null ? edit.recipients : sourceRecipients).trim();
        const schoolSource=edit.school!=null?'manual':(sourceSchoolRaw?(collection.meta?.mailFrames?'recognized':'imported'):'');
        const schoolRaw=String(edit.school != null ? edit.school : sourceSchoolRaw).trim();
        const schoolEvidence=Scheduler?.institutionEvidence?.(schoolRaw,recipients,schoolSource)||{valid:!!schoolRaw&&!/^[A-Z0-9]$/i.test(schoolRaw),value:schoolRaw};
        const school=schoolEvidence.valid?String(schoolEvidence.value||schoolRaw).trim():'';
        const subject = String(edit.subject != null ? edit.subject : sourceSubject).trim();
        const body = String(edit.body != null ? edit.body : sourceBody);
        const attachmentRaw = edit.attachments != null ? edit.attachments : sourceAttachmentRaw;
        const rawAttachmentRefs = Importer.splitAttachments(attachmentRaw);
        const attachmentRefs = actionableAttachmentRefs(rawAttachmentRefs);
        const scheduleRaw = edit.scheduleAt != null ? edit.scheduleAt : sourceScheduleRaw;
        const originalScheduleSource = mailboxDraft && String(sourceScheduleRaw ?? '').trim() ? 'mailbox' : (String(sourceScheduleRaw ?? '').trim() ? 'imported' : '');
        const scheduleSource = String(edit.scheduleSource || originalScheduleSource).trim();
        const importedTags = parseTaskClassifications(edit.tags != null ? edit.tags : sourceTags);
        const id = String(edit.id != null ? edit.id : getValue(row, 'id') ?? '').trim() || `${collectionIndex + 1}-${rowIndex + 1}`;
        const meaningful = [recipients, subject, body, ...attachmentRefs, String(scheduleRaw ?? ''), ...importedTags].some(v => String(v).trim());
        if (!meaningful) continue;

        const errors = [], warnings = [];
        const importIssues = [...new Set(rowMeta?.issues || [])];
        const importConfidence = Number(rowMeta?.confidence || 0);
        if (!recipients) errors.push('缺少收件人');
        else if (!recipientLooksValid(recipients)) errors.push('收件人邮箱格式无效');
        if (!subject) errors.push('缺少主题');
        if (!String(body||'').trim()) errors.push('缺少正文');
        if (collection.meta?.mailFrames && importConfidence && importConfidence < 70) warnings.push('请检查邮件内容');
        for (const issue of importIssues) {
          if (/未定位收件人/.test(issue) && recipients) continue;
          if (/主题为空/.test(issue) && subject) continue;
          if (/正文过短/.test(issue) && body.length >= 40) continue;
          if (!errors.includes(issue) && !warnings.includes(issue)) warnings.push(issue);
        }
        let scheduleAt = '';
        if (String(scheduleRaw ?? '').trim()) {
          const parsed = Importer.parseDateValue(scheduleRaw);
          if (!parsed) warnings.push(`原定时时间无法识别：${scheduleRaw}；请在自动安排时间中重新选择`);
          else {
            scheduleAt = Importer.formatLocalDateTime(parsed);
            if (parsed.getTime() <= Date.now() + 60 * 1000) warnings.push('定时时间已过，建议手工修改或使用智能排程覆盖');
          }
        }

        const resolved = resolveAttachmentRefs(attachmentRefs, editKey);
        if (resolved.missing.length) errors.push(`缺少附件：${resolved.missing.join('、')}`);
        if (resolved.ambiguous.length) errors.push(`附件同名冲突：${resolved.ambiguous.join('、')}`);
        for (const detail of resolved.details) {
          if (detail.status === 'matched' && detail.method === 'relaxed-copy-suffix') warnings.push(`附件按下载副本名匹配：${detail.ref} → ${detail.file.name}`);
        }

        const gate = contactPolicyGateForRecipients(recipients);
        if (gate.policies.includes('不再联系')) errors.push(`联系策略：不再联系（${gate.reasons.join('、')}）`);
        else if (gate.policies.includes('暂停')) warnings.push(`联系策略：暂停（${gate.reasons.join('、')}）`);

        const policyBlocked = gate.blocked;
        const mergedFiles = mergeTaskFiles(resolved.files, editKey);
        const staticSearch = normalizedSearchText([
          id, rowIndex + 1, recipients, school, subject, body,
          mergedFiles.map(file => file.name).join(' '),
          scheduleAt ? scheduleAt.replace('T', ' ') : '',
          importedTags.join(' ')
        ].join(' '));
        tasks.push({
          id, rowIndex, collectionIndex, collectionName: collection.name || `内容 ${collectionIndex + 1}`, sourceFile: rowSourceFile,
          editKey, sourceRow: rowIndex + 1, recipients, cc:mailboxCc, bcc:mailboxBcc, school, schoolSource:school?schoolSource:'', ignoredSchool:schoolRaw&&!school?schoolRaw:'', subject, body,
          bodyHtml: mailboxDraft && edit.body == null ? mailboxBodyHtml : '', bodyIsHtml: mailboxDraft && edit.body == null ? mailboxBodyIsHtml : false,
          priority: mailboxPriority, requestReadReceipt: mailboxReadReceipt,
          attachmentRefs, ignoredAttachmentRefs:rawAttachmentRefs.filter(ref=>!attachmentRefs.includes(ref)),
          sourceKind:mailboxDraft?'mailbox-draft':'import', mailboxDraftId:String(mailboxDraft?.id||''), mailboxDraftSavedAt:String(mailboxDraft?.savedAt||''), remoteAttachments:[...(mailboxDraft?.attachments||[])],
          tags: importedTags,
          enabled: policyBlocked ? false : edit.enabled !== false,
          policyBlocked, policyReasons: gate.reasons,
          files: mergedFiles, tableFiles: resolved.files, attachmentDetails: resolved.details,
          scheduleAt, scheduleSource, scheduleReason:String(edit.scheduleReason||(scheduleSource==='mailbox'?'草稿箱原排期':scheduleSource==='imported'?'导入自带排期':'')), scheduleEvidenceHeaders:[...(scheduleEvidence.headers||[])], errors:[...new Set(errors)], warnings:[...new Set(warnings)], status: errors.length ? 'error' : 'ready', runtimeError: '', note: '',
          importConfidence, importEvidence:[...(rowMeta?.evidence || [])], importIssues, importHeading:rowMeta?.heading || '', importRecipientEvidence:rowMeta?.recipientEvidence || null,
          reviewConfirmed: !!edit.reviewConfirmed, reviewDraftPending: !!edit.reviewDraftPending, rosterConfirmed: !!edit.rosterConfirmed,
          duplicateConfirmedGroups:Array.isArray(edit.duplicateConfirmedGroups)?[...edit.duplicateConfirmedGroups]:[], duplicateIssues:[], duplicateGroupIds:[], importExcluded:false,
          manuallyEdited: ['recipients','school','subject','body','attachments','scheduleAt','tags'].some(key=>edit[key]!=null), _searchStatic: staticSearch
        });
      }
    }
    applyBatchDuplicateAudit(tasks);
    applyRosterCrossCheck(tasks);
    batch.tasks = tasks;
    scheduleBatchRender({aux:true});
  }

  function statusLabel(task) {
    if (task.policyBlocked && task.status !== 'running' && task.status !== 'done') { const policies=task.policyReasons||[]; const label=(task.policyReasons||[]).some(x=>String(x).includes('不再联系'))?'已停止联系':'已暂停联系'; return `${label}：${policies.join('、')}`; }
    if (!task.enabled && task.status !== 'running' && task.status !== 'done') return '未选择';
    if (task.status === 'done') return '已完成';
    if (task.status === 'running') return '处理中';
    if(task.runtimeError)return `失败：${task.runtimeError}`;
    const state=taskIssueState(task);
    if(state.content.length){
      const labels=[];
      if(state.content.some(x=>/收件人|邮箱/.test(x)))labels.push('收件人');
      if(state.content.some(x=>/主题/.test(x)))labels.push('主题');
      if(state.content.some(x=>/正文/.test(x)))labels.push('正文');
      return `待补内容：${[...new Set(labels)].join('、')}`;
    }
    if(state.review.length)return `需要核对：${state.review[0].replace('修改待确认','修改内容')}`;
    if(state.attachment.length)return `待添加附件：${state.attachment[0].replace(/^缺少附件：|^附件同名冲突：/,'')}`;
    if(state.schedule.length)return '待调整时间';
    if(state.other.length)return `暂不可创建：${state.other[0]}`;
    if (task.status === 'error') return '暂不可创建';
    if (task.warnings.length) return `可创建（${task.warnings.join('；')}）`;
    return '可创建';
  }


  function renderTagChips() {
    const box = $('nmda-batch-tag-chips');
    if (!box || !Contacts) return;
    const counts = new Map();
    for (const task of batch.tasks || []) {
      for (const tag of taskBusinessTags(task)) counts.set(tag, (counts.get(tag) || 0) + 1);
    }
    const tags = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'));
    box.innerHTML = tags.length ? tags.slice(0, 50).map(([tag, count]) => `<button type="button" class="nmda-tag-chip" data-tag-chip="${escapeHtml(tag)}">${escapeHtml(tag)} <small>${count}</small></button>`).join('') : '<span class="nmda-hint">当前任务没有业务标记。联系状态和联系策略不会混入标记。</span>';
    box.querySelectorAll('[data-tag-chip]').forEach(button => button.addEventListener('click', () => {
      const tagsNow = Contacts.parseTags(batchTagIncludeEl.value);
      const clicked = button.dataset.tagChip;
      const key = clicked.toLocaleLowerCase('zh-CN');
      const exists = tagsNow.some(tag => tag.toLocaleLowerCase('zh-CN') === key);
      batchTagIncludeEl.value = exists ? tagsNow.filter(tag => tag.toLocaleLowerCase('zh-CN') !== key).join(';') : Contacts.mergeTags(tagsNow, [clicked]).join(';');
      scheduleBatchRender({aux:false});
    }));
  }

  function importAttachmentStats() {
    const items=attachmentRequirementOverview();
    const matched=items.filter(item=>item.total>0&&item.matched>=item.total).length;
    return {total:items.length,matched,issues:Math.max(0,items.length-matched),files:attachmentPreparedFileCount()};
  }

  function renderImportHandoff() {
    if (typeof renderProcessGuide === 'function') renderProcessGuide();
    const card = $('nmda-import-handoff-card');
    const summary = $('nmda-import-ready-summary');
    const button = $('nmda-go-batch');
    const hint=$('nmda-handoff-hint');
    const hasDataset = !!batch.dataset;
    if (!card || !summary || !button) return;
    if (!hasDataset) { card.hidden=true; return; }
    const tasks = batch.tasks || [];
    const states=tasks.map(task=>[task,taskIssueState(task)]);
    const blockerTasks=states.filter(([task])=>taskHasPrePlanningBlocker(task));
    const blocked=blockerTasks.length>0;
    const contextPending=supplementPreflightNeedsDecision();
    const ready=states.filter(([task])=>!taskHasPrePlanningBlocker(task)&&!task.policyBlocked).length;
    const excluded=excludedImportCount();
    card.hidden = contextPending || blocked || !tasks.length;
    if(card.hidden)return;
    const metrics=[`<div class="nmda-import-metric"><strong>${tasks.length}</strong><span>邮件</span></div>`,`<div class="nmda-import-metric"><strong>${ready}</strong><span>可继续</span></div>`];
    if(excluded)metrics.push(`<div class="nmda-import-metric"><strong>${excluded}</strong><span>已排除</span></div>`);
    summary.innerHTML=metrics.join('');
    button.textContent = batch.handoffComplete ? '查看选择与安排' : '进入选择与安排';
    button.disabled = !tasks.length;
    if(hint){const attachmentIssues=importAttachmentStats().issues;hint.textContent=batch.handoffComplete?'当前批次已进入选择与安排。':attachmentIssues?`内容待办已完成；${attachmentIssues} 项附件可在发送前补齐。`:'全部内容待办已完成，可以继续。';}
  }


  function scheduleSourceLabel(task) {
    const source=String(task?.scheduleSource||'');
    if(source==='auto')return '自动安排';
    if(source==='manual'||source==='manual-clear')return '手工调整';
    if(source==='mailbox')return '草稿原排期';
    if(source==='imported')return '导入排期';
    return task?.scheduleAt?'已有排期':'未定时';
  }

  function renderScheduleCenter() {
    if (typeof renderProcessGuide === 'function') renderProcessGuide();
    const card=$('nmda-scheduler-card'); if(!card)return;
    const tasks=batch.tasks||[], hasTasks=batch.handoffComplete&&tasks.length>0;
    card.hidden=!hasTasks; if(!hasTasks)return;
    if(schedulerToggleLabelEl)schedulerToggleLabelEl.textContent=card.open?'收起':'展开';
    if(!Scheduler){if(scheduleRulePreviewEl)scheduleRulePreviewEl.textContent='自动安排暂不可用。';if(scheduleApplyEl)scheduleApplyEl.disabled=true;return;}
    syncScheduleRuleControls();
    const selected=tasks.filter(t=>t.enabled&&t.status==='ready');
    const groups=new Map(); let fallback=0, auto=0, protectedCount=0, unscheduled=0;
    for(const task of selected){
      const group=Scheduler.groupForTask(task); groups.set(group.key,group);
      if(group.source==='domain'||group.source==='unknown')fallback++;
      if(task.scheduleSource==='auto'&&task.scheduleAt)auto++;
      else if(task.scheduleAt)protectedCount++;
      else unscheduled++;
    }
    const rules=batch.scheduleRules||freshScheduleRules();
    const audit=Scheduler.audit?.(selected,rules)||{conflicts:[],holidayConflicts:[]};
    const conflictCount=audit.conflicts?.length||0, holidayConflictCount=audit.holidayConflicts?.length||0;
    if(scheduleSummaryEl)scheduleSummaryEl.innerHTML=`<strong>${selected.length}</strong> 已选 · 自动 ${auto} · 已有 ${protectedCount} · 待排 ${unscheduled}${conflictCount?` · <span class="nmda-danger">同校冲突 ${conflictCount}</span>`:''}${holidayConflictCount?` · <span class="nmda-danger">休息日 ${holidayConflictCount}</span>`:''}`;
    if(scheduleRulePreviewEl){
      const conflictText=conflictCount?` · ${conflictCount} 个同校时间冲突`:'';const holidayText=holidayConflictCount?` · ${holidayConflictCount} 个已有时间落在休息日`:'';
      scheduleRulePreviewEl.textContent=`当前规则：每所院校每轮最多 ${rules.maxPerGroupPerRound||1} 位 · 间隔 ${rules.intervalDays||7} 天${rules.skipHolidays!==false?' · 跳过节假日/周末':''}${conflictText}${holidayText}`;
    }
    const ruleChip=$('nmda-planning-rule-chip');
    if(ruleChip)ruleChip.textContent=`每校每轮 ${rules.maxPerGroupPerRound||1} 位 · 间隔 ${rules.intervalDays||7} 天${rules.skipHolidays!==false?' · 避开休息日':''}${conflictCount?` · ${conflictCount} 个冲突`:''}`;
    const scheduleContextCopy=$('nmda-schedule-context-copy');
    if(scheduleContextCopy){
      const rosterCount=referenceRosterCount();
      const schoolKnown=selected.filter(task=>String(task.school||'').trim()).length;
      const priorityKnown=selected.filter(task=>Scheduler.priorityForTask?.(task)?.has).length;
      const contextText=rosterCount?`已加入 ${rosterCount} 条参考名单；${schoolKnown} 封已有院校信息${priorityKnown?`，其中 ${priorityKnown} 封有明确顺序`:''}。`:`${schoolKnown} / ${selected.length} 封已有院校信息。`;
      scheduleContextCopy.textContent=`${contextText} 设置开始时间与同校间隔后应用。`;
    }
    if(scheduleApplyEl){scheduleApplyEl.disabled=batch.running||!selected.length;scheduleApplyEl.textContent=auto||unscheduled?'应用安排':'重新安排';}
    if(scheduleClearEl)scheduleClearEl.disabled=batch.running||!tasks.some(t=>t.scheduleSource==='auto'&&t.scheduleAt);
  }

  function applySmartSchedule() {
    if(!Scheduler){setBatchStatus('自动安排暂不可用。','error');return;}
    try{
      const rules=readScheduleRuleControls();
      const plan=Scheduler.buildPlan(batch.tasks||[],rules,new Date());
      for(const assignment of plan.assignments){
        const prev=batch.taskEdits.get(assignment.editKey)||{};
        batch.taskEdits.set(assignment.editKey,{...prev,scheduleAt:assignment.scheduleAt,scheduleSource:'auto',scheduleReason:assignment.reason});
      }
      batch.schedulePlan=plan;
      rebuildTasks();
      if(window.matchMedia('(max-width: 900px)').matches)setPlanningView('mails');
      const s=plan.summary, audit=Scheduler.audit?.(batch.tasks||[],rules)||{conflicts:[],holidayConflicts:[]};
      const fallbackCount=Number(s.fallbackTasks||s.fallbackGroups||0);
      const fallback='';
      const priority=s.priorityOrderedGroups?`；${s.priorityOrderedGroups} 所院校已按总名单顺序排列`:'';
      const holiday=s.holidayAdjusted?`；${s.holidayAdjusted} 封为避开节假日/周末自动顺延`:'';
      const unsupported='';
      const conflicts=(audit.conflicts?.length||0)+(audit.holidayConflicts?.length||0);
      const conflict=audit.conflicts?.length?`；保留的已有时间仍有 ${audit.conflicts.length} 个同校规则冲突，请手工调整或关闭“保留已有时间”后重排`:'';
      const holidayConflict=audit.holidayConflicts?.length?`；${audit.holidayConflicts.length} 个保留时间仍落在节假日/周末`:'';
      setBatchStatus(`时间已安排：${s.selected} 封邮件，自动安排 ${s.auto} 封，保留已有 ${s.preserved} 封，共 ${s.rounds} 轮${priority}${holiday}${fallback}${unsupported}${conflict}${holidayConflict}。`,conflicts?'warn':'ok');
    }catch(error){setBatchStatus(`安排时间失败：${error.message}`,'error');}
  }

  function clearAutoSchedule() {
    let cleared=0;
    for(const task of batch.tasks||[]){
      if(task.scheduleSource!=='auto')continue;
      const prev={...(batch.taskEdits.get(task.editKey)||{})};
      delete prev.scheduleAt; delete prev.scheduleSource; delete prev.scheduleReason;
      batch.taskEdits.set(task.editKey,prev); cleared++;
    }
    batch.schedulePlan=null;
    rebuildTasks();
    setBatchStatus(cleared?`已清除 ${cleared} 封任务的自动排程；导入或手工时间保持不变。`:'当前没有自动排程需要清除。',cleared?'ok':'warn');
  }

  function batchSummarySnapshot(tasks = batch.tasks || []) {
    const snapshot={errors:0,done:0,selectedReady:0,selectedScheduled:0,selectedTotal:0,unselected:0};
    for(const task of tasks){
      if(task.status==='error')snapshot.errors++;
      if(task.status==='done')snapshot.done++;
      if(task.enabled && task.status!=='done')snapshot.selectedTotal++;
      if(!task.enabled)snapshot.unselected++;
      if(task.enabled && task.status==='ready'){
        snapshot.selectedReady++;
        if(task.scheduleAt)snapshot.selectedScheduled++;
      }
    }
    return snapshot;
  }

  function renderBatchSummaryControls(tasks = batch.tasks || [], snapshot = batchSummarySnapshot(tasks)) {
    const summaryParts=[`共 <strong>${tasks.length}</strong> 封`,`本次 <strong>${snapshot.selectedTotal}</strong>`,`可创建 <strong>${snapshot.selectedReady}</strong>`];
    if(snapshot.selectedScheduled)summaryParts.push(`定时 ${snapshot.selectedScheduled}`);
    if(snapshot.errors)summaryParts.push(`<span class="nmda-danger">异常 ${snapshot.errors}</span>`);
    if(snapshot.done)summaryParts.push(`已完成 ${snapshot.done}`);
    batchSummaryEl.innerHTML=summaryParts.join(' · ');
    if(batchStartEl)batchStartEl.textContent=snapshot.selectedReady?`前往网易邮箱 · 创建 ${snapshot.selectedReady} 封`:'前往网易邮箱并创建所选草稿';
    const selectionChip=$('nmda-planning-selection-chip');
    if(selectionChip)selectionChip.textContent=snapshot.selectedReady?`本次已选择 ${snapshot.selectedReady} 封${snapshot.selectedScheduled?` · 已定时 ${snapshot.selectedScheduled} 封`:''}`:'尚未选择可创建邮件';
    const attachmentChip=$('nmda-planning-attachment-chip');
    if(attachmentChip){
      const stats=typeof importAttachmentStats==='function'?importAttachmentStats():{issues:0,shared:0};
      const localCount=attachmentPreparedFileCount();
      attachmentChip.textContent=stats.issues?`附件待补 ${stats.issues} 项 · 打开工作台处理`:localCount?`附件工作台 · ${localCount} 个文件`:'附件工作台 · 暂无文件';
      attachmentChip.dataset.state=stats.issues?'warn':localCount?'ok':'idle';
    }

    batchStartEl.disabled=batch.running||!batch.handoffComplete||!snapshot.selectedReady;
    const preflight=$('nmda-create-preflight');
    if(preflight){
      const selected=(tasks||[]).filter(task=>task.enabled&&task.status==='ready');
      const fileCount=selected.reduce((sum,task)=>sum+(task.files?.length||0),0);
      const excluded=typeof excludedImportCount==='function'?excludedImportCount():0;
      const facts=[`本次 ${snapshot.selectedReady} 封`,snapshot.selectedScheduled?`定时 ${snapshot.selectedScheduled} 封`:'普通草稿',fileCount?`附件 ${fileCount} 份`:'无附件',excluded?`已排除 ${excluded} 封`:''].filter(Boolean);
      preflight.innerHTML=`<span>${facts.map(item=>`<em>${escapeHtml(item)}</em>`).join('')}</span>${fileCount?'<button class="nmda-text-action" type="button" data-open-attachment-manager>查看附件</button>':''}<b>执行时自动切到网易邮箱</b>`;
    }
    return snapshot;
  }

  function refreshTaskSearchStatic(task){
    if(!task)return;
    task._searchStatic=normalizedSearchText([
      task.id,task.sourceRow,task.recipients,task.school,task.subject,task.body,
      task.files?.map(file=>file.name).join(' ')||'',
      task.scheduleAt?task.scheduleAt.replace('T',' '):'',
      parseTaskClassifications(task.tags||[]).join(' ')
    ].join(' '));
  }

  function renderPreview({ aux = true } = {}) {
    const tasks=batch.tasks||[];
    const matched=filteredBatchTasks();
    const snapshot=renderBatchSummaryControls(tasks);
    previewBodyEl.innerHTML=matched.slice(0,150).map(task=>{
      const contactState=taskContactSnapshot(task).state;
      const sourceLabel=scheduleSourceLabel(task);
      const scheduleHtml=`<div class="nmda-schedule-edit-cell"><input type="datetime-local" data-task-schedule="${escapeHtml(task.editKey)}" value="${escapeHtml(task.scheduleAt||'')}" ${batch.running?'disabled':''}><small>${escapeHtml(sourceLabel)}</small></div>`;
      const statusText=statusLabel(task);
      const fileText=task.files?.length?` · 附件 ${task.files.length}`:'';
      return `<tr data-task-row="${escapeHtml(task.editKey)}" data-status="${task.status}" data-enabled="${task.enabled?'1':'0'}">
        <td><input type="checkbox" data-task-enabled="${escapeHtml(task.editKey)}" ${task.enabled?'checked':''} ${batch.running||task.policyBlocked||task.status==='running'||task.status==='done'?'disabled':''} title="${escapeHtml(task.policyBlocked?statusLabel(task):'')}"></td>
        <td class="nmda-recipient-cell" title="${escapeHtml(task.recipients)}"><strong>${escapeHtml(task.recipients||'—')}</strong><small>${escapeHtml(contactState.stage||'')}</small></td>
        <td class="nmda-subject-cell" title="${escapeHtml(task.subject)}">${escapeHtml(task.subject||'—')}</td>
        <td>${scheduleHtml}</td>
        <td class="nmda-task-state-cell" title="${escapeHtml(statusText)}">${escapeHtml(statusText)}${fileText}</td>
        <td class="nmda-task-review-cell"><button class="nmda-row-action" type="button" data-review-task="${escapeHtml(task.editKey)}">审阅</button></td>
      </tr>`;
    }).join('');
    if(!matched.length)previewBodyEl.innerHTML='<tr><td colspan="6">没有匹配的邮件。调整搜索条件后再试。</td></tr>';
    else if(matched.length>150)previewBodyEl.insertAdjacentHTML('beforeend',`<tr><td colspan="6">当前只显示前 150 封，共 ${matched.length} 封。</td></tr>`);

    const hasTasks=batch.handoffComplete&&tasks.length>0;
    const emptyCard=$('nmda-batch-empty');
    if(emptyCard){
      const kicker=emptyCard.querySelector('.nmda-card-kicker'),title=emptyCard.querySelector('.nmda-card-title'),desc=emptyCard.querySelector('.nmda-card-desc'),action=$('nmda-go-import');
      if(tasks.length&&!batch.handoffComplete){
        if(kicker)kicker.textContent='待交接';if(title)title.textContent=`已准备 ${tasks.length} 封邮件，尚未进入排程`;
        if(desc)desc.textContent='回到上方准备区，处理必要问题后继续。';if(action)action.textContent='回到准备区';
      }else{
        if(kicker)kicker.textContent='批量任务';if(title)title.textContent='还没有准备好的批量任务';
        if(desc)desc.textContent='先在上方添加资料。';if(action)action.textContent='回到准备区';
      }
    }
    $('nmda-preview-card').hidden=!hasTasks;
    $('nmda-scheduler-card').hidden=!hasTasks;
    $('nmda-batch-empty').hidden=true;
    const executeStage=$('nmda-stage-execute');if(executeStage)executeStage.hidden=!hasTasks;

    // Selection and filtering need only the table, summary, schedule and step rail.
    // Attachment resolution / roster / parsing work is recomputed only after structural changes.
    renderScheduleCenter();
    setPlanningView(batch.planningView||'rules');
    if(aux){
      renderTagChips();
      renderAttachmentCenter();
      renderImportTaskPreview();
      renderRosterAudit();
      renderImportHandoff();
      renderReviewPageOverview();
      viewPerf.batchAuxDirty=false;
    }
    viewPerf.batchDirty=false;
    return {matched:matched.length,...snapshot};
  }

  function renderAttachmentCenter() {
    const stats=importAttachmentStats(),count=attachmentPreparedFileCount(),card=$('nmda-attachments-card'),contextPending=typeof supplementPreflightNeedsDecision==='function'&&supplementPreflightNeedsDecision();
    if(card)card.hidden=contextPending||(!count&&!stats.total);
    if(card){const title=card.querySelector('summary strong'),hint=card.querySelector('summary small');if(title)title.textContent='附件工作台';if(hint)hint.textContent=stats.issues?`${stats.issues} 项待补 · 打开工作台处理`:count?`${count} 个附件 · ${stats.matched}/${stats.total} 项需求已覆盖`:'查看附件要求';card.dataset.issue=stats.issues?'1':'0';card.open=false;}
    const summary=$('nmda-attachment-summary');if(summary)summary.innerHTML=stats.total?`已准备 <strong>${count}</strong> 个附件；邮件中有 <strong>${stats.total}</strong> 项附件要求，已覆盖 <strong>${stats.matched}</strong> 项${stats.issues?`，还有 <strong class="nmda-danger">${stats.issues}</strong> 项待处理。`:'，当前已全部覆盖。'}`:count?`已准备 <strong>${count}</strong> 个附件。发送范围统一在附件工作台配置。`:'当前没有附件文件或邮件附件要求。';
    const box=$('nmda-attachment-resolution'),list=$('nmda-attachment-resolution-list');if(box)box.hidden=true;if(list)list.innerHTML='';
    renderAttachmentAssetViews();
  }

  function setImportStatus(message, kind = '') {
    if (!importStatusEl) return;
    importStatusEl.textContent = message;
    if (kind) importStatusEl.dataset.kind = kind; else delete importStatusEl.dataset.kind;
  }

  function setBatchStatus(message, kind = '') {
    batchStatusEl.textContent = message;
    if (kind) batchStatusEl.dataset.kind = kind; else delete batchStatusEl.dataset.kind;
  }


  function mailboxDraftDataset(result = {}) {
    const headers=['编号','收件人','学校 / 机构','主题','正文','附件','定时时间','任务标记'];
    const rows=[headers];
    const rowMeta=[null];
    const drafts=Array.isArray(result.drafts)?result.drafts:[];
    let complete=0,missingRecipients=0;
    const warnings=[];
    for(const draft of drafts){
      const summary=draft?.summary||{};
      const id=String(draft?.id||summary?.id||'').trim();
      const recipients=String(draft?.recipients||summary?.toRaw||'').trim();
      const subject=String(draft?.subject||summary?.subject||'').trim();
      const body=String(draft?.body||'');
      const bodyHtml=String(draft?.bodyHtml||'');
      const isHtml=draft?.isHtml!==false;
      const cc=String(draft?.cc||'').trim();
      const bcc=String(draft?.bcc||'').trim();
      const account=String(draft?.account||'').trim();
      const priority=Number(draft?.priority||0)||0;
      const requestReadReceipt=!!draft?.requestReadReceipt;
      const attachmentObjects=(Array.isArray(draft?.attachments)?draft.attachments:[]).filter(item=>!(item&&typeof item==='object'&&item.inlined));
      const attachments=attachmentObjects.map(item=>String(item?.name||item||'').trim()).filter(Boolean);
      const scheduleAt=String(draft?.scheduleAt||'').trim();
      const savedAt=String(draft?.savedAt||summary?.savedAt||'').trim();
      const issues=[];
      if(draft?.ok===false)issues.push(`草稿详情读取不完整：${draft.reason||'未知错误'}`);
      if(!recipients)missingRecipients++;
      if(recipients&&subject&&body.trim())complete++;
      const evidence=[
        '来源：网易草稿箱',
        id?`草稿 ID：${id}`:'',
        savedAt?`保存时间：${savedAt}`:'',
        scheduleAt?`检测到定时：${scheduleAt}`:'',
        scheduleAt&&draft?.scheduleEvidence?`排期来源：${draft.scheduleEvidence}`:'',
        cc?`抄送：${cc}`:'',
        bcc?`密送：${bcc}`:'',
        account?`发件账号：${account}`:'',
        priority===1?'优先级：紧急':'',
        requestReadReceipt?'已读回执：开启':'',
        attachments.length?`原草稿附件：${attachments.join('、')}`:'',
        draft?.detailSource?`详情读取：${draft.detailSource}`:''
      ].filter(Boolean);
      const confidence=draft?.ok===false?45:(body.trim()?98:72);
      rows.push([id,recipients,'',subject,body,attachments.join(';'),scheduleAt,'草稿箱']);
      rowMeta.push({
        sourceFile:'网易草稿箱', confidence, issues, evidence,
        mailboxDraft:{
          id, savedAt, scheduleAt, scheduleEvidence:String(draft?.scheduleEvidence||''), cc, bcc, account, priority, requestReadReceipt,
          bodyHtml, isHtml, attachments:[...attachmentObjects], detailReadOk:draft?.ok!==false,
          detailSource:String(draft?.detailSource||''), directSchema:!!draft?.directSchema
        }
      });
    }
    if(result.truncated)warnings.push(`草稿箱本次仅读取 ${result.read||drafts.length} / ${result.total||'?'} 封；可再次读取或调整上限。`);
    if(result.failures)warnings.push(`${result.failures} 封草稿详情读取不完整，已保留在审阅待办中。`);
    const recordSet={
      name:'网易草稿箱', source:'网易草稿箱', rows,
      meta:{
        format:'mailbox-drafts', sourcePurpose:'mail', purposeConfidence:100, purposeReasons:['草稿箱来源已确定为邮件'], mailboxDrafts:true, rowMeta,
        mailScan:{records:drafts.length,complete,missingRecipients}
      }
    };
    return {
      recordSets:[recordSet], sheets:[recordSet], sourceFiles:[{name:'网易草稿箱',size:0,_nmdaPath:'网易草稿箱'}], embeddedFiles:[], warnings,
      format:'mailbox-drafts',
      meta:{ mailboxDraftImport:true, mailboxAccount:String(result.uid||''), mailboxDraftCoverage:{read:Number(result.read||drafts.length),total:Number(result.total||drafts.length),complete:!!result.complete,truncated:!!result.truncated} }
    };
  }

  async function importMailboxDrafts() {
    if(batch.running){setImportStatus('正在执行当前批次，暂时不能读取草稿箱。','warn');return;}
    if(draftImportEl)draftImportEl.disabled=true;
    let token=null;
    try{
      // Authenticate before replacing the current import workspace. A failed login check must never erase
      // a batch the user is already reviewing.
      const connection=await sendRuntimeMessage({type:'NMDA_CONNECTION_STATUS'});
      if(!connection?.connected||!connection?.authenticated){
        await sendRuntimeMessage({type:'NMDA_OPEN_MAIL',focus:true}).catch(()=>null);
        setImportStatus('请先在网易邮箱完成登录，然后返回工作台再次点击“读取草稿箱”。','warn');
        return;
      }
      token=beginImportSession('正在读取网易草稿箱…');
      setImportStatus('正在读取草稿列表与原生 Compose 数据；无需逐封打开页面，将获取正文、收件人、定时和附件信息。');
      const result=await sendRuntimeMessage({type:'NMDA_IMPORT_DRAFTS',limit:300});
      if(!isCurrentBatchSession(token))return;
      if(!result?.ok)throw new Error(result?.reason||'草稿箱读取失败');
      const dataset=mailboxDraftDataset(result);
      await applyImportedDataset(dataset,'网易草稿箱',token);
      if(!isCurrentBatchSession(token))return;
      const coverage=result.complete?'已读取完整草稿箱':`已读取最近 ${result.read||0} 封草稿`;
      setImportStatus(`${coverage}；已识别正文、主题、收件人、定时与附件要求。原草稿附件不会被伪造复制，创建前需提供对应本地文件。`,result.failures?'warn':'ok');
    }catch(error){
      if(token!=null && isCurrentBatchSession(token))clearImportOnError(error,token);
      else setImportStatus(`草稿箱读取失败：${error.message}`,'error');
    }finally{
      if(token!=null)finishImportSession(token);
      if(draftImportEl)draftImportEl.disabled=false;
    }
  }

  async function applyImportedDataset(dataset, label = '数据', sessionToken = batch.sessionId) {
    if (!isCurrentBatchSession(sessionToken)) return false;
    batch.dataset = dataset;
    batch.duplicateAudit = null;
    batch.handoffComplete = false;
    batch.importMeta = dataset?.meta || null;
    batch.collectionConfigs.clear();
    batch.taskEdits.clear();
    batch.reviewSelected?.clear?.();
    batch.duplicateSelections?.clear?.();
    batch.reviewFilter='all';
    batch.reviewSearch='';
    batch.bulkSubjectPromptAutoShown=false;
    batch.bulkSubjectPromptDismissed=false;
    if(reviewBulkSubjectInputEl)reviewBulkSubjectInputEl.value='';
    hideBulkSubjectPrompt();
    batch.attachmentAttentionShown=false;
    batch.supplementPreflightDone=false;batch.supplementPreflightOpen=false;batch.attachmentPrepChoice='pending';batch.sourceInspectName='';batch.preflightFolderPath='';batch.preflightSearch='';batch.preflightReviewOnly=false;batch.preflightPurposeFilter='';
    closeImportTaskEditor();
    batch.directoryFiles = []; batch.taskFiles = uniqueFiles(dataset?.embeddedFiles || []); batch.routedAttachmentFiles=[]; batch.sharedFiles = []; batch.attachmentOverrides.clear(); batch.attachmentPolicies=new Map(); batch.attachmentTargetEditing=''; batch.attachmentTargetSearch=''; batch.ignoredAttachmentIdentities=new Set(); batch.attachmentManagerOpen=false;
    for(const file of batch.taskFiles)ensureAttachmentPolicy(file,'task',{source:'随资料导入',mode:'smart'});
    batch.fileIndex = Importer.buildFileIndex(batch.taskFiles);
    dirEl.value = ''; taskFilesEl.value = ''; sharedFilesEl.value = '';
    if (batchSearchEl) batchSearchEl.value = '';
    if (batchTagIncludeEl) batchTagIncludeEl.value = '';
    if (batchStageFilterEl) batchStageFilterEl.value = '';
    const sets = recordSets();
    sets.forEach((_, index) => ensureCollectionConfig(index, { reset: true }));
    syncRoutedSources();
    batch.fileIndex=Importer.buildFileIndex(allAttachmentFiles());
    const mailIndexes=sets.map((_,index)=>index).filter(index=>ensureCollectionConfig(index)?.purpose==='mail');
    const bestIndex=(mailIndexes.map(index=>({index,score:Number(Importer.detectHeader(sets[index]?.rows||[]).score||0)})).sort((a,b)=>b.score-a.score)[0]?.index)??0;
    batch.collectionIndex = bestIndex;
    collectionSelectEl.innerHTML = sets.map((collection, i) => {
      const config=ensureCollectionConfig(i),kind = collectionKind(collection,config?.purpose);
      const detection = Importer.detectHeader(collection.rows || []);
      const records = Math.max(0, (collection.rows || []).length - detection.index - 1);
      return `<option value="${i}" ${i === bestIndex ? 'selected' : ''}>${escapeHtml(collection.name)} · ${escapeHtml(kind.label)} · ${records} 条</option>`;
    }).join('');
    $('nmda-collection-field').hidden = sets.length <= 1;
    $('nmda-structure-card').hidden = false;
    $('nmda-mapping-card').hidden = false;
    $('nmda-ingest-diagnostics').hidden = true;
    $('nmda-ingest-result-card').hidden = false;
    $('nmda-attachments-card').hidden = false;
    configureCollection(bestIndex, false);
    renderSourceInventory();
    clearStaleOverrides();
    batch.fileIndex=Importer.buildFileIndex(allAttachmentFiles());
    batch.rosterPromptChoice=referenceRosterCount()?'added':'pending';
    batch.attachmentPrepChoice=attachmentPreparedFileCount()?'added':'pending';
    batch.attachmentPromptDeferred=false;
    if (!isCurrentBatchSession(sessionToken)) return false;
    const routedCounts=[...batch.collectionConfigs.values()].reduce((acc,config)=>{acc[config.purpose]=(acc[config.purpose]||0)+1;return acc;},{mail:0,roster:0,attachment:0,ignored:0});
    const sourceCount=dataset.sourceFiles?.length || 0;
    const containerCount=dataset.meta?.containerFiles?.length||0;
    const duplicateSourceCount=Number(dataset.meta?.duplicateSourceCount||0);
    $('nmda-import-format-info').textContent = `${containerCount?`已展开 ${containerCount} 个资料包 · `:''}${sourceCount?`${sourceCount} 个内容文件 · `:''}${batch.tasks.length} 封邮件${referenceRosterCount()?` · 参考名单 ${referenceRosterCount()} 条`:''}${duplicateSourceCount?` · 已忽略 ${duplicateSourceCount} 个重复副本`:''}`;
    setImportStatus(routedCounts.mail
      ? `邮件已加入本批次。${duplicateSourceCount?`系统已在解析前合并 ${duplicateSourceCount} 个完全相同的重复来源。`:''}${referenceRosterCount()?'参考总名单已参与核对。':'有参考总名单可现在补充；没有可直接继续。'}`
      : `当前没有识别到可创建的邮件。已打开分类核验工作区，请先确认文件用途并直接修正。`,
      routedCounts.mail?'ok':'warn');
    renderImportLifecycleState();
    batch.supplementPreflightOpen=true;renderSupplementPreflight();
    if(!routedCounts.mail||!batch.tasks.length)setBatchStatus('当前没有生成邮件任务；非邮件资料不会占用任务数或阻塞后续流程。','warn');
    else setBatchStatus(`已准备 ${batch.tasks.length} 封邮件。${(batch.tasks||[]).some(taskHasBlockingIssue)?'完成必要待办后会自动进入下一步。':'内容已就绪，正在进入选择与安排。'}`, 'ok');
    if(batch.tasks.length){
      if(batch.supplementPreflightDone&&!(batch.tasks||[]).some(taskHasPrePlanningBlocker))setTimeout(()=>void enterSelectionAndSchedule('解析完成'),0);
    }
    return true;
  }

  function resetImportWorkspace({ keepStatus = false, invalidate = true, message = '' } = {}) {
    if (invalidate) batch.sessionId += 1;
    batch.importBusy = false;
    batch.handoffComplete = false;
    batch.autoAdvancing = false;
    batch.dataset = null;
    batch.importMeta = null;
    batch.collectionIndex = 0;
    batch.collectionConfigs.clear();
    batch.detection = null;
    batch.mapping = {};
    batch.tasks = [];
    batch.duplicateAudit = null;
    batch.directoryFiles = [];
    batch.taskFiles = [];
    batch.routedAttachmentFiles = [];
    batch.sharedFiles = [];
    batch.ignoredAttachmentIdentities = new Set();
    batch.attachmentManagerOpen = false;
    batch.attachmentOverrides.clear();
    batch.attachmentPolicies = new Map();
    batch.attachmentTargetEditing = '';
    batch.attachmentTargetSearch = '';
    batch.taskEdits.clear();
    batch.reviewSelected?.clear?.();
    batch.duplicateSelections?.clear?.();
    batch.reviewFilter='all';
    batch.reviewSearch='';
    batch.bulkSubjectPromptAutoShown=false;
    batch.bulkSubjectPromptDismissed=false;
    if(reviewBulkSubjectInputEl)reviewBulkSubjectInputEl.value='';
    hideBulkSubjectPrompt();
    batch.attachmentAttentionShown=false;
    batch.rosterPromptChoice='idle';
    batch.attachmentPromptDeferred=false;
    batch.attachmentPrepChoice='idle';
    batch.supplementPreflightDone=false;batch.supplementPreflightOpen=false;batch.preflightView='files';batch.planningView='rules';batch.sourceInspectName='';batch.preflightFolderPath='';batch.preflightSearch='';batch.preflightReviewOnly=false;batch.preflightPurposeFilter='';
    batch.fileIndex = Importer.buildFileIndex([]);
    batch.profileSuggestion = null;
    batch.stopRequested = false;
    batch.schedulePlan = null;
    batch.scheduleRules = freshScheduleRules();
    batch.roster = emptyRosterState();
    syncScheduleRuleControls();

    closeImportTaskEditor();
    [importFileEl, importDirEl, importPackageEl, rosterFileEl, dirEl, taskFilesEl, sharedFilesEl].forEach(el => { if (el) el.value = ''; });
    if (pasteSourceEl) pasteSourceEl.value = '';
    const pastePanel = $('nmda-paste-panel'); if (pastePanel) pastePanel.hidden = true;
    const diagnostics = $('nmda-ingest-diagnostics'); if (diagnostics) { diagnostics.hidden = true; diagnostics.open = false; }

    if (batchSearchEl) batchSearchEl.value = '';
    if (batchTagIncludeEl) batchTagIncludeEl.value = '';
    if (batchStageFilterEl) batchStageFilterEl.value = '';
    const bulkTag = $('nmda-bulk-tag-value'); if (bulkTag) bulkTag.value = '';

    ['nmda-structure-card','nmda-mapping-card','nmda-ingest-diagnostics','nmda-ingest-result-card','nmda-roster-audit-card','nmda-attachments-card','nmda-import-handoff-card','nmda-preview-card','nmda-scheduler-card'].forEach(id => {
      const el = $(id); if (el) el.hidden = true;
    });
    const inventory = $('nmda-source-inventory'); if (inventory) { inventory.hidden = true; inventory.innerHTML = ''; }
    if (collectionSelectEl) collectionSelectEl.innerHTML = '';
    const collectionList = $('nmda-collection-list'); if (collectionList) collectionList.innerHTML = '';
    const structureSummary = $('nmda-structure-summary'); if (structureSummary) structureSummary.innerHTML = '';
    const headerInfo = $('nmda-header-info'); if (headerInfo) headerInfo.textContent = '';
    const profileInfo = $('nmda-profile-info'); if (profileInfo) profileInfo.textContent = '';
    const mapping = $('nmda-mapping'); if (mapping) { mapping.innerHTML = ''; mapping.hidden = true; }
    const semantic = $('nmda-semantic-summary'); if (semantic) semantic.innerHTML = '';
    const structure = $('nmda-structure-preview'); if (structure) structure.innerHTML = '';
    const summary = $('nmda-import-preview-summary'); if (summary) summary.innerHTML = '';
    if (importPreviewSummaryEl) importPreviewSummaryEl.innerHTML = '';
    if (reviewQueueEl) reviewQueueEl.innerHTML = '';
    if (reviewSourceContextEl) reviewSourceContextEl.innerHTML = '';
    if (reviewSourceMetaEl) reviewSourceMetaEl.innerHTML = '';
    if (reviewCandidatesEl) reviewCandidatesEl.innerHTML = '';
    if (reviewProgressEl) reviewProgressEl.textContent = '';
    if (reviewNavCountEl) { reviewNavCountEl.hidden=true; reviewNavCountEl.textContent=''; }
    if (reviewPageSummaryEl) reviewPageSummaryEl.innerHTML='<span>尚无批量邮件</span>';
    if (reviewPageEmptyEl) reviewPageEmptyEl.hidden=false;
    if (reviewBatchbarEl) reviewBatchbarEl.hidden=true;
    const reviewGuide = $('nmda-review-guidance'); if (reviewGuide) reviewGuide.textContent = '解析完成后可查看每封邮件的结果。';
    const reviewBtn = $('nmda-review-import-issues'); if (reviewBtn) { reviewBtn.hidden = true; reviewBtn.textContent = '检查邮件'; }
    hideSubjectAssist();
    if(schedulerCardEl){schedulerCardEl.open=true;schedulerCardEl.hidden=true;}
    if(schedulerToggleLabelEl)schedulerToggleLabelEl.textContent='收起';
    const restoreBtn = $('nmda-restore-excluded'); if (restoreBtn) restoreBtn.hidden = true;
    const fileInfo = $('nmda-file-index-info'); if (fileInfo) fileInfo.textContent = '尚未选择本地附件。';
    const attachmentSummary = $('nmda-attachment-summary'); if (attachmentSummary) attachmentSummary.textContent = '尚未添加附件。';
    const attachmentResolution = $('nmda-attachment-resolution'); if (attachmentResolution) attachmentResolution.hidden = true;
    const attachmentResolutionList = $('nmda-attachment-resolution-list'); if (attachmentResolutionList) attachmentResolutionList.innerHTML = '';
    const readySummary = $('nmda-import-ready-summary'); if (readySummary) readySummary.textContent = '还没有准备好邮件。';

    $('nmda-batch-empty').hidden = false;
    $('nmda-import-format-info').textContent = '可直接加入常见文档、表格和文本。';
    const rosterStatus=$('nmda-roster-source-status'); if(rosterStatus)rosterStatus.textContent='尚未载入总套磁名单。';
    const rosterRemove=$('nmda-roster-remove'); if(rosterRemove)rosterRemove.hidden=true;
    const rosterSummary=$('nmda-roster-audit-summary'); if(rosterSummary)rosterSummary.innerHTML='';
    const rosterDetails=$('nmda-roster-audit-details'); if(rosterDetails)rosterDetails.innerHTML='';
    setBatchStatus('请先添加资料并检查解析结果。');
    renderImportLifecycleState();
    if (!keepStatus) setImportStatus(message || '还没有添加资料。');
    scheduleBatchRender({aux:true});
  }

  function clearImportOnError(error, sessionToken = batch.sessionId) {
    if (!isCurrentBatchSession(sessionToken)) return;
    console.error(`[${APP}] import`, error);
    resetImportWorkspace({ keepStatus: true, invalidate: true });
    setImportStatus(`读取失败：${error.message}`, 'error');
  }


  async function readDroppedEntry(entry, path = '') {
    if (!entry) return [];
    if (entry.isFile) {
      const file = await new Promise((resolve,reject)=>entry.file(resolve,reject));
      try { Object.defineProperty(file,'_nmdaPath',{value:`${path}${file.name}`,configurable:true}); } catch (_) { try { file._nmdaPath=`${path}${file.name}`; } catch (_) {} }
      return [file];
    }
    if (!entry.isDirectory) return [];
    const reader=entry.createReader(); const entries=[];
    while(true){
      const batchEntries=await new Promise((resolve,reject)=>reader.readEntries(resolve,reject));
      if(!batchEntries.length)break; entries.push(...batchEntries);
    }
    const nested=[];
    for(const child of entries)nested.push(...await readDroppedEntry(child,`${path}${entry.name}/`));
    return nested;
  }

  async function filesFromDrop(dataTransfer) {
    const items=[...(dataTransfer?.items||[])]; const out=[];
    if(items.length){
      for(const item of items){
        const entry=item.webkitGetAsEntry?.();
        if(entry){ out.push(...await readDroppedEntry(entry,'')); continue; }
        const file=item.getAsFile?.(); if(file)out.push(file);
      }
    } else out.push(...[...(dataTransfer?.files||[])]);
    return uniqueFiles(out);
  }

  async function importDroppedFiles(files) {
    if(!files.length||!Importer)return;
    const hasFolders=files.some(file=>String(file?._nmdaPath||file?.webkitRelativePath||'').includes('/'));
    const token=beginImportSession(`正在读取拖入的 ${files.length} 个文件…`);
    try{
      const dataset=hasFolders?await Importer.parseDirectory(files):await Importer.parseFiles(files);
      if(!isCurrentBatchSession(token))return;
      await applyImportedDataset(dataset,hasFolders?`拖入文件夹（${files.length} 个文件）`:`拖入文件（${files.length} 个）`,token);
    }catch(error){clearImportOnError(error,token);}
    finally{finishImportSession(token);}
  }

  const importDropZone=$('nmda-import-drop-zone');
  importDropZone?.addEventListener('click',()=>{if(!batch.importBusy)importFileEl?.click();});
  importDropZone?.addEventListener('keydown',event=>{if((event.key==='Enter'||event.key===' ')&&!batch.importBusy){event.preventDefault();importFileEl?.click();}});
  importDropZone?.addEventListener('dragenter',event=>{event.preventDefault();importDropZone.classList.add('is-dragging');});
  importDropZone?.addEventListener('dragover',event=>{event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect='copy';importDropZone.classList.add('is-dragging');});
  importDropZone?.addEventListener('dragleave',event=>{if(!importDropZone.contains(event.relatedTarget))importDropZone.classList.remove('is-dragging');});
  importDropZone?.addEventListener('drop',async event=>{event.preventDefault();importDropZone.classList.remove('is-dragging');if(batch.importBusy)return;const files=await filesFromDrop(event.dataTransfer);if(!files.length){setImportStatus('没有识别到可导入的文件。','warn');return;}await importDroppedFiles(files);});

  importFileEl.addEventListener('change', async () => {
    const files = [...(importFileEl.files || [])];
    if (!files.length || !Importer) return;
    const token = beginImportSession(`正在读取 ${files.length === 1 ? files[0].name : `${files.length} 个文件`}…`);
    try {
      const dataset = await Importer.parseFiles(files);
      if (!isCurrentBatchSession(token)) return;
      await applyImportedDataset(dataset, files.length === 1 ? files[0].name : `${files.length} 个文件`, token);
    } catch (error) { clearImportOnError(error, token); }
    finally { finishImportSession(token); if (importFileEl) importFileEl.value = ''; }
  });

  importDirEl?.addEventListener('change', async () => {
    const files = [...(importDirEl.files || [])];
    if (!files.length || !Importer) return;
    const token = beginImportSession(`正在扫描文件夹（${files.length} 个文件）…`);
    try {
      const dataset = await Importer.parseDirectory(files);
      if (!isCurrentBatchSession(token)) return;
      await applyImportedDataset(dataset, `文件夹（${dataset.sourceFiles?.length || 0} 个可读取文件）`, token);
    } catch (error) { clearImportOnError(error, token); }
    finally { finishImportSession(token); if (importDirEl) importDirEl.value = ''; }
  });

  importPackageEl?.addEventListener('change', async () => {
    const file = importPackageEl.files?.[0];
    if (!file || !Importer) return;
    const token = beginImportSession(`正在读取 ZIP ${file.name}…`);
    try {
      const dataset = await Importer.parseFile(file);
      if (!isCurrentBatchSession(token)) return;
      await applyImportedDataset(dataset, `ZIP ${file.name}`, token);
    } catch (error) { clearImportOnError(error, token); }
    finally { finishImportSession(token); if (importPackageEl) importPackageEl.value = ''; }
  });


  rosterFileEl?.addEventListener('change', async () => {
    const files=[...(rosterFileEl.files||[])];
    if(files.length)await loadRosterFiles(files);
  });
  $('nmda-roster-remove')?.addEventListener('click', removeRoster);
  $('nmda-open-supplement-preflight')?.addEventListener('click',()=>openSupplementPreflight('files'));
  $('nmda-edit-batch-prep')?.addEventListener('click',()=>openSupplementPreflight('support'));
  $('nmda-close-supplement-preflight')?.addEventListener('click',()=>{batch.supplementPreflightOpen=false;renderSupplementPreflight();setImportStatus('已返回上传区。','ok');});
  $('nmda-preflight-source-search')?.addEventListener('input',event=>{batch.preflightSearch=String(event.target.value||'');renderPreflightSourceRoles();});
  $('nmda-source-inspector-close')?.addEventListener('click',()=>{batch.sourceInspectName='';const diagnostics=$('nmda-ingest-diagnostics');if(diagnostics){diagnostics.hidden=true;diagnostics.open=false;}renderPreflightSourceRoles();});
  ui.querySelectorAll('[data-preflight-view]').forEach(button=>button.addEventListener('click',()=>setPreflightView(button.dataset.preflightView)));
  ui.querySelectorAll('button[data-support-view]').forEach(button=>button.addEventListener('click',()=>setSupportView(button.dataset.supportView)));
  ui.querySelectorAll('[data-planning-view]').forEach(button=>button.addEventListener('click',()=>setPlanningView(button.dataset.planningView)));
  $('nmda-open-review-from-planning')?.addEventListener('click',()=>openReviewWorkspace({returnStep:3}));
  $('nmda-open-schedule-modal')?.addEventListener('click',openScheduleModal);
  $('nmda-close-schedule-modal')?.addEventListener('click',()=>closeScheduleModal());
  $('nmda-cancel-schedule-modal')?.addEventListener('click',()=>closeScheduleModal());
  $('nmda-schedule-modal')?.addEventListener('click',event=>{if(event.target===event.currentTarget)closeScheduleModal();});
  $('nmda-back-to-planning')?.addEventListener('click',()=>goToProcessStep(3));
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!$('nmda-schedule-modal')?.hidden){event.preventDefault();closeScheduleModal();}});
  previewBodyEl?.addEventListener('click',event=>{const button=event.target.closest?.('[data-review-task]');if(button)openReviewWorkspace({returnStep:3,taskKey:button.dataset.reviewTask});});

  $('nmda-source-next-review')?.addEventListener('click',event=>{const source=decodeURIComponent(event.currentTarget.dataset.nextSource||'');if(source)inspectSourceInPreflight(source);});
  $('nmda-preflight-dropzones')?.querySelectorAll('[data-drop-purpose]').forEach(zone=>{
    zone.addEventListener('dragover',event=>{event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect='move';zone.classList.add('is-over');});
    zone.addEventListener('dragleave',event=>{if(!zone.contains(event.relatedTarget))zone.classList.remove('is-over');});
    zone.addEventListener('drop',event=>{event.preventDefault();zone.classList.remove('is-over');document.querySelector('.nmda-classify-dialog')?.classList.remove('is-drag-classifying');const source=event.dataTransfer?.getData('text/plain')||batch.sourceInspectName;if(!source)return;const purpose=zone.dataset.dropPurpose||'';if(purpose==='review')setSourceNeedsReview(source);else setSourcePurpose(source,purpose);});
  });
  $('nmda-preflight-roster-skip')?.addEventListener('click',()=>{batch.rosterPromptChoice='skipped';renderImportLifecycleState();renderSupplementPreflight();});
  $('nmda-preflight-attachment-skip')?.addEventListener('click',()=>{batch.attachmentPrepChoice='skipped';renderImportLifecycleState();renderSupplementPreflight();});
  $('nmda-complete-supplement-preflight')?.addEventListener('click',completeSupplementPreflight);
  $('nmda-roster-skip')?.addEventListener('click',()=>{
    batch.rosterPromptChoice='skipped';
    renderImportLifecycleState();
    scheduleBatchRender({aux:true,force:true});
    setImportStatus('已跳过参考总名单。','ok');
    renderSupplementPreflight();
    if(batch.supplementPreflightDone)setTimeout(()=>void enterSelectionAndSchedule('参考总名单已跳过'),0);
  });
  $('nmda-attachment-later')?.addEventListener('click',()=>{
    batch.attachmentPromptDeferred=true;
    renderAttachmentContextCue();
    setImportStatus('附件待办已保留；先处理邮件内容即可。','ok');
  });
  $('nmda-roster-enabled')?.addEventListener('change', e => {
    rosterState().enabled=!!e.target.checked;
    batch.handoffComplete=false;
    if(batch.dataset)rebuildTasks();else renderRosterAudit();
  });
  $('nmda-roster-auto-school')?.addEventListener('change', e => {
    rosterState().autoSchool=!!e.target.checked;
    batch.handoffComplete=false;
    if(batch.dataset)rebuildTasks();else renderRosterAudit();
  });
  $('nmda-roster-strict')?.addEventListener('change', e => {
    rosterState().strict=!!e.target.checked;
    batch.handoffComplete=false;
    if(batch.dataset)rebuildTasks();else renderRosterAudit();
  });

  $('nmda-show-paste')?.addEventListener('click', () => {
    const panel = $('nmda-paste-panel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) pasteSourceEl?.focus();
  });

  $('nmda-paste-import')?.addEventListener('click', async () => {
    const text = String(pasteSourceEl?.value || '').trim();
    if (!text) { setImportStatus('请先粘贴需要导入的内容。', 'warn'); return; }
    const token = beginImportSession('正在读取粘贴内容…');
    try {
      const file = new File([text], `pasted-${Date.now()}.txt`, { type:'text/plain;charset=utf-8', lastModified:Date.now() });
      const dataset = await Importer.parseFile(file);
      if (!isCurrentBatchSession(token)) return;
      dataset.meta = { ...(dataset.meta || {}), pasted:true };
      await applyImportedDataset(dataset, '粘贴内容', token);
    } catch (error) { clearImportOnError(error, token); }
    finally { finishImportSession(token); }
  });

  draftImportEl?.addEventListener('click',()=>void importMailboxDrafts());

  $('nmda-reset-import')?.addEventListener('click', () => {
    if (batch.running) { setImportStatus('正在创建草稿，暂时不能开始新批次。', 'warn'); return; }
    resetImportWorkspace({ message: '当前批次已彻底清空，可以载入新的来源。' });
  });

  $('nmda-go-batch')?.addEventListener('click', async () => {
    const button = $('nmda-go-batch');
    if (!button || button.disabled || !batch.tasks.length) return;
    if(batch.handoffComplete){setWorkbenchTab('batch');setBatchStatus(`当前有 ${batch.tasks.length} 封邮件。`, 'ok');requestAnimationFrame(() => $('nmda-stage-execute')?.scrollIntoView?.({behavior:'smooth', block:'start'}));return;}
    button.disabled = true;
    button.textContent = '正在进入下一步…';
    await enterSelectionAndSchedule('资料已就绪');
  });

  importReviewBtnEl?.addEventListener('click',()=>{if(importReviewBtnEl?.dataset.mode==='issues')openNextBlockingIssue();else openReviewWorkspace();});
  $('nmda-review-next-pending')?.addEventListener('click',()=>{
    const button=$('nmda-review-next-pending');
    if(button?.dataset.mode==='continue'){void continueAfterReviewResolution('邮件检查完成');return;}
    openNextReviewTask();
  });
  $('nmda-review-guidance')?.addEventListener('click',event=>{
    const action=event.target?.closest?.('[data-issue-action]')?.dataset?.issueAction;
    if(action==='next'||action==='review'){openNextBlockingIssue();return;}
    if(action==='attachments'){openNextBlockingIssue('attachments');}
  });
  ui.querySelectorAll('[data-review-filter]').forEach(button=>button.addEventListener('click',()=>{
    batch.reviewFilter=['all','auto','pending','decision','confirmed'].includes(button.dataset.reviewFilter)?button.dataset.reviewFilter:'all';
    viewPerf.reviewRenderLimit=250;
    const currentKey=importEditorOverlayEl?.dataset.editKey||'';
    renderReviewPageOverview();
    const visible=reviewVisibleTasks();
    if(currentKey && !visible.some(task=>task.editKey===currentKey))closeImportTaskEditor();
  }));
  reviewFillSubjectsEl?.addEventListener('click',()=>openBulkSubjectPrompt({auto:false}));
  reviewBulkSubjectApplyEl?.addEventListener('click',()=>void applyBulkSubjects());
  $('nmda-review-bulk-subject-dismiss')?.addEventListener('click',()=>hideBulkSubjectPrompt({dismiss:true}));
  reviewBulkSubjectInputEl?.addEventListener('input',()=>{if(reviewSubjectPromptEl)delete reviewSubjectPromptEl.dataset.error;});
  reviewBulkSubjectInputEl?.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing){event.preventDefault();void applyBulkSubjects();}});
  $('nmda-review-select-filtered')?.addEventListener('click',selectVisibleReviewTasks);
  $('nmda-review-clear-selected')?.addEventListener('click',()=>{batch.reviewSelected.clear();renderReviewQueue(importEditorOverlayEl?.dataset.editKey||'');renderReviewBatchActions();});
  $('nmda-review-confirm-selected')?.addEventListener('click',confirmSelectedReviewTasks);
  duplicateCandidatesEl?.addEventListener('change',event=>{
    const input=event.target?.closest?.('[data-duplicate-pick]');if(!input)return;
    const groupId=duplicateDecisionEl?.dataset.groupId||'';
    const selected=[...duplicateCandidatesEl.querySelectorAll('input[data-duplicate-pick]:checked')].map(item=>item.dataset.duplicatePick).filter(Boolean);
    if(groupId&&batch.duplicateSelections instanceof Map)batch.duplicateSelections.set(groupId,selected);
    duplicateCandidatesEl.querySelectorAll('[data-duplicate-row]').forEach(row=>row.classList.toggle('is-selected',selected.includes(row.dataset.duplicateRow)));
    if(duplicateKeepSelectedEl)duplicateKeepSelectedEl.textContent=`保留所选（${selected.length}）`;
    if(duplicateDecisionHintEl)duplicateDecisionHintEl.textContent=selected.length?'未勾选的邮件将在确认后排除。':'至少保留一封；当前尚未选择任何邮件。';
  });
  duplicateCandidatesEl?.addEventListener('click',event=>{
    const button=event.target?.closest?.('[data-duplicate-open]');if(!button)return;
    const key=button.dataset.duplicateOpen||'';const groupId=duplicateDecisionEl?.dataset.groupId||'';
    if(groupId&&batch.duplicateSelections instanceof Map){const selected=[...duplicateCandidatesEl.querySelectorAll('input[data-duplicate-pick]:checked')].map(item=>item.dataset.duplicatePick).filter(Boolean);if(selected.length)batch.duplicateSelections.set(groupId,selected);}
    stashCurrentReviewDraft();rebuildTasks();const target=(batch.tasks||[]).find(item=>item.editKey===key);if(target)openImportTaskEditor(target);
  });
  $('nmda-duplicate-keep-selected')?.addEventListener('click',()=>void keepSelectedDuplicateCandidate());
  $('nmda-duplicate-keep-all')?.addEventListener('click',()=>void keepAllDuplicateCandidates());
  $('nmda-import-editor-close')?.addEventListener('click', closeImportTaskEditor);
  $('nmda-import-editor-cancel')?.addEventListener('click', closeReviewWorkspace);
  $('nmda-import-editor-save')?.addEventListener('click', () => saveImportTaskEditor(false));
  $('nmda-import-editor-next')?.addEventListener('click', () => saveImportTaskEditor(true));
  $('nmda-review-correct')?.addEventListener('click',()=>{const task=reviewCurrentTask();if(task)setReviewCorrectionMode('correction',task);});
  $('nmda-review-back-audit')?.addEventListener('click',returnToReviewAudit);
  $('nmda-review-exclude')?.addEventListener('click', excludeCurrentReviewTask);
  [importEditRecipientsEl,importEditSubjectEl,importEditBodyEl].forEach(el=>el?.addEventListener('input',()=>{refreshReviewDraftIndicators();if(el===importEditBodyEl)autoSizeReviewBody();}));
  importEditSubjectEl?.addEventListener('input',()=>{
    hideSubjectAssist();
    if(subjectAssistTimer)clearTimeout(subjectAssistTimer);
    if(importEditSubjectEl.dataset.startedBlank==='1'&&String(importEditSubjectEl.value||'').trim())subjectAssistTimer=setTimeout(()=>{subjectAssistTimer=null;maybeOfferSubjectAssist();},650);
  });
  [importEditRecipientsEl,importEditBodyEl].forEach(el=>el?.addEventListener('change',()=>{
    const key=importEditorOverlayEl?.dataset.editKey||'';
    stashCurrentReviewDraft();rebuildTasks();renderReviewQueue(key);
    const current=(batch.tasks||[]).find(task=>task.editKey===key);
    if(current){
      const previousMode=importEditorOverlayEl?.dataset.mode||'correction';
      renderReviewAudit(current);updateReviewFieldStates(current);
      setReviewCorrectionMode(previousMode==='direct'?(taskNeedsDirectCorrection(current)?'direct':'audit'):'correction',current);
    }
  }));
  importEditSubjectEl?.addEventListener('change',()=>{
    if(subjectAssistTimer){clearTimeout(subjectAssistTimer);subjectAssistTimer=null;}
    const key=importEditorOverlayEl?.dataset.editKey||'';
    stashCurrentReviewDraft();rebuildTasks();renderReviewQueue(key);maybeOfferSubjectAssist();
    const current=(batch.tasks||[]).find(task=>task.editKey===key);
    if(current){
      const previousMode=importEditorOverlayEl?.dataset.mode||'correction';
      renderReviewAudit(current);updateReviewFieldStates(current);
      setReviewCorrectionMode(previousMode==='direct'?(taskNeedsDirectCorrection(current)?'direct':'audit'):'correction',current);
    }
  });
  $('nmda-subject-assist-apply')?.addEventListener('click',()=>void applySubjectAssist());
  $('nmda-subject-assist-dismiss')?.addEventListener('click',async()=>{
    if(subjectAssistTimer){clearTimeout(subjectAssistTimer);subjectAssistTimer=null;}
    hideSubjectAssist();if(importEditSubjectEl)importEditSubjectEl.dataset.startedBlank='0';
    const key=importEditorOverlayEl?.dataset.editKey||'';
    const current=(batch.tasks||[]).find(task=>task.editKey===key);
    if(current&&!taskNeedsImportReview(current))await continueAfterReviewResolution('当前邮件已补齐');
  });
  schedulerCardEl?.addEventListener('toggle',()=>{if(schedulerToggleLabelEl)schedulerToggleLabelEl.textContent=schedulerCardEl.open?'收起':'展开';});
  $('nmda-restore-excluded')?.addEventListener('click', () => {
    batch.handoffComplete=false;
    for (const [key,edit] of batch.taskEdits) if(edit?.importExcluded) batch.taskEdits.set(key,{...edit,importExcluded:false});
    rebuildTasks();
  });

  mappingToggleEl?.addEventListener('click', () => setMappingEditorOpen(mappingEl.hidden));
  $('nmda-save-profile')?.addEventListener('click', () => {
    const collection = currentCollection();
    if (!collection || !batch.detection) return;
    const defaultName = `${collection.name || '内容'} 识别模板`;
    const name = prompt('为这套导入设置命名：', defaultName);
    if (!name) return;
    const headers = batch.detection.headers || [];
    const fieldHeaders = {};
    for (const [field, index] of Object.entries(batch.mapping || {})) fieldHeaders[field] = headers[index] || '';
    const profile = Importer.createProfile({
      name,
      format: collection.meta?.format || batch.dataset?.format || '',
      collectionName: collection.name || '',
      headers,
      mapping: batch.mapping,
      confidence: batch.detection.confidence || {}
    });
    profile.fieldHeaders = fieldHeaders;
    Importer.saveProfile(profile);
    $('nmda-profile-info').textContent = `已保存当前导入设置“${name}”。`;
  });
  $('nmda-apply-profile')?.addEventListener('click', () => {
    const suggestion = batch.profileSuggestion;
    const collection = currentCollection();
    if (!suggestion?.profile || !collection || !batch.detection) return;
    const headers = batch.detection.headers || [];
    const normalized = headers.map(Importer.normalizeHeader);
    const next = {};
    const profile = suggestion.profile;
    for (const [field, oldIndex] of Object.entries(profile.mapping || {})) {
      const wanted = Importer.normalizeHeader(profile.fieldHeaders?.[field] || profile.headers?.[oldIndex] || '');
      const currentIndex = wanted ? normalized.indexOf(wanted) : -1;
      if (currentIndex >= 0) next[field] = currentIndex;
      else if (Number(oldIndex) < headers.length) next[field] = Number(oldIndex);
    }
    const config = ensureCollectionConfig(batch.collectionIndex);
    config.mapping = next;
    batch.mapping = config.mapping;
    mappingEl.innerHTML = Importer.FIELD_DEFS.map(field => mappingSelectHtml(field, headers)).join('');
    mappingEl.querySelectorAll('select[data-map-field]').forEach(select => select.addEventListener('change', () => {
      const field = select.dataset.mapField;
      if (select.value === '') delete config.mapping[field]; else config.mapping[field] = Number(select.value);
      batch.mapping = config.mapping;
      batch.handoffComplete=false;
      renderSemanticSummary(); rebuildTasks();
    }));
    setMappingEditorOpen(true);
    renderSemanticSummary(); rebuildTasks();
    $('nmda-profile-info').textContent = `已使用导入设置“${profile.name}”。请检查邮件结果。`;
  });
  collectionSelectEl.addEventListener('change', () => { configureCollection(collectionSelectEl.value, false); renderCollectionList(); });
  dirEl?.addEventListener('change', () => {
    const files=uniqueFiles([...(dirEl.files||[])]);for(const file of files)batch.ignoredAttachmentIdentities.delete(Importer.fileIdentity(file));
    batch.directoryFiles=uniqueFiles([...(batch.directoryFiles||[]),...files]);for(const file of files)ensureAttachmentPolicy(file,'directory',{source:'选择文件夹',mode:'smart'});
    batch.attachmentPrepChoice='added';dirEl.value='';refreshFileIndex(false);renderSupplementPreflight();
  });
  preSendMatchFilesEl?.addEventListener('change',()=>{const files=[...(preSendMatchFilesEl.files||[])];preSendMatchFilesEl.value='';addAttachmentFiles(files,{source:'发送前添加',mode:'smart'});});
  preSendSharedFilesEl?.addEventListener('change',()=>{const files=[...(preSendSharedFilesEl.files||[])];preSendSharedFilesEl.value='';addAttachmentFiles(files,{source:'发送前添加'});});
  taskFilesEl?.addEventListener('change',()=>{const files=[...(taskFilesEl.files||[])];taskFilesEl.value='';const count=addAttachmentFiles(files,{source:'选择文件'});if(count)setBatchStatus(`已加入 ${count} 个附件；请在附件工作台确认适用范围。`,'ok');});
  sharedFilesEl?.addEventListener('change',()=>{const files=[...(sharedFilesEl.files||[])];sharedFilesEl.value='';addAttachmentFiles(files,{source:'兼容导入',mode:'all'});});

  const attachmentManagerDrop=$('nmda-attachment-manager-drop');
  attachmentManagerDrop?.addEventListener('click',()=>taskFilesEl?.click());
  attachmentManagerDrop?.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();taskFilesEl?.click();}});
  attachmentManagerDrop?.addEventListener('dragenter',event=>{event.preventDefault();attachmentManagerDrop.classList.add('is-dragging');});
  attachmentManagerDrop?.addEventListener('dragover',event=>{event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect='copy';attachmentManagerDrop.classList.add('is-dragging');});
  attachmentManagerDrop?.addEventListener('dragleave',event=>{if(!attachmentManagerDrop.contains(event.relatedTarget))attachmentManagerDrop.classList.remove('is-dragging');});
  attachmentManagerDrop?.addEventListener('drop',async event=>{
    event.preventDefault();attachmentManagerDrop.classList.remove('is-dragging');
    const files=await filesFromDrop(event.dataTransfer);if(!files.length)return;
    const folder=files.some(file=>String(file?._nmdaPath||file?.webkitRelativePath||'').includes('/'));
    const count=addAttachmentFiles(files,{source:folder?'拖入文件夹':'拖入文件',mode:folder?'smart':''});
    if(count)setBatchStatus(`已拖入 ${count} 个附件；发送范围已按业务场景给出默认配置，可在工作台逐项调整。`,'ok');
  });

  $('nmda-manager-clear-attachments')?.addEventListener('click',clearAttachmentAssets);
  $('nmda-close-attachment-manager')?.addEventListener('click',closeAttachmentManager);
  $('nmda-attachment-manager-done')?.addEventListener('click',closeAttachmentManager);
  $('nmda-manage-attachments-strip')?.addEventListener('click',openAttachmentManager);
  $('nmda-manage-attachments-todo')?.addEventListener('click',openAttachmentManager);
  $('nmda-manage-attachments-workflow')?.addEventListener('click',openAttachmentManager);
  $('nmda-manage-attachments-planning')?.addEventListener('click',openAttachmentManager);
  $('nmda-attachment-target-close')?.addEventListener('click',()=>{batch.attachmentTargetEditing='';batch.attachmentTargetSearch='';renderAttachmentAssetViews();});
  $('nmda-attachment-target-search')?.addEventListener('input',event=>{batch.attachmentTargetSearch=event.target.value||'';renderAttachmentTargetEditor();});
  $('nmda-attachment-target-all')?.addEventListener('click',()=>{
    const id=batch.attachmentTargetEditing,file=allAttachmentFiles().find(item=>Importer.fileIdentity(item)===id);if(!file)return;
    const policy=ensureAttachmentPolicy(file,attachmentKindForFile(file));const q=normalizedSearchText(batch.attachmentTargetSearch||'');
    const targets=new Set(policy.targets||[]);for(const task of batch.tasks||[])if(!q||normalizedSearchText([task.recipients,task.subject,task.school].join(' ')).includes(q))targets.add(task.editKey);
    policy.mode='selected';policy.targets=[...targets];batch.attachmentPolicies.set(id,policy);rebuildTasks();renderAttachmentAssetViews();
  });
  $('nmda-attachment-target-clear')?.addEventListener('click',()=>{
    const id=batch.attachmentTargetEditing,file=allAttachmentFiles().find(item=>Importer.fileIdentity(item)===id);if(!file)return;
    const policy=ensureAttachmentPolicy(file,attachmentKindForFile(file));policy.mode='selected';policy.targets=[];batch.attachmentPolicies.set(id,policy);rebuildTasks();renderAttachmentAssetViews();
  });
  $('nmda-attachment-manager-overlay')?.addEventListener('click',event=>{if(event.target===$('nmda-attachment-manager-overlay'))closeAttachmentManager();});
  ui.addEventListener('click',event=>{
    const remove=event.target.closest?.('[data-attachment-remove]');if(remove){removeAttachmentAsset(decodeURIComponent(remove.dataset.attachmentRemove||''));return;}
    if(event.target.closest?.('[data-open-attachment-manager]'))openAttachmentManager();
  });

  $('nmda-template').addEventListener('click', () => {
    const csv = '\ufeff编号,收件人,学校,主题,正文,附件,定时时间,任务标记\r\n001,mail-test@example.com,示例大学,测试主题,这是正文,该封材料.pdf,2026-08-25 09:30,第一批;重点\r\n002,mail-test-2@example.com,示例大学,测试主题2,这是正文2,,,第二批\r\n';
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = 'netease-mail-batch-template.csv'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  scheduleApplyEl?.addEventListener('click', () => { applySmartSchedule(); closeScheduleModal(); });
  scheduleClearEl?.addEventListener('click', clearAutoSchedule);
  [scheduleStartEl,scheduleMaxSchoolEl,scheduleIntervalDaysEl,schedulePreserveEl,scheduleHolidayEl].forEach(el=>el?.addEventListener('change',()=>{readScheduleRuleControls();batch.schedulePlan=null;renderScheduleCenter();}));
  syncScheduleRuleControls();

  const renderBatchFilterDebounced=debounce(()=>scheduleBatchRender({aux:false}),100);
  [batchSearchEl,batchTagIncludeEl].forEach(el=>el?.addEventListener('input',renderBatchFilterDebounced));
  batchStageFilterEl?.addEventListener('change',()=>scheduleBatchRender({aux:false}));

  function bulkEditFiltered(kind) {
    const targets = filteredBatchTasks().filter(task => task.status !== 'running' && task.status !== 'done');
    if (!targets.length) { setBatchStatus('当前检索/筛选结果没有可编辑任务。', 'warn'); return; }
    const tagValue = $('nmda-bulk-tag-value').value;
    const parsed = parseTaskClassifications(tagValue);
    if ((kind === 'addTag' || kind === 'removeTag') && !parsed.length) {
      setBatchStatus('请输入有效的任务标记。联系状态、待跟进和联系策略由联系人系统维护，不能作为任务标记。', 'warn'); return;
    }
    let affected = 0, blockedSkipped = 0;
    for (const task of targets) {
      if (kind === 'enable') {
        if (task.policyBlocked) { blockedSkipped++; continue; }
        setTaskEdit(task, { enabled: true }); affected++;
      }
      else if (kind === 'disable') { setTaskEdit(task, { enabled: false }); affected++; }
      else if (kind === 'addTag') { setTaskEdit(task, { tags: Contacts.mergeTags(task.tags || [], parsed) }); affected++; }
      else if (kind === 'removeTag') {
        const remove = new Set(parsed.map(tag => tag.toLocaleLowerCase('zh-CN')));
        setTaskEdit(task, { tags: parseTaskClassifications(task.tags || []).filter(tag => !remove.has(tag.toLocaleLowerCase('zh-CN'))) }); affected++;
      }
    }
    const actionText = { enable: '纳入筛选结果', disable: '排除筛选结果', addTag: `添加标记“${tagsText(parsed)}”`, removeTag: `移除标记“${tagsText(parsed)}”` }[kind];
    const skippedText = blockedSkipped ? `；另有 ${blockedSkipped} 封受联系策略拦截，无法选择` : '';
    setBatchStatus(`已对 ${affected} 封任务执行：${actionText}${skippedText}。`, blockedSkipped ? 'warn' : 'ok');
    scheduleBatchRender({aux:false});
  }

  $('nmda-bulk-add-tag').addEventListener('click', () => bulkEditFiltered('addTag'));
  $('nmda-bulk-remove-tag').addEventListener('click', () => bulkEditFiltered('removeTag'));
  $('nmda-bulk-enable').addEventListener('click', () => bulkEditFiltered('enable'));
  $('nmda-bulk-disable').addEventListener('click', () => bulkEditFiltered('disable'));
  $('nmda-clear-selection').addEventListener('click', () => {
    let affected = 0;
    for (const task of batch.tasks || []) {
      if (task.status === 'running' || task.status === 'done' || !task.enabled) continue;
      setTaskEdit(task, { enabled: false }); affected++;
    }
    setBatchStatus(`已排除 ${affected} 封任务；可逐封重新纳入，或使用“纳入筛选结果”。`, 'ok');
    scheduleBatchRender({aux:false});
  });
  $('nmda-clear-tag-filter').addEventListener('click', () => {
    if (batchSearchEl) batchSearchEl.value = '';
    if(batchTagIncludeEl)batchTagIncludeEl.value = '';
    if(batchStageFilterEl)batchStageFilterEl.value = '';
    scheduleBatchRender({aux:false});
  });

  const renderContactFilterDebounced=debounce(()=>{viewPerf.contactRenderLimit=250;scheduleContactsRender();},100);
  $('nmda-contact-search').addEventListener('input',renderContactFilterDebounced);
  $('nmda-contact-class-filter').addEventListener('input',renderContactFilterDebounced);


  async function runMailboxRead(mode = 'quick') {
    const full = mode === 'full';
    const refreshButton = $('nmda-refresh-history');
    const rebuildButton = $('nmda-rebuild-history');
    if (refreshButton) refreshButton.disabled = true;
    if (rebuildButton) rebuildButton.disabled = true;
    setContactStatusMessage(full
      ? '正在重建联系人记录…'
      : '正在快速读取最近邮箱变化…');
    try {
      await ensureContactBook();
      const result = await sendRuntimeMessage({ type: 'NMDA_READ_MAILBOX_STATE', mode: full ? 'full' : 'quick' });
      if (!result?.ok) throw new Error(`${result?.phase ? `${result.phase}：` : ''}${result?.reason || '邮箱读取失败'}`);
      const sent = result.sent || {}, drafts = result.drafts || {}, inbox = result.inbox || {};
      const sentMessages = sent.messages || [], draftMessages = drafts.messages || [], inboxMessages = inbox.messages || [];

      if (full) {
        // Destructive replacement is allowed only from a proven complete snapshot.
        if (!sent.complete || !drafts.complete || !inbox.complete) {
          const sentWhy = sent.complete ? '完整' : (sent.stopReason || `${sent.messages?.length || 0}/${sent.total || '?'}`);
          const draftWhy = drafts.complete ? '完整' : (drafts.stopReason || `${drafts.messages?.length || 0}/${drafts.total || '?'}`);
          const inboxWhy = inbox.complete ? '完整' : (inbox.stopReason || `${inbox.messages?.length || 0}/${inbox.total || '?'}`);
          throw new Error(`完整覆盖未完成（已发送：${sentWhy}；草稿：${draftWhy}；收件箱：${inboxWhy}）。为保护现有数据，本次没有修改联系人库。`);
        }
        const rebuilt = Contacts.rebuildMailboxSnapshot(contactBook.contacts, sentMessages, draftMessages, inboxMessages);
        // Persist the replacement before switching the live in-memory book: atomic at app level.
        await Contacts.save(contactBook.account, rebuilt.contacts);
        contactBook.contacts = rebuilt.contacts;
        markContactsChanged();
        const meta = {
          lastMode: 'full', complete: true, lastFullAt: new Date().toISOString(),
          sent: result.coverage?.sent || { read: sentMessages.length, total: sent.total || sentMessages.length, complete: true, pages: sent.pages || 0 },
          drafts: result.coverage?.drafts || { read: draftMessages.length, total: drafts.total || draftMessages.length, complete: true, pages: drafts.pages || 0 },
          inbox: result.coverage?.inbox || { read: inboxMessages.length, total: inbox.total || inboxMessages.length, complete: true, pages: inbox.pages || 0 }
        };
        const previous = await Contacts.loadSyncMeta(contactBook.account);
        await Contacts.saveSyncMeta(contactBook.account, { ...previous, ...meta });
        await renderMailboxReadMeta({ ...previous, ...meta });
        scheduleContactsRender(); scheduleBatchRender({aux:true}); if(followUpPaneVisible()) await renderFollowUp();
        setContactStatusMessage(`联系人记录重建完成：已发送 ${sentMessages.length} 封 · 草稿 ${draftMessages.length} 封 · 收件箱 ${inboxMessages.length} 封 · 更新 ${rebuilt.contactFacts} 个联系人。${rebuilt.draftsWithoutRecipient ? ` ${rebuilt.draftsWithoutRecipient} 封草稿没有收件人，未关联联系人。` : ''}`, 'ok');
      } else {
        // Quick refresh works on a clone, so a storage failure never leaves a half-applied live state.
        const nextContacts = Contacts.cloneContacts(contactBook.contacts);
        const sentApplied = Contacts.applySentMessages(nextContacts, sentMessages);
        const draftApplied = Contacts.applyDraftMessages(nextContacts, draftMessages, { replaceActive: false });
        const inboxApplied = Contacts.applyInboxMessages(nextContacts, inboxMessages, { replaceActive: false });
        await Contacts.save(contactBook.account, nextContacts);
        contactBook.contacts = nextContacts;
        markContactsChanged();
        const previous = await Contacts.loadSyncMeta(contactBook.account);
        const meta = {
          ...previous, lastMode: 'quick', complete: false, lastQuickAt: new Date().toISOString(),
          sent: result.coverage?.sent || { read: sentMessages.length, total: sent.total || 0, complete: !!sent.complete, pages: sent.pages || 0 },
          drafts: result.coverage?.drafts || { read: draftMessages.length, total: drafts.total || 0, complete: !!drafts.complete, pages: drafts.pages || 0 },
          inbox: result.coverage?.inbox || { read: inboxMessages.length, total: inbox.total || 0, complete: !!inbox.complete, pages: inbox.pages || 0 }
        };
        await Contacts.saveSyncMeta(contactBook.account, meta);
        await renderMailboxReadMeta(meta);
        scheduleContactsRender(); scheduleBatchRender({aux:true}); if(followUpPaneVisible()) await renderFollowUp();
        setContactStatusMessage(`邮箱同步完成：已发送 ${sentMessages.length} 封 · 草稿 ${draftMessages.length} 封 · 收件箱 ${inboxMessages.length} 封（真人回复新增 ${inboxApplied.humanReplies} · Auto Reply 新增 ${inboxApplied.autoReplies}）。`, 'ok');
      }
      return true;
    } catch (error) {
      console.error(`[${APP}] mailbox read ${mode}`, error);
      setContactStatusMessage(`${full ? '重建记录' : '同步邮箱'}失败：${error.message}`, 'error');
      return false;
    } finally {
      if (refreshButton) refreshButton.disabled = false;
      if (rebuildButton) rebuildButton.disabled = false;
    }
  }

  $('nmda-refresh-history')?.addEventListener('click', () => runMailboxRead('quick'));
  $('nmda-rebuild-history')?.addEventListener('click', () => runMailboxRead('full'));

  $('nmda-export-contacts').addEventListener('click', async () => {
    try {
      await ensureContactBook();
      const csv = Contacts.toCsv(contactBook.contacts);
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url; a.download = `netease-contacts-${contactBook.account.replace(/[^a-z0-9@._-]+/ig, '_')}.csv`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setContactStatusMessage('联系人状态与标记已导出为 CSV。', 'ok');
    } catch (error) { setContactStatusMessage(`导出失败：${error.message}`, 'error'); }
  });

  batchStopEl?.addEventListener('click', () => {
    batch.stopRequested = true;
    batchStopEl.disabled = true;
    setBatchStatus('已请求停止：当前这一封完成后不会继续下一封。', 'warn');
  });

  function setBatchPlanningLocked(locked) {
    [batchSearchEl, batchTagIncludeEl, batchStageFilterEl].forEach(el => { if (el) el.disabled = !!locked; });
    if (mappingToggleEl) mappingToggleEl.disabled = !!locked;
    ['nmda-clear-tag-filter','nmda-bulk-add-tag','nmda-bulk-remove-tag','nmda-bulk-enable','nmda-bulk-disable','nmda-clear-selection','nmda-rule-start-at','nmda-rule-max-school','nmda-rule-interval-days','nmda-rule-preserve-existing','nmda-rule-skip-holidays','nmda-apply-schedule','nmda-clear-auto-schedule'].forEach(id => {
      const el = $(id); if (el) el.disabled = !!locked;
    });
  }

  batchStartEl.addEventListener('click', async () => {
    if (batch.running) return;
    if (!batch.handoffComplete) { setBatchStatus('当前邮件还没有完成必要核对，请先在批量工作台上方处理。', 'error'); return; }
    const selectedBlocked=batch.tasks.filter(task=>task.enabled&&task.status==='error');
    if(selectedBlocked.length){
      const attachmentOnly=selectedBlocked.filter(task=>{const state=taskIssueState(task);return state.attachment.length&&state.content.length===0&&state.review.length===0&&state.schedule.length===0&&state.other.length===0;});
      if(attachmentOnly.length===selectedBlocked.length){setBatchStatus(`还有 ${selectedBlocked.length} 封已选择邮件缺少附件。请先打开“附件工作台”补齐文件或调整发送范围，或取消选择这些邮件。`,'error');}
      else setBatchStatus(`还有 ${selectedBlocked.length} 封已选择邮件存在未解决问题。请先审阅或取消选择。`,'error');
      return;
    }
    const executable = batch.tasks.filter(task => task.enabled && task.status === 'ready');
    if (!executable.length) { setBatchStatus('没有已选择且可创建的任务。请先在列表中勾选需要创建的草稿。', 'error'); return; }
    const staleScheduled=executable.filter(task=>task.scheduleAt && (Scheduler?.parseLocalDateTime?.(task.scheduleAt)?.getTime()||0) <= Date.now()+60*1000);
    if(staleScheduled.length){setBatchStatus(`有 ${staleScheduled.length} 封邮件的定时时间已过。请先在“安排时间”中更新或清空。`,'error');return;}
    const executableKeys = new Set(executable.map(task => task.editKey)); // freeze this run at start
    const mailTarget=await sendRuntimeMessage({type:'NMDA_OPEN_MAIL',focus:true});
    if(!mailTarget?.ok){setBatchStatus('无法打开网易邮箱页面，请先完成登录。','error');return;}
    const mailboxReady=await waitForMailboxExecutionReady();
    if(!mailboxReady?.connected || !mailboxReady?.authenticated){
      setBatchStatus('网易邮箱已打开，但尚未检测到已登录账号。请在网易邮箱完成登录后返回工作台再次开始。','error');
      return;
    }
    batch.uiStep=3; renderProcessGuide();
    batch.running = true; batch.stopRequested = false; batchStartEl.disabled = true; batchStopEl.disabled = false;
    await updateMailboxBatchMonitor({action:'start',total:executable.length,succeeded:0,failed:0,remaining:executable.length,items:executable.map((task,index)=>({key:task.editKey,id:task.id,index:index+1,recipient:task.recipients||'',subject:task.subject||'',scheduleAt:task.scheduleAt||'',status:'queued'}))});
    importFileEl.disabled = true; if (importDirEl) importDirEl.disabled = true; if (importPackageEl) importPackageEl.disabled = true; if (rosterFileEl) rosterFileEl.disabled = true; collectionSelectEl.disabled = true; dirEl.disabled = true; taskFilesEl.disabled = true; sharedFilesEl.disabled = true; if(preSendMatchFilesEl)preSendMatchFilesEl.disabled=true;if(preSendSharedFilesEl)preSendSharedFilesEl.disabled=true;if(draftImportEl)draftImportEl.disabled=true; ['nmda-paste-import','nmda-reset-import','nmda-show-paste'].forEach(id => { const el=$(id); if(el) el.disabled=true; });
    setBatchPlanningLocked(true);
    let succeeded = 0, failed = 0;
    try {
      for (let i = 0; i < batch.tasks.length; i++) {
        const task = batch.tasks[i];
        if (!executableKeys.has(task.editKey) || task.status !== 'ready') continue;
        if (batch.stopRequested) break;
        task.status = 'running'; scheduleBatchRender({aux:false});
        const runIndex=succeeded+failed+1;
        setBatchStatus(`正在处理 ${runIndex}/${executable.length} · ${task.id} · ${task.subject || '(无主题)'}${task.scheduleAt ? ` · 定时 ${task.scheduleAt.replace('T', ' ')}` : ' · 未定时'}`);
        await updateMailboxBatchMonitor({action:'task-start',current:runIndex,total:executable.length,succeeded,failed,remaining:Math.max(0,executable.length-runIndex+1),task:{key:task.editKey,id:task.id,recipient:task.recipients||'',subject:task.subject||'',scheduleAt:task.scheduleAt||''}});
        try {
          const outcome = await executeDraftRemotely(task, {
            fresh: true,
            onProgress: progress => {
              setBatchStatus(`任务 ${task.id}：${progress.message || '正在创建草稿…'}`);
              void updateMailboxBatchMonitor({action:'task-progress',current:runIndex,total:executable.length,succeeded,failed,remaining:Math.max(0,executable.length-runIndex),task:{key:task.editKey,id:task.id,recipient:task.recipients||'',subject:task.subject||''},phase:progress.phase||'',message:progress.message||'正在创建草稿…'});
            }
          });
          const upload = outcome.attachment || {};
          if (upload.verified === false && upload.missingNames?.length) {
            task.note = [task.note, `附件已提交上传，但页面未确认：${upload.missingNames.join('、')}`].filter(Boolean).join('；');
          }
          if (task.scheduleAt && outcome.actualMinute !== null && outcome.actualMinute !== undefined) {
            const requestedMinute = new Date(task.scheduleAt).getMinutes();
            if (Number(outcome.actualMinute) !== requestedMinute) task.note = [task.note, `分钟由 ${requestedMinute} 调整为 ${outcome.actualMinute}`].filter(Boolean).join('；');
          }
          task.note = [task.note, `草稿已确认保存（${outcome.saveOutcome?.kind || 'remote'}）`].filter(Boolean).join('；');
          task.status = 'done'; succeeded++;
          await updateMailboxBatchMonitor({action:'task-done',current:runIndex,total:executable.length,succeeded,failed,remaining:Math.max(0,executable.length-succeeded-failed),task:{key:task.editKey,id:task.id,recipient:task.recipients||'',subject:task.subject||''},message:'草稿已确认保存'});
          scheduleBatchRender({aux:false});
          await sleep(300);
        } catch (error) {
          console.error(`[${APP}] batch source record ${task.sourceRow}`, error);
          task.status = 'error'; task.runtimeError = error.message || String(error); failed++; scheduleBatchRender({aux:false});
          await updateMailboxBatchMonitor({action:'task-error',current:runIndex,total:executable.length,succeeded,failed,remaining:Math.max(0,executable.length-succeeded-failed),task:{key:task.editKey,id:task.id,recipient:task.recipients||'',subject:task.subject||''},message:task.runtimeError});
          setBatchStatus(`任务 ${task.id} 失败，已自动停止：${task.runtimeError}。为避免页面状态异常导致串稿，不继续执行后续任务。`, 'error');
          break;
        }
      }
      const remaining = batch.tasks.filter(t => executableKeys.has(t.editKey) && t.status === 'ready').length;
      if (batch.stopRequested) setBatchStatus(`已停止。成功 ${succeeded}，失败 ${failed}，剩余 ${remaining}。`, 'warn');
      else if (failed) setBatchStatus(`批量处理结束：成功 ${succeeded}，失败 ${failed}。请在网易邮箱查看错误任务。`, 'warn');
      else setBatchStatus(`批量处理完成：成功创建并保存 ${succeeded} 封草稿。`, 'ok');
      await updateMailboxBatchMonitor({action:'finish',total:executable.length,succeeded,failed,remaining,status:batch.stopRequested?'stopped':failed?'error':'done',message:batch.stopRequested?`已停止 · 成功 ${succeeded} · 剩余 ${remaining}`:failed?`执行结束 · 成功 ${succeeded} · 失败 ${failed}`:`全部完成 · ${succeeded} 封草稿已保存`});
    } finally {
      batch.running = false; batchStopEl.disabled = true;
      importFileEl.disabled = false; if (importDirEl) importDirEl.disabled = false; if (importPackageEl) importPackageEl.disabled = false; if (rosterFileEl) rosterFileEl.disabled = false; collectionSelectEl.disabled = false; dirEl.disabled = false; taskFilesEl.disabled = false; sharedFilesEl.disabled = false; if(preSendMatchFilesEl)preSendMatchFilesEl.disabled=false;if(preSendSharedFilesEl)preSendSharedFilesEl.disabled=false;if(draftImportEl)draftImportEl.disabled=false; ['nmda-paste-import','nmda-reset-import','nmda-show-paste'].forEach(id => { const el=$(id); if(el) el.disabled=false; });
      setBatchPlanningLocked(false);
      scheduleBatchRender({aux:false});
    }
  });

  restoreFormState();
  invalidateBatchView(true);
  initContacts();
})();
