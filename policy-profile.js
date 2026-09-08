(() => {
  'use strict';

  const PROFILE_KEY = 'nmda.policy.profile.v1';
  const LEGACY_SCHEDULE_KEY = 'nmda.schedule.rules.v1';
  const SCHEDULE_FIELDS = new Set([
    'startAt', 'grouping', 'maxPerGroupPerRound', 'intervalDays',
    'preserveExisting', 'skipHolidays', 'intraRoundMinutes', 'allowDomainFallback'
  ]);
  const CONTROL_FIELDS = new Map([
    ['nmda-rule-start-at', 'startAt'],
    ['nmda-rule-max-school', 'maxPerGroupPerRound'],
    ['nmda-rule-interval-days', 'intervalDays'],
    ['nmda-rule-preserve-existing', 'preserveExisting'],
    ['nmda-rule-skip-holidays', 'skipHolidays'],
    ['nmda-rule-group-institution', 'grouping']
  ]);

  function emptyProfile() {
    return {
      version: 1,
      schedule: { explicitFields: [], grouping: 'none' },
      identity: { aliases: [] }
    };
  }

  function readJson(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); }
    catch (_) { return null; }
  }

  function normalizeAliasEntry(value) {
    if (!value || typeof value !== 'object') return null;
    const canonical = String(value.canonical || '').normalize('NFKC').trim();
    if (!canonical) return null;
    const aliases = [...new Set((Array.isArray(value.aliases) ? value.aliases : [])
      .map(item => String(item || '').normalize('NFKC').trim()).filter(Boolean))];
    return { canonical, aliases };
  }

  function normalizeProfile(value) {
    const base = emptyProfile();
    const schedule = value?.schedule && typeof value.schedule === 'object' ? value.schedule : {};
    const explicitFields = [...new Set((Array.isArray(schedule.explicitFields) ? schedule.explicitFields : [])
      .filter(field => SCHEDULE_FIELDS.has(field)))];
    const grouping = schedule.grouping === 'institution' ? 'institution' : 'none';
    const aliases = (Array.isArray(value?.identity?.aliases) ? value.identity.aliases : [])
      .map(normalizeAliasEntry).filter(Boolean);
    return {
      ...base,
      version: 1,
      schedule: { explicitFields, grouping },
      identity: { aliases }
    };
  }

  let profile = normalizeProfile(readJson(PROFILE_KEY));
  const touched = new Set(profile.schedule.explicitFields);

  function importLegacyExplicitFields() {
    if (profile.schedule.explicitFields.length) return;
    const legacy = readJson(LEGACY_SCHEDULE_KEY);
    if (!legacy || typeof legacy !== 'object') return;
    for (const field of ['startAt', 'maxPerGroupPerRound', 'intervalDays', 'preserveExisting', 'skipHolidays']) {
      if (Object.prototype.hasOwnProperty.call(legacy, field)) touched.add(field);
    }
    profile.schedule.explicitFields = [...touched];
    saveProfile();
  }

  function saveProfile() {
    profile.schedule.explicitFields = [...touched].filter(field => SCHEDULE_FIELDS.has(field));
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); } catch (_) {}
  }

  function markScheduleField(field, explicit = true) {
    if (!SCHEDULE_FIELDS.has(field)) return;
    if (explicit) touched.add(field); else touched.delete(field);
    saveProfile();
  }

  function isScheduleFieldExplicit(field) {
    return touched.has(field);
  }

  function setGrouping(value, { explicit = true } = {}) {
    profile.schedule.grouping = value === 'institution' ? 'institution' : 'none';
    if (explicit) touched.add('grouping');
    saveProfile();
  }

  function getGrouping() {
    return profile.schedule.grouping === 'institution' && touched.has('grouping') ? 'institution' : 'none';
  }

  function sanitizeScheduleInput(input = {}) {
    if (input?.policySource === 'explicit' || input?.__explicit === true) return { ...input };
    const out = {
      startAt: touched.has('startAt') ? String(input.startAt || '').trim() : '',
      grouping: getGrouping(),
      maxPerGroupPerRound: touched.has('maxPerGroupPerRound') ? input.maxPerGroupPerRound : null,
      intervalDays: touched.has('intervalDays') ? input.intervalDays : null,
      preserveExisting: touched.has('preserveExisting') ? input.preserveExisting !== false : true,
      skipHolidays: touched.has('skipHolidays') ? input.skipHolidays === true : false,
      intraRoundMinutes: touched.has('intraRoundMinutes') ? input.intraRoundMinutes : 0,
      allowDomainFallback: touched.has('allowDomainFallback') ? input.allowDomainFallback === true : false,
      policySource: 'profile'
    };
    return out;
  }

  function institutionKey(value) {
    return String(value || '').normalize('NFKC').trim().toLowerCase()
      .replace(/[&＆]/g, 'and')
      .replace(/[\u00a0\u200b\u200c\u200d\ufeff]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/[^a-z0-9\p{L}]+/gu, '')
      .trim();
  }

  function resolveInstitutionKey(value) {
    const rawKey = institutionKey(value);
    if (!rawKey) return '';
    for (const entry of profile.identity.aliases) {
      const canonicalKey = institutionKey(entry.canonical);
      const keys = new Set([canonicalKey, ...entry.aliases.map(institutionKey)]);
      if (keys.has(rawKey)) return canonicalKey;
    }
    return rawKey;
  }

  function setInstitutionAlias(canonical, aliases = []) {
    const entry = normalizeAliasEntry({ canonical, aliases });
    if (!entry) throw new Error('canonical institution is required');
    const canonicalKey = institutionKey(entry.canonical);
    profile.identity.aliases = profile.identity.aliases.filter(item => institutionKey(item.canonical) !== canonicalKey);
    profile.identity.aliases.push(entry);
    saveProfile();
    return entry;
  }

  function removeInstitutionAlias(canonical) {
    const key = institutionKey(canonical);
    profile.identity.aliases = profile.identity.aliases.filter(item => institutionKey(item.canonical) !== key);
    saveProfile();
  }

  function getProfile() {
    return JSON.parse(JSON.stringify(profile));
  }

  importLegacyExplicitFields();

  if (typeof document !== 'undefined') {
    const onFieldEvent = event => {
      const field = CONTROL_FIELDS.get(event.target?.id || '');
      if (!field) return;
      if (field === 'grouping') setGrouping(event.target.checked ? 'institution' : 'none');
      else markScheduleField(field, true);
    };
    document.addEventListener('input', onFieldEvent, true);
    document.addEventListener('change', onFieldEvent, true);
  }

  globalThis.NMDAPolicyProfile = {
    PROFILE_KEY,
    getProfile,
    saveProfile,
    markScheduleField,
    isScheduleFieldExplicit,
    setGrouping,
    getGrouping,
    sanitizeScheduleInput,
    institutionKey,
    resolveInstitutionKey,
    setInstitutionAlias,
    removeInstitutionAlias
  };
})();
