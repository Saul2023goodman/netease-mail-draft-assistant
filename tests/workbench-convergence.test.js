'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const app = fs.readFileSync('app.js', 'utf8');
const html = fs.readFileSync('app.html', 'utf8');
const css = fs.readFileSync('workbench.css', 'utf8');
const historySource = fs.readFileSync('history-source.js', 'utf8');
const evidence = fs.readFileSync('contact-evidence.js', 'utf8');
const architecture = fs.readFileSync('ARCHITECTURE.md', 'utf8');

test('standalone workbench is the only front-end surface', () => {
  assert.match(app, /id="nmda-panel"/);
  assert.match(app, /1 · 来源/);
  assert.match(app, /2 · 核验/);
  assert.match(app, /3 · 排期/);
  assert.match(app, /4 · 执行/);
  for (const token of ['nmda-launcher','setPanelOpen','data-view-step','uiStep','autoAdvancing','enterSelectionAndSchedule','supplementPreflight']) {
    assert.equal(app.includes(token), false, token);
  }
  assert.equal(css.includes('nmda-launcher'), false);
});

test('standalone HTML loads one UI stylesheet and no legacy stage layers', () => {
  assert.match(html, /workbench\.css/);
  for (const legacy of ['app.css','app-shell.css','ui-system.css','workflow-dialogs.css','schedule-preferences.js']) {
    assert.equal(html.includes(legacy), false, legacy);
  }
});

test('source intake is unified and classification correction stays inline', () => {
  assert.match(app, /Importer\.parseFiles/);
  assert.match(app, /Importer\.parseDirectory/);
  assert.match(app, /Importer\?\.classifyRecordSet/);
  assert.match(app, /data-source-role=/);
  assert.match(app, /Roster\.parseDataset/);
  assert.match(app, /id="nmda-import-file"/);
  assert.match(app, /id="nmda-import-card"/);
});

test('selection changes do not reparse the entire batch', () => {
  assert.match(app, /function syncSelectionState/);
  assert.match(app, /data-task-select/);
  assert.match(app, /syncSelectionState\(\);/);
  assert.doesNotMatch(app, /data-task-select[\s\S]{0,500}rebuildTasks\(\)/);
});

test('scheduling is explicit and only runs from the schedule action', () => {
  assert.match(app, /function applySchedule\(\)/);
  assert.match(app, /Scheduler\.buildPlan/);
  assert.match(app, /nmda-apply-schedule/);
  assert.match(app, /policySource:'explicit'/);
  assert.equal(app.includes("setTimeout(()=>void enterSelectionAndSchedule"), false);
});

test('draft execution is sequential, retryable and does not poll forever', () => {
  assert.match(app, /NMDA_EXECUTE_DRAFT/);
  assert.match(app, /NMDA_CONNECTION_STATUS/);
  assert.match(app, /for\(const task of tasks\)/);
  assert.match(app, /runState: new Map\(\)/);
  assert.match(app, /status:'done'/);
  assert.equal(app.includes('setInterval('), false);
});

test('historical mail remains a secondary source using the same import input', () => {
  assert.match(historySource, /id = 'nmda-history-source'/);
  assert.match(historySource, /从历史邮件创建任务/);
  assert.match(historySource, /#nmda-import-file/);
  assert.match(historySource, /class="nmda-history-advanced"/);
  assert.equal(historySource.includes('data-tab="followup"'), false);
});

test('contact evidence is contextual rather than a CRM workspace', () => {
  assert.match(evidence, /\.nmda-recipient-cell/);
  assert.match(evidence, /Contacts\.setPolicy/);
  assert.equal(evidence.includes('Contacts.setStage'), false);
  assert.equal(evidence.includes('Contacts.setFollowUp'), false);
});

test('architecture forbids launcher and automatic stage navigation', () => {
  assert.match(architecture, /standalone workbench/i);
  assert.match(architecture, /no floating launcher/i);
  assert.match(architecture, /explicit user action/i);
});
