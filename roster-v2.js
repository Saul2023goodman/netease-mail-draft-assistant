(() => {
  'use strict';

  const FIELD_ALIASES = {
    email:['邮箱','邮箱地址','导师邮箱','教授邮箱','联系邮箱','email','email address','mail','contact email'],
    name:['导师','导师姓名','教授','教授姓名','姓名','老师','联系人','supervisor','professor','faculty','name','contact name'],
    school:['学校','院校','大学','高校','所属学校','所属院校','机构','单位','university','school','institution','organisation','organization','affiliation'],
    country:['国家','国家地区','国家/地区','地区','所在国家','country','country/region','country region','region'],
    batch:['批次','轮次','第几批','联系批次','发送批次','batch','round','wave'],
    status:['状态','联系状态','套磁状态','申请状态','status','contact status'],
    priority:['套磁顺序','联系顺序','发送顺序','优先级','优先度','排序','顺序','等级','priority','rank','tier','order','sequence','contact order','outreach order'],
    tags:['分类','标签','分组','类别','方向','tag','tags','category','group'],
    notes:['备注','说明','comment','comments','note','notes','remark','remarks']
  };

  function clean(value) {
    return String(value ?? '').normalize('NFKC')
      .replace(/[\u00a0\u200b\u200c\u200d\ufeff]/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  function norm(value) {
    return clean(value).toLowerCase().replace(/[\s_\-—–:：()（）\[\]【】<>《》\/\\.,，;；]+/g, '');
  }

  function emailOf(value) {
    const match = String(value ?? '').match(/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}(?![A-Z0-9.\-])/i);
    return match ? match[0].toLowerCase() : '';
  }

  function emailsOf(value) {
    const out = [], seen = new Set();
    for (const match of String(value ?? '').matchAll(/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}(?![A-Z0-9.\-])/ig)) {
      const email = String(match[0] || '').toLowerCase();
      if (email && !seen.has(email)) { seen.add(email); out.push(email); }
    }
    return out;
  }

  function splitTags(value) {
    return String(value ?? '').split(/[;；|,，\n]+/).map(clean).filter(Boolean);
  }

  function parsePriorityOrder(value) {
    const raw = clean(value);
    if (!raw) return null;
    const parsed = globalThis.NMDAScheduler?.parsePriority?.(raw);
    if (parsed?.has && Number.isFinite(parsed.rank)) return parsed.rank;
    const match = raw.match(/(?:第\s*)?(\d+(?:\.\d+)?)/);
    return match ? Number(match[1]) : null;
  }

  function normalizeName(value) {
    return clean(value).toLowerCase()
      .replace(/^\s*(?:prof(?:essor)?|dr|mr|mrs|ms)\.?\s+/i, '')
      .replace(/[（(][^）)]{0,60}[）)]/g, '')
      .replace(/\s+[—–-]\s+.*$/, '')
      .replace(/[^a-z0-9\p{L}]+/gu, '');
  }

  function nameKeys(value) {
    const raw = clean(value)
      .replace(/^\s*(?:(?:associate|assistant|adjunct|emeritus)\s+)?(?:prof(?:essor)?|dr|mr|mrs|ms)\.?\s+/i, '')
      .replace(/[（(][^）)]{0,60}[）)]/g, '')
      .replace(/\s+[—–-]\s+.*$/, '').trim();
    if (!raw || emailOf(raw)) return [];
    const out = new Set();
    const direct = normalizeName(raw);
    if (direct) out.add(direct);
    const comma = raw.split(/\s*[,，]\s*/).filter(Boolean);
    if (comma.length === 2) {
      const swapped = normalizeName(`${comma[1]} ${comma[0]}`);
      if (swapped) out.add(swapped);
    }
    const latin = raw.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/)
      .filter(token => token && !/^(?:professor|prof|doctor|dr|associate|assistant|adjunct|emeritus|mr|mrs|ms)$/.test(token));
    if (latin.length >= 2 && latin.length <= 8) out.add([...latin].sort().join(''));
    return [...out];
  }

  function looksGenericId(value) {
    const text = clean(value);
    return !text || /^\d+(?:[-.]\d+)*$/.test(text) || /^\d+[-_]\d+$/.test(text);
  }

  function taskNameCandidates(task) {
    const values = [task?.name, task?.supervisor, task?.contactName];
    const evidence = clean(task?.importRecipientEvidence?.text || '');
    if (evidence && !emailOf(evidence)) values.push(evidence);
    const heading = clean(task?.importHeading || '').replace(/^\d+[.、)）:]\s*/, '');
    if (heading) values.push(heading.split(/\s+[—–-]\s+/)[0]);
    for (const part of String(task?.recipients || '').split(/[;；,，\n]+/)) {
      const display = clean(part.match(/^\s*([^<>]+?)\s*<[^>]+>/)?.[1] || '');
      if (display) values.push(display);
    }
    const id = clean(task?.id || '').replace(/^\d+[.、)）:]\s*/, '').replace(/\s+[—–-]\s+.*$/, '').trim();
    if (id && !looksGenericId(id) && !emailOf(id)) values.push(id);
    const seen = new Set(), out = [];
    for (const value of values) {
      const key = normalizeName(value);
      if (!key || seen.has(key)) continue;
      seen.add(key); out.push(clean(value));
    }
    return out;
  }

  function taskName(task) { return taskNameCandidates(task)[0] || ''; }

  function schoolKey(value) {
    return globalThis.NMDAScheduler?.normalizeInstitutionKey?.(value)
      || globalThis.NMDAPolicyProfile?.resolveInstitutionKey?.(value)
      || norm(value);
  }

  function sameSchool(a, b) {
    const left = schoolKey(a), right = schoolKey(b);
    return !!left && !!right && left === right;
  }

  function schoolSimilarity(a, b) {
    const left = clean(a).toLowerCase().replace(/[^a-z0-9\p{L}]+/gu, ' ').trim();
    const right = clean(b).toLowerCase().replace(/[^a-z0-9\p{L}]+/gu, ' ').trim();
    if (!left || !right) return 0;
    if (sameSchool(a, b)) return 100;
    const l = new Set(left.split(/\s+/).filter(token => token.length > 2));
    const r = new Set(right.split(/\s+/).filter(token => token.length > 2));
    if (!l.size || !r.size) return 0;
    let overlap = 0;
    for (const token of l) if (r.has(token)) overlap++;
    return Math.round(100 * overlap / Math.max(l.size, r.size));
  }

  function headerScore(header, aliases) {
    const key = norm(header);
    if (!key) return 0;
    let best = 0;
    for (const raw of aliases) {
      const alias = norm(raw);
      if (!alias) continue;
      if (key === alias) best = Math.max(best, 100);
      else if (key.includes(alias) || alias.includes(key)) best = Math.max(best, 72 + Math.min(20, alias.length));
    }
    return best;
  }

  function detectColumns(rows) {
    let best = { row:0, score:-1, map:{} };
    const limit = Math.min(rows?.length || 0, 40);
    for (let rowIndex = 0; rowIndex < limit; rowIndex++) {
      const row = rows[rowIndex] || [], map = {};
      let score = 0, recognized = 0;
      for (let column = 0; column < row.length; column++) {
        for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
          const current = headerScore(row[column], aliases);
          if (current && (!map[field] || current > map[field].score)) map[field] = { index:column, score:current };
        }
      }
      for (const value of Object.values(map)) { score += value.score; recognized++; }
      score += recognized * 120 - rowIndex * 3;
      if (score > best.score) best = { row:rowIndex, score, map };
    }
    return best;
  }

  function likelyName(row, used = new Set()) {
    for (let i = 0; i < row.length; i++) {
      if (used.has(i)) continue;
      const value = clean(row[i]);
      if (!value || emailOf(value) || value.length > 100) continue;
      if (/(?:university|college|school|institute|大学|学院|学校)/i.test(value)) continue;
      if (/^(?:yes|no|是|否|第一批|第二批|第三批|a|b|c)$/i.test(value)) continue;
      if (/[A-Za-z\p{L}]/u.test(value) && value.split(/\s+/).length <= 8) return value;
    }
    return '';
  }

  function likelySchool(row, used = new Set()) {
    for (let i = 0; i < row.length; i++) {
      if (used.has(i)) continue;
      const value = clean(row[i]);
      if (!value || emailOf(value) || value.length > 180) continue;
      if (/(?:university|college|school|institute|academy|polytechnic|大学|学院|学校|研究院|理工|师范|商学院)/i.test(value)) return value;
    }
    return '';
  }

  function parseDataset(dataset) {
    const entries = [], warnings = [], invalidEmailRows = [];
    for (const set of (dataset?.sheets || dataset?.recordSets || [])) {
      const rows = set?.rows || [];
      if (!rows.length) continue;
      const detected = detectColumns(rows), hasIdentityHeader = !!(detected.map.email || detected.map.name || detected.map.school);
      const start = hasIdentityHeader ? Math.min(rows.length, detected.row + 1) : 0;
      let inheritedSchool = '';
      for (let rowIndex = start; rowIndex < rows.length; rowIndex++) {
        const row = rows[rowIndex] || [];
        if (!row.some(value => clean(value))) { inheritedSchool = ''; continue; }
        const get = field => detected.map[field] ? row[detected.map[field].index] : '';
        const used = new Set(Object.values(detected.map).map(item => item.index));
        const emailCell = clean(get('email'));
        let email = emailOf(emailCell);
        if (!email) for (const value of row) { email = emailOf(value); if (email) break; }
        if (emailCell.includes('@') && !email) invalidEmailRows.push({ source:set.source || set.name || '', row:rowIndex + 1, value:emailCell });
        const name = clean(get('name')) || likelyName(row, used);
        const explicitSchool = clean(get('school'));
        if (explicitSchool) inheritedSchool = explicitSchool;
        let school = explicitSchool || (detected.map.school ? inheritedSchool : likelySchool(row, used));
        if (!detected.map.school && school) inheritedSchool = school;
        if (!hasIdentityHeader && !email && !(name && school)) continue;
        const country=clean(get('country')),batch=clean(get('batch')),status=clean(get('status')),priority=clean(get('priority'));
        const priorityOrder=parsePriorityOrder(priority),tags=splitTags(get('tags')),notes=clean(get('notes'));
        if (!email && !name && !school) continue;
        entries.push({
          key:`r${entries.length + 1}`, email, name, school, country, batch, status, priority, priorityOrder, tags, notes,
          source:set.source || set.name || '', collection:set.name || '', sourceRow:rowIndex + 1,
          nameKey:normalizeName(name), nameKeys:nameKeys(name), schoolKey:schoolKey(school), schoolInherited:!explicitSchool && !!school
        });
      }
    }
    const emailCounts = new Map(), nameCounts = new Map();
    for (const entry of entries) {
      if (entry.email) emailCounts.set(entry.email, (emailCounts.get(entry.email) || 0) + 1);
      if (entry.nameKey) nameCounts.set(entry.nameKey, (nameCounts.get(entry.nameKey) || 0) + 1);
    }
    const duplicates = entries.filter(entry => (entry.email && emailCounts.get(entry.email) > 1) || (!entry.email && entry.nameKey && nameCounts.get(entry.nameKey) > 1));
    if (duplicates.length) warnings.push(`总名单中有 ${duplicates.length} 条身份重复记录，交叉核验时会保守处理。`);
    if (invalidEmailRows.length) warnings.push(`总名单中有 ${invalidEmailRows.length} 条邮箱格式不完整；仍会尝试按姓名匹配。`);
    return { entries, warnings, invalidEmailRows, stats:{ total:entries.length, withEmail:entries.filter(entry=>entry.email).length, withSchool:entries.filter(entry=>entry.school).length, duplicates:duplicates.length, invalidEmails:invalidEmailRows.length } };
  }

  function buildMatchIndex(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const byEmail = new Map(), byName = new Map(), byKey = new Map();
    for (const entry of list) {
      if (entry?.key) byKey.set(entry.key, entry);
      if (entry?.email) {
        if (!byEmail.has(entry.email)) byEmail.set(entry.email, []);
        byEmail.get(entry.email).push(entry);
      }
      for (const key of (entry?.nameKeys?.length ? entry.nameKeys : nameKeys(entry?.name || ''))) {
        if (!byName.has(key)) byName.set(key, []);
        byName.get(key).push(entry);
      }
    }
    return { entries:list, byEmail, byName, byKey };
  }

  function matchOne(task, entriesOrIndex) {
    const index = Array.isArray(entriesOrIndex) ? buildMatchIndex(entriesOrIndex) : (entriesOrIndex?.byEmail ? entriesOrIndex : buildMatchIndex([]));
    const emails = emailsOf(task?.recipients || ''), email = emails[0] || '', names = taskNameCandidates(task), name = names[0] || '';
    const keys = [...new Set(names.flatMap(nameKeys))], school = clean(task?.school || ''), found = new Map();
    const add = (entry, score, by) => {
      if (!entry) return;
      const key = entry.key || `${entry.email}|${entry.name}|${entry.school}`;
      const previous = found.get(key);
      if (!previous || score > previous.score) found.set(key, { entry, score, by });
    };

    for (const address of emails) for (const entry of (index.byEmail.get(address) || [])) add(entry, 120, 'email');
    for (const key of keys) {
      const sameName = [...new Map((index.byName.get(key) || []).map(entry => [entry.key || `${entry.email}|${entry.school}`, entry])).values()];
      for (const entry of sameName) {
        if (school && entry.school && sameSchool(entry.school, school)) add(entry, 108, 'name+institution');
      }
      if (sameName.length === 1) add(sameName[0], 90, 'unique-name');
      else for (const entry of sameName) add(entry, 70, 'ambiguous-name');
    }

    const candidates = [...found.values()].sort((a, b) => b.score - a.score);
    if (!candidates.length) return { status:'off-roster', task, email, emails, name, names, candidates:[] };
    const top = candidates[0], ties = candidates.filter(candidate => candidate.score === top.score);
    if (ties.length > 1) {
      const equivalent = new Set(ties.map(item => `${item.entry.email}|${normalizeName(item.entry.name)}|${schoolKey(item.entry.school)}`)).size === 1;
      if (!equivalent) return { status:'ambiguous', task, email, emails, name, names, candidates:ties, score:top.score, by:top.by };
    }

    const entry = top.entry;
    const schoolConflictCandidate = !!(school && entry.school && !sameSchool(school, entry.school));
    return {
      status:'matched', task, email, emails, name, names, entry, score:top.score, by:top.by,
      schoolConflict:false,
      schoolConflictCandidate,
      schoolCandidate:entry.school || '',
      schoolSimilarity:schoolConflictCandidate ? schoolSimilarity(school, entry.school) : (school && entry.school ? 100 : 0),
      schoolSupplement:false,
      emailCandidate:!email && !!entry.email && top.score >= 84 ? entry.email : ''
    };
  }

  function auditTaskDuplicates(tasks) {
    const list = Array.isArray(tasks) ? tasks.filter(Boolean) : [];
    const taskKey = (task, index) => String(task?.editKey || task?.id || `task-${index}`);
    const byEmail = new Map(), byNameSchool = new Map();
    list.forEach((task, index) => {
      for (const email of emailsOf(task?.recipients || '')) {
        if (!byEmail.has(email)) byEmail.set(email, []);
        byEmail.get(email).push(task);
      }
      const nameKey = normalizeName(taskName(task)), institutionKey = schoolKey(task?.school || '');
      if (nameKey && institutionKey) {
        const key = `${nameKey}|${institutionKey}`;
        if (!byNameSchool.has(key)) byNameSchool.set(key, { name:taskName(task), school:clean(task?.school || ''), tasks:[] });
        byNameSchool.get(key).tasks.push(task);
      }
    });

    const groups = [], coveredPairs = new Set();
    const addPairs = groupTasks => {
      for (let i = 0; i < groupTasks.length; i++) for (let j = i + 1; j < groupTasks.length; j++) {
        coveredPairs.add([taskKey(groupTasks[i], i), taskKey(groupTasks[j], j)].sort().join('::'));
      }
    };
    for (const [email, groupTasks] of byEmail) {
      const unique = [...new Map(groupTasks.map((task, index) => [taskKey(task, index), task])).values()];
      if (unique.length < 2) continue;
      groups.push({ id:`email:${email}`, type:'exact-email', confidence:100, email, label:email, tasks:unique });
      addPairs(unique);
    }
    for (const [key, group] of byNameSchool) {
      const unique = [...new Map(group.tasks.map((task, index) => [taskKey(task, index), task])).values()];
      if (unique.length < 2) continue;
      let uncovered = false;
      for (let i = 0; i < unique.length && !uncovered; i++) for (let j = i + 1; j < unique.length; j++) {
        if (!coveredPairs.has([taskKey(unique[i], i), taskKey(unique[j], j)].sort().join('::'))) { uncovered = true; break; }
      }
      if (!uncovered) continue;
      groups.push({ id:`name-school:${key}`, type:'name-school', confidence:90, name:group.name, school:group.school, label:[group.name, group.school].filter(Boolean).join(' · '), tasks:unique });
    }
    const affected = new Set();
    for (const group of groups) for (const task of group.tasks) affected.add(taskKey(task, 0));
    return {
      groups,
      exactGroups:groups.filter(group => group.type === 'exact-email'),
      probableGroups:groups.filter(group => group.type === 'name-school'),
      summary:{ tasks:list.length, groups:groups.length, exact:groups.filter(group=>group.type==='exact-email').length, probable:groups.filter(group=>group.type==='name-school').length, affectedTasks:affected.size }
    };
  }

  function crossCheck(tasks, entries) {
    const list = entries || [], index = buildMatchIndex(list);
    const matches = (tasks || []).map(task => matchOne(task, index));
    const byRoster = new Map();
    for (const match of matches) {
      if (!match.entry) continue;
      if (!byRoster.has(match.entry.key)) byRoster.set(match.entry.key, []);
      byRoster.get(match.entry.key).push(match);
    }
    const duplicateMatches = [];
    for (const [key, related] of byRoster) if (related.length > 1) duplicateMatches.push({ entry:index.byKey.get(key), matches:related });
    const matchedKeys = new Set([...byRoster.keys()]);
    const unwritten = list.filter(entry => !matchedKeys.has(entry.key));
    return {
      matches, unwritten, duplicateMatches,
      summary:{
        roster:list.length, tasks:(tasks || []).length,
        matched:matches.filter(match => match.status === 'matched').length,
        offRoster:matches.filter(match => match.status === 'off-roster').length,
        ambiguous:matches.filter(match => match.status === 'ambiguous').length,
        conflicts:0,
        unwritten:unwritten.length,
        duplicates:duplicateMatches.length,
        schoolSupplements:0,
        schoolCandidates:matches.filter(match => match.schoolCandidate).length,
        emailCandidates:matches.filter(match => match.emailCandidate).length
      }
    };
  }

  globalThis.NMDARoster = {
    FIELD_ALIASES,
    normalizeName,
    nameKeys,
    taskName,
    taskNameCandidates,
    schoolKey,
    sameSchool,
    schoolSimilarity,
    parsePriorityOrder,
    parseDataset,
    auditTaskDuplicates,
    crossCheck,
    matchOne,
    buildMatchIndex
  };
})();
