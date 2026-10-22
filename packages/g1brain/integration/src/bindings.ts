/** Durable, fail-closed G1brain target bindings keyed by Harness Session id. */
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { G1brainSessionTarget } from './types.ts'
import { isSystemDomain, resourceName } from './names.ts'

interface BindingSession {
  readonly id: SessionId
  readonly header: { readonly cwd?: string; readonly parentSession?: SessionId }
}

interface BindingRecord {
  readonly version: 1
  readonly sessionId: SessionId
  readonly target: G1brainSessionTarget
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function name(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined
  const clean = value.trim()
  if (!clean) throw new Error(`G1brain ${field} must not be blank`)
  return clean
}

function targetOf(value: G1brainSessionTarget): G1brainSessionTarget {
  if (!isAbsolute(value.folderPath) || value.folderPath.includes('\0')) {
    throw new Error('G1brain materials directory must be an absolute local path')
  }
  const ontologyCollectionName = name(value.ontologyCollectionName, 'ontologyCollectionName')
  const createOntologyCollectionName = name(value.createOntologyCollectionName, 'createOntologyCollectionName')
  const documentLibraryName = name(value.documentLibraryName, 'documentLibraryName')
  const createDocumentLibraryName = name(value.createDocumentLibraryName, 'createDocumentLibraryName')
  const domainName = name(value.domainName, 'domainName')
  const createDomainName = name(value.createDomainName, 'createDomainName')
  const createOntologyCollectionDisplayName = name(value.createOntologyCollectionDisplayName, 'createOntologyCollectionDisplayName')
  const createDomainDisplayName = name(value.createDomainDisplayName, 'createDomainDisplayName')
  if ((createOntologyCollectionDisplayName && !createOntologyCollectionName) || (createDomainDisplayName && !createDomainName)) {
    throw new Error('G1brain display names require a new resource target')
  }
  if ((value.mode === 'new-ontology' && (!createOntologyCollectionName || ontologyCollectionName))
    || (value.mode === 'update-ontology' && (!ontologyCollectionName || createOntologyCollectionName))) {
    throw new Error('G1brain ontology target does not match the selected mode')
  }
  if (documentLibraryName && createDocumentLibraryName) {
    throw new Error('Select at most one existing or new G1brain document library')
  }
  if ((value.mode === 'new-ontology' && (!createDomainName || domainName))
    || (value.mode === 'update-ontology' && (!domainName || createDomainName))) {
    throw new Error('G1brain domain target does not match the selected mode')
  }
  return {
    mode: value.mode,
    folderPath: value.folderPath,
    ...(ontologyCollectionName === undefined ? {} : { ontologyCollectionName }),
    ...(createOntologyCollectionName === undefined ? {} : { createOntologyCollectionName }),
    ...(documentLibraryName === undefined ? {} : { documentLibraryName }),
    ...(createDocumentLibraryName === undefined ? {} : { createDocumentLibraryName }),
    ...(domainName === undefined ? {} : { domainName }),
    ...(createDomainName === undefined ? {} : { createDomainName }),
    ...(createOntologyCollectionDisplayName === undefined ? {} : { createOntologyCollectionDisplayName }),
    ...(createDomainDisplayName === undefined ? {} : { createDomainDisplayName }),
  }
}

function recordOf(value: unknown, sessionId: SessionId): BindingRecord {
  if (!isRecord(value) || value.version !== 1 || value.sessionId !== sessionId || !isRecord(value.target)) {
    throw new Error('Invalid saved G1brain Session binding')
  }
  const target = value.target
  if ((target.mode !== 'new-ontology' && target.mode !== 'update-ontology') || typeof target.folderPath !== 'string') {
    throw new Error('Invalid saved G1brain Session target')
  }
  for (const key of ['ontologyCollectionName', 'createOntologyCollectionName', 'documentLibraryName',
    'createDocumentLibraryName', 'domainName', 'createDomainName', 'createOntologyCollectionDisplayName', 'createDomainDisplayName']) {
    if (target[key] !== undefined && typeof target[key] !== 'string') throw new Error(`Invalid saved G1brain ${key}`)
  }
  const parsed: G1brainSessionTarget = {
    mode: target.mode,
    folderPath: target.folderPath,
    ...(typeof target.ontologyCollectionName === 'string' ? { ontologyCollectionName: target.ontologyCollectionName } : {}),
    ...(typeof target.createOntologyCollectionName === 'string' ? { createOntologyCollectionName: target.createOntologyCollectionName } : {}),
    ...(typeof target.documentLibraryName === 'string' ? { documentLibraryName: target.documentLibraryName } : {}),
    ...(typeof target.createDocumentLibraryName === 'string' ? { createDocumentLibraryName: target.createDocumentLibraryName } : {}),
    ...(typeof target.domainName === 'string' ? { domainName: target.domainName } : {}),
    ...(typeof target.createDomainName === 'string' ? { createDomainName: target.createDomainName } : {}),
    ...(typeof target.createOntologyCollectionDisplayName === 'string' ? { createOntologyCollectionDisplayName: target.createOntologyCollectionDisplayName } : {}),
    ...(typeof target.createDomainDisplayName === 'string' ? { createDomainDisplayName: target.createDomainDisplayName } : {}),
  }
  return { version: 1, sessionId, target: targetOf(parsed) }
}

async function canonicalDirectory(session: BindingSession): Promise<string> {
  if (!session.header.cwd) throw new Error('G1brain Session has no materials directory')
  const path = await realpath(session.header.cwd)
  if (!(await stat(path)).isDirectory()) throw new Error('G1brain Session materials path is not a directory')
  return path
}

class BindingStore {
  constructor(private readonly directory: string) {}

  private path(sessionId: SessionId): string {
    const hash = createHash('sha256').update(sessionId).digest('hex')
    return join(this.directory, `${hash}.json`)
  }

  async bind(session: BindingSession, input: G1brainSessionTarget): Promise<G1brainSessionTarget> {
    if (session.header.parentSession !== undefined) throw new Error('Bind the top-level Harness Session, not a child')
    const folderPath = await canonicalDirectory(session)
    if (relative(folderPath, await realpath(input.folderPath)) !== '') throw new Error('Selected directory differs from the Session Workspace')
    const selected = targetOf({ ...input, folderPath })
    if (selected.domainName && isSystemDomain(selected.domainName)) throw new Error('G1brain system domains cannot be selected for improvement')
    const target = targetOf({ ...selected,
      ...(selected.createOntologyCollectionName === undefined ? {} : {
        createOntologyCollectionName: resourceName(selected.createOntologyCollectionName, 'col', session.id),
        createOntologyCollectionDisplayName: selected.createOntologyCollectionDisplayName ?? selected.createOntologyCollectionName,
      }),
      ...(selected.createDomainName === undefined ? {} : {
        createDomainName: resourceName(selected.createDomainName, 'dom', session.id),
        createDomainDisplayName: selected.createDomainDisplayName ?? selected.createDomainName,
      }),
    })
    const record: BindingRecord = { version: 1, sessionId: session.id, target }
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const info = await lstat(this.directory)
    // Windows protection comes from the user's profile ACL; stat.mode does not describe its access rules.
    if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
      throw new Error('G1brain binding directory is not private')
    }
    const file = this.path(session.id)
    try {
      await writeFile(file, JSON.stringify(record), { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if (!isRecord(error) || error.code !== 'EEXIST') throw error
      const existing = await this.load(session)
      if (existing === undefined || JSON.stringify(existing) !== JSON.stringify(target)) {
        throw new Error('G1brain Session is already bound to a different target')
      }
    }
    return target
  }

  async load(session: BindingSession): Promise<G1brainSessionTarget | undefined> {
    const file = this.path(session.id)
    let info: Awaited<ReturnType<typeof lstat>>
    try {
      info = await lstat(file)
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') return undefined
      throw error
    }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('G1brain binding file is not a regular file')
    const text = await readFile(file, 'utf8')
    const value: unknown = JSON.parse(text)
    const record = recordOf(value, session.id)
    if (relative(record.target.folderPath, await canonicalDirectory(session)) !== '') {
      throw new Error('Saved G1brain target differs from the Session Workspace')
    }
    return record.target
  }
}

/** Create the private Session-target store used by the G1brain Host plugin.
 * @param directory - owner-private directory for binding records.
 * @returns store that refuses rebinding and validates Workspace paths on read.
 */
export function createBindingStore(directory: string): BindingStore {
  return new BindingStore(directory)
}
