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
    identity: Object.freeze({
      aliases: Object.freeze([]),
      persistInferredAliases: false
    })
  });
})();
