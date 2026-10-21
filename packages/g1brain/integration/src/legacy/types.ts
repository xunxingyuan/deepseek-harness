/** Ontology creation or extension selected for one Session. */
export type TaskMode = 'new-ontology' | 'update-ontology'
/** Authentication mode of the G1brain REST client. */
export type G1BrainAuthMode = 'local-dev' | 'oauth'

/** REST endpoint and authentication settings retained by the Host. */
export interface G1BrainConfig {
  baseUrl: string
  authMode: G1BrainAuthMode
  clientId: string
  clientSecret: string
  tenantId: string
  publicKey: string
  timeoutMs: number
  localUserId: string
  localClientId: string
}

/** OAuth token and associated tenant identity. */
export interface AuthTokens {
  accessToken: string
  authMode?: G1BrainAuthMode
  refreshToken?: string
  tenantId: string
  expiresIn?: number
  issuedAt: number
  user?: Record<string, unknown>
}

/** Credentials submitted to the G1brain OAuth password exchange. */
export interface LoginInput {
  username: string
  password: string
  tenantId?: string
  type?: string
  captchaKey?: string
  captchaCode?: string
}

/** User-selected source and target details before a Session is created. */
export interface TaskSpec {
  mode: TaskMode
  folderPath: string
  documentLibraryName?: string
  createDocumentLibraryName?: string
  ontologyCollectionName?: string
  createOntologyCollectionName?: string
  domainName?: string
  createDomainName?: string
  agentPreset?: string
  instruction?: string
}

/** Validated G1brain targets attached to a Harness Session. */
export interface PreparedTask {
  mode: TaskMode
  folderPath: string
  documentLibraryName?: string
  createDocumentLibraryName?: string
  ontologyCollectionName?: string
  createOntologyCollectionName?: string
  createOntologyCollectionDisplayName?: string
  domainName?: string
  createDomainName?: string
  createDomainDisplayName?: string
  instruction: string
}

/** Launch receipt for the earlier task-oriented application. */
export interface HarnessTaskResult {
  workspaceId: string
  sessionId: string
  prompt: string
  harnessUrl: string
}

/** Common envelope returned by G1brain REST endpoints. */
export interface ApiEnvelope<T> {
  code?: number | string
  msg?: string
  message?: string
  data?: T
  [key: string]: unknown
}

/** Document library entry returned by G1brain. */
export interface DocumentLibrary {
  id?: string
  name: string
  [key: string]: unknown
}

/** G1brain document processing submission accepted by the MD service. */
export type DocumentTaskSubmission = {
  type: 'MD'
  operations: ['slice']
  mdIds: number[]
  mdType: 'simple'
  chunkMetadata: Record<string, never>
  chunkSize: 512
} | {
  type: 'CHUNK'
  operations: Array<'keywords' | 'vectorization' | 'indexCreate'>
  mdIds: number[]
  embeddingMetadata: Record<string, string>
  chunkMetadata: Record<string, string>
  extraContent: []
}

/** Ontology collection entry returned by G1brain. */
export interface OntologyCollection {
  id?: string
  name: string
  description?: string
  [key: string]: unknown
}

/** Ontology domain entry returned by G1brain. */
export interface OntologyDomain {
  name: string
  description?: string
  [key: string]: unknown
}

/** Input accepted by G1brain agent creation. */
export interface AgentInput {
  name: string
  description?: string | undefined
  prompt?: string | undefined
  promptTemplate?: string | undefined
  modelId?: string | undefined
  model?: string | undefined
  collection?: string | undefined
  ontology?: string | undefined
  docs?: string[] | unknown[] | undefined
  skills?: unknown[] | undefined
  mcp?: unknown[] | undefined
  capabilities?: unknown[] | undefined
  [key: string]: unknown
}

/** G1brain agent entry with optional attached resources. */
export interface AgentInfo {
  id?: string
  name: string
  description?: string
  prompt?: string
  promptTemplate?: string
  modelId?: string
  model?: string
  collection?: string
  ontology?: string
  docs?: string[] | unknown[]
  skills?: unknown[]
  mcp?: unknown[]
  capabilities?: unknown[]
  [key: string]: unknown
}

/** Canonical file entry inside the selected materials directory. */
export interface ScopeFile {
  relativePath: string
  absolutePath: string
  size: number
  extension: string
}

/** Text and optional JSON returned by an imported G1brain tool. */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: unknown
  isError?: boolean
}
