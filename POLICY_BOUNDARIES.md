# Policy boundaries

The runtime separates capability, product defaults, user overrides, evidence, and migration.

## Layers

1. `scheduler.js`, roster parsing, mailbox reading, and execution code provide capabilities and validation. They do not contain outreach-specific default values or institution-specific exceptions.
2. `default-policy.js` is the single source for product automation defaults. It may define useful default cadence and scheduling behavior, but it must contain no named school, past batch, user example, or historical case.
3. `policy-profile.js` resolves product defaults plus user overrides. It also migrates old preferences only when they differ from the current product defaults.
4. Institution aliases live in learned/user policy data. The shipped alias list is empty.

## Runtime behavior

A product default may be applied automatically. A user does not need to configure every rule before automation can run.

Source facts remain evidence. Strong evidence may fill a missing field, but similarity alone must not permanently rewrite identity. Exact identity, an explicit institution ID, or a learned alias may create durable institution equivalence.

Existing mailbox state and previously confirmed user decisions are safety constraints; preserving them is not a business recommendation.

## Comment rules

Production comments may explain technical invariants, browser compatibility, data-loss risks, or protocol behavior. They must not encode a particular user's workflow, a past batch, a named institution, a preferred weekday/time, or an illustrative threshold as an engine default.

Historical behavior belongs in migration notes or version history. Scenario-specific examples belong in tests or fixtures. Neither is a source of runtime policy.

## Institution identity

No institution-specific alias ships with the product. Cross-campus or alternate-name relationships may be learned from source data or user confirmation and persisted outside core code. High-confidence inference may be used within a batch as evidence, but it must not silently become a global alias.

## Scheduling

The engine itself is policy-neutral. The product default profile may enable institution grouping, cadence, non-working-day handling, or a generated start strategy. Users may override any of these without editing core code.
