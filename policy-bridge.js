(() => {
  'use strict';

  const Policy = globalThis.NMDAPolicyProfile;
  const Scheduler = globalThis.NMDAScheduler;
  if (!Policy || !Scheduler || typeof document === 'undefined') return;

  const nativeInstitutionEvidence = Scheduler.institutionEvidence.bind(Scheduler);
  Scheduler.institutionEvidence = (value, recipients = '', source = '', options = {}) => {
    const result = nativeInstitutionEvidence(value, recipients, source, options);
    if (result.valid || String(source || '').toLowerCase() !== 'recognized') return result;
    const text = String(value || '').normalize('NFKC').trim();
    if (!text || result.reason === 'short-code') return result;
    return { ...result, valid:true, value:text, reason:'recognized-source', candidate:true, groupable:false };
  };

  const byId = id => document.getElementById(id);
  let rendering = false;

  function ensureGroupingControl() {
    let input = byId('nmda-rule-group-institution');
    if (input) return input;
    const grid = document.querySelector('#nmda-scheduler-card .nmda-scheduler-grid');
    if (!grid) return null;
    const label = document.createElement('label');
    label.className = 'nmda-check-card nmda-schedule-wide-check nmda-policy-grouping';
    label.innerHTML = '<input id="nmda-rule-group-institution" type="checkbox"><span><strong>按院校分组</strong><small>使用当前策略配置；可随时关闭或修改。</small></span>';
    const maxField = byId('nmda-rule-max-school')?.closest('label');
    if (maxField) grid.insertBefore(label, maxField); else grid.prepend(label);
    return label.querySelector('input');
  }

  function ruleSnapshot() {
    return Scheduler.normalizeRules({
      startAt: byId('nmda-rule-start-at')?.value || '',
      grouping: byId('nmda-rule-group-institution')?.checked ? 'institution' : 'none',
      maxPerGroupPerRound: byId('nmda-rule-max-school')?.value ?? null,
      intervalDays: byId('nmda-rule-interval-days')?.value ?? null,
      preserveExisting: byId('nmda-rule-preserve-existing')?.checked !== false,
      skipHolidays: byId('nmda-rule-skip-holidays')?.checked === true
    });
  }

  function sourceMark(field) {
    return Policy.isScheduleFieldExplicit(field) ? '自定义' : '自动默认';
  }

  function ruleSummary(rules) {
    const parts = [];
    parts.push(rules.grouping === 'institution' ? '按院校分组' : '不按院校分组');
    if (rules.maxPerGroupPerRound != null) parts.push(`每组 ${rules.maxPerGroupPerRound} 位`);
    if (rules.intervalDays != null) parts.push(`间隔 ${rules.intervalDays} 天`);
    if (rules.skipHolidays) parts.push('避开休息日');
    return parts.join(' · ');
  }

  function applyPolicyPresentation() {
    if (rendering) return;
    rendering = true;
    try {
      const effective = Policy.effectiveSchedule();
      const grouping = ensureGroupingControl();
      const max = byId('nmda-rule-max-school');
      const interval = byId('nmda-rule-interval-days');
      const preserve = byId('nmda-rule-preserve-existing');
      const holiday = byId('nmda-rule-skip-holidays');
      const start = byId('nmda-rule-start-at');

      if (grouping && document.activeElement !== grouping) grouping.checked = effective.grouping === 'institution';
      if (max && document.activeElement !== max && !Policy.isScheduleFieldExplicit('maxPerGroupPerRound')) max.value = String(effective.maxPerGroupPerRound ?? '');
      if (interval && document.activeElement !== interval && !Policy.isScheduleFieldExplicit('intervalDays')) interval.value = String(effective.intervalDays ?? '');
      if (preserve && !Policy.isScheduleFieldExplicit('preserveExisting')) preserve.checked = effective.preserveExisting !== false;
      if (holiday && !Policy.isScheduleFieldExplicit('skipHolidays')) holiday.checked = effective.skipHolidays === true;
      if (start && document.activeElement !== start && !start.value) start.value = Policy.suggestedStart();

      const grouped = effective.grouping === 'institution';
      if (max) max.disabled = !grouped;
      if (interval) interval.disabled = !grouped;

      const maxLabel = max?.closest('label')?.querySelector('.nmda-label');
      const intervalLabel = interval?.closest('label')?.querySelector('.nmda-label');
      if (maxLabel) maxLabel.textContent = `每组上限 · ${sourceMark('maxPerGroupPerRound')}`;
      if (intervalLabel) intervalLabel.textContent = `分组间隔 · ${sourceMark('intervalDays')}`;

      const rules = ruleSnapshot();
      const summary = ruleSummary(rules);
      const preview = byId('nmda-schedule-rule-preview');
      const chip = byId('nmda-planning-rule-chip');
      if (preview && preview.textContent !== summary) preview.textContent = summary;
      if (chip && chip.textContent !== summary) chip.textContent = summary;
    } finally {
      rendering = false;
    }
  }

  document.addEventListener('input', event => {
    if (String(event.target?.id || '').startsWith('nmda-rule-')) queueMicrotask(applyPolicyPresentation);
  }, true);
  document.addEventListener('change', event => {
    if (String(event.target?.id || '').startsWith('nmda-rule-')) queueMicrotask(applyPolicyPresentation);
  }, true);
  document.addEventListener('click', event => {
    if (event.target?.closest?.('#nmda-open-schedule-modal,#nmda-apply-schedule,#nmda-cancel-schedule-modal,#nmda-close-schedule-modal')) {
      queueMicrotask(() => requestAnimationFrame(applyPolicyPresentation));
    }
  }, true);

  const observer = new MutationObserver(records => {
    if (rendering) return;
    if (records.some(record => {
      const target = record.target?.nodeType === 1 ? record.target : record.target?.parentElement;
      return target?.closest?.('#nmda-schedule-modal,#nmda-schedule-rule-preview,#nmda-planning-rule-chip');
    })) queueMicrotask(applyPolicyPresentation);
  });

  observer.observe(document.documentElement, { subtree:true, childList:true, attributes:true, characterData:true, attributeFilter:['hidden','class'] });
  queueMicrotask(() => requestAnimationFrame(applyPolicyPresentation));
})();
