/** Root-scoped G1brain landing page. Selections prepare a Harness Session draft only. */
import { useEffect, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { G1brainCatalogItem, G1brainSessionTarget } from '@deepseek-ai/dsh-g1brain-integration/types'
import css from './G1brainHome.module.css'

type Catalog = {
  readonly configured: boolean
  readonly mode: 'local-dev' | 'oauth'
  readonly ontologies: readonly G1brainCatalogItem[]
  readonly libraries: readonly G1brainCatalogItem[]
  readonly error?: boolean
}

function catalogLabel(item: G1brainCatalogItem): string {
  const label = item.displayName?.trim()
  return label && label !== item.name ? `${label}（${item.name}）` : item.name
}

function catalogDisplayName(item: G1brainCatalogItem): string {
  return item.displayName?.trim() || item.name
}

type AssetKind = 'ontology' | 'library'

function AssetGlyph({ kind }: { readonly kind: AssetKind }) {
  return kind === 'ontology'
    ? <svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M24 24 10 11m14 13 14-13M24 24 10 37m14-13 14 13" stroke="currentColor" strokeWidth="2" /><circle cx="24" cy="24" r="5" fill="currentColor" /><circle cx="10" cy="11" r="4" fill="currentColor" /><circle cx="38" cy="11" r="4" fill="currentColor" /><circle cx="10" cy="37" r="4" fill="currentColor" /><circle cx="38" cy="37" r="4" fill="currentColor" /></svg>
    : <svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M10 10h20l8 8v24H10V10Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /><path d="M30 10v8h8M16 25h16M16 31h16M16 37h11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
}

const mapPositions = [
  { x: 25, y: 22, className: css.mapNodeTopLeft },
  { x: 75, y: 22, className: css.mapNodeTopRight },
  { x: 25, y: 78, className: css.mapNodeBottomLeft },
  { x: 75, y: 78, className: css.mapNodeBottomRight },
] as const

function CatalogDiagram({ items, kind, expanded, action, hub, onSelect }: {
  readonly items: readonly G1brainCatalogItem[]
  readonly kind: AssetKind
  readonly expanded: boolean
  readonly action: string
  readonly hub: string
  readonly onSelect: (item: G1brainCatalogItem) => void
}) {
  const node = (item: G1brainCatalogItem, className: string | undefined) => <button key={item.name} className={className}
    type="button" aria-label={`${catalogLabel(item)} ${action}`} title={catalogLabel(item)} onClick={() => { onSelect(item) }}>
    <span className={css.nodeGlyph}><AssetGlyph kind={kind} /></span>
    <span className={css.nodeText}>
      <strong>{catalogDisplayName(item)}</strong>
      {item.displayName?.trim() && item.displayName.trim() !== item.name && <small>{item.name}</small>}
    </span>
    <span className={css.nodeAction}>{action}</span>
  </button>
  if (expanded) return <div className={css.assetGallery}>{items.map(item => node(item, css.galleryNode))}</div>
  return <div className={css.assetMap}>
    <svg className={css.mapLinks} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      {mapPositions.map((position, index) => {
        const item = items[index]
        return item ? <line key={item.name} x1="50" y1="50" x2={position.x} y2={position.y} /> : null
      })}
    </svg>
    <span className={css.mapHub}><AssetGlyph kind={kind} /><strong>{hub}</strong></span>
    {mapPositions.map((position, index) => {
      const item = items[index]
      return item ? node(item, `${css.mapNode} ${position.className}`) : null
    })}
  </div>
}

/** Host actions injected into the landing panel. */
export interface G1brainHomeInjected {
  /** Read configuration and available resource names without exposing credentials. */
  readonly loadCatalog: () => Promise<Catalog>
  /** Read existing domains after an ontology collection is selected. */
  readonly loadDomains: (collectionName: string) => Promise<readonly G1brainCatalogItem[]>
  /** Pick a local source directory. */
  readonly pickDirectory: () => Promise<string | null>
  /** Register the directory as a Workspace and open a prepared Session. */
  readonly openSession: (input: { target: G1brainSessionTarget; prompt: string }) => Promise<void>
}

/** Fully assembled root panel props. */
export type G1brainHomeProps = InjectFace<G1brainHomeInjected> & PropsLocale<'g1brain'>

/** Render the ontology, document-library, and source-folder choices. */
export function G1brainHome({ t, loadCatalog, loadDomains, pickDirectory, openSession }: G1brainHomeProps) {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [catalogError, setCatalogError] = useState(false)
  const [retry, setRetry] = useState(0)
  const [view, setView] = useState<'overview' | 'prepare'>('overview')
  const [showAllOntologies, setShowAllOntologies] = useState(false)
  const [showAllLibraries, setShowAllLibraries] = useState(false)
  const [mode, setMode] = useState<'new' | 'optimize'>('new')
  const [ontologyName, setOntologyName] = useState('')
  const [ontologyExisting, setOntologyExisting] = useState('')
  const [newDomain, setNewDomain] = useState('')
  const [existingDomain, setExistingDomain] = useState('')
  const [domains, setDomains] = useState<readonly G1brainCatalogItem[]>([])
  const [domainError, setDomainError] = useState(false)
  const [libraryMode, setLibraryMode] = useState<'new' | 'existing'>('new')
  const [libraryName, setLibraryName] = useState('')
  const [libraryExisting, setLibraryExisting] = useState('')
  const [directory, setDirectory] = useState('')
  const [busy, setBusy] = useState(false)
  const [startError, setStartError] = useState(false)

  useEffect(() => {
    let active = true
    setCatalogError(false)
    void loadCatalog().then((value) => { if (active) setCatalog(value) }, () => { if (active) setCatalogError(true) })
    return () => { active = false }
  }, [loadCatalog, retry])

  const target = mode === 'new' ? ontologyName.trim() : ontologyExisting
  const domain = mode === 'new' ? newDomain.trim() : existingDomain
  const library = libraryMode === 'new' ? libraryName.trim() : libraryExisting
  const targetLabel = mode === 'new' ? target
    : catalog?.ontologies.find(item => item.name === target)?.displayName?.trim() || target
  const domainLabel = mode === 'new' ? domain
    : domains.find(item => item.name === domain)?.displayName?.trim() || domain
  const ready = target.length > 0 && domain.length > 0 && library.length > 0 && directory.trim().length > 0 && !busy
  const existingAvailable = catalog?.configured === true && catalog.error !== true
  const failed = catalogError || catalog?.error === true
  const ontologies = catalog?.ontologies ?? []
  const libraries = catalog?.libraries ?? []

  const prepare = (nextMode: 'new' | 'optimize', collectionName?: string) => {
    setMode(nextMode)
    if (collectionName !== undefined) { setOntologyExisting(collectionName); setExistingDomain('') }
    setView('prepare')
  }

  useEffect(() => {
    if (mode !== 'optimize' || !ontologyExisting || !existingAvailable) { setDomains([]); return }
    let active = true
    setDomainError(false)
    void loadDomains(ontologyExisting).then(
      (value) => { if (active) setDomains(value) },
      () => { if (active) { setDomains([]); setDomainError(true) } },
    )
    return () => { active = false }
  }, [mode, ontologyExisting, existingAvailable, loadDomains])

  const proceed = async () => {
    if (!ready) return
    setBusy(true)
    setStartError(false)
    const prompt = [
      mode === 'new' ? t('promptNew', { name: target }) : t('promptOptimize', { name: target }),
      t('promptDomain', { name: domain }),
      libraryMode === 'new' ? t('promptLibraryNew', { name: library }) : t('promptLibraryExisting', { name: library }),
      t('promptSafety'),
      t('promptProcessing'),
    ].join('\n')
    try {
      const binding: G1brainSessionTarget = {
        mode: mode === 'new' ? 'new-ontology' : 'update-ontology',
        folderPath: directory.trim(),
        ...(mode === 'new'
          ? { createOntologyCollectionName: target, createDomainName: domain }
          : { ontologyCollectionName: target, domainName: domain }),
        ...(libraryMode === 'new' ? { createDocumentLibraryName: library } : { documentLibraryName: library }),
      }
      await openSession({ target: binding, prompt })
    } catch (_error) {
      setStartError(true)
    } finally {
      setBusy(false)
    }
  }

  return <main className={css.page}>
    <div className={css.container}>
      <header className={css.header}>
        <span className={css.eyebrow}>{t('eyebrow')}</span>
        <h1>{view === 'overview' ? t('overviewTitle') : t('title')}</h1>
        <p>{view === 'overview' ? t('overviewDescription') : t('description')}</p>
      </header>

      <section className={css.status} aria-live="polite">
        <span className={existingAvailable ? css.statusDotReady : css.statusDot} aria-hidden="true" />
        <div>
          <strong>{catalog === null && !catalogError ? t('loading') : failed ? t('connectionFailed') : catalog?.configured ? t('connected') : t('disconnected')}</strong>
          {existingAvailable && catalog.mode === 'local-dev' && <p>{t('developmentConnectedDetail')}</p>}
          {catalog?.configured === false && <p>{t('disconnectedDetail')}</p>}
          {failed && <p role="alert">{t('catalogError')}</p>}
        </div>
        <Button variant="ghost" onClick={() => { setRetry(value => value + 1) }}>{t('retry')}</Button>
      </section>

      {view === 'overview' ? <>
        <div className={css.overviewGrid}>
          <section className={css.assetPanel} aria-labelledby="g1brain-ontology-assets">
            <div className={css.assetHeading}><div><h2 id="g1brain-ontology-assets">{t('overviewOntologies')}</h2><p>{t('overviewOntologiesHelp')}</p></div><strong>{existingAvailable ? ontologies.length : '—'}</strong></div>
            {existingAvailable && ontologies.length > 0 ? <CatalogDiagram items={ontologies} kind="ontology" expanded={showAllOntologies} action={t('overviewImprove')} hub={t('overviewOntologies')} onSelect={(item) => { prepare('optimize', item.name) }} />
              : <p className={css.assetEmpty}>{existingAvailable ? t('overviewNoOntologies') : t('overviewUnavailable')}</p>}
            {existingAvailable && ontologies.length > 4 && <button className={css.more} type="button" onClick={() => { setShowAllOntologies(value => !value) }}>{showAllOntologies ? t('overviewShowLess') : t('overviewShowAll', { count: String(ontologies.length) })}</button>}
          </section>
          <section className={css.assetPanel} aria-labelledby="g1brain-library-assets">
            <div className={css.assetHeading}><div><h2 id="g1brain-library-assets">{t('overviewLibraries')}</h2><p>{t('overviewLibrariesHelp')}</p></div><strong>{existingAvailable ? libraries.length : '—'}</strong></div>
            {existingAvailable && libraries.length > 0 ? <CatalogDiagram items={libraries} kind="library" expanded={showAllLibraries} action={t('overviewUse')} hub={t('overviewLibraries')} onSelect={(item) => { setLibraryMode('existing'); setLibraryExisting(item.name); prepare('new') }} />
              : <p className={css.assetEmpty}>{existingAvailable ? t('overviewNoLibraries') : t('overviewUnavailable')}</p>}
            {existingAvailable && libraries.length > 4 && <button className={css.more} type="button" onClick={() => { setShowAllLibraries(value => !value) }}>{showAllLibraries ? t('overviewShowLess') : t('overviewShowAll', { count: String(libraries.length) })}</button>}
          </section>
        </div>
        <section className={css.startPanel} aria-labelledby="g1brain-start"><div><h2 id="g1brain-start">{t('overviewStart')}</h2><p>{t('overviewStartHelp')}</p></div><div className={css.startActions}><Button variant="primary" onClick={() => { prepare('new') }}>{t('modeNew')}</Button><Button variant="outline" disabled={!existingAvailable || ontologies.length === 0} onClick={() => { prepare('optimize') }}>{t('modeOptimize')}</Button></div></section>
      </> : <>
        <button className={css.back} type="button" onClick={() => { setView('overview') }}>{t('backToOverview')}</button>
        <div className={css.sections}>
          <section className={css.card} aria-labelledby="g1brain-target">
            <div className={css.cardHeader}><span className={css.step}>01</span><div><h2 id="g1brain-target">{t('sectionTarget')}</h2><p>{t('sectionTargetHelp')}</p></div></div>
            <div className={css.choiceGrid} role="group" aria-label={t('sectionTarget')}>
              <button className={mode === 'new' ? css.choiceSelected : css.choice} type="button" aria-pressed={mode === 'new'} onClick={() => { setMode('new') }}><strong>{t('modeNew')}</strong><span>{t('modeNewHelp')}</span></button>
              <button className={mode === 'optimize' ? css.choiceSelected : css.choice} type="button" aria-pressed={mode === 'optimize'} onClick={() => { setMode('optimize') }}><strong>{t('modeOptimize')}</strong><span>{t('modeOptimizeHelp')}</span></button>
            </div>
            <div className={css.targetFields}>
              {mode === 'new' ? <label className={css.field}>{t('ontologyName')}<Input value={ontologyName} onChange={(event) => { setOntologyName(event.target.value) }} placeholder={t('ontologyNamePlaceholder')} /></label>
                : <div><label className={css.field}>{t('ontologyExisting')}<select disabled={!existingAvailable} value={ontologyExisting} onChange={(event) => { setOntologyExisting(event.target.value); setExistingDomain('') }}><option value="">{t('ontologyExistingPlaceholder')}</option>{catalog?.ontologies.map(item => <option key={item.name} value={item.name}>{catalogLabel(item)}</option>)}</select></label>{!existingAvailable && <small className={css.hint}>{t('unavailable')}</small>}</div>}
              {mode === 'new'
                ? <label className={css.field}>{t('domainNew')}<Input value={newDomain} onChange={(event) => { setNewDomain(event.target.value) }} placeholder={t('domainNewPlaceholder')} /></label>
                : <div><label className={css.field}>{t('domainExisting')}<select disabled={!existingAvailable || domains.length === 0} value={existingDomain} onChange={(event) => { setExistingDomain(event.target.value) }}><option value="">{t('domainExistingPlaceholder')}</option>{domains.map(item => <option key={item.name} value={item.name}>{catalogLabel(item)}</option>)}</select></label>{domainError && <small className={css.hint}>{t('domainError')}</small>}</div>}
            </div>
          </section>

          <section className={css.card} aria-labelledby="g1brain-library">
            <div className={css.cardHeader}><span className={css.step}>02</span><div><h2 id="g1brain-library">{t('sectionLibrary')}</h2><p>{t('sectionLibraryHelp')}</p></div></div>
            <div className={css.segment} role="group" aria-label={t('sectionLibrary')}>
              <button type="button" aria-pressed={libraryMode === 'new'} onClick={() => { setLibraryMode('new') }}>{t('libraryNew')}</button>
              <button type="button" aria-pressed={libraryMode === 'existing'} onClick={() => { setLibraryMode('existing') }}>{t('libraryExisting')}</button>
            </div>
            {libraryMode === 'new' ? <label className={css.field}>{t('libraryName')}<Input value={libraryName} onChange={(event) => { setLibraryName(event.target.value) }} placeholder={t('libraryNamePlaceholder')} /></label>
              : <div><label className={css.field}>{t('libraryExistingLabel')}<select disabled={!existingAvailable} value={libraryExisting} onChange={(event) => { setLibraryExisting(event.target.value) }}><option value="">{t('libraryExistingPlaceholder')}</option>{catalog?.libraries.map(item => <option key={item.name} value={item.name}>{catalogLabel(item)}</option>)}</select></label>{!existingAvailable && <small className={css.hint}>{t('unavailable')}</small>}</div>}
          </section>

          <section className={css.card} aria-labelledby="g1brain-directory">
            <div className={css.cardHeader}><span className={css.step}>03</span><div><h2 id="g1brain-directory">{t('sectionDirectory')}</h2><p>{t('sectionDirectoryHelp')}</p></div></div>
            <div className={css.directory}>
              <label className={css.directoryField}>{t('directoryPath')}<Input value={directory} onChange={(event) => { setDirectory(event.target.value); setStartError(false) }} placeholder={t('directoryPathPlaceholder')} /></label>
              <Button variant="outline" onClick={() => { void pickDirectory().then((path) => { if (path !== null) setDirectory(path) }).catch(() => { setStartError(true) }) }}>{t('pickDirectory')}</Button>
            </div>
          </section>
        </div>

        <aside className={css.footer}>
          <div><strong>{t('summary')}</strong><p>{target ? mode === 'new' ? t('summaryNew', { name: targetLabel }) : t('summaryOptimize', { name: targetLabel }) : t('summaryPending')} · {domain ? t('summaryDomain', { name: domainLabel }) : t('summaryPending')} · {library ? libraryMode === 'new' ? t('summaryLibraryNew', { name: library }) : t('summaryLibraryExisting', { name: library }) : t('summaryPending')} · {directory ? t('summaryDirectory', { name: directory }) : t('summaryPending')}</p><small>{t('draftNotice')}</small></div>
          <Button variant="primary" disabled={!ready} onClick={() => { void proceed() }}>{busy ? t('proceeding') : t('proceed')}</Button>
        </aside>
        {startError && <p className={css.error} role="alert">{t('startError')}</p>}
      </>}
    </div>
  </main>
}
