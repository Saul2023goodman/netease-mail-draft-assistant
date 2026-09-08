(() => {
  'use strict';

  const schedule = Object.freeze({
    startStrategy: 'next-hour',
    leadMinutes: 60,
    grouping: 'institution',
    maxPerGroupPerRound: 1,
    intervalDays: 7,
    preserveExisting: true,
    intraRoundMinutes: 10,
    skipHolidays: true,
    allowDomainFallback: false
  });

  const historySource = Object.freeze({
    mode: 'forward',
    minDays: 7,
    maxCount: 1,
    blockHumanReply: true,
    blockAutoReply: false,
    fwPrefix: 'Fw:',
    rePrefix: 'Re:',
    template: 'Dear {{name}},\n\nI am writing to follow up on my previous email regarding {{subject}}. I would be grateful if you had a chance to review it.\n\nBest regards,'
  });

  const identity = Object.freeze({
    aliases: Object.freeze([]),
    persistInferredAliases: false
  });

  const defaults = Object.freeze({
    version: 2,
    schedule,
    historySource,
    identity
  });

  globalThis.NMDARuntimeDefaults = defaults;

  // Compatibility for 4.0-era modules and persisted installations. New code should
  // consume NMDARuntimeDefaults and treat history mail as a source, not a feature area.
  globalThis.NMDADefaultPolicy = Object.freeze({
    version: defaults.version,
    schedule,
    historySource,
    followUp: historySource,
    identity
  });
})();
