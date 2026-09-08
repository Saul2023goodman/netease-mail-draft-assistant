'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function runtime(seed = {}) {
  const values = new Map(Object.entries(seed));
  const context = {
    console,
    localStorage: {
      getItem(key) { return values.has(key) ? values.get(key) : null; },
      setItem(key, value) { values.set(key, String(value)); },
      removeItem(key) { values.delete(key); }
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  for (const file of ['runtime-defaults.js', 'preferences-store.js', 'scheduler.js', 'roster-v2.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename:file });
  }
  return context;
}

test('runtime defaults support the scheduler without becoming scheduler core', () => {
  const { NMDAScheduler: Scheduler, NMDAPreferences: Preferences, NMDARuntimeDefaults: Defaults } = runtime();
  assert.equal(Scheduler.DEFAULT_RULES.startAt, '');
  assert.equal(Scheduler.DEFAULT_RULES.grouping, 'none');
  assert.equal(Scheduler.DEFAULT_RULES.maxPerGroupPerRound, null);
  assert.equal(Scheduler.DEFAULT_RULES.intervalDays, null);
  assert.equal(Scheduler.DEFAULT_RULES.skipHolidays, false);

  assert.equal(Defaults.historySource.mode, 'forward');
  const effective = Preferences.getEffectivePreferences().schedule;
  assert.equal(effective.grouping, 'institution');
  assert.equal(effective.maxPerGroupPerRound, 1);
  assert.equal(effective.intervalDays, 7);
  assert.equal(effective.skipHolidays, true);

  const resolved = Scheduler.normalizeRules({});
  assert.equal(resolved.grouping, 'institution');
  assert.equal(resolved.maxPerGroupPerRound, 1);
  assert.equal(resolved.intervalDays, 7);
  assert.equal(resolved.skipHolidays, true);
  assert.ok(resolved.startAt);
});

test('4.0 compatibility aliases resolve to the new runtime APIs', () => {
  const runtimeContext = runtime();
  assert.equal(runtimeContext.NMDADefaultPolicy.schedule, runtimeContext.NMDARuntimeDefaults.schedule);
  assert.equal(runtimeContext.NMDAPolicyProfile, runtimeContext.NMDAPreferences);
  assert.equal(runtimeContext.NMDADefaultPolicy.followUp, runtimeContext.NMDARuntimeDefaults.historySource);
});

test('legacy values equal to defaults are not promoted to user overrides', () => {
  const legacy = JSON.stringify({maxPerGroupPerRound:1,intervalDays:7,preserveExisting:true,intraRoundMinutes:10,skipHolidays:true});
  const { NMDAPreferences: Preferences } = runtime({'nmda.schedule.rules.v1': legacy});
  assert.equal(Array.from(Preferences.getPreferences().schedule.explicitFields).length, 0);
});

test('legacy values that differ from defaults become user overrides', () => {
  const legacy = JSON.stringify({maxPerGroupPerRound:2,intervalDays:14,preserveExisting:true,intraRoundMinutes:10,skipHolidays:false});
  const { NMDAPreferences: Preferences } = runtime({'nmda.schedule.rules.v1': legacy});
  const effective = Preferences.getEffectivePreferences().schedule;
  assert.equal(effective.maxPerGroupPerRound, 2);
  assert.equal(effective.intervalDays, 14);
  assert.equal(effective.skipHolidays, false);
});

test('explicit scheduling input is honored without hidden rules', () => {
  const { NMDAScheduler: Scheduler } = runtime();
  const rules = Scheduler.normalizeRules({
    policySource:'explicit',
    startAt:'2032-03-04T09:00',
    grouping:'none',
    maxPerGroupPerRound:null,
    intervalDays:null,
    preserveExisting:false,
    intraRoundMinutes:0,
    skipHolidays:false,
    allowDomainFallback:false
  });
  assert.equal(rules.startAt, '2032-03-04T09:00');
  assert.equal(rules.grouping, 'none');
  assert.equal(rules.maxPerGroupPerRound, null);
  assert.equal(rules.intervalDays, null);
  assert.equal(rules.skipHolidays, false);
});

test('invalid local dates are rejected instead of rolling forward', () => {
  const { NMDAScheduler: Scheduler } = runtime();
  assert.equal(Scheduler.parseLocalDateTime('2032-02-31T09:00'), null);
  assert.ok(Scheduler.parseLocalDateTime('2032-02-29T09:00'));
});

test('runtime defaults ship no institution-specific aliases', () => {
  const { NMDAPreferences: Preferences } = runtime();
  assert.equal(Array.from(Preferences.getDefaults().identity.aliases).length, 0);
});

test('institution similarity does not create identity by itself', () => {
  const { NMDARoster: Roster } = runtime();
  assert.equal(Roster.sameSchool('Example University', 'Example University London'), false);
  assert.equal(Roster.sameSchool('Example University', 'Example University'), true);
});

test('learned alias may unify labels without changing core code', () => {
  const { NMDAPreferences: Preferences, NMDARoster: Roster } = runtime();
  Preferences.setInstitutionAlias('Example University', ['Example University London']);
  assert.equal(Roster.sameSchool('Example University', 'Example University London'), true);
});

test('message importance is not outreach ranking', () => {
  const { NMDAScheduler: Scheduler } = runtime();
  assert.equal(Scheduler.priorityForTask({ priority:1 }).has, false);
  assert.equal(Scheduler.priorityForTask({ rosterMeta:{ priorityOrder:3 } }).rank, 3);
});
