(() => {
  'use strict';

  globalThis.NMDADefaultPolicy = Object.freeze({
    version: 1,
    schedule: Object.freeze({
      startStrategy: 'next-hour',
      leadMinutes: 60,
      grouping: 'institution',
      maxPerGroupPerRound: 1,
      intervalDays: 7,
      preserveExisting: true,
      intraRoundMinutes: 10,
      skipHolidays: true,
      allowDomainFallback: false
    }),
    followUp: Object.freeze({
      mode: 'forward',
      minDays: 7,
      maxCount: 1,
      blockHumanReply: true,
      blockAutoReply: false,
      fwPrefix: 'Fw:',
      rePrefix: 'Re:',
      template: 'Dear {{name}},\n\nI am writing to follow up on my previous email regarding {{subject}}. I would be grateful if you had a chance to review it.\n\nBest regards,'
    }),
    identity: Object.freeze({
      aliases: Object.freeze([]),
      persistInferredAliases: false
    })
  });
})();
