'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function htmlResources(html, tag, attr) {
  const regex = new RegExp(`<${tag}\\b[^>]*\\b${attr}=["']([^"']+)["'][^>]*>`, 'gi');
  return [...html.matchAll(regex)].map(match => match[1]).filter(value => !/^(?:https?:|data:)/i.test(value));
}

test('every local app.html resource exists', () => {
  const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
  const resources = [
    ...htmlResources(html, 'script', 'src'),
    ...htmlResources(html, 'link', 'href')
  ];
  assert.ok(resources.includes('app.js'));
  assert.ok(resources.includes('workbench.css'));
  for (const resource of resources) {
    assert.ok(fs.existsSync(path.join(ROOT, resource)), `missing app resource: ${resource}`);
  }
});

test('every top-level runtime javascript file parses', () => {
  const files = fs.readdirSync(ROOT).filter(name => name.endsWith('.js'));
  for (const file of files) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.doesNotThrow(() => new vm.Script(source, { filename:file }), `syntax error in ${file}`);
  }
});

test('standalone bootstrap compatibility globals are created before app.js', () => {
  const context = { console, localStorage:{ getItem(){ return null; }, setItem(){}, removeItem(){} } };
  context.globalThis = context;
  vm.createContext(context);
  for (const file of ['runtime-defaults.js', 'preferences-store.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename:file });
  }
  assert.ok(context.NMDARuntimeDefaults);
  assert.ok(context.NMDADefaultPolicy);
  assert.ok(context.NMDAPreferences);
  assert.ok(context.NMDAPolicyProfile);
});

test('app bootstrap constructs the panel directly and never constructs a launcher', () => {
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert.match(app, /function buildShell\(\)/);
  assert.match(app, /root\.id = 'nmda-root'/);
  assert.match(app, /id="nmda-panel"/);
  assert.match(app, /document\.body\.appendChild\(root\)/);
  assert.equal(app.includes('nmda-launcher'), false);
  assert.equal(app.includes('launcher.hidden'), false);
  assert.equal(app.includes('panel.hidden = false'), false);
});

test('all literal workbench element lookups have a corresponding shell id', () => {
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const lookups = new Set([...app.matchAll(/\$\('([^']+)'\)/g)].map(match => match[1]));
  const ids = new Set([...app.matchAll(/id="([^"]+)"/g)].map(match => match[1]));
  const missing = [...lookups].filter(id => !ids.has(id));
  assert.deepEqual(missing, []);
});

test('main flow has no automatic stage machine or perpetual polling', () => {
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  for (const token of ['uiStep','autoAdvancing','enterSelectionAndSchedule','data-view-step','setInterval(']) {
    assert.equal(app.includes(token), false, token);
  }
});
