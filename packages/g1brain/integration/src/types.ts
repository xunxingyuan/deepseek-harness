import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Collection entry retaining its API name and optional user-facing label. */
export interface G1brainCatalogItem {
  /** Stable collection, domain, or library name used in API calls and Session bindings. */
  readonly name: string
  /** Friendly display name, when G1brain supplies one. */
  readonly displayName?: string
}

/** Connection state deliberately excludes credentials. */
export interface G1brainStatus {
  /** Whether URL and mode-specific Host request credentials are present. */
  readonly configured: boolean
  /** Authorization mode used for catalog requests. Local development does not authenticate the entered password. */
  readonly mode: 'local-dev' | 'oauth'
}

/** Source directory and G1brain targets approved for one Harness Session. */
export interface G1brainSessionTarget {
  /** New ontology creation or extension of an existing collection. */
  readonly mode: 'new-ontology' | 'update-ontology'
  /** Absolute local materials directory selected by the user. */
  readonly folderPath: string
  /** Existing ontology collection for update mode. */
  readonly ontologyCollectionName?: string
  /** Collection name to create in new mode. */
  readonly createOntologyCollectionName?: string
  /** User-facing name saved separately from the new collection's API identifier. */
  readonly createOntologyCollectionDisplayName?: string
  /** Existing document library. */
  readonly documentLibraryName?: string
  /** Document library name to create. */
  readonly createDocumentLibraryName?: string
  /** Existing ontology domain, when selected. */
  readonly domainName?: string
  /** Domain name to create, when selected. */
  readonly createDomainName?: string
  /** User-facing name saved in the new domain's configuration. */
  readonly createDomainDisplayName?: string
}

/** Browser request binding a newly created Harness Session to G1brain targets. */
export interface G1brainBindRequest {
  readonly sessionId: SessionId
  readonly target: G1brainSessionTarget
}

/** Confirmation that a Session target binding was persisted. */
export interface G1brainBindReceipt {
  readonly sessionId: SessionId
  readonly bound: true
  /** Canonical identifiers and display names persisted by the Host. */
  readonly target: G1brainSessionTarget
}
