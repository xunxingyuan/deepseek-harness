# Agent Note: Desktop-owned G1brain connections and sign-out

Status: implemented

English | [中文](2026-10-22-g1brain-desktop-connections.zh.md)

## Problem

Environment-only service addresses prevent operators from selecting another G1brain deployment in the installed client. Hiding a workspace is not sign-out: its document and Host can retain credentials and continue work. Merely changing an address in the renderer leaves existing plugin clients on their previous service.

## Decision

Welcome owns a progressively disclosed connection form, consistent with the cognitive-load and familiar-navigation guidance in [Laws of UX](https://lawsofux.com/). The native main process validates and atomically saves service URLs without credentials. Saved choices override environment addresses; an explicitly blank table URL disables its integration. Only the current Welcome top frame can edit these preferences.

Connection saves and sign-out are serialized with login. Applying settings replaces the Host, rather than editing a running client's environment. Native sign-out asks about interruption, forgets process-local authentication, destroys the old workspace document, and replaces the Host before another login. Login generations prevent delayed OAuth responses from restoring signed-out credentials. Session data and model settings are not deleted or migrated between service targets.

## Alternatives considered

**Environment variables alone** do not serve installed-client users. **Renderer-owned credentials or connection writes** give product documents authority beyond the requested sign-out action. **Hide and reopen without replacing the Host** preserves old clients and in-memory identity. **Restart the whole application for each edit** adds unnecessary navigation when the shell can replace its child safely.

## Consequences

The settings file is application-local, not a Session record or a credential store. A syntactically valid address need not identify an available service. The shared development identity and environment-based production credentials retain their existing authorization limitations; local sign-out is not remote token revocation. Persisted Session target names do not change when service addresses change. Window/IPC tests cover ownership, cancellation, address propagation, stale-renderer rejection, and signing in again; preference tests verify real file persistence, version checks, and explicit table disabling.
