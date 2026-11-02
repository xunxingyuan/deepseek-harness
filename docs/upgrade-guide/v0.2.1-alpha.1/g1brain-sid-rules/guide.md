---
kind: upgrade-guide
description: G1brain fine-grained creation rejects unsafe new SIDs and edge creation requires an existing relation SID.
---

# G1brain SID rules

English | [中文](guide.zh.md)

## Change

G1brain class, instance, property and relation-type creation previously accepted arbitrary nonblank SIDs. These creation calls now require `^[A-Za-z][A-Za-z0-9_]*$`. Relation edge creation requires an exact SID from the effective relation definitions and uses its display name as the edge label, matching the Web editor. Missing definitions, ambiguous labels and labels containing dots or control characters reject before writing. Relationship creation never retries with an alternate label.

## Migration

1. Update scripts and creation prompts to use identifiers such as `Instrument` and `belongs_to_unit`, without collection/domain prefixes. Store Chinese names in `displayName`.
2. Keep existing entity, property and relation SIDs unchanged in reads, updates and references. Do not strip dots or rename stored identifiers. For relationships, query `g1brain_list_ontology_relation_definitions` and pass the exact SID as `relationSid`, not a display name.
3. Resolve conflicting relation display names or unusable labels before creating edges. Verify the created edge through `g1brain_get_ontology_relations`.

No saved binding or existing graph is automatically migrated. Package artifact IDs continue to use the server's package schema; this change does not rewrite them.
