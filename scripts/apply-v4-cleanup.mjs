import fs from 'node:fs';

function replaceExact(text, from, to, label) {
  if (!text.includes(from)) throw new Error(`missing cleanup target: ${label}`);
  return text.replace(from, to);
}

const app = fs.readFileSync('app.js', 'utf8');
const forbiddenApp = [
  'data-tab="followup"',
  'data-pane="followup"',
  'FOLLOWUP_SETTINGS_KEY',
  'function defaultFollowUpSettings',
  'executeNativeFollowUpRemotely',
  'nmda-contact-modal-followup',
  "Scheduler?.DEFAULT_RULES || { maxPerGroupPerRound:1",
  'scheduleIntervalDaysEl?.value||7',
  'scheduleMaxSchoolEl?.value||1'
];
for (const token of forbiddenApp) {
  if (app.includes(token)) throw new Error(`legacy source remains in app.js: ${token}`);
}

let unifier = fs.readFileSync('workflow-unifier.js', 'utf8');
unifier = replaceExact(unifier,
  "      blockHumanReply: value.blockHumanReply !== false,\n      blockAutoReply: value.blockAutoReply === true,\n      fwPrefix: String(value.fwPrefix ?? base.fwPrefix).trim() || 'Fw:',\n      rePrefix: String(value.rePrefix ?? base.rePrefix).trim() || 'Re:',",
  "      blockHumanReply: value.blockHumanReply == null ? !!base.blockHumanReply : value.blockHumanReply !== false,\n      blockAutoReply: value.blockAutoReply == null ? !!base.blockAutoReply : value.blockAutoReply === true,\n      fwPrefix: String(value.fwPrefix ?? base.fwPrefix ?? '').trim(),\n      rePrefix: String(value.rePrefix ?? base.rePrefix ?? '').trim(),",
  'follow-up normalization fallbacks');
unifier = replaceExact(unifier,
  "      fwPrefix: state.settings?.fwPrefix || 'Fw:',\n      rePrefix: state.settings?.rePrefix || 'Re:',",
  "      fwPrefix: state.settings?.fwPrefix,\n      rePrefix: state.settings?.rePrefix,",
  'follow-up form fallbacks');

if (/\|\| 'Fw:'|\|\| 'Re:'|blockHumanReply: value\.blockHumanReply !== false/.test(unifier)) {
  throw new Error('workflow-unifier.js still owns Follow-up defaults');
}
fs.writeFileSync('workflow-unifier.js', unifier);
console.log('v4 policy finalization applied');
