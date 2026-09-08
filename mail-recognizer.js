(() => {
  'use strict';

  const EMAIL_RE = /\b[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}(?![A-Z0-9.\-])/ig;
  const SUBJECT_LABEL_RE = /^(?:\*{0,2})\s*(?:subject|e-?mail\s+subject|主题|邮件主题|邮件标题|标题|邮件题目|邮件题名|信件主题|套磁主题)\s*(?:\*{0,2})\s*[:：]\s*(?:\*{0,2})?\s*/iu;
  const EN_SALUTATION_RE = /^(?:dear|hello|hi)\s+(?:(?:prof(?:essor)?|dr|mr|mrs|ms)\.?\s+)?[^,，:：\n]{1,90}(?:[,，:：]|$)/iu;
  const CN_SALUTATION_RE = /^(?:(?:尊敬的|敬爱的)\s*[^，,：:\n]{1,60}[，,：:]?\s*(?:您好|好)?[！!，,：:]?|(?:[\p{L}·•]{1,30})?(?:教授|老师|博士|先生|女士)[，,：:]?\s*(?:您好|好)[！!，,：:]?|(?:各位)?(?:老师|教授)(?:们)?[，,：:]?\s*(?:您好|好)[！!，,：:]?|您好[！!，,：:])/iu;
  const HARD_NOISE_RE = /^\s*(?:[-—_]{3,}|#{1,6}\s+|\*{0,2}(?:完整套磁信|改写点标注|改写说明|契合点|备注|说明)\s*[:：]?|✏️|📝|📌|(?:剩下的发|好的，我来|第一部分|第二部分|发送计划))/i;
  const NUMBER_ONLY_RE = /^\s*(?:\d{1,4}|[一二三四五六七八九十百]+)[\.、)）:]?\s*$/;
  const POSTSCRIPT_RE = /^\s*(?:p\.?\s*s\.?|postscript|附言|又及)\s*[:：.]/iu;
  const RECORD_HEADING_RE = /^(?:\d+[.、)）:]\s*)?[^\n]{2,100}?\s+[—–-]\s+[^\n]{0,160}(?:university|college|school|institute|academy|polytechnic|大学|学院|学校|研究院|科学院|@[A-Z0-9.-]+)[^\n]*$/iu;
  const EN_CLOSE_RE = /^(yours\s+sincerely|sincerely\s+yours|sincerely|best\s+regards|with\s+best\s+regards|kind\s+regards|warm\s+regards|regards|best\s+wishes|respectfully|with\s+gratitude|many\s+thanks|thank\s+you)\b/iu;
  const CN_COMPLETE_CLOSE_RE = /^(此致\s*敬礼|祝好|顺颂(?:时祺|商祺|教祺|研祺|春祺|夏祺|秋祺|冬祺)|敬颂(?:时祺|教祺|研祺|学安)|谨致问候|敬祝(?:安好|顺利|学安|教安|研安|工作顺利))/u;
  const CN_CLOSE_START_RE = /^此致\s*[,，。！!;；:：—–―-]*\s*$/u;
  const CN_CLOSE_END_RE = /^敬礼\s*[,，。！!;；:：—–―-]*/u;
  const TAIL_PUNCTUATION_RE = /^[\s,，。.!！;；:：—–―\-_*`~～·•]+$/u;
  const SIGNATURE_STOP_WORDS = new Set(['thanks','thank','regards','best','sincerely','respectfully','hello','dear','source','sources','reference','references','attachment','attachments','subject','email','note','notes']);
  const METADATA_FIELDS = [
    {field:'source',label:'来源',re:/^(?:research\s+sources?|information\s+sources?|data\s+sources?|source(?:s|\s+(?:links?|urls?))?|references?|reference\s+(?:links?|urls?)|citations?|research\s+(?:basis|evidence)|(?:professor|supervisor|advisor|faculty)\s+(?:profiles?|pages?)|profile\s+(?:links?|urls?)|official\s+(?:university\s+)?(?:page|profile)|publication\s+(?:list|links?)|paper\s+links?|资料来源|研究来源|信息来源|数据来源|来源链接|来源网址|来源|参考资料|参考文献|引用来源|导师主页|教授主页|学校主页|课题组主页|论文链接|官方主页|网页链接)/iu},
    {field:'attachments',label:'附件',re:/^(?:required\s+attachments?|attached\s+(?:files?|documents?)|documents?\s+attached|files?\s+to\s+attach|attachment(?:s|\s+list)?|enclosures?|附件(?:清单|列表|要求)?|待附文件|随附文件|所需材料)/iu},
    {field:'scheduleAt',label:'定时',re:/^(?:scheduled?\s+(?:send(?:ing)?\s+)?(?:time|date)|send(?:ing)?\s+(?:time|date)|delivery\s+(?:time|date)|send\s+at|schedule|定时(?:发送)?时间|计划发送时间|发送时间|预约发送时间)/iu},
    {field:'recipient',label:'收件人',re:/^(?:recipient(?:\s+email)?|to\s+address|professor\s+email|supervisor\s+email|advisor\s+email|收件人(?:邮箱)?|导师邮箱|教授邮箱)/iu},
    {field:'notes',label:'说明',re:/^(?:internal\s+notes?|editor(?:ial)?\s+notes?|drafting\s+notes?|instructions?|rewrite\s+notes?|matching\s+points?|rationale|analysis|备注|内部说明|操作说明|写作说明|改写说明|改写点|契合点|匹配点|发送说明|研究说明)/iu}
  ];
  const METADATA_MATCHERS = METADATA_FIELDS.map(def=>{
    const core=def.re.source.replace(/^\^/,'');
    return {...def,
      valued:new RegExp(`^(?:${core})\\s*(?:(?:[:：])|(?:\\s+[—–-]\\s+))\\s*(.+)$`,def.re.flags),
      heading:new RegExp(`^(?:${core})\\s*[:：]?\\s*$`,def.re.flags)
    };
  });

  function textOfBlock(block) {
    if (block == null) return '';
    if (typeof block === 'string') return block;
    return String(block.text ?? block.value ?? '');
  }

  function cleanBlockText(value) {
    return String(value ?? '')
      .replace(/[\u00ad\u200b\u200c\u200d\ufeff]/g, '')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
  }

  function cleanInlineMarkup(value) {
    return cleanBlockText(value)
      .replace(/^\s*#{1,6}\s*/, '')
      .replace(/^\s*>\s*/, '')
      .replace(/^\s*[-*]\s+/, '')
      .replace(/^\*{1,3}|\*{1,3}$/g, '')
      .replace(/\*\*/g, '')
      .trim();
  }

  function presentationPrefixLength(value) {
    return String(value || '').match(/^\s*(?:(?:#{1,6}|>|[-*•▪◦])\s*)*/u)?.[0].length || 0;
  }

  function logicalLines(value) {
    const text=cleanBlockText(value),out=[];
    const re=/[^\n]+/g;let m;
    while((m=re.exec(text))){
      const raw=m[0],lead=raw.match(/^\s*/)?.[0].length||0,trail=raw.match(/\s*$/)?.[0].length||0;
      const start=m.index+lead,end=m.index+raw.length-trail;
      if(end>start)out.push({text:text.slice(start,end),start,end});
    }
    return out;
  }

  function collapseSubject(value) {
    return cleanInlineMarkup(value)
      .replace(/\s*\n\s*/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/^[-—–:：\s]+|[-—–\s]+$/g, '')
      .trim();
  }

  function extractEmails(value) {
    const source = String(value ?? '');
    const matches = source.match(EMAIL_RE) || [];
    const seen = new Set(), out = [];
    for (const raw of matches) {
      const email = raw.replace(/[)>\],.;:，；。]+$/g, '').trim();
      const key = email.toLowerCase();
      if (email && !seen.has(key)) { seen.add(key); out.push(email); }
    }
    return out;
  }

  function isNoiseBlock(value) {
    const text = cleanBlockText(value);
    if (!text) return true;
    if (HARD_NOISE_RE.test(text)) return true;
    if (/^\s*(?:📧\s*)?[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}\s*$/i.test(text)) return true;
    if (NUMBER_ONLY_RE.test(text)) return true;
    return false;
  }

  function subjectAnchor(value) {
    const text=cleanBlockText(value);
    for(const line of logicalLines(text)){
      const prefix=presentationPrefixLength(line.text),candidate=line.text.slice(prefix);
      const m=SUBJECT_LABEL_RE.exec(candidate);
      if(m)return{index:line.start+prefix+m[0].length,markerStart:line.start+prefix,marker:m[0],lineStart:line.start,lineEnd:line.end};
    }
    return null;
  }

  function salutationAnchor(value) {
    const text=cleanBlockText(value);
    for(const line of logicalLines(text)){
      const prefix=presentationPrefixLength(line.text),candidate=line.text.slice(prefix);
      const m=EN_SALUTATION_RE.exec(candidate)||CN_SALUTATION_RE.exec(candidate);
      if(m)return{index:line.start+prefix+(m.index||0),end:line.start+prefix+(m.index||0)+m[0].length,text:m[0],lineStart:line.start,lineEnd:line.end};
    }
    const subject=subjectAnchor(text);
    if(subject){
      const tail=text.slice(subject.index),m=/(?:\b(?:dear|hello|hi)\s+(?:(?:prof(?:essor)?|dr|mr|mrs|ms)\.?\s+)?[^,，:：\n]{1,90}(?:[,，:：]|$)|(?:尊敬的|敬爱的)[^，,：:\n]{1,60}[，,：:])/iu.exec(tail);
      if(m)return{index:subject.index+m.index,end:subject.index+m.index+m[0].length,text:m[0],lineStart:subject.index,lineEnd:text.length};
    }
    return null;
  }

  function isLikelyPersonNameLine(value) {
    const text=cleanInlineMarkup(value).replace(/^[,，:：;；—–―\-\s]+|[,，:：;；—–―\-\s]+$/g,'').trim();
    if(!text||text.length>90||/[.!?。！？:：/@]/u.test(text))return false;
    if(/^[\p{Script=Han}·]{2,12}(?:\s*[（(][A-Za-z][A-Za-z'’ .-]{0,50}[)）])?$/u.test(text))return true;
    const tokens=text.split(/\s+/).filter(Boolean);
    if(tokens.length<1||tokens.length>6)return false;
    if(tokens.some(token=>SIGNATURE_STOP_WORDS.has(token.toLowerCase())))return false;
    return tokens.every(token=>/^(?:[A-Z][\p{L}'’.-]*|[A-Z]{2,}|[A-Z]\.)$/u.test(token));
  }

  function closingLineInfo(line) {
    const prefix=presentationPrefixLength(line.text),candidate=line.text.slice(prefix).trim().replace(/\*{1,3}$/,'').trim();
    const absoluteStart=line.start+prefix;
    if(CN_CLOSE_START_RE.test(candidate))return{kind:'start',index:absoluteStart,end:line.end,text:candidate};
    const cnComplete=CN_COMPLETE_CLOSE_RE.exec(candidate);
    if(cnComplete){
      const after=candidate.slice(cnComplete[0].length),punct=after.match(/^\s*[,，。！!;；:：—–―-]*\s*/u)?.[0]||'',tail=after.slice(punct.length).trim();
      if(!tail||isLikelyPersonNameLine(tail))return{kind:'complete',index:absoluteStart,end:absoluteStart+cnComplete[0].length+punct.length,text:candidate.slice(0,cnComplete[0].length+punct.length)};
    }
    const cnEnd=CN_CLOSE_END_RE.exec(candidate);
    if(cnEnd){
      const tail=candidate.slice(cnEnd[0].length).trim();
      if(!tail||isLikelyPersonNameLine(tail))return{kind:'end',index:absoluteStart,end:absoluteStart+cnEnd[0].length,text:candidate.slice(0,cnEnd[0].length)};
    }
    const en=EN_CLOSE_RE.exec(candidate);
    if(en){
      const markerEnd=en[0].length,after=candidate.slice(markerEnd),punct=after.match(/^\s*[,，:：;；—–―-]*\s*/u)?.[0]||'',tail=after.slice(punct.length).trim();
      const hasSeparator=/[,，:：;；—–―-]/u.test(punct);
      if(!tail||(hasSeparator&&isLikelyPersonNameLine(tail)))return{kind:'complete',index:absoluteStart,end:absoluteStart+markerEnd+punct.length,text:candidate.slice(0,markerEnd+punct.length)};
    }
    return null;
  }

  function closeAnchor(value) {
    const text=cleanBlockText(value),lines=logicalLines(text);
    for(let i=0;i<lines.length;i++){
      const found=closingLineInfo(lines[i]);if(!found)continue;
      if(found.kind==='start'&&i+1<lines.length){
        const next=closingLineInfo(lines[i+1]);
        if(next?.kind==='end')return{index:found.index,end:next.end,text:text.slice(found.index,next.end),kind:'complete'};
      }
      return found;
    }
    return null;
  }

  function laterClosingExists(blocks,from,endBlock) {
    for(let i=Math.max(0,from);i<Math.min(endBlock,blocks.length);i++)if(closeAnchor(textOfBlock(blocks[i])))return true;
    return false;
  }

  function closingCandidatePrecedesBody(blocks,span,endBlock) {
    const candidates=[],endRaw=cleanBlockText(textOfBlock(blocks[span.endBlock])),inlineTail=endRaw.slice(span.end).trim();
    for(const text of inlineTail.split(/\n+/).map(x=>x.trim()).filter(Boolean))candidates.push(text);
    for(let i=span.endBlock+1;i<Math.min(endBlock,span.endBlock+5,blocks.length);i++)for(const text of cleanBlockText(textOfBlock(blocks[i])).split(/\n+/).map(x=>x.trim()).filter(Boolean))candidates.push(text);
    for(const text of candidates){
      const classification=classifyBoundaryBlock(text,{phase:'post-close'});
      if(classification.role==='formatting')continue;
      if(['signature','postscript','metadata','subject','salutation','record-heading','record-marker','annotation'].includes(classification.role))return false;
      if(classification.role==='body')return laterClosingExists(blocks,span.endBlock+1,endBlock);
    }
    return false;
  }

  function findClosingSpan(blocks,startBlock,endBlock) {
    for(let i=Math.max(0,startBlock);i<Math.min(endBlock,blocks.length);i++){
      const found=closeAnchor(textOfBlock(blocks[i]));if(!found)continue;
      let span=null;
      if(found.kind==='start'){
        for(let j=i+1;j<Math.min(endBlock,i+3,blocks.length);j++){
          const next=closeAnchor(textOfBlock(blocks[j]));
          if(next?.kind==='end'||next?.kind==='complete'&&/^敬礼/u.test(cleanInlineMarkup(next.text))){
            span={startBlock:i,endBlock:j,index:found.index,end:next.end,text:`${found.text}\n${next.text}`,kind:'complete'};break;
          }
          if(!TAIL_PUNCTUATION_RE.test(cleanBlockText(textOfBlock(blocks[j]))))break;
        }
      }
      span=span||{startBlock:i,endBlock:i,index:found.index,end:found.end,text:found.text,kind:found.kind};
      if(closingCandidatePrecedesBody(blocks,span,endBlock))continue;
      return span;
    }
    return null;
  }

  function stripListPrefix(value) {
    const text=cleanBlockText(value),prefix=presentationPrefixLength(text);
    return text.slice(prefix)
      .replace(/^\s*(?:✏️|📝|📌|🔗|📎|⏰|📧)\s*/u,'')
      .replace(/([:：])\s*\*{1,3}\s*/u,'$1 ')
      .trim();
  }

  function metadataAnchor(value) {
    const text=stripListPrefix(value);
    for(const def of METADATA_MATCHERS){
      const valued=def.valued.exec(text);
      if(valued)return{field:def.field,label:def.label,value:String(valued[1]||'').trim(),text,headingOnly:false};
      const heading=def.heading.exec(text);
      if(heading)return{field:def.field,label:def.label,value:'',text,headingOnly:true};
    }
    const directEmails=extractEmails(value);
    // A leading mail icon is an explicit recipient marker even when the source appends a human
    // note such as “（请以官网为准）”. Requiring the whole block to be only an email caused these
    // high-quality recipient lines to fall back to generic prose classification.
    if(/^\s*📧/u.test(cleanBlockText(value))&&directEmails.length)return{field:'recipient',label:'收件人',value:directEmails[0],text,headingOnly:false};
    return null;
  }

  function isLikelySignatureLine(value) {
    const text=cleanInlineMarkup(value);
    if(!text||text.length>180||metadataAnchor(text)||subjectAnchor(text)||salutationAnchor(text)||closeAnchor(text)||HARD_NOISE_RE.test(text)||NUMBER_ONLY_RE.test(text))return false;
    if(POSTSCRIPT_RE.test(text))return false;
    if(isLikelyPersonNameLine(text))return true;
    if(/\b(?:ph\.?d\.?|doctoral|master'?s?|student|candidate|researcher|assistant|associate|professor|lecturer|department|faculty|school|college|university|institute|laboratory|lab|中心|实验室|研究院|学院|大学|博士|硕士|学生|研究员|教授|讲师)\b/iu.test(text))return true;
    if(/^(?:e-?mail|email|tel|telephone|phone|mobile|wechat|微信|电话|手机|网址|website)\s*[:：]/iu.test(text))return true;
    if(/^(?:https?:\/\/|www\.)\S+$/iu.test(text))return true;
    if(/^\+?[\d()\s.-]{7,24}$/.test(text))return true;
    return false;
  }

  function classifyBoundaryBlock(value,{phase='body'}={}) {
    const text=cleanBlockText(value);
    if(!text)return{role:'empty',hard:false,label:'空行'};
    if(TAIL_PUNCTUATION_RE.test(text))return{role:'formatting',hard:false,label:'排版符号'};
    const metadata=metadataAnchor(text);
    if(metadata)return{role:'metadata',hard:true,label:metadata.label,metadata};
    if(subjectAnchor(text))return{role:'subject',hard:true,label:'下一主题'};
    if(NUMBER_ONLY_RE.test(text))return{role:'record-marker',hard:true,label:'下一记录'};
    // Identity headings may themselves be Markdown headings (e.g. “### 1. Name — mail@uni.edu”).
    // Detect their semantic role before the generic Markdown/noise rule, otherwise the previous
    // record can consume the next record's identity line and hide its embedded email.
    if(phase!=='body'&&RECORD_HEADING_RE.test(cleanInlineMarkup(text)))return{role:'record-heading',hard:true,label:'下一记录'};
    if(HARD_NOISE_RE.test(text))return{role:'annotation',hard:true,label:'说明'};
    if(salutationAnchor(text))return{role:'salutation',hard:phase!=='body',label:'称呼'};
    if(closeAnchor(text))return{role:'closing',hard:false,label:'结束语'};
    if(POSTSCRIPT_RE.test(text))return{role:'postscript',hard:false,label:'附言'};
    if(phase==='post-close'&&isLikelySignatureLine(text))return{role:'signature',hard:false,label:'署名'};
    return{role:'body',hard:false,label:'正文'};
  }

  function excludedBlock(block,index,classification) {
    return {index,text:cleanBlockText(textOfBlock(block)),role:classification.role,label:classification.label,field:classification.metadata?.field||'',value:classification.metadata?.value||''};
  }

  function continuationClassification(field,label,value) {
    const clean=stripListPrefix(value).replace(/^\d{1,3}[.、)）]\s*/u,'').trim();
    return{role:'metadata-continuation',hard:true,label,metadata:{field,label,value:clean}};
  }

  // Recipient is a leading field of the *next* mail frame, never a post-body sidecar of the
  // completed frame. v1.21 introduced consumedEndBlock to stop source/notes metadata leaking
  // into the next record, but it also consumed a next-record recipient when the source order was
  // `previous signature -> notes -> 📧 next@... -> record marker/heading -> Subject`. That made
  // previousConsumedEnd jump past the real recipient before nearestRecipientContext could see it.
  // Keep source/attachment/schedule/notes tail ownership, but stop ownership immediately before
  // a recipient header so the next frame can resolve it from its own preamble.
  function isRecipientBoundary(classification) {
    return classification?.role==='metadata' && classification.metadata?.field==='recipient';
  }

  function sidecarFromExcluded(items) {
    const attachments=[],sources=[],schedules=[];
    for(const item of items||[]){
      const value=String(item.value||'').trim();if(!value)continue;
      if(item.field==='attachments')attachments.push(value);
      else if(item.field==='source')sources.push(value);
      else if(item.field==='scheduleAt')schedules.push(value);
    }
    return{attachments:[...new Set(attachments)].join('; '),scheduleAt:schedules[0]||'',sources:[...new Set(sources)]};
  }

  function nearestRecipientContext(blocks, start, end, salutationText='', options={}) {
    const candidates = [];
    const indexOffset=Number(options?.indexOffset||0);
    const salutation=String(salutationText||'').replace(/[,，:：！!]/g,' ').trim();
    const surname=salutation.split(/\s+/).filter(Boolean).pop()?.toLowerCase()||'';
    for (let i=Math.max(0,start); i<=Math.min(end,blocks.length-1); i++) {
      const text = cleanBlockText(textOfBlock(blocks[i])),metadata=metadataAnchor(text),emails=extractEmails(text);
      for (const email of emails) {
        let score = 100 - Math.min(70, Math.max(0,end-i)*8);
        const explicitRecipient=metadata?.field==='recipient'||/(?:recipient|收件人|导师邮箱|教授邮箱|to\s*[:：])/iu.test(text);
        if (/📧/.test(text)) score += 18;
        if (/[-—–]\s*[^\n]*@/.test(text) || /@[^\s]+\s*$/.test(text)) score += 10;
        if (surname && text.toLowerCase().includes(surname)) score += 14;
        if (/\b(?:from|my email|sender)\b/i.test(text)) score -= 30;
        if(metadata&&metadata.field!=='recipient')score-=80;else if(explicitRecipient)score+=24;
        candidates.push({email,index:i+indexOffset,score,text,explicitRecipient});
      }
    }
    const deduped=new Map();
    for(const candidate of candidates){const key=candidate.email.toLowerCase(),prior=deduped.get(key);if(!prior||candidate.score>prior.score)deduped.set(key,candidate);}
    const ranked=[...deduped.values()].sort((a,b)=>b.score-a.score || b.index-a.index),first=ranked[0]||null,second=ranked[1]||null;
    const ambiguous=!!(first&&second&&first.score>=55&&second.score>=55&&!first.explicitRecipient&&first.score-second.score<10);
    return { selected:first&&first.score>=55&&!ambiguous?first:null, candidates:ranked, ambiguous };
  }

  function headingContext(blocks, contextStart, subjectBlock) {
    const from=Math.max(contextStart,subjectBlock-8);
    for (let i=subjectBlock-1; i>=from; i--) {
      const raw=cleanBlockText(textOfBlock(blocks[i])); if(!raw)continue;
      if (subjectAnchor(raw) || salutationAnchor(raw) || closeAnchor(raw) || metadataAnchor(raw)) continue;
      const clean=cleanInlineMarkup(raw);
      if (/^(?:\d+[.、)）:]\s*)?[^\n]{2,100}?\s+[—–-]\s+[^\n]{2,180}$/i.test(clean)) return {index:i,text:clean};
    }
    for (let i=subjectBlock-1; i>=from; i--) {
      const raw = cleanBlockText(textOfBlock(blocks[i]));
      if (!raw || HARD_NOISE_RE.test(raw) || NUMBER_ONLY_RE.test(raw) || metadataAnchor(raw)) continue;
      if (/^\s*(?:📧\s*)?[A-Z0-9._%+\-]+@/i.test(raw)) continue;
      if (subjectAnchor(raw) || salutationAnchor(raw) || closeAnchor(raw)) continue;
      const text = cleanInlineMarkup(raw);
      if (text.length > 180 || /^(?:突出|强调|契合点|改写)/.test(text)) continue;
      return {index:i,text};
    }
    return null;
  }

  function institutionFromHeading(headingText) {
    const clean=cleanInlineMarkup(headingText||'').replace(/^\s*\d+[\.、)）:]\s*/,'').trim();
    if(!clean)return '';
    const parts=clean.split(/\s+[—–-]\s+/).map(x=>x.trim()).filter(Boolean);
    if(parts.length<2)return '';
    const candidates=parts.slice(1).filter(part=>!extractEmails(part).length && !/^(?:邮箱|email)(?:待确认|pending)?$/i.test(part));
    const strong=candidates.find(part=>/(university|college|school|institute|academy|polytechnic|conservatoire|大学|学院|学校|研究院|科学院|理工|师范|商学院)/i.test(part));
    return (strong||'').replace(/[（(](?:邮箱待确认|email pending)[）)]/ig,'').trim().slice(0,160);
  }

  function deriveId(heading, ordinal) {
    if (!heading?.text) return String(ordinal);
    const t = heading.text.replace(/^\s*\d+[\.、)）:]\s*/, '').trim();
    const m = t.match(/^(.{1,100}?)(?:\s+[—–-]\s+|\s+—\s+)/);
    return (m?.[1] || t).replace(/\s*[-—–]\s*\(?\s*(?:邮箱|email).*/i,'').trim().slice(0,100) || String(ordinal);
  }

  function subjectText(blocks, subjectBlock, salutBlock, subjectInfo, salutInfo) {
    const parts=[];
    scanSubject:for(let i=subjectBlock;i<=salutBlock&&parts.join(' ').length<260;i++){
      let text=cleanBlockText(textOfBlock(blocks[i]));if(!text)continue;
      if(i===subjectBlock)text=text.slice(subjectInfo.index);
      if(i===salutBlock&&salutInfo){
        const localSal=i===subjectBlock?salutationAnchor(cleanBlockText(textOfBlock(blocks[i]))):salutInfo;
        if(localSal){const cut=i===subjectBlock?Math.max(0,localSal.index-subjectInfo.index):localSal.index;text=text.slice(0,cut);}
      }
      for(const line of text.split(/\n+/).map(x=>x.trim()).filter(Boolean)){
        const classification=classifyBoundaryBlock(line,{phase:'header'});
        if(!parts.length&&(i===subjectBlock||classification.role==='body'||classification.role==='record-marker')){parts.push(line);continue;}
        if(classification.hard||classification.role==='closing'||classification.role==='postscript')break scanSubject;
        parts.push(line);
      }
    }
    return collapseSubject(parts.join(' ')).slice(0,260);
  }

  function appendPostClose(blocks,parts,closeInfo,nextSubjectBlock) {
    let endBlock=closeInfo.endBlock,inPostscript=false,signatureLines=0,postscriptLines=0,boundaryMode=false,activeField='',activeLabel='';
    let consumedEndBlock=endBlock;
    const excludedBlocks=[],signatureBlocks=new Set(),postscriptBlocks=new Set(),candidates=[];
    const closeRaw=cleanBlockText(textOfBlock(blocks[closeInfo.endBlock])),inlineTail=closeRaw.slice(closeInfo.end).trim();
    for(const text of inlineTail.split(/\n+/).map(x=>x.trim()).filter(Boolean))candidates.push({text,index:closeInfo.endBlock,inline:true});
    for(let i=closeInfo.endBlock+1;i<Math.min(nextSubjectBlock,closeInfo.endBlock+16,blocks.length);i++)for(const text of cleanBlockText(textOfBlock(blocks[i])).split(/\n+/).map(x=>x.trim()).filter(Boolean))candidates.push({text,index:i,inline:false});
    for(const candidate of candidates){
      const raw=candidate.text,i=candidate.index;if(!raw)continue;
      const classification=classifyBoundaryBlock(raw,{phase:'post-close'});
      if(classification.role==='formatting')continue;
      if(boundaryMode){
        if(['subject','salutation','record-heading','record-marker'].includes(classification.role)||isRecipientBoundary(classification))break;
        if(classification.role==='metadata'){
          activeField=classification.metadata?.field||'';activeLabel=classification.label;
          excludedBlocks.push(excludedBlock(candidate,i,classification));consumedEndBlock=Math.max(consumedEndBlock,i);continue;
        }
        if(classification.hard&&classification.role!=='annotation')break;
        const continuation=activeField?continuationClassification(activeField,activeLabel,raw):{role:'ambiguous-tail',hard:true,label:'未归类尾部'};
        excludedBlocks.push(excludedBlock(candidate,i,continuation));consumedEndBlock=Math.max(consumedEndBlock,i);continue;
      }
      if(isRecipientBoundary(classification))break;
      if(classification.hard){
        excludedBlocks.push(excludedBlock(candidate,i,classification));consumedEndBlock=Math.max(consumedEndBlock,i);boundaryMode=true;
        activeField=classification.metadata?.field||'';activeLabel=classification.label||'';continue;
      }
      if(classification.role==='postscript'){inPostscript=true;postscriptLines=0;}
      if(inPostscript){
        if(postscriptLines>=4){excludedBlocks.push(excludedBlock(candidate,i,{role:'ambiguous-tail',label:'未归类尾部'}));boundaryMode=true;consumedEndBlock=Math.max(consumedEndBlock,i);continue;}
        parts.push(cleanInlineMarkup(raw));endBlock=Math.max(endBlock,i);consumedEndBlock=Math.max(consumedEndBlock,i);postscriptBlocks.add(i);postscriptLines++;continue;
      }
      if(classification.role==='signature'&&signatureLines<8){
        parts.push(cleanInlineMarkup(raw));endBlock=Math.max(endBlock,i);consumedEndBlock=Math.max(consumedEndBlock,i);signatureBlocks.add(i);signatureLines++;continue;
      }
      excludedBlocks.push(excludedBlock(candidate,i,{role:'ambiguous-tail',label:'未归类尾部'}));consumedEndBlock=Math.max(consumedEndBlock,i);boundaryMode=true;
    }
    return{endBlock,consumedEndBlock,excludedBlocks,signatureBlocks:[...signatureBlocks],postscriptBlocks:[...postscriptBlocks]};
  }

  function bodyText(blocks, salutationBlock, closeInfo, nextSubjectBlock, salutInfo) {
    const parts=[];
    for (let i=salutationBlock; i<=closeInfo.endBlock; i++) {
      let text=cleanBlockText(textOfBlock(blocks[i]));if(!text)continue;
      const start=i===salutationBlock&&salutInfo?salutInfo.index:0,end=i===closeInfo.endBlock?closeInfo.end:text.length;
      text=text.slice(start,end);if(text.trim())parts.push(cleanInlineMarkup(text));
    }
    const tail=appendPostClose(blocks,parts,closeInfo,nextSubjectBlock);
    return {text:parts.filter(Boolean).join('\n\n').replace(/\n{3,}/g,'\n\n').trim(),...tail};
  }

  function bodyTextOpenEnded(blocks, startBlock, nextSubjectBlock, startInfo=null) {
    const parts=[],excludedBlocks=[];let endBlock=startBlock,consumedEndBlock=startBlock,boundaryMode=false,activeField='',activeLabel='';
    scanBlocks:for(let i=startBlock;i<Math.min(nextSubjectBlock,blocks.length);i++){
      let raw=cleanBlockText(textOfBlock(blocks[i]));if(!raw)continue;
      if(i===startBlock&&startInfo)raw=raw.slice(startInfo.index);
      const local=[];
      for(const segment of raw.split(/\n+/).map(x=>x.trim()).filter(Boolean)){
        const classification=classifyBoundaryBlock(segment,{phase:'open-ended'});
        const isInitialSalutation=i===startBlock&&!parts.length&&!local.length&&classification.role==='salutation';
        if(isRecipientBoundary(classification)&&!isInitialSalutation)break scanBlocks;
        if(boundaryMode){
          if(['subject','salutation','record-heading','record-marker'].includes(classification.role))break scanBlocks;
          if(classification.role==='metadata'){
            activeField=classification.metadata?.field||'';activeLabel=classification.label;
            excludedBlocks.push(excludedBlock({text:segment},i,classification));consumedEndBlock=i;continue;
          }
          const continuation=activeField?continuationClassification(activeField,activeLabel,segment):{role:'ambiguous-tail',hard:true,label:'未归类尾部'};
          excludedBlocks.push(excludedBlock({text:segment},i,continuation));consumedEndBlock=i;continue;
        }
        if(classification.hard&&!isInitialSalutation){
          excludedBlocks.push(excludedBlock({text:segment},i,classification));consumedEndBlock=i;boundaryMode=true;activeField=classification.metadata?.field||'';activeLabel=classification.label||'';continue;
        }
        const clean=cleanInlineMarkup(segment);if(clean)local.push(clean);
      }
      if(local.length){parts.push(local.join('\n'));endBlock=i;consumedEndBlock=Math.max(consumedEndBlock,i);}
    }
    while(parts.length&&(HARD_NOISE_RE.test(parts[parts.length-1])||NUMBER_ONLY_RE.test(parts[parts.length-1])))parts.pop();
    return{text:parts.join('\n\n').replace(/\n{3,}/g,'\n\n').trim(),endBlock,consumedEndBlock,excludedBlocks,signatureBlocks:[],postscriptBlocks:[]};
  }

  function bodyTextUntilClose(blocks, startBlock, closeInfo, nextSubjectBlock) {
    const parts=[];
    for(let i=startBlock;i<=closeInfo.endBlock;i++){
      let raw=cleanBlockText(textOfBlock(blocks[i]));if(i===closeInfo.endBlock)raw=raw.slice(0,closeInfo.end);
      if(raw)parts.push(cleanInlineMarkup(raw));
    }
    const tail=appendPostClose(blocks,parts,closeInfo,nextSubjectBlock);
    return{text:parts.filter(Boolean).join('\n\n').replace(/\n{3,}/g,'\n\n').trim(),...tail};
  }

  function addBlockRole(map,index,role,label,extra={}) {
    if(!Number.isFinite(Number(index))||Number(index)<0)return;
    const key=Number(index),list=map.get(key)||[];
    if(!list.some(item=>item.role===role&&item.label===label&&item.field===(extra.field||'')))list.push({role,label,...extra});
    map.set(key,list);
  }

  function buildBlockRoles(blocks,{subjectBlock,salutationBlock,salutInfo,closeInfo,body,heading,recipientEvidence,recipientCandidates=[]}) {
    const map=new Map();
    if(heading)addBlockRole(map,heading.index,'identity','对象标题');
    if(recipientEvidence)addBlockRole(map,recipientEvidence.index,'recipient','收件人线索');
    for(const candidate of recipientCandidates||[]){
      if(Number(candidate?.score)<55||candidate?.email===recipientEvidence?.email)continue;
      addBlockRole(map,candidate.index,'recipient-candidate','邮箱候选');
    }
    if(subjectBlock>=0)addBlockRole(map,subjectBlock,'subject','主题');
    if(salutationBlock>=0)addBlockRole(map,salutationBlock,'salutation','称呼');
    const contentStart=salutationBlock>=0?salutationBlock:subjectBlock+1,contentEnd=closeInfo?closeInfo.startBlock:body.endBlock;
    for(let i=Math.max(0,contentStart);i<=Math.min(contentEnd,body.endBlock);i++){
      const raw=cleanBlockText(textOfBlock(blocks[i]));let substantive=true;
      if(i===salutationBlock&&salutInfo)substantive=!!cleanInlineMarkup(raw.slice(salutInfo.end)).trim();
      if(closeInfo&&i===closeInfo.startBlock)substantive=!!raw.slice(0,closeInfo.index).trim();
      if(substantive)addBlockRole(map,i,'body','正文');
    }
    if(closeInfo)for(let i=closeInfo.startBlock;i<=closeInfo.endBlock;i++)addBlockRole(map,i,'closing','结束语');
    for(const i of body.signatureBlocks||[])addBlockRole(map,i,'signature','署名');
    for(const i of body.postscriptBlocks||[])addBlockRole(map,i,'postscript','附言');
    for(const item of body.excludedBlocks||[])addBlockRole(map,item.index,'excluded',`已排除·${item.label||'非正文'}`,{field:item.field||'',sourceRole:item.role||''});
    return[...map.entries()].sort((a,b)=>a[0]-b[0]).map(([index,roles])=>({index,roles}));
  }

  function sanitizeRecognizedBody(value) {
    const raw=String(value??'').replace(/\r\n?/g,'\n').trim();
    if(!raw)return{text:'',excludedBlocks:[]};
    const blocks=raw.split(/\n{2,}/).map((text,index)=>({text,index})),closeInfo=findClosingSpan(blocks,0,blocks.length);
    if(closeInfo){
      const parts=[];
      for(let i=0;i<=closeInfo.endBlock;i++){
        let text=cleanBlockText(blocks[i].text);if(i===closeInfo.endBlock)text=text.slice(0,closeInfo.end);
        if(text)parts.push(cleanInlineMarkup(text));
      }
      const tail=appendPostClose(blocks,parts,closeInfo,blocks.length);
      return{text:parts.join('\n\n').replace(/\n{3,}/g,'\n\n').trim(),excludedBlocks:tail.excludedBlocks};
    }
    const parsed=bodyTextOpenEnded(blocks,0,blocks.length,null);
    return{text:parsed.text,excludedBlocks:parsed.excludedBlocks};
  }

  function mailDiscourseEvidence(value) {
    const text=cleanBlockText(value),recipientMentions=(text.match(/您|贵(?:课题组|团队|实验室|院系|校)|\byou(?:r)?\b/giu)||[]).length;
    const salutation=!!salutationAnchor(text);
    const directedPatterns=[
      /(?:冒昧|特此)?(?:来信|写信|致信|联系您|给您写信)|向您(?:咨询|申请)|希望(?:申请|加入|攻读|有机会加入|有机会在)|申请(?:博士|硕士|研究生|ph\.?d)|在您(?:的)?指导下|对您(?:的)?(?:研究|课题|方向|工作)|您的(?:研究|课题|论文|团队)|贵(?:课题组|团队|实验室|院系|校)/iu,
      /(?:感谢您(?:的)?(?:时间|阅读|考虑|回复)|期待(?:您的回复|与您交流|有机会|进一步交流)|盼复|敬候佳音|祝(?:您)?(?:工作顺利|一切顺利|身体健康))/iu,
      /\b(?:i\s+am\s+writing|i['’]?m\s+writing|writing\s+to\s+(?:express|ask|inquire)|interested\s+in\s+(?:pursuing|joining|working)|under\s+your\s+supervision|your\s+(?:research|work|group|lab)|thank\s+you\s+for\s+your|look(?:ing)?\s+forward\s+to)\b/iu
    ];
    const directed=directedPatterns.filter(re=>re.test(text)).length;
    const selfIntro=/(?:^|[。！？!?.\n])\s*(?:我(?:叫|是|目前|现为|本科|硕士|博士)|本人)|\bmy\s+name\s+is\b|\bi\s+am\s+(?:a|an|currently)\b/iu.test(text);
    const courtesy=/(?:感谢您|谢谢您|期待|盼复|敬候佳音|祝(?:您)?|thank\s+you|look(?:ing)?\s+forward)/iu.test(text);
    let score=0;if(salutation)score+=3;score+=Math.min(4,directed*2);if(recipientMentions>=2)score+=2;else if(recipientMentions===1)score+=1;if(selfIntro)score+=1;if(courtesy)score+=1;if(text.length>=100)score+=1;
    return{score,salutation,directed,recipientMentions,selfIntro,courtesy,strong:score>=8&&text.length>=80&&(salutation||recipientMentions>=2)&&directed>=1,moderate:score>=6&&text.length>=60&&(salutation||recipientMentions>=1)&&directed>=1};
  }

  function scoreFrame(frame) {
    let score=0;
    if (frame.subject) score+=30;
    if (frame.salutation) score+=24;
    if (frame.closing) score+=20;
    if (frame.body && frame.body.length>=80) score+=11;else if (frame.body) score+=5;
    if (frame.recipients) score+=15;
    if(frame.discourseEvidence?.strong)score+=26;else if(frame.discourseEvidence?.moderate)score+=16;
    if(frame.recipientAmbiguous)score-=12;
    return Math.max(0,Math.min(100,score));
  }

  function recognizeMailFrames(inputBlocks,{sourceFile='',minConfidence=55,includeWeak=true}={}) {
    const blocks=(inputBlocks||[]).map((b,index)=>({index,type:typeof b==='object'&&b?(b.type||'block'):'block',style:typeof b==='object'&&b?(b.style||''):'',text:cleanBlockText(textOfBlock(b))})).filter(b=>b.text);
    if (!blocks.length) return {records:[],stats:{blocks:0,subjects:0,salutations:0,closings:0,emails:0},blocks:[]};
    const subjectBlocks=[];
    for(let i=0;i<blocks.length;i++)if(subjectAnchor(blocks[i].text))subjectBlocks.push(i);
    const records=[],usedSalutations=new Set();let previousConsumedEnd=-1;

    const buildFrame=(subjectBlock,nextSubjectBlock,ordinal)=>{
      const subjectInfo=subjectAnchor(blocks[subjectBlock].text);
      let salutationBlock=-1,salutInfo=null;
      for(let i=subjectBlock;i<Math.min(nextSubjectBlock,subjectBlock+10);i++){const found=salutationAnchor(blocks[i].text);if(found){salutationBlock=i;salutInfo=found;break;}}
      let semanticBoundary=nextSubjectBlock;
      if(salutationBlock>=0)for(let i=salutationBlock+1;i<nextSubjectBlock;i++){if(salutationAnchor(blocks[i].text)){semanticBoundary=i;break;}}
      const closeInfo=findClosingSpan(blocks,salutationBlock>=0?salutationBlock:subjectBlock,semanticBoundary);
      let subject='',body={text:'',endBlock:subjectBlock,consumedEndBlock:subjectBlock,excludedBlocks:[],signatureBlocks:[],postscriptBlocks:[]};
      const issues=[];
      if(salutationBlock>=0){
        subject=subjectText(blocks,subjectBlock,salutationBlock,subjectInfo,salutInfo);
        if(closeInfo)body=bodyText(blocks,salutationBlock,closeInfo,nextSubjectBlock,salutInfo);else{body=bodyTextOpenEnded(blocks,salutationBlock,semanticBoundary,salutInfo);issues.push('未找到邮件落款');}
      }else{
        subject=collapseSubject(cleanBlockText(blocks[subjectBlock].text).slice(subjectInfo.index));
        if(closeInfo){body=bodyTextUntilClose(blocks,subjectBlock+1,closeInfo,nextSubjectBlock);issues.push('未找到邮件称呼');}else{body=bodyTextOpenEnded(blocks,subjectBlock+1,nextSubjectBlock,null);issues.push('未找到邮件称呼','未找到邮件落款');}
      }
      if((body.excludedBlocks||[]).some(item=>item.role==='ambiguous-tail'))issues.push('邮件落款后存在未归类内容，已从正文隔离');
      const contextStart=Math.max(0,previousConsumedEnd+1),recipientContext=nearestRecipientContext(blocks,contextStart,Math.max(subjectBlock,salutationBlock>=0?salutationBlock:subjectBlock),salutInfo?.text||'');
      const heading=headingContext(blocks,contextStart,subjectBlock),recipients=recipientContext.selected?.email||'',sidecar=sidecarFromExcluded(body.excludedBlocks||[]);
      const structure={subjectBlock,salutationBlock,bodyStartBlock:salutationBlock>=0?salutationBlock:subjectBlock+1,closeStartBlock:closeInfo?.startBlock??-1,closeEndBlock:closeInfo?.endBlock??-1,signatureStartBlock:(body.signatureBlocks||[])[0]??-1,signatureEndBlock:(body.signatureBlocks||[]).slice(-1)[0]??-1,mailStartBlock:subjectBlock,mailEndBlock:body.endBlock,consumedEndBlock:body.consumedEndBlock};
      const frame={id:deriveId(heading,ordinal),recipients,school:institutionFromHeading(heading?.text||''),subject,body:body.text,attachments:sidecar.attachments,scheduleAt:sidecar.scheduleAt,tags:'',sourceFile,salutation:salutInfo?.text||'',closing:closeInfo?.text||'',startBlock:subjectBlock,endBlock:body.endBlock,consumedEndBlock:body.consumedEndBlock,heading:heading?.text||'',excludedBlocks:[...(body.excludedBlocks||[])],sourceReferences:[...sidecar.sources],structure,recipientEvidence:recipientContext.selected||null,recipientAmbiguous:recipientContext.ambiguous,recipientCandidates:(recipientContext.candidates||[]).slice(0,8).map(c=>({email:c.email,index:c.index,score:c.score,text:c.text})),evidence:['subject',...(salutInfo?['salutation']:[]),...(closeInfo?['closing']:[]),...((body.signatureBlocks||[]).length?['signature']:[]),...(body.text.length>=80?['body']:[]),...(recipients?['recipient-email']:[]),...((body.excludedBlocks||[]).length?['tail-boundary']:[])],issues};
      frame.blockRoles=buildBlockRoles(blocks,{subjectBlock,salutationBlock,salutInfo,closeInfo,body,heading,recipientEvidence:recipientContext.selected,recipientCandidates:recipientContext.candidates});
      frame.discourseEvidence=mailDiscourseEvidence(`${frame.salutation||''}\n${frame.body||''}`);
      frame.confidence=scoreFrame(frame);
      if(recipientContext.ambiguous)frame.issues.push('收件人存在多个相近候选');
      if(!recipients)frame.issues.push('未定位收件人邮箱');
      if(!subject)frame.issues.push('主题为空');
      if(frame.body.length<40)frame.issues.push('正文过短');
      if(frame.confidence<70)frame.issues.push('邮件边界识别置信度较低');
      if(salutationBlock>=0)usedSalutations.add(salutationBlock);
      if(!salutInfo&&!closeInfo&&frame.body.length<80&&!recipients)return null;
      return frame;
    };

    for(let s=0;s<subjectBlocks.length;s++){
      const subjectBlock=subjectBlocks[s],nextSubjectBlock=subjectBlocks[s+1]??blocks.length,frame=buildFrame(subjectBlock,nextSubjectBlock,records.length+1);
      if(frame&&(includeWeak||frame.confidence>=minConfidence)){records.push(frame);previousConsumedEnd=Math.max(frame.consumedEndBlock??frame.endBlock,frame.endBlock);}
    }

    for(let i=0;i<blocks.length;i++){
      if(usedSalutations.has(i))continue;
      const salut=salutationAnchor(blocks[i].text);if(!salut)continue;
      const nextSubject=subjectBlocks.find(x=>x>i)??blocks.length;let fallbackBoundary=Math.min(nextSubject,i+80);
      for(let j=i+1;j<fallbackBoundary;j++){if(salutationAnchor(blocks[j].text)){fallbackBoundary=j;break;}}
      const closeInfo=findClosingSpan(blocks,i,fallbackBoundary);
      const body=closeInfo?bodyText(blocks,i,closeInfo,nextSubject,salut):bodyTextOpenEnded(blocks,i,fallbackBoundary,salut);
      const discourseEvidence=mailDiscourseEvidence(`${salut.text||''}\n${body.text||''}`);
      // A large share of real Chinese outreach mail ends with “感谢/期待回复/祝好” plus a name,
      // without a formal “此致敬礼”. Keep it as a mail frame only when recipient-directed discourse
      // is strong enough; a bare salutation in an essay or statement is not sufficient.
      if(!closeInfo&&!discourseEvidence.moderate)continue;
      const prevEnd=records.filter(r=>r.endBlock<i).sort((a,b)=>(b.consumedEndBlock??b.endBlock)-(a.consumedEndBlock??a.endBlock))[0]?.consumedEndBlock??-1;
      const rc=nearestRecipientContext(blocks,prevEnd+1,i,salut.text),heading=headingContext(blocks,prevEnd+1,i),sidecar=sidecarFromExcluded(body.excludedBlocks||[]);
      const structure={subjectBlock:-1,salutationBlock:i,bodyStartBlock:i,closeStartBlock:closeInfo?.startBlock??-1,closeEndBlock:closeInfo?.endBlock??-1,signatureStartBlock:(body.signatureBlocks||[])[0]??-1,signatureEndBlock:(body.signatureBlocks||[]).slice(-1)[0]??-1,mailStartBlock:i,mailEndBlock:body.endBlock,consumedEndBlock:body.consumedEndBlock};
      const frame={id:deriveId(heading,records.length+1),recipients:rc.selected?.email||'',school:institutionFromHeading(heading?.text||''),subject:'',body:body.text,attachments:sidecar.attachments,scheduleAt:sidecar.scheduleAt,tags:'',sourceFile,salutation:salut.text,closing:closeInfo?.text||'',startBlock:i,endBlock:body.endBlock,consumedEndBlock:body.consumedEndBlock,heading:heading?.text||'',recipientEvidence:rc.selected||null,recipientAmbiguous:rc.ambiguous,recipientCandidates:(rc.candidates||[]).slice(0,8).map(c=>({email:c.email,index:c.index,score:c.score,text:c.text})),excludedBlocks:[...(body.excludedBlocks||[])],sourceReferences:[...sidecar.sources],structure,discourseEvidence,evidence:['salutation',...(closeInfo?['closing']:['recipient-directed-discourse']),...((body.signatureBlocks||[]).length?['signature']:[]),...(body.text.length>=80?['body']:[]),...(rc.selected?['recipient-email']:[]),...((body.excludedBlocks||[]).length?['tail-boundary']:[])],issues:['未找到 Subject 标记',...(!closeInfo?['未找到标准邮件落款，已按收件人导向语篇保留']:[]),...((body.excludedBlocks||[]).some(item=>item.role==='ambiguous-tail')?['邮件落款后存在未归类内容，已从正文隔离']:[])]};
      frame.blockRoles=buildBlockRoles(blocks,{subjectBlock:-1,salutationBlock:i,salutInfo:salut,closeInfo,body,heading,recipientEvidence:rc.selected,recipientCandidates:rc.candidates});frame.confidence=scoreFrame(frame);
      if(rc.ambiguous)frame.issues.push('收件人存在多个相近候选');if(!frame.recipients)frame.issues.push('未定位收件人邮箱');if(frame.confidence<70)frame.issues.push('邮件边界识别置信度较低');
      if(includeWeak||frame.confidence>=minConfidence)records.push(frame);
    }

    records.sort((a,b)=>a.startBlock-b.startBlock);records.forEach((r,i)=>{if(!r.id)r.id=String(i+1);r.ordinal=i+1;});
    const stats={blocks:blocks.length,subjects:subjectBlocks.length,salutations:blocks.filter(b=>salutationAnchor(b.text)).length,closings:records.filter(r=>r.closing).length,emails:blocks.reduce((n,b)=>n+extractEmails(b.text).length,0),records:records.length,complete:records.filter(r=>r.recipients&&r.subject&&r.body).length,missingRecipients:records.filter(r=>!r.recipients).length,averageConfidence:records.length?Math.round(records.reduce((a,r)=>a+r.confidence,0)/records.length):0,excludedTailBlocks:records.reduce((count,record)=>count+(record.excludedBlocks||[]).length,0)};
    return{records,stats,blocks};
  }

  function recognizeMailText(text,options={}) {
    const blocks=String(text??'').replace(/\r\n?/g,'\n').split(/\n+/).map(t=>({type:'text-line',text:t}));
    return recognizeMailFrames(blocks,options);
  }

  function recordsToRows(records) {
    const headers=['编号','收件人','学校 / 机构','主题','正文','附件','定时时间','任务分类','来源文件'];
    return[headers,...(records||[]).map(r=>[r.id||'',r.recipients||'',r.school||'',r.subject||'',r.body||'',r.attachments||'',r.scheduleAt||'',r.tags||'',r.sourceFile||''])];
  }

  function rowMetaFromRecords(records) {
    const meta={};
    (records||[]).forEach((r,i)=>{meta[i+1]={confidence:r.confidence||0,evidence:[...(r.evidence||[])],issues:[...(r.issues||[])],heading:r.heading||'',school:r.school||'',sourceFile:r.sourceFile||'',salutation:r.salutation||'',closing:r.closing||'',startBlock:r.startBlock,endBlock:r.endBlock,consumedEndBlock:r.consumedEndBlock??r.endBlock,structure:{...(r.structure||{})},blockRoles:(r.blockRoles||[]).map(item=>({index:item.index,roles:(item.roles||[]).map(role=>({...role}))})),recipientEvidence:r.recipientEvidence?{email:r.recipientEvidence.email,index:r.recipientEvidence.index,score:r.recipientEvidence.score,text:r.recipientEvidence.text||''}:null,recipientAmbiguous:!!r.recipientAmbiguous,recipientCandidates:(r.recipientCandidates||[]).map(c=>({email:c.email,index:c.index,score:c.score,text:c.text||''})),excludedBlocks:(r.excludedBlocks||[]).map(item=>({...item})),sourceReferences:[...(r.sourceReferences||[])]};});
    return meta;
  }

  globalThis.NMDAMailRecognizer={EMAIL_RE,extractEmails,isNoiseBlock,subjectAnchor,salutationAnchor,closeAnchor,metadataAnchor,isLikelySignatureLine,classifyBoundaryBlock,mailDiscourseEvidence,sanitizeRecognizedBody,resolveRecipientContext:nearestRecipientContext,recognizeMailFrames,recognizeMailText,recordsToRows,rowMetaFromRecords,cleanInlineMarkup,institutionFromHeading};
})();
