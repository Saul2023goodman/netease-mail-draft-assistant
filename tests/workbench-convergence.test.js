const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const app = fs.readFileSync('app.js', 'utf8');
const contacts = fs.readFileSync('contacts.js', 'utf8');
const historyImport = fs.readFileSync('workflow-unifier.js', 'utf8');
const html = fs.readFileSync('app.html', 'utf8');

test('one task workbench owns the front-end', () => {
  for (const token of [
    'data-tab="single"', 'data-pane="single"',
    'data-tab="contacts"', 'data-pane="contacts"',
    'data-tab="followup"', 'data-pane="followup"'
  ]) assert.equal(app.includes(token), false, token);
  assert.match(app, /<h2>外联任务<\/h2>/);
});

test('all source types enter through the unified source system', () => {
  assert.equal(app.includes('<input id="nmda-roster-file"'), false);
  assert.equal(app.includes('for="nmda-roster-file"'), false);
  assert.equal(app.includes('id="nmda-batch-prep-strip"'), false);
  assert.equal(app.includes('id="nmda-import-handoff-card"'), false);
  assert.equal(app.includes('id="nmda-preflight-roster-box"'), false);
  assert.match(app, /id="nmda-open-supplement-preflight"[^>]*>Sources<\/button>/);
  assert.match(app, /if\(config\.purpose==='roster'\)rosterSets\.push\(collection\)/);
});

test('source review is exception driven and confidence is not UI copy', () => {
  assert.match(app, /function sourceReviewCount\(\)/);
  assert.match(app, /return !!batch\.dataset && sourceReviewCount\(\) > 0/);
  assert.equal(app.includes('function roleConfidenceText'), false);
  assert.equal(app.includes('判断明确'), false);
  assert.equal(app.includes('基本确定'), false);
});

test('history follow-up is pending work, not a standalone import module', () => {
  assert.match(historyImport, /id = 'nmda-history-pending'/);
  assert.match(historyImport, /const filter = 'eligible'/);
  assert.match(historyImport, /NMDA_READ_MAILBOX_STATE/);
  assert.equal(historyImport.includes('nmda-import-history'), false);
  assert.equal(historyImport.includes('nmda-source-action-history'), false);
});

test('contact interaction state is mailbox-derived', () => {
  const sandbox = { globalThis: {} };
  vm.runInNewContext(contacts, sandbox, { filename:'contacts.js' });
  const api = sandbox.globalThis.NMDAContacts;
  assert.equal(api.interactionState({}), '未联系');
  assert.equal(api.interactionState({ sentCount:1 }), '已发送');
  assert.equal(api.interactionState({ sentCount:1, humanReplyCount:1 }), '已回复');
  assert.match(contacts, /contact\.stage = interactionState\(contact\)/);
});

test('contact evidence is contextual and only exposes policy control', () => {
  assert.match(html, /contact-evidence\.js/);
  const evidence = fs.readFileSync('contact-evidence.js', 'utf8');
  assert.match(evidence, /\.nmda-recipient-cell/);
  assert.match(evidence, /Contacts\.setPolicy/);
  assert.equal(evidence.includes('Contacts.setStage'), false);
  assert.equal(evidence.includes('Contacts.setFollowUp'), false);
});
