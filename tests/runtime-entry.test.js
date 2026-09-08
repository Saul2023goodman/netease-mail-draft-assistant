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
