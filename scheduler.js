(() => {
  'use strict';

  const DEFAULT_RULES = Object.freeze({
    startAt: '',
    grouping: 'none',
    maxPerGroupPerRound: null,
    intervalDays: null,
    preserveExisting: true,
    intraRoundMinutes: 0,
    skipHolidays: false,
    allowDomainFallback: false
  });

  const HOLIDAY_CACHE = new Map();
  const COUNTRY_ALIASES = new Map([
    ['us','US'],['usa','US'],['unitedstates','US'],['unitedstatesofamerica','US'],['美国','US'],['美國','US'],
    ['canada','CA'],['ca','CA'],['加拿大','CA'],
    ['australia','AU'],['au','AU'],['澳大利亚','AU'],['澳大利亞','AU'],['澳洲','AU'],
    ['unitedkingdom','UK'],['uk','UK'],['greatbritain','UK'],['britain','UK'],['英国','UK'],['英國','UK'],
    ['england','UK'],['wales','UK'],
    ['newzealand','NZ'],['nz','NZ'],['新西兰','NZ'],['新西蘭','NZ']
  ]);

  function pad(n) { return String(n).padStart(2, '0'); }

  function formatLocalDateTime(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
    return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function parseLocalDateTime(value) {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
    const raw = String(value || '').trim();
    if (!raw) return null;
    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
    if (!match) return null;
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    const hour = Number(match[4]), minute = Number(match[5]);
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
    const date = new Date(year, month - 1, day, hour, minute, 0, 0);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day || date.getHours() !== hour || date.getMinutes() !== minute) return null;
    return date;
  }

  function defaultStart() { return ''; }

  function recipientDomain(recipients) {
    const match = String(recipients || '').match(/@([A-Z0-9.-]+\.[A-Z]{2,})(?![A-Z0-9.-])/i);
    if (!match) return '';
    const raw = match[1].toLowerCase().replace(/^mail\./, '');
    const labels = raw.split('.').filter(Boolean);
    if (labels.length < 2) return raw;
    const academicSuffixes = new Set(['edu.au','edu.hk','ac.uk','ac.nz','ac.jp','ac.kr','ac.in','edu.sg','edu.cn','edu.my','edu.tw','edu.ph','ac.za']);
    const last2 = labels.slice(-2).join('.');
    if (academicSuffixes.has(last2) && labels.length >= 3) return labels.slice(-3).join('.');
    return labels.slice(-2).join('.');
  }

  function cleanInstitution(value) {
    return String(value || '').normalize('NFKC')
      .replace(/[\u00a0\u200b\u200c\u200d\ufeff]/g, ' ')
      .replace(/^[\s\-—–:：]+|[\s\-—–:：]+$/g, '')
      .replace(/\s+/g, ' ').trim();
  }

  function rawInstitutionKey(value) {
    return cleanInstitution(value).toLowerCase()
      .replace(/[&＆]/g, 'and')
      .replace(/[^a-z0-9\p{L}]+/gu, '')
      .trim();
  }

  function normalizeInstitutionKey(value) {
    const policy = globalThis.NMDAPolicyProfile;
    return policy?.resolveInstitutionKey?.(value) || rawInstitutionKey(value);
  }

  function institutionEvidence(value, recipients = '', source = '', options = {}) {
    const school = cleanInstitution(value);
    if (!school) return { valid:false, value:'', reason:'empty', candidate:false };
    if (/^(?:[a-z]|\d{1,3}|[a-z]\d{0,2}|(?:group|batch|round|wave|tier|class|category|tag)\s*[a-z0-9-]*|(?:第[\u4e00-\u5341\d]+批|分组|批次|类别|标签)\s*[a-z0-9-]*)$/i.test(school)) {
      return { valid:false, value:'', reason:'short-code', candidate:false };
    }
    const sourceKey = String(source || '').toLowerCase();
    const sourceExplicit = ['manual','roster','roster-confirmed','source-explicit','imported'].includes(sourceKey);
    const institutionShape = /(?:university|college|school|institute|academy|polytechnic|conservatoire|大学|学院|学校|研究院|科学院|理工|师范|商学院|学部)/i.test(school);
    if (sourceExplicit || institutionShape) return { valid:true, value:school, reason:sourceExplicit?'explicit-source':'institution-shape', candidate:false };

    const domain = recipientDomain(recipients);
    const key = rawInstitutionKey(school);
    const domainTokens = domain.split('.').filter(token => token.length >= 2 && !['edu','ac','com','org','net','mail'].includes(token));
    const domainMatch = domainTokens.some(token => key === token || key.includes(token) || token.includes(key));
    if (domainMatch && options.allowDomainFallback === true) return { valid:true, value:school, reason:'domain-confirmed-by-policy', candidate:false };
    return { valid:false, value:'', reason:domainMatch?'domain-candidate':'unverified', candidate:domainMatch, candidateValue:domainMatch?school:'' };
  }

  function taskIdentity(task) {
    return String(task?.editKey || task?.id || task?.mailId || task?.recipients || Math.random());
  }

  function groupForTask(task, rulesInput = {}) {
    const rules = normalizeRules(rulesInput);
    const domain = recipientDomain(task?.recipients || '');
    if (rules.grouping !== 'institution') {
      return { key:`task:${taskIdentity(task)}`, label:'独立邮件', source:'task', domain };
    }

    const explicitId = String(task?.confirmedInstitutionId || task?.institutionId || task?.rosterMeta?.institutionId || task?.rosterReference?.institutionId || '').trim();
    if (explicitId) return { key:`institution:${explicitId}`, label:cleanInstitution(task?.school || task?.rosterReference?.school || explicitId), source:'institution-id', domain };

    const evidence = institutionEvidence(task?.school || '', task?.recipients || '', task?.schoolSource || '', { allowDomainFallback:rules.allowDomainFallback });
    if (evidence.valid) {
      const key = normalizeInstitutionKey(evidence.value);
      if (key) return { key:`institution:${key}`, label:evidence.value, source:task?.schoolSource || evidence.reason, domain };
    }

    const generic = new Set(['gmail.com','googlemail.com','outlook.com','hotmail.com','live.com','yahoo.com','qq.com','163.com','126.com','icloud.com','proton.me','protonmail.com']);
    if (rules.allowDomainFallback && domain && !generic.has(domain)) return { key:`domain:${domain}`, label:domain, source:'domain-policy', domain };
    return { key:`task:${taskIdentity(task)}`, label:cleanInstitution(task?.school || '') || '未确认机构', source:'unconfirmed', domain };
  }

  function positiveIntegerOrNull(value, max) {
    if (value == null || String(value).trim() === '') return null;
    const number = Number(value);
    if (!Number.isFinite(number) || !Number.isInteger(number) || number < 1 || number > max) return null;
    return number;
  }

  function normalizeRules(input = {}) {
    const policy = globalThis.NMDAPolicyProfile;
    const raw = policy?.sanitizeScheduleInput ? policy.sanitizeScheduleInput(input) : { ...input };
    return {
      startAt: String(raw.startAt || '').trim(),
      grouping: raw.grouping === 'institution' ? 'institution' : 'none',
      maxPerGroupPerRound: positiveIntegerOrNull(raw.maxPerGroupPerRound, 1000),
      intervalDays: positiveIntegerOrNull(raw.intervalDays, 3650),
      preserveExisting: raw.preserveExisting !== false,
      intraRoundMinutes: raw.intraRoundMinutes == null || String(raw.intraRoundMinutes).trim() === '' ? 0 : Math.max(0, Math.min(1440, Number(raw.intraRoundMinutes) || 0)),
      skipHolidays: raw.skipHolidays === true,
      allowDomainFallback: raw.allowDomainFallback === true,
      policySource: String(raw.policySource || '')
    };
  }

  function compactKey(value) {
    return String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/[^a-z0-9\p{L}]+/gu, '');
  }

  function normalizeCountry(value) {
    const raw = compactKey(value);
    if (!raw) return '';
    if (COUNTRY_ALIASES.has(raw)) return COUNTRY_ALIASES.get(raw);
    for (const [alias, code] of COUNTRY_ALIASES) if (alias.length >= 4 && (raw.includes(alias) || alias.includes(raw))) return code;
    return '';
  }

  function countryForTask(task) {
    const raw = task?.rosterMeta?.country || task?.rosterReference?.country || task?.country || '';
    return { raw:String(raw || '').trim(), code:normalizeCountry(raw) };
  }

  function parsePriority(value) {
    if (value == null || value === '') return { has:false, rank:Number.POSITIVE_INFINITY, raw:'' };
    if (typeof value === 'number' && Number.isFinite(value)) return { has:true, rank:value, raw:String(value) };
    const raw = String(value).normalize('NFKC').trim();
    if (!raw) return { has:false, rank:Number.POSITIVE_INFINITY, raw:'' };
    let match = raw.match(/(?:^|[^\d])(?:第\s*)?(\d+(?:\.\d+)?)(?:\s*(?:位|名|顺序|順位|priority|rank))?/i);
    if (match) return { has:true, rank:Number(match[1]), raw };
    match = raw.match(/^p\s*(\d+(?:\.\d+)?)$/i);
    if (match) return { has:true, rank:Number(match[1]), raw };
    if (/^(?:最高|最优|最優|highest|top)$/i.test(raw)) return { has:true, rank:-100, raw };
    if (/^(?:高|优先|優先|high)$/i.test(raw)) return { has:true, rank:100, raw };
    if (/^(?:中|普通|normal|medium)$/i.test(raw)) return { has:true, rank:200, raw };
    if (/^(?:低|low)$/i.test(raw)) return { has:true, rank:300, raw };
    match = raw.match(/^(?:tier\s*)?([a-z])$/i);
    if (match) return { has:true, rank:1000 + (match[1].toUpperCase().charCodeAt(0) - 65), raw };
    return { has:false, rank:Number.POSITIVE_INFINITY, raw };
  }

  function priorityForTask(task) {
    const explicit = task?.rosterMeta?.priorityOrder ?? task?.rosterReference?.priorityOrder;
    if (Number.isFinite(Number(explicit)) && String(explicit ?? '').trim() !== '') {
      return { has:true, rank:Number(explicit), raw:String(task?.rosterMeta?.priority || task?.rosterReference?.priority || explicit) };
    }
    return parsePriority(task?.rosterMeta?.priority ?? task?.rosterReference?.priority ?? '');
  }

  function dateKey(date) { return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`; }
  function addDays(date, days) { const next = new Date(date); next.setDate(next.getDate() + days); return next; }
  function nthWeekday(year, month, weekday, n) { const date = new Date(year, month, 1); const offset = (weekday - date.getDay() + 7) % 7; date.setDate(1 + offset + (n - 1) * 7); return date; }
  function lastWeekday(year, month, weekday) { const date = new Date(year, month + 1, 0); date.setDate(date.getDate() - ((date.getDay() - weekday + 7) % 7)); return date; }
  function easterSunday(year) {
    const a=year%19,b=Math.floor(year/100),c=year%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),month=Math.floor((h+l-7*m+114)/31)-1,day=((h+l-7*m+114)%31)+1;
    return new Date(year, month, day);
  }
  function put(map, date, name) { map.set(dateKey(date), name); }
  function putObservedNextWeekday(map, date, name) {
    put(map, date, name);
    if (date.getDay() === 0 || date.getDay() === 6) {
      let next = addDays(date, date.getDay() === 6 ? 2 : 1);
      while (map.has(dateKey(next))) next = addDays(next, 1);
      put(map, next, `${name}（补休）`);
    }
  }
  function putObservedUS(map, date, name) {
    put(map, date, name);
    let observed = null;
    if (date.getDay() === 6) observed = addDays(date, -1);
    else if (date.getDay() === 0) observed = addDays(date, 1);
    if (observed) put(map, observed, `${name}（补休）`);
  }

  function buildHolidayMap(code, year) {
    const map = new Map(), easter = easterSunday(year);
    if (code === 'US') {
      putObservedUS(map,new Date(year,0,1),'New Year’s Day'); put(map,nthWeekday(year,0,1,3),'Martin Luther King Jr. Day');
      put(map,nthWeekday(year,1,1,3),"Washington’s Birthday"); put(map,lastWeekday(year,4,1),'Memorial Day');
      putObservedUS(map,new Date(year,5,19),'Juneteenth'); putObservedUS(map,new Date(year,6,4),'Independence Day');
      put(map,nthWeekday(year,8,1,1),'Labor Day'); put(map,nthWeekday(year,9,1,2),'Columbus Day');
      putObservedUS(map,new Date(year,10,11),'Veterans Day'); put(map,nthWeekday(year,10,4,4),'Thanksgiving Day'); putObservedUS(map,new Date(year,11,25),'Christmas Day');
    } else if (code === 'CA') {
      putObservedNextWeekday(map,new Date(year,0,1),"New Year’s Day"); put(map,addDays(easter,-2),'Good Friday');
      const may25=new Date(year,4,25),victoria=addDays(may25,-((may25.getDay()+6)%7||7)); put(map,victoria,'Victoria Day');
      putObservedNextWeekday(map,new Date(year,6,1),'Canada Day'); put(map,nthWeekday(year,8,1,1),'Labour Day');
      putObservedNextWeekday(map,new Date(year,8,30),'National Day for Truth and Reconciliation'); put(map,nthWeekday(year,9,1,2),'Thanksgiving');
      putObservedNextWeekday(map,new Date(year,10,11),'Remembrance Day'); putObservedNextWeekday(map,new Date(year,11,25),'Christmas Day'); putObservedNextWeekday(map,new Date(year,11,26),'Boxing Day');
    } else if (code === 'AU') {
      putObservedNextWeekday(map,new Date(year,0,1),"New Year’s Day"); putObservedNextWeekday(map,new Date(year,0,26),'Australia Day');
      put(map,addDays(easter,-2),'Good Friday'); put(map,addDays(easter,1),'Easter Monday'); put(map,new Date(year,3,25),'ANZAC Day');
      putObservedNextWeekday(map,new Date(year,11,25),'Christmas Day'); putObservedNextWeekday(map,new Date(year,11,26),'Boxing Day');
    } else if (code === 'UK') {
      putObservedNextWeekday(map,new Date(year,0,1),"New Year’s Day"); put(map,addDays(easter,-2),'Good Friday'); put(map,addDays(easter,1),'Easter Monday');
      put(map,nthWeekday(year,4,1,1),'Early May bank holiday'); put(map,lastWeekday(year,4,1),'Spring bank holiday'); put(map,lastWeekday(year,7,1),'Summer bank holiday');
      putObservedNextWeekday(map,new Date(year,11,25),'Christmas Day'); putObservedNextWeekday(map,new Date(year,11,26),'Boxing Day');
    } else if (code === 'NZ') {
      putObservedNextWeekday(map,new Date(year,0,1),"New Year’s Day"); putObservedNextWeekday(map,new Date(year,0,2),'Day after New Year’s Day');
      putObservedNextWeekday(map,new Date(year,1,6),'Waitangi Day'); put(map,addDays(easter,-2),'Good Friday'); put(map,addDays(easter,1),'Easter Monday');
      putObservedNextWeekday(map,new Date(year,3,25),'ANZAC Day'); put(map,nthWeekday(year,5,1,1),"King’s Birthday"); put(map,nthWeekday(year,9,1,4),'Labour Day');
      putObservedNextWeekday(map,new Date(year,11,25),'Christmas Day'); putObservedNextWeekday(map,new Date(year,11,26),'Boxing Day');
    }
    return map;
  }

  function holidayMap(code, year) {
    if (!code) return new Map();
    const key = `${code}:${year}`;
    if (!HOLIDAY_CACHE.has(key)) HOLIDAY_CACHE.set(key, buildHolidayMap(code, year));
    return HOLIDAY_CACHE.get(key);
  }

  function holidayName(date, code) {
    if (!code) return '';
    const key = dateKey(date);
    for (const year of [date.getFullYear()-1, date.getFullYear(), date.getFullYear()+1]) {
      const name = holidayMap(code, year).get(key);
      if (name) return name;
    }
    return '';
  }

  function nonWorkingInfo(date, task) {
    const country = countryForTask(task), weekend = date.getDay() === 0 || date.getDay() === 6, holiday = holidayName(date, country.code);
    return { nonWorking:weekend || !!holiday, weekend, holiday, country, countrySupported:!!country.code };
  }

  function adjustForNonWorkingDay(date, task, rulesInput = {}) {
    const rules = normalizeRules(rulesInput);
    const original = new Date(date);
    const country = countryForTask(task);
    if (!rules.skipHolidays) return { date:original, shiftedDays:0, reasons:[], country, countrySupported:!!country.code };
    let current = new Date(original), shiftedDays = 0, latestCountry = country, countrySupported = !!country.code;
    const reasons = [];
    for (let guard = 0; guard < 21; guard++) {
      const info = nonWorkingInfo(current, task);
      latestCountry = info.country; countrySupported = info.countrySupported;
      if (!info.nonWorking) break;
      if (info.holiday && !reasons.includes(info.holiday)) reasons.push(info.holiday);
      if (info.weekend && !reasons.includes('周末')) reasons.push('周末');
      current = addDays(current, 1); shiftedDays++;
    }
    return { date:current, shiftedDays, reasons, country:latestCountry, countrySupported };
  }

  function schedulableTasks(tasks) {
    return (tasks || []).filter(task => task && task.enabled && task.status === 'ready');
  }

  function validateGroupedCadence(rules) {
    if (rules.grouping !== 'institution') return;
    if (rules.intervalDays != null && rules.maxPerGroupPerRound == null) throw new Error('已设置分组间隔，但未设置每组上限。请明确规则后再应用。');
  }

  function audit(tasks, rulesInput = {}) {
    const rules = normalizeRules(rulesInput);
    validateGroupedCadence(rules);
    const start = parseLocalDateTime(rules.startAt);
    const conflicts = [], holidayConflicts = [];
    let scheduled = 0;
    if (!start) return { conflicts, holidayConflicts, scheduled, configured:false };

    const intervalMs = rules.intervalDays == null ? null : rules.intervalDays * 86400000;
    const buckets = new Map();
    for (const task of schedulableTasks(tasks).filter(task => task.scheduleAt)) {
      const date = parseLocalDateTime(task.scheduleAt);
      if (!date) continue;
      scheduled++;
      if (rules.skipHolidays) {
        const info = nonWorkingInfo(date, task);
        if (info.nonWorking) holidayConflicts.push({ task, date, info });
      }
      if (rules.grouping !== 'institution' || rules.maxPerGroupPerRound == null || intervalMs == null) continue;
      const delta = date.getTime() - start.getTime();
      const round = Math.max(0, Math.floor(delta / intervalMs));
      const group = groupForTask(task, rules), key = `${group.key}|${round}`;
      if (!buckets.has(key)) buckets.set(key, { group, round, tasks:[] });
      buckets.get(key).tasks.push(task);
    }
    for (const bucket of buckets.values()) {
      if (bucket.tasks.length > rules.maxPerGroupPerRound) {
        conflicts.push({ groupLabel:bucket.group.label, roundIndex:bucket.round, count:bucket.tasks.length, limit:rules.maxPerGroupPerRound, tasks:bucket.tasks });
      }
    }
    return { conflicts, holidayConflicts, scheduled, configured:true };
  }

  function buildPlan(tasks, rulesInput = {}, now = new Date()) {
    const rules = normalizeRules(rulesInput);
    validateGroupedCadence(rules);
    const start = parseLocalDateTime(rules.startAt);
    if (!start) throw new Error('请明确设置排期起始时间。');
    if (start.getTime() <= now.getTime() + 60000) throw new Error('排期起始时间需要晚于当前时间。');

    const candidates = schedulableTasks(tasks);
    if (!candidates.length) throw new Error('当前没有已选择且预检通过的任务可排期。');

    const taskOrder = new Map(candidates.map((task, index) => [task, index]));
    const groups = new Map();
    for (const task of candidates) {
      const group = groupForTask(task, rules);
      if (!groups.has(group.key)) groups.set(group.key, { ...group, tasks:[] });
      groups.get(group.key).tasks.push(task);
    }

    const groupedLimit = rules.grouping === 'institution' ? rules.maxPerGroupPerRound : null;
    if (groupedLimit != null && rules.intervalDays == null) {
      const overflow = [...groups.values()].find(group => group.tasks.length > groupedLimit);
      if (overflow) throw new Error(`“${overflow.label}”超过已设置的每组上限，但没有设置下一轮间隔。`);
    }

    const intervalMs = rules.intervalDays == null ? 0 : rules.intervalDays * 86400000;
    const assignments = [], preserved = [];
    let maxRound = 0, holidayAdjusted = 0, holidayShiftDays = 0, priorityOrderedGroups = 0, prioritizedTasks = 0;
    const unsupportedCountries = new Set();

    for (const group of groups.values()) {
      const occupancy = new Map(), autoQueue = [];
      for (const task of group.tasks) {
        const source = String(task.scheduleSource || '');
        const existingDate = parseLocalDateTime(task.scheduleAt);
        const protectedExisting = rules.preserveExisting && existingDate && source !== 'auto' && existingDate.getTime() > now.getTime() + 60000;
        if (!protectedExisting) { autoQueue.push(task); continue; }
        let round = 0;
        if (groupedLimit != null && intervalMs > 0) round = Math.max(0, Math.floor((existingDate.getTime() - start.getTime()) / intervalMs));
        occupancy.set(round, (occupancy.get(round) || 0) + 1);
        maxRound = Math.max(maxRound, round);
        preserved.push({ task, group, scheduleAt:task.scheduleAt, source:source || 'existing' });
      }

      const withPriority = autoQueue.filter(task => priorityForTask(task).has);
      if (withPriority.length) {
        prioritizedTasks += withPriority.length;
        if (autoQueue.length > 1) priorityOrderedGroups++;
      }
      autoQueue.sort((a, b) => {
        const pa = priorityForTask(a), pb = priorityForTask(b);
        if (pa.has !== pb.has) return pa.has ? -1 : 1;
        if (pa.rank !== pb.rank) return pa.rank - pb.rank;
        return (taskOrder.get(a) || 0) - (taskOrder.get(b) || 0);
      });

      let cursorRound = 0;
      for (const task of autoQueue) {
        if (groupedLimit != null) while ((occupancy.get(cursorRound) || 0) >= groupedLimit) cursorRound++;
        const slot = occupancy.get(cursorRound) || 0;
        const rawWhen = new Date(start.getTime() + cursorRound * intervalMs + slot * rules.intraRoundMinutes * 60000);
        const adjusted = adjustForNonWorkingDay(rawWhen, task, { ...rules, policySource:'explicit', __explicit:true });
        const when = adjusted.date;
        if (adjusted.shiftedDays) { holidayAdjusted++; holidayShiftDays += adjusted.shiftedDays; }
        if (rules.skipHolidays && adjusted.country.raw && !adjusted.countrySupported) unsupportedCountries.add(adjusted.country.raw);
        occupancy.set(cursorRound, slot + 1);
        maxRound = Math.max(maxRound, cursorRound);

        const priority = priorityForTask(task), reasonParts = [];
        if (rules.grouping === 'institution') reasonParts.push(group.label);
        if (groupedLimit != null) reasonParts.push(`第 ${cursorRound + 1} 轮`);
        if (priority.has) reasonParts.push(`名单顺序 ${priority.raw || priority.rank}`);
        if (adjusted.shiftedDays) reasonParts.push(`顺延 ${adjusted.shiftedDays} 天`);
        assignments.push({
          editKey:task.editKey, task, groupKey:group.key, groupLabel:group.label, groupSource:group.source,
          scheduleAt:formatLocalDateTime(when), originalScheduleAt:formatLocalDateTime(rawWhen), roundIndex:cursorRound, slotIndex:slot,
          priorityRank:priority.has ? priority.rank : null, priorityLabel:priority.has ? (priority.raw || String(priority.rank)) : '',
          holidayShiftDays:adjusted.shiftedDays, holidayReasons:adjusted.reasons, country:adjusted.country.raw || adjusted.country.code || '',
          reason:reasonParts.join(' · ')
        });
      }
    }

    return {
      rules,
      assignments,
      preserved,
      summary: {
        selected:candidates.length,
        groups:groups.size,
        auto:assignments.length,
        preserved:preserved.length,
        rounds:assignments.length ? maxRound + 1 : 0,
        fallbackGroups:0,
        fallbackTasks:0,
        priorityOrderedGroups,
        prioritizedTasks,
        holidayAdjusted,
        holidayShiftDays,
        unsupportedCountries:[...unsupportedCountries]
      }
    };
  }

  globalThis.NMDAScheduler = {
    DEFAULT_RULES,
    formatLocalDateTime,
    parseLocalDateTime,
    defaultStart,
    recipientDomain,
    cleanInstitution,
    normalizeInstitutionKey,
    institutionEvidence,
    groupForTask,
    normalizeRules,
    normalizeCountry,
    countryForTask,
    parsePriority,
    priorityForTask,
    holidayName,
    nonWorkingInfo,
    adjustForNonWorkingDay,
    audit,
    buildPlan
  };
})();
