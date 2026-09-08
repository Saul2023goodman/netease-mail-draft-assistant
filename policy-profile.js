(() => {
  'use strict';

  const PROFILE_KEY = 'nmda.policy.profile.v1';
  const LEGACY_SCHEDULE_KEY = 'nmda.schedule.rules.v1';
  const DEFAULT_POLICY = globalThis.NMDADefaultPolicy;
  if (!DEFAULT_POLICY) throw new Error('NMDADefaultPolicy must be loaded before policy-profile.js');

  const SCHEDULE_FIELDS = new Set([
    'grouping','maxPerGroupPerRound','intervalDays','preserveExisting',
    'skipHolidays','intraRoundMinutes','allowDomainFallback'
  ]);
  const CONTROL_FIELDS = new Map([
    ['nmda-rule-max-school','maxPerGroupPerRound'],
    ['nmda-rule-interval-days','intervalDays'],
    ['nmda-rule-preserve-existing','preserveExisting'],
    ['nmda-rule-skip-holidays','skipHolidays'],
    ['nmda-rule-group-institution','grouping']
  ]);

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function readJson(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); }
    catch (_) { return null; }
  }
  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
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
    const schedule = value?.schedule && typeof value.schedule === 'object' ? value.schedule : {};
    const overrides = schedule.overrides && typeof schedule.overrides === 'object' ? schedule.overrides : {};
    const explicitFields = [...new Set((Array.isArray(schedule.explicitFields) ? schedule.explicitFields : [])
      .filter(field => SCHEDULE_FIELDS.has(field)))];
    const aliases = (Array.isArray(value?.identity?.aliases) ? value.identity.aliases : [])
      .map(normalizeAliasEntry).filter(Boolean);
    return {
      version:1,
      schedule:{explicitFields,overrides:{...overrides}},
      identity:{aliases}
    };
  }

  let profile = normalizeProfile(readJson(PROFILE_KEY));
  const explicit = new Set(profile.schedule.explicitFields);

  function normalizeComparable(field, value) {
    if (field === 'grouping') return value === 'institution' ? 'institution' : 'none';
    if (field === 'preserveExisting' || field === 'skipHolidays' || field === 'allowDomainFallback') return value === true;
    if (field === 'maxPerGroupPerRound' || field === 'intervalDays' || field === 'intraRoundMinutes') {
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    }
    return value;
  }

  function migrateLegacyOverrides() {
    if (profile.schedule.explicitFields.length || Object.keys(profile.schedule.overrides).length) return;
    const legacy = readJson(LEGACY_SCHEDULE_KEY);
    if (!legacy || typeof legacy !== 'object') return;
    for (const field of SCHEDULE_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(legacy, field)) continue;
      const legacyValue = normalizeComparable(field, legacy[field]);
      const defaultValue = normalizeComparable(field, DEFAULT_POLICY.schedule?.[field]);
      if (legacyValue === defaultValue) continue;
      explicit.add(field);
      profile.schedule.overrides[field] = legacyValue;
    }
    saveProfile();
  }

  function saveProfile() {
    profile.schedule.explicitFields = [...explicit];
    writeJson(PROFILE_KEY, profile);
  }

  function setScheduleOverride(field, value) {
    if (!SCHEDULE_FIELDS.has(field)) return;
    explicit.add(field);
    profile.schedule.overrides[field] = normalizeComparable(field, value);
    saveProfile();
  }

  function clearScheduleOverride(field) {
    if (!SCHEDULE_FIELDS.has(field)) return;
    explicit.delete(field);
    delete profile.schedule.overrides[field];
    saveProfile();
  }

  function isScheduleFieldExplicit(field) { return explicit.has(field); }

  function effectiveSchedule() {
    return {
      ...clone(DEFAULT_POLICY.schedule || {}),
      ...clone(profile.schedule.overrides || {})
    };
  }

  function setGrouping(value, { explicit:mark = true } = {}) {
    if (mark) setScheduleOverride('grouping', value === 'institution' ? 'institution' : 'none');
    else profile.schedule.overrides.grouping = value === 'institution' ? 'institution' : 'none';
  }

  function getGrouping() { return effectiveSchedule().grouping === 'institution' ? 'institution' : 'none'; }

  function pad(number) { return String(number).padStart(2, '0'); }
  function formatLocalDateTime(date) {
    return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  function suggestedStart(now = new Date()) {
    const rules = effectiveSchedule();
    if (rules.startStrategy !== 'next-hour') return '';
    const leadMinutes = Math.max(0, Number(rules.leadMinutes) || 0);
    const date = new Date(now.getTime() + leadMinutes * 60000);
    date.setMinutes(0, 0, 0);
    if (date.getTime() <= now.getTime()) date.setHours(date.getHours() + 1);
    return formatLocalDateTime(date);
  }

  function sanitizeScheduleInput(input = {}) {
    if (input?.policySource === 'explicit' || input?.__explicit === true) return { ...input };
    const resolved = effectiveSchedule();
    for (const field of SCHEDULE_FIELDS) {
      if (explicit.has(field) && Object.prototype.hasOwnProperty.call(input, field)) {
        resolved[field] = normalizeComparable(field, input[field]);
      }
    }
    resolved.startAt = String(input.startAt || suggestedStart()).trim();
    resolved.policySource = 'profile';
    return resolved;
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

  function getProfile() { return clone(profile); }
  function getDefaultPolicy() { return clone(DEFAULT_POLICY); }
  function getEffectivePolicy() {
    return {
      version:1,
      schedule:effectiveSchedule(),
      identity:{aliases:clone(profile.identity.aliases)}
    };
  }

  migrateLegacyOverrides();

  if (typeof document !== 'undefined') {
    const onFieldEvent = event => {
      const field = CONTROL_FIELDS.get(event.target?.id || '');
      if (!field) return;
      let value;
      if (field === 'grouping') value = !!event.target.checked ? 'institution' : 'none';
      else if (field === 'preserveExisting' || field === 'skipHolidays') value = !!event.target.checked;
      else value = event.target.value;
      setScheduleOverride(field, value);
    };
    document.addEventListener('input', onFieldEvent, true);
    document.addEventListener('change', onFieldEvent, true);
  }

  globalThis.NMDAPolicyProfile = {
    PROFILE_KEY,
    getProfile,
    getDefaultPolicy,
    getEffectivePolicy,
    effectiveSchedule,
    suggestedStart,
    saveProfile,
    setScheduleOverride,
    clearScheduleOverride,
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
