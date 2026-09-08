# NetEase Mail Draft Assistant

Chrome MV3 workbench for preparing NetEase 163 mail drafts.

## Runtime model

Files, mailbox drafts, and historical mail enter one task pipeline: import → inspect → plan → create draft. Native NetEase Forward/Reply remains an execution mode for tasks imported from historical mail.

Automation defaults are allowed, but they are isolated from core business logic. `default-policy.js` is the single source for product-level defaults; `policy-profile.js` adds user overrides and learned identity relationships; engines only execute the resolved policy.

No named institution alias, past batch, preferred weekday/time example, or historical workaround belongs in core code. Institution relationships are learned from evidence or explicit confirmation instead of being shipped as special cases.

See `POLICY_BOUNDARIES.md` for the boundary between capability, defaults, user policy, evidence, and migration.
