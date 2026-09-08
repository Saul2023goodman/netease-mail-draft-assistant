# Product architecture

## Product center

The product is a standalone outreach task workbench. The only primary business object is a task.

Every task follows one visible pipeline:

1. source intake
2. recognition and inline source correction when necessary
3. exception review
4. scheduling
5. draft execution in NetEase Mail
6. mailbox evidence refresh

A single email and a large batch use the same pipeline. Features must not create parallel workflows when they can enter this task model as a source, preference, evidence record, or execution mode.

## Standalone UI rule

`app.html` is the only product workspace opened by the extension action. There is **no floating launcher**, no in-page launcher button, and no launcher-first bootstrap that later attempts to reveal the real panel.

The standalone workbench constructs its panel directly. Removing a supporting surface must never prevent the core workbench from appearing.

Flow transitions happen only after an **explicit user action** or the direct completion of the operation the user just started. Import may populate task data, but it must not automatically navigate through review, scheduling, or execution. There is no hidden stage machine and no perpetual connection polling.

A normal selection change is a local state update. It must not reparse all source files, rebuild the whole import model, or restart unrelated async work.

## Priority model

### Primary — always visible and optimized first

- file / folder / pasted source intake
- recipient, subject, body and attachment recognition
- exception review and direct correction
- roster-assisted ordering and grouping when roster evidence exists
- explicit scheduling and preservation of existing schedules
- sequential draft creation with per-task progress and retry
- NetEase connection, authentication and execution reliability

### Supporting — contextual, not top-level

- roster details and identity evidence
- recipient history and mailbox-derived contact state
- historical sent-mail intake
- native Fw / Re execution for tasks created from historical mail
- manual contact pause / stop controls

Supporting capabilities should appear only where they help the current task. They must not become independent workbenches or participate in the startup critical path.

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

## Scheduling rule

Scheduling defaults and user choices are execution preferences, not a policy screen. The workbench reads the current controls only when the user clicks the schedule action, then the scheduler validates and builds a plan. Selection or import must not silently recompute schedules.

No named institution, historical batch, user example or one-off workaround may be shipped as core logic.

## Execution rule

Draft creation is sequential and task-local. One failed draft must not stall the batch. Completed tasks retain their completed state; failed tasks remain retryable after the current run. A stop request finishes the current task and then stops cleanly.

Authentication failure does not start a wait loop. The workbench opens NetEase Mail, asks the user to finish login, and returns control immediately.

## Change test

Before adding a new feature, ask in order:

1. Can it be represented as another task source?
2. Can it be represented as evidence attached to a task or recipient?
3. Can it be represented as an execution preference?
4. Can it be represented as an execution mode?

Only if all four answers are no should a new top-level workflow be considered.
