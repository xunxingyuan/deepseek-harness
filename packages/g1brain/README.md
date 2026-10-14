---
description: "The G1brain package group: Host-side ontology and document integration for selecting assets and working in scoped Harness Sessions."
kind: "package-group"
---

# g1brain/ — ontology and document integration

English | [中文](README.zh.md)

## Summary

The `g1brain/` group connects the desktop workbench and Harness Sessions to G1brain ontology and document resources. Use its integration package to discover existing collections and libraries, search their contents, or work within a selected Session target. The browser interface is owned separately by the [G1brain workbench UI](../client/ui-g1brain/README.md).

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

The Host integration is the only package in this group; its README owns the backend and Session-tool behavior.

| Package | Role |
|---|---|
| [`integration/`](integration/README.md) | Provides G1brain catalogs, discovery and search tools, and selected-Session ontology/document operations |

<a id="related-documentation"></a>
## Related documentation

- [G1brain workbench UI](../client/ui-g1brain/README.md) — browser-side asset selection and Session preparation.
- [Desktop application](../../apps/desktop/README.md) — profile activation and packaged runtime behavior.

<a id="dev-note"></a>
## Dev Note

None.
