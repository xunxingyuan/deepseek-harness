# Agent Note: Domain-bound Excel data routing

Status: implemented

English | [中文](2026-10-22-g1brain-excel-routing.zh.md)

## Problem

Converting every Excel sheet to vector documents loses structured-query semantics. Workbooks can also mix row records with explanations, so a workbook-wide routing decision can lose either data or context. Display-name equality does not establish that two ontology domains own the same table collection.

## Decision

The G1brain Host preflights explicitly selected files and separates regular data worksheets from document worksheets without editing sources. It owns a private service/tenant/ontology/domain mapping to one table-service collection. A source marker and stable collision suffix prevent accidental adoption of foreign collections. Table reads use a collection-bound read-only MCP endpoint; G1brain credentials are not forwarded. Ordinary Sessions retain their existing read-only G1brain discovery tools.

Upload intent is recorded exclusively before transmission. Accepted receipts suppress duplicate content uploads; unresolved intents block retries after uncertain network outcomes. The service offers neither upload idempotency nor a transactional upload receipt, so this favors operator reconciliation over duplicate imports. Table-only Sessions retain scoped document tools that reject unbound libraries, preventing fallback to globally visible document reads.

## Alternatives considered

**All-vector ingestion** retains explanations but cannot support exact SQL aggregation or reliable numeric precision. **Whole-workbook table ingestion** sends narrative sheets into table extraction and can require destructive column decisions. **Reuse by domain display name alone** can merge unrelated ontology scopes. **Automatic retry after timeout** can duplicate a write already accepted by the service. Each is excluded from automatic routing.

## Consequences

Mixed files need a vector library; pure structured files can omit it. Conservative classification sends ambiguous sheets to documents instead of guessing business fields. Local journals do not provide cross-device deduplication or production authorization. Import acceptance remains distinct from completion, and table imports do not automatically create ontology instances. Focused routing tests and the real Loader workflow cover mixed uploads, scoped SQL, and durable tool results; the built workflow also forbids resolving external SheetJS.
