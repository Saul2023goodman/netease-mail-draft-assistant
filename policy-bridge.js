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
    label.innerHTML = '<input id="nmda-rule-group-institution" type="checkbox"><span><strong>按院校分组</strong><small>仅在明确启用后，院校信息才参与分组排期。</small></span>';
    const maxField = byId('nmda-rule-max-school')?.closest('label');
    if (maxField) grid.insertBefore(label, maxField); else grid.prepend(label);
    input = label.querySelector('input');
    input.checked = Policy.getGrouping() === 'institution';
    return input;
  }

  function ruleSnapshot() {
    return Scheduler.normalizeRules({
      startAt: byId('nmda-rule-start-at')?.value || '',
      maxPerGroupPerRound: byId('nmda-rule-max-school')?.value ?? null,
      intervalDays: byId('nmda-rule-interval-days')?.value ?? null,
      preserveExisting: byId('nmda-rule-preserve-existing')?.checked !== false,
      skipHolidays: byId('nmda-rule-skip-holidays')?.checked === true
    });
  }

  function ruleSummary(rules) {
    const parts = [];
    if (rules.grouping === 'institution') parts.push('按院校分组');
    else parts.push('未启用自动分组');
    if (rules.maxPerGroupPerRound != null) parts.push(`每组上限 ${rules.maxPerGroupPerRound}`);
    if (rules.intervalDays != null) parts.push(`间隔 ${rules.intervalDays} 天`);
    if (rules.skipHolidays) parts.push('避开休息日');
    if (!rules.startAt) parts.push('起始时间未设置');
    return parts.join(' · ');
  }

  function applyNeutralPresentation() {
    if (rendering) return;
    rendering = true;
    try {
      const grouping = ensureGroupingControl();
      if (grouping) grouping.checked = Policy.getGrouping() === 'institution';

      const max = byId('nmda-rule-max-school');
      const interval = byId('nmda-rule-interval-days');
      const holiday = byId('nmda-rule-skip-holidays');
      const start = byId('nmda-rule-start-at');

      if (max && !Policy.isScheduleFieldExplicit('maxPerGroupPerRound')) max.value = '';
      if (interval && !Policy.isScheduleFieldExplicit('intervalDays')) interval.value = '';
      if (holiday && !Policy.isScheduleFieldExplicit('skipHolidays')) holiday.checked = false;
      if (start && !Policy.isScheduleFieldExplicit('startAt')) start.value = '';

      const grouped = Policy.getGrouping() === 'institution';
      if (max) max.disabled = !grouped;
      if (interval) interval.disabled = !grouped;

      const maxLabel = max?.closest('label')?.querySelector('.nmda-label');
      const intervalLabel = interval?.closest('label')?.querySelector('.nmda-label');
      if (maxLabel) maxLabel.textContent = '每组上限（可选）';
      if (intervalLabel) intervalLabel.textContent = '分组间隔（可选）';

      const rules = ruleSnapshot(), summary = ruleSummary(rules);
      const preview = byId('nmda-schedule-rule-preview');
      const chip = byId('nmda-planning-rule-chip');
      if (preview && preview.textContent !== summary) preview.textContent = summary;
      if (chip && chip.textContent !== summary) chip.textContent = summary;

      const autoSchool = byId('nmda-roster-auto-school');
      if (autoSchool && autoSchool.checked) {
        autoSchool.checked = false;
        autoSchool.dispatchEvent(new Event('change', { bubbles:true }));
      }
    } finally {
      rendering = false;
    }
  }

  document.addEventListener('input', event => {
    if (String(event.target?.id || '').startsWith('nmda-rule-')) queueMicrotask(applyNeutralPresentation);
  }, true);
  document.addEventListener('change', event => {
    if (event.target?.id === 'nmda-rule-group-institution') Policy.setGrouping(event.target.checked ? 'institution' : 'none');
    if (String(event.target?.id || '').startsWith('nmda-rule-')) queueMicrotask(applyNeutralPresentation);
  }, true);
  document.addEventListener('click', event => {
    if (event.target?.closest?.('#nmda-open-schedule-modal,#nmda-apply-schedule,#nmda-cancel-schedule-modal,#nmda-close-schedule-modal')) {
      queueMicrotask(() => requestAnimationFrame(applyNeutralPresentation));
    }
  }, true);

  const observer = new MutationObserver(records => {
    if (rendering) return;
    if (records.some(record => {
      const target = record.target?.nodeType === 1 ? record.target : record.target?.parentElement;
      return target?.closest?.('#nmda-schedule-modal,#nmda-schedule-rule-preview,#nmda-planning-rule-chip,#nmda-roster-audit-card');
    })) queueMicrotask(applyNeutralPresentation);
  });

  observer.observe(document.documentElement, { subtree:true, childList:true, attributes:true, characterData:true, attributeFilter:['hidden','class'] });
  queueMicrotask(() => requestAnimationFrame(applyNeutralPresentation));
})();
