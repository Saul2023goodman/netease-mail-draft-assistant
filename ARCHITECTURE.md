# Product architecture

## Product center

The product is an outreach task workbench. The only primary business object is a task.

Every task follows one pipeline:

1. source intake
2. automatic recognition
3. exception review only when required
4. scheduling
5. draft execution in NetEase Mail
6. mailbox evidence refresh

A single email and a large batch use the same pipeline. Features must not create parallel workflows when they can enter this task model as a source, preference, evidence record, or execution mode.

## Priority model

### Primary — always visible and optimized first

- file / folder / pasted source intake
- recipient, subject, body and attachment recognition
- exception review and correction
- roster-assisted ordering and grouping when roster evidence exists
- scheduling and preservation of existing schedules
- draft creation / execution and progress feedback
- NetEase connection, authentication and execution reliability

### Supporting — contextual, not top-level

- roster details and identity evidence
- recipient history and mailbox-derived contact state
- historical sent-mail intake
- native Fw / Re execution for tasks created from historical mail
- manual contact pause / stop controls

Supporting capabilities should appear only where they help the current task. They must not become independent workbenches.

### Internal constraints — never product navigation

- runtime defaults
- user scheduling preferences
- learned institution aliases
- migration of legacy settings
- compatibility storage keys and aliases

These exist to make the primary flow safer and more automatic. They do not define the product.

## Historical mail rule

Historical mail is a supplementary source. It is not a separate Follow-up module.

The UI may surface eligible historical messages from mailbox evidence and let the user add them to the current task batch. Fw / Re / new-message choice, waiting thresholds, reply blocking and template changes are advanced options and stay collapsed by default.

Existing storage keys may retain legacy `followup` names for upgrade compatibility. New user-facing copy and new module names should use `history source` semantics.

## Preference rule

Scheduling defaults and user choices are preferences around execution, not policy screens. The scheduler validates and executes the resolved rules; preferences only supply defaults and explicit user overrides.

No named institution, historical batch, user example or one-off workaround may be shipped as core logic.

## Change test

Before adding a new feature, ask in order:

1. Can it be represented as another task source?
2. Can it be represented as evidence attached to a task or recipient?
3. Can it be represented as an execution preference?
4. Can it be represented as an execution mode?

Only if all four answers are no should a new top-level workflow be considered.
