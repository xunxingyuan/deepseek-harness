---
description: "Desktop G1brain entry panel for selecting ontology, document library, and source folder before opening a Harness Session."
kind: "package-reference"
---

# G1brain workbench UI

English | [中文](README.zh.md)

## Summary

The desktop profile opens this panel after sign-in. It diagrams connected ontology collections and document libraries, with counts and available display names. Its lines show category membership, not ontology relationships. A gallery shows the full catalog. Operators can start a new ontology or improve an existing one, then select a domain, document library, and local source folder. Selectors prefer display names but retain API names for binding. The folder becomes a Harness Workspace; the Session holds the work without a separate task record.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the package](#understand-the-package)
- [Further reading](#further-reading)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The panel reads existing resource names through the Host's G1brain service. Without API credentials, the overview shows unavailable resources and the new-ontology action still opens a form where names and a local folder can prepare a Session; improvement stays unavailable. The source folder can be selected with the native chooser or entered as an absolute local path; Workspace creation validates it. **Open Harness Session** creates a fresh Session, binds its exact selected targets and folder in the Host, and prepares a draft brief asking for source inventory and a proposal. The brief also instructs the agent to confirm MD slicing and chunk/index processing before claiming uploaded files are searchable. Opening a Session does not create an ontology, upload a file, or submit a task by itself. The sidebar G1brain entry returns to the panel from a Session.

The panel waits for the Session reference to be ready before preparing the draft and navigating. Failures preserve the form and distinguish directory access, Session creation, target binding, and draft initialization; retry after resolving the indicated step.

<a id="understand-the-package"></a>
## Understand the package

The panel implementation is in `src/client/G1brainHome.tsx`. Resource catalogs and Session binding come from the Host-side G1brain integration; the browser plugin does not hold the service token.

<a id="further-reading"></a>
## Further reading

- [G1brain Host integration](../../g1brain/integration/README.md)
- [Desktop setup](../../../apps/desktop/README.md)

<a id="model-experience"></a>
## Model Experience

### Prepared Session draft

#### What the model sees

The browser plugin registers no tools. A prepared draft becomes an ordinary user message only when the user submits it in the `Session`. It asks the model to follow the current request's language, including progress, questions, and the final result. The Host uses the durable binding to add scoped G1brain tools to that Session's agent; writes require explicit confirmation, with bounded same-tool approval reuse for creation and individual approval for other writes.

#### Token effect

No model tokens are used before submission. The submitted draft adds its own text to the request.

#### KV Cache effect

No cache change occurs before submission; the submitted text follows the existing request prefix.

## Known Limitations and Deferred Work

- Existing-resource selection requires a connected G1brain service. The local-development sign-in is not a verified user identity; development writes use the configured test identity.
- The target is fixed after entering the Session. Return to the panel and open a new Session to work with other resources.

<a id="dev-note"></a>
### Dev Note

None.
