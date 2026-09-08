'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function runtime() {
  const values = new Map();
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
  for (const file of ['policy-profile.js', 'scheduler.js', 'roster-v2.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename:file });
  }
  return context;
}

test('unconfigured scheduling stays unconfigured', () => {
  const { NMDAScheduler: Scheduler } = runtime();
  assert.equal(Scheduler.defaultStart(), '');
  assert.equal(Scheduler.DEFAULT_RULES.startAt, '');
  assert.equal(Scheduler.DEFAULT_RULES.grouping, 'none');
  assert.equal(Scheduler.DEFAULT_RULES.maxPerGroupPerRound, null);
  assert.equal(Scheduler.DEFAULT_RULES.intervalDays, null);
  assert.equal(Scheduler.DEFAULT_RULES.skipHolidays, false);

  const inheritedUiValues = Scheduler.normalizeRules({
    startAt:'2032-03-04T09:00',
    maxPerGroupPerRound:1,
    intervalDays:7,
    skipHolidays:true
  });
  assert.equal(inheritedUiValues.startAt, '');
  assert.equal(inheritedUiValues.maxPerGroupPerRound, null);
  assert.equal(inheritedUiValues.intervalDays, null);
  assert.equal(inheritedUiValues.skipHolidays, false);
});

test('explicit scheduling policy is honored without adding extra rules', () => {
  const { NMDAScheduler: Scheduler } = runtime();
  const rules = Scheduler.normalizeRules({
    policySource:'explicit',
    startAt:'2032-03-04T09:00',
    grouping:'institution',
    maxPerGroupPerRound:2,
    intervalDays:5,
    skipHolidays:true
  });
  assert.equal(rules.startAt, '2032-03-04T09:00');
  assert.equal(rules.grouping, 'institution');
  assert.equal(rules.maxPerGroupPerRound, 2);
  assert.equal(rules.intervalDays, 5);
  assert.equal(rules.skipHolidays, true);
  assert.equal(rules.intraRoundMinutes, 0);
  assert.equal(rules.allowDomainFallback, false);
});

test('invalid local dates are rejected instead of rolling forward', () => {
  const { NMDAScheduler: Scheduler } = runtime();
  assert.equal(Scheduler.parseLocalDateTime('2032-02-31T09:00'), null);
  assert.ok(Scheduler.parseLocalDateTime('2032-02-29T09:00'));
});

test('institution similarity does not create identity', () => {
  const { NMDARoster: Roster } = runtime();
  assert.equal(Roster.sameSchool('Example University', 'Example University London'), false);
  assert.equal(Roster.sameSchool('Example University', 'Example University'), true);
});

test('only an explicit alias may unify different institution labels', () => {
  const { NMDAPolicyProfile: Policy, NMDARoster: Roster } = runtime();
  assert.equal(Roster.sameSchool('Example University', 'Example University London'), false);
  Policy.setInstitutionAlias('Example University', ['Example University London']);
  assert.equal(Roster.sameSchool('Example University', 'Example University London'), true);
});

test('message importance is not outreach ranking', () => {
  const { NMDAScheduler: Scheduler } = runtime();
  assert.equal(Scheduler.priorityForTask({ priority:1 }).has, false);
  assert.equal(Scheduler.priorityForTask({ rosterMeta:{ priorityOrder:3 } }).rank, 3);
});
