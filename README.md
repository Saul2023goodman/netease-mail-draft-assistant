# NetEase Mail Draft Assistant

Chrome MV3 workbench for preparing NetEase 163 mail drafts.

## Runtime model

Files, mailbox drafts, and historical mail enter one task pipeline: import → inspect → plan → create draft. Native NetEase Forward/Reply remains an execution mode for tasks imported from historical mail.

Business rules are policy data, not engine defaults. When a scheduling, identity, or follow-up rule has not been explicitly configured or supplied by source data, the core keeps it unset rather than inventing a value.

See `POLICY_BOUNDARIES.md` for the runtime boundary between capability, evidence, policy, and migration.
