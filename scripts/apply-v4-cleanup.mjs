import fs from 'node:fs';

function replaceExact(text, from, to, label) {
  if (!text.includes(from)) throw new Error(`missing cleanup target: ${label}`);
  return text.replace(from, to);
}

function replaceRegex(text, pattern, to, label) {
  if (!pattern.test(text)) throw new Error(`missing cleanup target: ${label}`);
  pattern.lastIndex = 0;
  return text.replace(pattern, to);
}

let app = fs.readFileSync('app.js', 'utf8');

app = replaceExact(app,
  "  const FOLLOWUP_SETTINGS_KEY = 'nmda.followup.settings.v1';\n",
  '',
  'legacy follow-up settings key');
app = replaceExact(app,
  "  const Scheduler = globalThis.NMDAScheduler;\n",
  "  const Scheduler = globalThis.NMDAScheduler;\n  const Policy = globalThis.NMDAPolicyProfile;\n",
  'policy binding');

app = replaceRegex(app,
  /\n\s*<button class="nmda-tab" data-tab="followup"[\s\S]*?<\/button>\n/,
  '\n',
  'follow-up navigation');
app = replaceRegex(app,
  /\n\s*<div class="nmda-page-head" data-page-head="followup"[\s\S]*?(?=\n\s*<div class="nmda-page-head" data-page-head="contacts")/,
  '\n',
  'follow-up page');
app = replaceRegex(app,
  /\n\s*<div class="nmda-workflow-modal-overlay" id="nmda-followup-reply-modal"[\s\S]*?(?=\n\s*<div class="nmda-workflow-modal-overlay" id="nmda-contact-modal")/,
  '\n',
  'follow-up reply modal');
app = replaceExact(app,
  '                    <label class="nmda-check-card"><input id="nmda-contact-modal-followup" type="checkbox"><span><strong>待跟进</strong></span></label>\n',
  '',
  'contact follow-up checkbox');

app = replaceRegex(app,
  /\n  async function executeNativeFollowUpRemotely\([\s\S]*?(?=\n  async function updateMailboxBatchMonitor)/,
  '\n',
  'legacy app follow-up executor');
app = replaceRegex(app,
  /\n  function followUpPaneVisible\(\) \{[\s\S]*?\n  \}\n/,
  '\n',
  'follow-up pane helper');
app = replaceRegex(app,
  /\n  const followUpState = \{[\s\S]*?(?=\n\n  \$\('nmda-contact-class-chips'\))/,
  '\n',
  'legacy follow-up runtime');
app = app.replace(/\n\s*if \(name === 'followup'\) renderFollowUp\(\)\.catch\([^\n]*\);/g, '');

app = app.replace(/\n\s*\$\('nmda-contact-modal-followup'\)\.checked=!!contact\.followUp;/g, '');
app = app.replace(/\n\s*Contacts\.setFollowUp\(contactBook\.contacts,email,\$\('nmda-contact-modal-followup'\)\.checked\);/g, '');
app = app.replace(/\n\s*if\(c\.followUp\)items\.push\(\{kind:'followup',value:'待跟进'\}\);/g, '');
app = app.replace(/\n\s*\}else if\(el\.dataset\.contactFollowup\)\{[\s\S]*?affectsBatchView=true;/g, '');

app = replaceExact(app,
  '                    <label class="nmda-field"><span class="nmda-label">每所院校每轮最多</span><input id="nmda-rule-max-school" type="number" min="1" max="20" step="1" value="1"></label>\n                    <label class="nmda-field"><span class="nmda-label">同校间隔</span><div class="nmda-input-suffix"><input id="nmda-rule-interval-days" type="number" min="1" max="365" step="1" value="7"><span>天</span></div></label>\n                    <label class="nmda-check-card"><input id="nmda-rule-preserve-existing" type="checkbox" checked><span><strong>保留草稿 / 导入原排期</strong></span></label>\n                    <label class="nmda-check-card nmda-schedule-wide-check"><input id="nmda-rule-skip-holidays" type="checkbox" checked><span><strong>避开节假日和周末</strong></span></label>\n                  </div>\n                  <div class="nmda-schedule-rule-preview" id="nmda-schedule-rule-preview">同校每 7 天最多 1 位。</div>',
  '                    <label class="nmda-field"><span class="nmda-label">每组上限</span><input id="nmda-rule-max-school" type="number" min="1" max="20" step="1"></label>\n                    <label class="nmda-field"><span class="nmda-label">分组间隔</span><div class="nmda-input-suffix"><input id="nmda-rule-interval-days" type="number" min="1" max="365" step="1"><span>天</span></div></label>\n                    <label class="nmda-check-card"><input id="nmda-rule-preserve-existing" type="checkbox"><span><strong>保留已有排期</strong></span></label>\n                    <label class="nmda-check-card nmda-schedule-wide-check"><input id="nmda-rule-skip-holidays" type="checkbox"><span><strong>避开节假日和周末</strong></span></label>\n                  </div>\n                  <div class="nmda-schedule-rule-preview" id="nmda-schedule-rule-preview">按当前自动化策略安排。</div>',
  'schedule markup defaults');

app = replaceExact(app,
  "    scheduleRules: { ...(Scheduler?.DEFAULT_RULES || { maxPerGroupPerRound:1, intervalDays:7, preserveExisting:true, intraRoundMinutes:10 }), startAt: Scheduler?.defaultStart?.() || '' },",
  "    scheduleRules: null,",
  'batch schedule defaults');

app = replaceRegex(app,
  /\n  const SCHEDULE_PREFS_KEY = 'nmda\.schedule\.rules\.v1';[\s\S]*?\n  \}\)\(\);\n(?=\n  \/\/ One delegated handler)/,
  `\n  function freshScheduleRules() {\n    const effective = Policy?.effectiveSchedule?.() || {};\n    const startAt = Policy?.suggestedStart?.() || '';\n    return Scheduler?.normalizeRules?.({ ...effective, startAt, policySource:'explicit' }) || { ...effective, startAt };\n  }\n  function syncScheduleRuleControls() {\n    if(!batch.scheduleRules) batch.scheduleRules=freshScheduleRules();\n    if(scheduleStartEl && document.activeElement!==scheduleStartEl) scheduleStartEl.value=batch.scheduleRules.startAt||'';\n    if(scheduleMaxSchoolEl && document.activeElement!==scheduleMaxSchoolEl) scheduleMaxSchoolEl.value=batch.scheduleRules.maxPerGroupPerRound == null ? '' : String(batch.scheduleRules.maxPerGroupPerRound);\n    if(scheduleIntervalDaysEl && document.activeElement!==scheduleIntervalDaysEl) scheduleIntervalDaysEl.value=batch.scheduleRules.intervalDays == null ? '' : String(batch.scheduleRules.intervalDays);\n    if(schedulePreserveEl) schedulePreserveEl.checked=!!batch.scheduleRules.preserveExisting;\n    if(scheduleHolidayEl) scheduleHolidayEl.checked=!!batch.scheduleRules.skipHolidays;\n  }\n  function readScheduleRuleControls() {\n    const effective = Policy?.effectiveSchedule?.() || {};\n    const input = {\n      ...effective,\n      startAt:scheduleStartEl?.value||batch.scheduleRules?.startAt||Policy?.suggestedStart?.()||'',\n      grouping:Policy?.getGrouping?.()||effective.grouping||'none',\n      maxPerGroupPerRound:scheduleMaxSchoolEl?.value||effective.maxPerGroupPerRound,\n      intervalDays:scheduleIntervalDaysEl?.value||effective.intervalDays,\n      preserveExisting:!!schedulePreserveEl?.checked,\n      intraRoundMinutes:effective.intraRoundMinutes,\n      skipHolidays:!!scheduleHolidayEl?.checked,\n      policySource:'explicit'\n    };\n    const rules=Scheduler?.normalizeRules?.(input)||input;\n    batch.scheduleRules=rules;\n    return rules;\n  }\n  batch.scheduleRules = freshScheduleRules();\n`,
  'legacy schedule preference pipeline');

app = app.replace(/rules\.maxPerGroupPerRound\|\|1/g, 'rules.maxPerGroupPerRound');
app = app.replace(/rules\.intervalDays\|\|7/g, 'rules.intervalDays');
app = app.replace(/rules\.skipHolidays!==false/g, '!!rules.skipHolidays');

if (/data-tab="followup"|data-pane="followup"|FOLLOWUP_SETTINGS_KEY|function defaultFollowUpSettings|executeNativeFollowUpRemotely|nmda-contact-modal-followup/.test(app)) {
  throw new Error('legacy follow-up source remains in app.js');
}
if (/Scheduler\?\.DEFAULT_RULES \|\| \{\s*maxPerGroupPerRound:1|scheduleIntervalDaysEl\?\.value\|\|7|scheduleMaxSchoolEl\?\.value\|\|1/.test(app)) {
  throw new Error('schedule fallback source remains in app.js');
}
fs.writeFileSync('app.js', app);

let unifier = fs.readFileSync('workflow-unifier.js', 'utf8');
unifier = replaceExact(unifier,
  "  const Contacts = globalThis.NMDAContacts;\n",
  "  const Contacts = globalThis.NMDAContacts;\n  const DefaultPolicy = globalThis.NMDADefaultPolicy;\n",
  'unifier default policy binding');
unifier = replaceRegex(unifier,
  /  function defaultSettings\(\) \{[\s\S]*?\n  \}\n\n  function normalizeSettings/,
  `  function defaultSettings() {\n    const policy = DefaultPolicy?.followUp || {};\n    return { ...policy };\n  }\n\n  function normalizeSettings`,
  'follow-up defaults');
unifier = replaceRegex(unifier,
  /\n  function retireLegacyFollowUpNavigation\(\) \{[\s\S]*?\n  \}\n(?=\n  function relabelProduct)/,
  '\n',
  'legacy navigation retire hook');
unifier = unifier.replace("    retireLegacyFollowUpNavigation();\n", '');
if (/function defaultSettings\(\) \{\s*return \{|retireLegacyFollowUpNavigation/.test(unifier)) throw new Error('unifier still owns product defaults or legacy hiding');
fs.writeFileSync('workflow-unifier.js', unifier);

console.log('v4 cleanup applied');
