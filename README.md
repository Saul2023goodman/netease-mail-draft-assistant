# NetEase Mail Draft Assistant

Chrome MV3 standalone outreach task workbench for NetEase 163 Mail.

## Product model

The product has one primary workflow:

**source intake → recognition → exception review → explicit scheduling → sequential draft execution**

A single email and a large batch use the same task model. Files, folders, pasted content, rosters, attachments and eligible historical messages are sources that feed the same pipeline.

Version 5 removes the old launcher/stage-machine UI. Clicking the Chrome extension action opens `app.html` directly; the app never renders a floating N launcher and never relies on “create launcher first, reveal panel later” bootstrap behavior.

The workbench does not automatically jump through stages. Import generates tasks, selection is a local state change, scheduling runs only when the user applies it, and execution runs only when the user starts it. One failed draft does not stop unrelated tasks; failures remain retryable.

Supporting capabilities stay contextual:

- roster data helps recognition, ordering and grouping;
- recipient history provides mailbox evidence and contact safeguards;
- historical sent mail can be added as a supplementary source;
- native NetEase Fw / Re is an execution mode for tasks created from historical mail;
- pause / stop controls are recipient-level safeguards, not a CRM workflow.

## Runtime structure

- `app.html`, `app.js`, `workbench.css` — standalone product workbench
- `import-core.js`, `import-adapters.js`, `importer.js` — source intake and classification
- `mail-recognizer.js` — mail field recognition
- `scheduler.js` — scheduling capability and validation
- `executor.js` — NetEase draft / native execution
- `contacts.js` — mailbox-derived recipient evidence
- `roster-v2.js` — roster evidence
- `history-source.js` — supplementary historical-mail source
- `runtime-defaults.js` — product defaults
- `preferences-store.js` — user overrides and learned aliases

Legacy storage keys and compatibility globals remain only where they preserve existing user settings or pending history-source records. They are not product navigation.

See `ARCHITECTURE.md` for the standalone-flow and module-boundary rules.
