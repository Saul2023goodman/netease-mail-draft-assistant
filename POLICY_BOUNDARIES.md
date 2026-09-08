# Policy boundaries

The runtime separates capability, evidence, policy, and migration.

## Runtime rules

- Core modules do not invent outreach cadence, time, institution aliases, reply thresholds, or other business choices when configuration is absent.
- A value extracted from a file or mailbox is evidence. It becomes a durable business decision only through an explicit source field, user decision, or saved policy.
- Similar names, substring matches, and email domains may produce candidates. They do not create institution identity by themselves.
- Existing remote state and previously confirmed user decisions are safety constraints; preserving them is not a business recommendation.
- Missing policy stays missing. UI placeholders and example values must not be promoted into runtime rules.

## Comment rules

Production comments may explain technical invariants, browser compatibility, data-loss risks, or protocol behavior. They must not encode a particular user's workflow, a past batch, a named institution, a preferred weekday/time, or an illustrative threshold as a default.

Historical behavior belongs in migration notes or version history. Scenario-specific examples belong in tests or fixtures. Neither is a source of runtime policy.

## Identity rules

Institution identity uses an explicit institution ID when available. Otherwise only an exact normalized identity or a saved alias may be treated as the same institution. Heuristic similarity remains evidence for review.

Alias profiles start empty. No institution-specific alias is shipped by the core.

## Scheduling rules

Scheduling starts with an empty policy. The engine requires an explicit start time before generating a new plan. Group limits, cadence, non-working-day handling, domain fallback, and institution grouping are disabled until explicitly configured or migrated from a saved user preference.
