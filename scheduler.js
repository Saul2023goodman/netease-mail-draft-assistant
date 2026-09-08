(() => {
  'use strict';

  const DEFAULT_RULES = Object.freeze({
    maxPerGroupPerRound: 1,
    intervalDays: 7,
    preserveExisting: true,
    intraRoundMinutes: 10,
    skipHolidays: true
  });

  const HOLIDAY_CACHE=new Map();
  const COUNTRY_ALIASES=new Map([
    ['us','US'],['usa','US'],['unitedstates','US'],['unitedstatesofamerica','US'],['美国','US'],['美國','US'],
    ['canada','CA'],['ca','CA'],['加拿大','CA'],
    ['australia','AU'],['au','AU'],['澳大利亚','AU'],['澳大利亞','AU'],['澳洲','AU'],
    ['unitedkingdom','UK'],['uk','UK'],['greatbritain','UK'],['britain','UK'],['英国','UK'],['英國','UK'],
    ['england','UK'],['wales','UK'],
    ['newzealand','NZ'],['nz','NZ'],['新西兰','NZ'],['新西蘭','NZ']
  ]);
  const COUNTRY_LABELS={US:'美国',CA:'加拿大',AU:'澳大利亚',UK:'英国',NZ:'新西兰'};

  function pad(n){ return String(n).padStart(2,'0'); }
  function formatLocalDateTime(date){
    if(!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
    return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  function parseLocalDateTime(value){
    if(value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    const raw=String(value||'').trim(); if(!raw) return null;
    const m=raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2})/);
    if(m){const d=new Date(+m[1],+m[2]-1,+m[3],+m[4],+m[5],0,0);return Number.isNaN(d.getTime())?null:d;}
    const d=new Date(raw); return Number.isNaN(d.getTime())?null:d;
  }
  function defaultStart(now=new Date()){
    const d=new Date(now.getTime()+60*60*1000); d.setMinutes(0,0,0); return formatLocalDateTime(d);
  }
  function recipientDomain(recipients){
    const m=String(recipients||'').match(/@([A-Z0-9.-]+\.[A-Z]{2,})(?![A-Z0-9.-])/i); if(!m)return'';
    const raw=m[1].toLowerCase().replace(/^mail\./,'');
    const labels=raw.split('.').filter(Boolean); if(labels.length<2)return raw;
    const academicSuffixes=new Set(['edu.au','edu.hk','ac.uk','ac.nz','ac.jp','ac.kr','ac.in','edu.sg','edu.cn','edu.my','edu.tw','edu.ph','ac.za']);
    const last2=labels.slice(-2).join('.');
    if(academicSuffixes.has(last2)&&labels.length>=3)return labels.slice(-3).join('.');
    return labels.slice(-2).join('.');
  }
  function cleanInstitution(value){
    return String(value||'').normalize('NFKC').replace(/^[\s\-—–:：]+|[\s\-—–:：]+$/g,'').replace(/\s+/g,' ').trim();
  }
  function normalizeInstitutionKey(value){
    return cleanInstitution(value).toLowerCase()
      .replace(/^the\s+/,'')
      .replace(/\([^)]{1,20}\)/g,'')
      .replace(/[&＆]/g,'and')
      .replace(/[^a-z0-9\p{L}]+/gu,'')
      .trim();
  }
  function institutionEvidence(value,recipients='',source=''){
    const school=cleanInstitution(value),trusted=['roster','manual','recognized'].includes(String(source||''));
    if(!school)return{valid:false,value:'',reason:'empty'};
    if(/^(?:[a-z]|\d{1,3}|[a-z]\d{0,2}|(?:group|batch|round|wave|tier|class|category|tag)\s*[a-z0-9-]*|(?:第[\u4e00-\u5341\d]+批|分组|批次|类别|标签)\s*[a-z0-9-]*)$/i.test(school))return{valid:false,value:'',reason:'short-code'};
    const strong=/(?:university|college|school|institute|academy|polytechnic|conservatoire|faculty|department|大学|学院|学校|研究院|科学院|理工|师范|商学院|学部)/i.test(school);
    if(strong||trusted)return{valid:true,value:school,reason:strong?'institution-name':'trusted-source'};
    const domain=recipientDomain(recipients),key=normalizeInstitutionKey(school);
    const domainTokens=domain.split('.').filter(token=>token.length>=2&&!['edu','ac','com','org','net','mail'].includes(token));
    const matched=domainTokens.some(token=>key===token||key.includes(token)||token.includes(key));
    return matched?{valid:true,value:school,reason:'domain-match'}:{valid:false,value:'',reason:'unverified'};
  }
  function groupForTask(task){
    const evidence=institutionEvidence(task?.school||'',task?.recipients||'',task?.schoolSource||''),school=evidence.valid?evidence.value:'', domain=recipientDomain(task?.recipients||'');
    const generic=new Set(['gmail.com','googlemail.com','outlook.com','hotmail.com','live.com','yahoo.com','qq.com','163.com','126.com','icloud.com','proton.me','protonmail.com']);
    if(school) return { key:`school:${normalizeInstitutionKey(school)}`, label:school, source:task?.schoolSource||'school', domain };
    if(domain&&!generic.has(domain)) return { key:`domain:${domain}`, label:`邮箱域名 · ${domain}`, source:'domain', domain };
    if(domain) return { key:`task:${task?.editKey||task?.id||domain}`, label:`未识别学校 · ${domain}`, source:'unknown', domain };
    return { key:`task:${task?.editKey||task?.id||Math.random()}`, label:'未识别学校', source:'unknown' };
  }
  function normalizeRules(input={}){
    const max=Math.max(1,Math.min(20,Number(input.maxPerGroupPerRound)||DEFAULT_RULES.maxPerGroupPerRound));
    const days=Math.max(1,Math.min(365,Number(input.intervalDays)||DEFAULT_RULES.intervalDays));
    return {
      startAt:String(input.startAt||'').trim(),
      maxPerGroupPerRound:max,
      intervalDays:days,
      preserveExisting:input.preserveExisting!==false,
      intraRoundMinutes:Math.max(0,Math.min(120,Number(input.intraRoundMinutes)||DEFAULT_RULES.intraRoundMinutes)),
      skipHolidays:input.skipHolidays!==false
    };
  }

  function compactKey(v){return String(v??'').normalize('NFKC').trim().toLowerCase().replace(/[^a-z0-9\p{L}]+/gu,'');}
  function normalizeCountry(value){
    const raw=compactKey(value); if(!raw)return'';
    if(COUNTRY_ALIASES.has(raw))return COUNTRY_ALIASES.get(raw);
    for(const [alias,code] of COUNTRY_ALIASES){if(alias.length>=4&&(raw.includes(alias)||alias.includes(raw)))return code;}
    return '';
  }
  function countryForTask(task){
    const raw=task?.rosterMeta?.country||task?.rosterReference?.country||task?.country||'';
    return {raw:String(raw||'').trim(),code:normalizeCountry(raw)};
  }
  function parsePriority(value){
    if(value==null||value==='')return {has:false,rank:Number.POSITIVE_INFINITY,raw:''};
    if(typeof value==='number'&&Number.isFinite(value))return {has:true,rank:value,raw:String(value)};
    const raw=String(value).normalize('NFKC').trim(); if(!raw)return {has:false,rank:Number.POSITIVE_INFINITY,raw:''};
    let m=raw.match(/(?:^|[^\d])(?:第\s*)?(\d+(?:\.\d+)?)(?:\s*(?:位|名|顺序|順位|priority|rank))?/i);
    if(m)return {has:true,rank:Number(m[1]),raw};
    m=raw.match(/^p\s*(\d+(?:\.\d+)?)$/i);if(m)return {has:true,rank:Number(m[1]),raw};
    if(/^(?:最高|最优|最優|urgent|highest|top)$/i.test(raw))return {has:true,rank:-100,raw};
    if(/^(?:高|优先|優先|high)$/i.test(raw))return {has:true,rank:100,raw};
    if(/^(?:中|普通|normal|medium)$/i.test(raw))return {has:true,rank:200,raw};
    if(/^(?:低|low)$/i.test(raw))return {has:true,rank:300,raw};
    m=raw.match(/^(?:tier\s*)?([a-z])$/i);if(m)return {has:true,rank:1000+(m[1].toUpperCase().charCodeAt(0)-65),raw};
    return {has:false,rank:Number.POSITIVE_INFINITY,raw};
  }
  function priorityForTask(task){
    const explicit=task?.rosterMeta?.priorityOrder ?? task?.rosterReference?.priorityOrder;
    if(Number.isFinite(Number(explicit))&&String(explicit??'').trim()!=='')return {has:true,rank:Number(explicit),raw:String(task?.rosterMeta?.priority||task?.rosterReference?.priority||explicit)};
    return parsePriority(task?.rosterMeta?.priority ?? task?.rosterReference?.priority ?? task?.priority ?? '');
  }

  function dateKey(date){return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`;}
  function addDays(date,days){const d=new Date(date);d.setDate(d.getDate()+days);return d;}
  function nthWeekday(year,month,weekday,n){const d=new Date(year,month,1);const offset=(weekday-d.getDay()+7)%7;d.setDate(1+offset+(n-1)*7);return d;}
  function lastWeekday(year,month,weekday){const d=new Date(year,month+1,0);d.setDate(d.getDate()-((d.getDay()-weekday+7)%7));return d;}
  function easterSunday(year){
    const a=year%19,b=Math.floor(year/100),c=year%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),month=Math.floor((h+l-7*m+114)/31)-1,day=((h+l-7*m+114)%31)+1;
    return new Date(year,month,day);
  }
  function put(map,date,name){map.set(dateKey(date),name);}
  function putObservedNextWeekday(map,date,name){
    put(map,date,name);
    if(date.getDay()===0||date.getDay()===6){let d=addDays(date,date.getDay()===6?2:1);while(map.has(dateKey(d)))d=addDays(d,1);put(map,d,`${name}（补休）`);}
  }
  function putObservedUS(map,date,name){
    put(map,date,name);let observed=null;
    if(date.getDay()===6)observed=addDays(date,-1);else if(date.getDay()===0)observed=addDays(date,1);
    if(observed)put(map,observed,`${name}（补休）`);
  }
  function buildHolidayMap(code,year){
    const map=new Map(),easter=easterSunday(year);
    if(code==='US'){
      putObservedUS(map,new Date(year,0,1),'New Year’s Day');
      put(map,nthWeekday(year,0,1,3),'Martin Luther King Jr. Day');
      put(map,nthWeekday(year,1,1,3),"Washington’s Birthday");
      put(map,lastWeekday(year,4,1),'Memorial Day');
      putObservedUS(map,new Date(year,5,19),'Juneteenth');
      putObservedUS(map,new Date(year,6,4),'Independence Day');
      put(map,nthWeekday(year,8,1,1),'Labor Day');
      put(map,nthWeekday(year,9,1,2),'Columbus Day');
      putObservedUS(map,new Date(year,10,11),'Veterans Day');
      put(map,nthWeekday(year,10,4,4),'Thanksgiving Day');
      putObservedUS(map,new Date(year,11,25),'Christmas Day');
    }else if(code==='CA'){
      putObservedNextWeekday(map,new Date(year,0,1),"New Year’s Day");
      put(map,addDays(easter,-2),'Good Friday');
      const may25=new Date(year,4,25),victoria=addDays(may25,-((may25.getDay()+6)%7||7));put(map,victoria,'Victoria Day');
      putObservedNextWeekday(map,new Date(year,6,1),'Canada Day');
      put(map,nthWeekday(year,8,1,1),'Labour Day');
      putObservedNextWeekday(map,new Date(year,8,30),'National Day for Truth and Reconciliation');
      put(map,nthWeekday(year,9,1,2),'Thanksgiving');
      putObservedNextWeekday(map,new Date(year,10,11),'Remembrance Day');
      putObservedNextWeekday(map,new Date(year,11,25),'Christmas Day');
      putObservedNextWeekday(map,new Date(year,11,26),'Boxing Day');
    }else if(code==='AU'){
      putObservedNextWeekday(map,new Date(year,0,1),"New Year’s Day");
      putObservedNextWeekday(map,new Date(year,0,26),'Australia Day');
      put(map,addDays(easter,-2),'Good Friday');
      put(map,addDays(easter,1),'Easter Monday');
      put(map,new Date(year,3,25),'ANZAC Day');
      putObservedNextWeekday(map,new Date(year,11,25),'Christmas Day');
      putObservedNextWeekday(map,new Date(year,11,26),'Boxing Day');
    }else if(code==='UK'){
      putObservedNextWeekday(map,new Date(year,0,1),"New Year’s Day");
      put(map,addDays(easter,-2),'Good Friday');
      put(map,addDays(easter,1),'Easter Monday');
      put(map,nthWeekday(year,4,1,1),'Early May bank holiday');
      put(map,lastWeekday(year,4,1),'Spring bank holiday');
      put(map,lastWeekday(year,7,1),'Summer bank holiday');
      putObservedNextWeekday(map,new Date(year,11,25),'Christmas Day');
      putObservedNextWeekday(map,new Date(year,11,26),'Boxing Day');
    }else if(code==='NZ'){
      putObservedNextWeekday(map,new Date(year,0,1),"New Year’s Day");
      putObservedNextWeekday(map,new Date(year,0,2),'Day after New Year’s Day');
      putObservedNextWeekday(map,new Date(year,1,6),'Waitangi Day');
      put(map,addDays(easter,-2),'Good Friday');
      put(map,addDays(easter,1),'Easter Monday');
      putObservedNextWeekday(map,new Date(year,3,25),'ANZAC Day');
      put(map,nthWeekday(year,5,1,1),"King’s Birthday");
      put(map,nthWeekday(year,9,1,4),'Labour Day');
      putObservedNextWeekday(map,new Date(year,11,25),'Christmas Day');
      putObservedNextWeekday(map,new Date(year,11,26),'Boxing Day');
    }
    return map;
  }
  function holidayMap(code,year){
    if(!code)return new Map();const key=`${code}:${year}`;if(!HOLIDAY_CACHE.has(key))HOLIDAY_CACHE.set(key,buildHolidayMap(code,year));return HOLIDAY_CACHE.get(key);
  }
  function holidayName(date,code){
    if(!code)return'';const key=dateKey(date);for(const year of [date.getFullYear()-1,date.getFullYear(),date.getFullYear()+1]){const name=holidayMap(code,year).get(key);if(name)return name;}return'';
  }
  function nonWorkingInfo(date,task){
    const country=countryForTask(task),weekend=date.getDay()===0||date.getDay()===6,holiday=holidayName(date,country.code);
    return {nonWorking:weekend||!!holiday,weekend,holiday,country,countrySupported:!!country.code};
  }
  function adjustForNonWorkingDay(date,task,rules){
    const original=new Date(date);if(!rules.skipHolidays)return {date:original,shiftedDays:0,reasons:[],country:countryForTask(task),countrySupported:!!countryForTask(task).code};
    let d=new Date(original),shifted=0;const reasons=[];let country=countryForTask(task),countrySupported=!!country.code;
    for(let guard=0;guard<21;guard++){
      const info=nonWorkingInfo(d,task);country=info.country;countrySupported=info.countrySupported;
      if(!info.nonWorking)break;
      if(info.holiday&&!reasons.includes(info.holiday))reasons.push(info.holiday);
      if(info.weekend&&!reasons.includes('周末'))reasons.push('周末');
      d=addDays(d,1);shifted++;
    }
    return {date:d,shiftedDays:shifted,reasons,country,countrySupported};
  }

  function audit(tasks,rulesInput={}){
    const rules=normalizeRules(rulesInput), start=parseLocalDateTime(rules.startAt);
    if(!start)return {conflicts:[],holidayConflicts:[],scheduled:0};
    const intervalMs=rules.intervalDays*24*60*60*1000, buckets=new Map(); let scheduled=0;
    const holidayConflicts=[];
    for(const task of (tasks||[]).filter(t=>t&&t.enabled&&t.status==='ready'&&t.scheduleAt)){
      const date=parseLocalDateTime(task.scheduleAt); if(!date)continue; scheduled++;
      if(rules.skipHolidays){const info=nonWorkingInfo(date,task);if(info.nonWorking)holidayConflicts.push({task,date,info});}
      let round=Math.floor((date.getTime()-start.getTime())/intervalMs); if(round<0&&date.getTime()+intervalMs>start.getTime())round=0; if(round<0)continue;
      const group=groupForTask(task), key=`${group.key}|${round}`;
      if(!buckets.has(key))buckets.set(key,{group,round,tasks:[]}); buckets.get(key).tasks.push(task);
    }
    const conflicts=[...buckets.values()].filter(x=>x.tasks.length>rules.maxPerGroupPerRound).map(x=>({groupLabel:x.group.label,roundIndex:x.round,count:x.tasks.length,limit:rules.maxPerGroupPerRound,tasks:x.tasks}));
    return {conflicts,holidayConflicts,scheduled};
  }

  function buildPlan(tasks,rulesInput={},now=new Date()){
    const rules=normalizeRules(rulesInput), start=parseLocalDateTime(rules.startAt);
    if(!start) throw new Error('请先设置排程起始时间。');
    if(start.getTime() <= now.getTime()+60*1000) throw new Error('排程起始时间需要晚于当前时间。');
    const intervalMs=rules.intervalDays*24*60*60*1000;
    const candidates=(tasks||[]).filter(t=>t && t.enabled && t.status==='ready');
    if(!candidates.length) throw new Error('当前没有已选择且预检通过的任务可排程。');

    const taskOrder=new Map(candidates.map((task,index)=>[task,index]));
    const groups=new Map();
    for(const task of candidates){
      const group=groupForTask(task); if(!groups.has(group.key)) groups.set(group.key,{...group,tasks:[]});
      groups.get(group.key).tasks.push(task);
    }

    const assignments=[], preserved=[]; let maxRound=0, fallbackGroups=0, fallbackTasks=0, priorityOrderedGroups=0, prioritizedTasks=0, holidayAdjusted=0, holidayShiftDays=0;
    const unsupportedCountries=new Set();
    for(const group of groups.values()){
      if(group.source==='domain'||group.source==='unknown'){fallbackGroups++;fallbackTasks+=group.tasks.length;}
      const occupancy=new Map();
      const autoQueue=[];
      for(const task of group.tasks){
        const source=String(task.scheduleSource||'');
        const existingDate=parseLocalDateTime(task.scheduleAt);
        const isProtected=rules.preserveExisting && task.scheduleAt && source!=='auto' && existingDate && existingDate.getTime()>now.getTime()+60*1000;
        if(isProtected){
          const date=existingDate;
          if(date){
            let round=Math.floor((date.getTime()-start.getTime())/intervalMs);
            if(round<0 && date.getTime()+intervalMs>start.getTime()) round=0;
            if(round>=0){occupancy.set(round,(occupancy.get(round)||0)+1);maxRound=Math.max(maxRound,round);}
          }
          preserved.push({task,group,scheduleAt:task.scheduleAt,source:source||'existing'});
        }else autoQueue.push(task);
      }
      const withPriority=autoQueue.filter(task=>priorityForTask(task).has);
      if(withPriority.length){prioritizedTasks+=withPriority.length;if(autoQueue.length>1)priorityOrderedGroups++;}
      autoQueue.sort((a,b)=>{
        const pa=priorityForTask(a),pb=priorityForTask(b);
        if(pa.has!==pb.has)return pa.has?-1:1;
        if(pa.rank!==pb.rank)return pa.rank-pb.rank;
        return (taskOrder.get(a)||0)-(taskOrder.get(b)||0);
      });
      let cursorRound=0;
      for(const task of autoQueue){
        while((occupancy.get(cursorRound)||0)>=rules.maxPerGroupPerRound) cursorRound++;
        const slot=occupancy.get(cursorRound)||0;
        const rawWhen=new Date(start.getTime()+cursorRound*intervalMs+slot*rules.intraRoundMinutes*60*1000);
        const adjusted=adjustForNonWorkingDay(rawWhen,task,rules),when=adjusted.date;
        if(adjusted.shiftedDays){holidayAdjusted++;holidayShiftDays+=adjusted.shiftedDays;}
        if(rules.skipHolidays&&adjusted.country.raw&&!adjusted.countrySupported)unsupportedCountries.add(adjusted.country.raw);
        occupancy.set(cursorRound,slot+1); maxRound=Math.max(maxRound,cursorRound);
        const priority=priorityForTask(task),reasonParts=[`${group.label} · 第 ${cursorRound+1} 轮${rules.maxPerGroupPerRound>1?` · 轮内第 ${slot+1} 位`:''}`];
        if(priority.has)reasonParts.push(`名单顺序 ${priority.raw||priority.rank}`);
        if(adjusted.shiftedDays)reasonParts.push(`避开${adjusted.reasons.join('、')}，顺延 ${adjusted.shiftedDays} 天`);
        assignments.push({
          editKey:task.editKey, task, groupKey:group.key, groupLabel:group.label, groupSource:group.source,
          scheduleAt:formatLocalDateTime(when), originalScheduleAt:formatLocalDateTime(rawWhen), roundIndex:cursorRound, slotIndex:slot,
          priorityRank:priority.has?priority.rank:null, priorityLabel:priority.has?(priority.raw||String(priority.rank)):'',
          holidayShiftDays:adjusted.shiftedDays, holidayReasons:adjusted.reasons, country:adjusted.country.raw||adjusted.country.code||'',
          reason:reasonParts.join(' · ')
        });
      }
    }
    return {
      rules, assignments, preserved,
      summary:{selected:candidates.length,groups:groups.size,auto:assignments.length,preserved:preserved.length,rounds:maxRound+1,fallbackGroups,fallbackTasks,priorityOrderedGroups,prioritizedTasks,holidayAdjusted,holidayShiftDays,unsupportedCountries:[...unsupportedCountries]}
    };
  }

  globalThis.NMDAScheduler={DEFAULT_RULES,formatLocalDateTime,parseLocalDateTime,defaultStart,recipientDomain,cleanInstitution,normalizeInstitutionKey,institutionEvidence,groupForTask,normalizeRules,normalizeCountry,countryForTask,parsePriority,priorityForTask,holidayName,nonWorkingInfo,adjustForNonWorkingDay,audit,buildPlan};
})();
