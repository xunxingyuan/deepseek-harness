---
description: "Host-side G1brain catalogs and Session-scoped ontology and document tools for the desktop workbench."
kind: "package-reference"
---

# G1brain integration

English | [中文](README.zh.md)

## Summary

The desktop profile enables this Host plugin by default. It exposes ontology-collection, domain, and document-library catalogs to the workbench. Catalog responses preserve API names and optional display names; the workbench shows the friendly name first while Session bindings retain the API name. Any ordinary Desktop Session can use 16 read-only discovery and search tools. A newly prepared G1brain Session is bound to the selected folder, ontology collection and domain, and document library before its agent receives the full 46 ontology and document tools. The access token remains in the Host process.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the package](#understand-the-package)
- [Further reading](#further-reading)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

A local-development Desktop or explicitly marked unsigned test installer supplies `G1BRAIN_BASE_URL` (`http://192.168.100.113:19091`), `G1BRAIN_LOCAL_USER_ID` (`developer`), `G1BRAIN_LOCAL_CLIENT_ID` (`g1brain-web`), `G1BRAIN_ALLOW_LOCAL_DEV=1`, and `G1BRAIN_ALLOW_DEV_WRITES=1` unless overridden by environment values. The Host sends the earlier client's `X-User-Id` and `X-Client-Id` headers; this test identity is unrelated to the entered login name. Development writes are enabled in these development and unsigned-test profiles and do not represent the signed-in user's authorization. Other deployments must configure their own service address and authorization. In OAuth mode, set `G1BRAIN_ACCESS_TOKEN` and `G1BRAIN_CLIENT_SECRET` (and optionally `G1BRAIN_CLIENT_ID`); the Host sends Basic authorization and `Blade-Auth`. `G1BRAIN_TENANT_ID` defaults to `000000`. With no applicable credentials the plugin remains active but reports `configured: false`; catalog calls fail explicitly. The desktop sign-in does not yet transfer its identity or OAuth token to this Host service.

The workbench calls `bindSession` for a new top-level Session. The Host verifies that the selected folder is that Session's workspace and saves the exact target in a private, owner-only binding file. It installs the 46 tools only in that agent's scope and reloads the binding when attaching a resumed agent. Tool execution rechecks the Session, target, original input schema, and folder scope. Mutations require `confirm=true`. The first call to one of seven additive creation tools asks the user to approve that same tool for the bound Session; the in-memory grant covers at most 100 calls within 30 minutes and disappears on Host restart. Another creation tool asks separately. Updates, deletes, uploads, document-task submission/cancellation, and package imports still need one approval per call. Uploads additionally require an explicit file list and preflight every path. The five legacy agent-management tools are intentionally excluded.

Document processing follows the G1brain Web application's MD API: after upload, submit an `MD` slicing task, confirm it succeeded, then submit a `CHUNK` task for any selected keyword, vectorization, and index operations. The submission tool accepts either all current files in the bound library or explicit document IDs verified against that library. Seven task tools cover submission, current/history lists, detail, per-file status, bounded waiting, and cancellation. List and detail results are summarized so a large task does not flood the model context.

Binding storage checks private directory permissions on POSIX; Windows relies on the current user's profile ACL instead of synthetic POSIX mode bits. Folder matching uses the platform's path comparison, including Windows drive-letter case. A resumed agent fails initialization if its binding or source folder cannot be loaded, rather than silently falling back to read-only tools.

Ordinary unbound Sessions can list ontology collections, domains, taxonomy nodes, properties, relation definitions and types, entities and relation edges. They can also list documents and use hybrid, QA, chunk-location, and chunk-list queries. Only these named read tools are global; tool inputs are validated and returned text is capped at 32 KiB with a truncation notice. They use the Host's configured G1brain identity, not an independently verified identity from the Desktop sign-in.

<a id="understand-the-package"></a>
## Understand the package

The Host plugin owns service credentials, resource catalogs, durable Session binding, and per-call authorization. The Client UI uses its catalog and binding methods; ordinary Sessions receive only the global read tools.

<a id="further-reading"></a>
## Further reading

- [G1brain workbench UI](../../client/ui-g1brain/README.md)
- [Desktop setup](../../../apps/desktop/README.md)

<a id="model-experience"></a>
## Model Experience

### Workflow guidance

#### What the model sees

The fixed `g1brain:workflow` system section adds the following text. The [recorded system prompt](../../../snapshots/session/g1brain-session-guidance/system-prompt.expected.md) verifies its placement.

##### Workflow instruction

```markdown
## G1brain workflow

Reply in the language of the current user request, including progress updates, clarification questions, and the final result. Use Simplified Chinese for Chinese requests unless the user explicitly asks for another language.

Use the available G1brain tools for ontology and document operations. Ordinary Sessions provide discovery and search; creation and updates require a G1brain build or improvement Session prepared with the selected ontology, domain, document library, and source folder.

If write tools are absent, explain that this Session is read-only and direct the user to prepare a G1brain build or improvement Session. Do not interpret missing write tools as missing API credentials or ask the user to install another plugin.

In a prepared Session, inspect the sources, propose a plan, and use the bound G1brain tools after the user approves the plan. Tool approval remains required for writes.
```

#### Token effect

The configured integration adds this fixed section to each agent request, independent of catalog size.

#### KV Cache effect

The section stays constant across ordinary and prepared Sessions. Its text changes the system prefix when the integration is updated or enabled.

### Catalog and bound-Session tools

#### What the model sees

With API credentials configured, every agent sees 16 read-only tools for G1brain resource discovery and document search, including `g1brain_list_ontology_domains` and `g1brain_hybrid_search`. The two global top-level catalog tools return names only; other global reads return bounded text. A bound Session sees 46 scoped tools for selected files, document libraries, document processing tasks, search, ontology entities, relations, properties, relation types, and package validation/import. Its catalog tools can return full backend records. Unbound Sessions do not see those scoped tools. If writes are disabled, the mutating subset is omitted. Results use ordinary text rendering in the conversation.

#### Token effect

Each visible tool adds its fixed definition to the request. Ordinary Sessions now carry 16 G1brain read definitions; bound Sessions have a materially larger prefix. Returned data adds result text after a call, capped for global reads.

#### KV Cache effect

The definitions are stable within one ordinary or bound Session; binding a Session or changing the write policy changes its prompt prefix.

## Known Limitations and Deferred Work

- Local-development sign-in does not verify identity or authorize backend writes. The `developer` test identity is shared; use the development server only, and rely on the per-call approval to avoid accidental changes.
- A repeated-creation grant is specific to one tool and bound Session, but the Host cannot infer whether each model-generated record matches a separately reviewed plan. Review the first approval scope and stop the run if later generated content diverges.
- Submitting a document task schedules server-side processing; it does not make search immediately available. Confirm `SUCCESS` through the detail or wait tool before treating chunks or indexes as ready. The task APIs are based on the current G1brain Web client; this integration does not expose task deletion or cleanup.
- A bound Session is fixed to its selected target; changing resources requires a new Session. Global discovery and search tools can query any collection visible to the configured Host identity but cannot mutate data.
- Environment-based OAuth credentials are not isolated from other Host plugins or future subprocesses; use development credentials only until a dedicated credential handoff is implemented.

<a id="dev-note"></a>
### Dev Note

None.
