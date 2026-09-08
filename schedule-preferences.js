(() => {
  'use strict';

  const Preferences = globalThis.NMDAPreferences || globalThis.NMDAPolicyProfile;
  const Scheduler = globalThis.NMDAScheduler;
  if (!Preferences || !Scheduler || typeof document === 'undefined') return;

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
    label.className = 'nmda-check-card nmda-schedule-wide-check nmda-schedule-grouping';
    label.innerHTML = '<input id="nmda-rule-group-institution" type="checkbox"><span><strong>同院校错峰</strong><small>需要时启用；只影响排期，不改变邮件内容。</small></span>';
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
    return Preferences.isScheduleFieldExplicit(field) ? '已修改' : '默认';
  }

  function ruleSummary(rules) {
    const parts = [];
    parts.push(rules.grouping === 'institution' ? '同院校错峰' : '连续排期');
    if (rules.maxPerGroupPerRound != null) parts.push(`每组 ${rules.maxPerGroupPerRound} 位`);
    if (rules.intervalDays != null) parts.push(`间隔 ${rules.intervalDays} 天`);
    if (rules.skipHolidays) parts.push('避开休息日');
    return parts.join(' · ');
  }

  function applySchedulePresentation() {
    if (rendering) return;
    rendering = true;
    try {
      const effective = Preferences.effectiveSchedule();
      const grouping = ensureGroupingControl();
      const max = byId('nmda-rule-max-school');
      const interval = byId('nmda-rule-interval-days');
      const preserve = byId('nmda-rule-preserve-existing');
      const holiday = byId('nmda-rule-skip-holidays');
      const start = byId('nmda-rule-start-at');

      if (grouping && document.activeElement !== grouping) grouping.checked = effective.grouping === 'institution';
      if (max && document.activeElement !== max && !Preferences.isScheduleFieldExplicit('maxPerGroupPerRound')) max.value = String(effective.maxPerGroupPerRound ?? '');
      if (interval && document.activeElement !== interval && !Preferences.isScheduleFieldExplicit('intervalDays')) interval.value = String(effective.intervalDays ?? '');
      if (preserve && !Preferences.isScheduleFieldExplicit('preserveExisting')) preserve.checked = effective.preserveExisting !== false;
      if (holiday && !Preferences.isScheduleFieldExplicit('skipHolidays')) holiday.checked = effective.skipHolidays === true;
      if (start && document.activeElement !== start && !start.value) start.value = Preferences.suggestedStart();

      const grouped = effective.grouping === 'institution';
      if (max) max.disabled = !grouped;
      if (interval) interval.disabled = !grouped;

      const maxLabel = max?.closest('label')?.querySelector('.nmda-label');
      const intervalLabel = interval?.closest('label')?.querySelector('.nmda-label');
      if (maxLabel) maxLabel.textContent = `每组上限 · ${sourceMark('maxPerGroupPerRound')}`;
      if (intervalLabel) intervalLabel.textContent = `分组间隔 · ${sourceMark('intervalDays')}`;

      const summary = ruleSummary(ruleSnapshot());
      const preview = byId('nmda-schedule-rule-preview');
      const chip = byId('nmda-planning-rule-chip');
      if (preview && preview.textContent !== summary) preview.textContent = summary;
      if (chip && chip.textContent !== summary) chip.textContent = summary;
    } finally {
      rendering = false;
    }
  }

  document.addEventListener('input', event => {
    if (String(event.target?.id || '').startsWith('nmda-rule-')) queueMicrotask(applySchedulePresentation);
  }, true);
  document.addEventListener('change', event => {
    if (String(event.target?.id || '').startsWith('nmda-rule-')) queueMicrotask(applySchedulePresentation);
  }, true);
  document.addEventListener('click', event => {
    if (event.target?.closest?.('#nmda-open-schedule-modal,#nmda-apply-schedule,#nmda-cancel-schedule-modal,#nmda-close-schedule-modal')) {
      queueMicrotask(() => requestAnimationFrame(applySchedulePresentation));
    }
  }, true);

  const observer = new MutationObserver(records => {
    if (rendering) return;
    if (records.some(record => {
      const target = record.target?.nodeType === 1 ? record.target : record.target?.parentElement;
      return target?.closest?.('#nmda-schedule-modal,#nmda-schedule-rule-preview,#nmda-planning-rule-chip');
    })) queueMicrotask(applySchedulePresentation);
  });

  observer.observe(document.documentElement, { subtree:true, childList:true, attributes:true, characterData:true, attributeFilter:['hidden','class'] });
  queueMicrotask(() => requestAnimationFrame(applySchedulePresentation));
})();
