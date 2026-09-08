# NetEase Mail Draft Assistant

Chrome MV3 outreach task workbench for NetEase 163 Mail.

## Product model

The product has one primary workflow:

**source intake → automatic recognition → exception review → scheduling → draft execution**

A single email and a large batch use the same task model. Files, folders, pasted content, rosters, attachments and eligible historical messages are all sources that feed the same pipeline.

The interface should optimize the primary task flow first. Supporting capabilities stay contextual:

- roster data helps recognition, ordering and grouping;
- recipient history provides mailbox evidence and duplicate / reply context;
- historical sent mail can be added as a supplementary source;
- native NetEase Fw / Re is an execution mode for tasks created from historical mail;
- pause / stop controls are recipient-level safeguards, not a CRM workflow.

Scheduling defaults, user preferences, learned aliases and legacy migration are internal execution support. They must not become top-level product navigation or dominate user-facing copy.

## Runtime structure

- `import-core.js`, `import-adapters.js`, `importer.js` — source intake and classification
- `mail-recognizer.js` — mail field recognition
- `app.js` — primary task workbench
- `scheduler.js` — scheduling capability and validation
- `executor.js` — NetEase draft / native execution
- `contacts.js` — mailbox-derived recipient evidence
- `roster-v2.js` — roster evidence
- `history-source.js` — supplementary historical-mail source
- `runtime-defaults.js` — product defaults
- `preferences-store.js` — user overrides and learned aliases
- `schedule-preferences.js` — scheduling preference presentation

Legacy storage keys and global aliases are retained where needed so upgrading from 4.0 does not discard existing settings or pending history-source execution records.

See `ARCHITECTURE.md` for product priority and module-boundary rules.
