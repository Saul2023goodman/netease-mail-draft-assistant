# NetEase Mail Draft Assistant

Chrome MV3 workbench for preparing NetEase 163 mail drafts.

## Runtime model

All outreach enters one task workbench. A single message and a large batch use the same task pipeline: source import → automatic recognition → exception review when needed → scheduling → draft execution.

Files, folders, pasted content, mailbox drafts, rosters, attachments, and eligible historical mail are sources. The importer determines their role. A roster is evidence for identity, duplicate checks, and scheduling; it is not a separate workflow. Sources that can be classified safely continue automatically, while only ambiguous sources interrupt the user.

Contacts are an evidence store rather than a top-level workbench. Sent, draft, and reply state comes from mailbox facts. The user-facing contact control is policy: allow contact, pause, or permanently stop. Contact facts and recent history are opened contextually from a recipient in the task list.

Historical follow-up is pending work, not a separate module. Only messages that currently satisfy the follow-up policy appear in Pending; importing one creates an ordinary task whose execution mode can preserve native NetEase Forward/Reply behavior.

Automation defaults are allowed, but they are isolated from core business logic. `default-policy.js` is the single source for product-level defaults; `policy-profile.js` adds user overrides and learned identity relationships; engines only execute the resolved policy.

No named institution alias, past batch, preferred weekday/time example, or historical workaround belongs in core code. Institution relationships are learned from evidence or explicit confirmation instead of being shipped as special cases.

See `POLICY_BOUNDARIES.md` for the boundary between capability, defaults, user policy, evidence, and migration.
