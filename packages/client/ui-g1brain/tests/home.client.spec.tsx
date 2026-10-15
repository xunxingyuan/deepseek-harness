// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { G1brainHome, type G1brainHomeProps } from '../src/client/G1brainHome.tsx'
import type {} from '../src/client/index.ts'
import { zh, type G1brainKey } from '../src/client/locales.ts'
import { G1brainPreparationError, type G1brainPreparationStage } from '../src/client/preparation.ts'

afterEach(cleanup)

const t = ((key: G1brainKey, values?: Record<string, string>) => Object.entries(values ?? {}).reduce<string>(
  (copy, [name, value]) => copy.replaceAll(`{${name}}`, value), zh[key],
)) as G1brainHomeProps['t']

function home(configured: boolean) {
  const openSession = vi.fn(async (_input: Parameters<G1brainHomeProps['openSession']>[0]) => {})
  const pickDirectory = vi.fn(async () => '/tmp/g1brain-material')
  const loadDomains = vi.fn(async () => [{ name: '设备领域', displayName: '设备运维领域' }])
  const loadCatalog = vi.fn(async () => ({ configured, mode: 'local-dev' as const,
    ontologies: [{ name: '已有本体', displayName: '设备运维知识图谱' }], libraries: [{ name: '现有资料库' }],
  }))
  render(<G1brainHome {...({ t, openSession, pickDirectory, loadCatalog, loadDomains })} />)
  return { openSession, pickDirectory, loadCatalog, loadDomains }
}

describe('G1brain landing page', () => {
  it('shows a connection failure instead of calling configured credentials a live connection', async () => {
    const loadCatalog = vi.fn(async () => ({ configured: true, mode: 'local-dev' as const,
      ontologies: [], libraries: [], error: true,
    }))
    render(<G1brainHome t={t} loadCatalog={loadCatalog} loadDomains={async () => []} pickDirectory={async () => null}
      openSession={async () => {}} />)
    expect(await screen.findByText(zh.connectionFailed)).toBeTruthy()
    expect(screen.getAllByText(zh.overviewUnavailable)).toHaveLength(2)
    expect(screen.getByRole('button', { name: zh.modeOptimize }).hasAttribute('disabled')).toBe(true)
  })

  it('prepares a new-ontology Session without claiming development sign-in is API access', async () => {
    const { openSession } = home(false)
    expect(await screen.findByText(zh.disconnected)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.modeNew }))
    fireEvent.change(screen.getByPlaceholderText(zh.ontologyNamePlaceholder), { target: { value: '设备本体' } })
    fireEvent.change(screen.getByPlaceholderText(zh.domainNewPlaceholder), { target: { value: '设备领域' } })
    fireEvent.change(screen.getByPlaceholderText(zh.libraryNamePlaceholder), { target: { value: '设备资料' } })
    fireEvent.click(screen.getByRole('button', { name: zh.pickDirectory }))
    await waitFor(() => { expect(screen.getByRole('button', { name: zh.proceed }).hasAttribute('disabled')).toBe(false) })
    fireEvent.click(screen.getByRole('button', { name: zh.proceed }))
    await waitFor(() => { expect(openSession).toHaveBeenCalledTimes(1) })
    const call = openSession.mock.calls[0]![0]
    expect(call.target.folderPath).toBe('/tmp/g1brain-material')
    expect(call.target.createOntologyCollectionName).toBe('设备本体')
    expect(call.target.createDomainName).toBe('设备领域')
    expect(call.prompt).toContain('设备本体')
    expect(call.prompt).toContain('在我确认方案前，不要创建、上传、修改或删除')
    expect(call.prompt).toContain('先提交 MD 切片任务并确认成功')
    expect(call.prompt).toContain('中文提问使用简体中文')
  })

  it('selects existing ontology and library only when the service is configured', async () => {
    const { openSession } = home(true)
    expect(await screen.findByText(zh.connected)).toBeTruthy()
    expect(screen.getByText(zh.developmentConnectedDetail)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.modeOptimize }))
    fireEvent.click(screen.getByRole('button', { name: zh.libraryExisting }))
    await waitFor(() => { expect(screen.getByLabelText(zh.ontologyExisting).hasAttribute('disabled')).toBe(false) })
    expect(screen.getByRole('option', { name: '设备运维知识图谱（已有本体）' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText(zh.ontologyExisting), { target: { value: '已有本体' } })
    await waitFor(() => { expect(screen.getByLabelText(zh.domainExisting).hasAttribute('disabled')).toBe(false) })
    expect(screen.getByRole('option', { name: '设备运维领域（设备领域）' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText(zh.domainExisting), { target: { value: '设备领域' } })
    expect(screen.getByText(/优化：设备运维知识图谱/)).toBeTruthy()
    expect(screen.getByText(/领域：设备运维领域/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText(zh.libraryExistingLabel), { target: { value: '现有资料库' } })
    fireEvent.click(screen.getByRole('button', { name: zh.pickDirectory }))
    await waitFor(() => { expect(screen.getByRole('button', { name: zh.proceed }).hasAttribute('disabled')).toBe(false) })
    fireEvent.click(screen.getByRole('button', { name: zh.proceed }))
    await waitFor(() => { expect(openSession).toHaveBeenCalledTimes(1) })
    const call = openSession.mock.calls[0]![0]
    expect(call.prompt).toContain('已有本体')
    expect(call.prompt).toContain('现有资料库')
    expect(call.target.ontologyCollectionName).toBe('已有本体')
    expect(call.target.domainName).toBe('设备领域')
  })

  it('accepts a pasted absolute folder path when the native chooser is unavailable', async () => {
    const { openSession, pickDirectory } = home(false)
    expect(await screen.findByText(zh.disconnected)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.modeNew }))
    fireEvent.change(screen.getByPlaceholderText(zh.ontologyNamePlaceholder), { target: { value: '测试本体' } })
    fireEvent.change(screen.getByPlaceholderText(zh.domainNewPlaceholder), { target: { value: '测试领域' } })
    fireEvent.change(screen.getByPlaceholderText(zh.libraryNamePlaceholder), { target: { value: '测试资料库' } })
    fireEvent.change(screen.getByLabelText(zh.directoryPath), { target: { value: ' /tmp/g1brain-material ' } })
    fireEvent.click(screen.getByRole('button', { name: zh.proceed }))
    await waitFor(() => { expect(openSession).toHaveBeenCalledTimes(1) })
    expect(openSession.mock.calls.at(0)?.[0].target.folderPath).toBe('/tmp/g1brain-material')
    expect(pickDirectory).not.toHaveBeenCalled()
  })

  it('shows actual asset counts and opens a selected ontology in improve mode', async () => {
    const { loadDomains } = home(true)
    expect(await screen.findByText(zh.overviewTitle)).toBeTruthy()
    expect(screen.getByRole('heading', { name: zh.overviewOntologies }).closest('section')?.querySelector('strong')?.textContent).toBe('1')
    expect(screen.getByRole('heading', { name: zh.overviewLibraries }).closest('section')?.querySelector('strong')?.textContent).toBe('1')
    expect(screen.getByRole('region', { name: zh.overviewOntologies }).querySelectorAll('svg line')).toHaveLength(1)
    expect(screen.getByRole('region', { name: zh.overviewLibraries }).querySelectorAll('svg line')).toHaveLength(1)
    expect(screen.getByRole('button', { name: '设备运维知识图谱（已有本体） 完善' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '现有资料库 使用' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '设备运维知识图谱（已有本体） 完善' }))
    expect(screen.getByRole('heading', { name: zh.sectionTarget })).toBeTruthy()
    expect(screen.getByLabelText<HTMLSelectElement>(zh.ontologyExisting).value).toBe('已有本体')
    await waitFor(() => { expect(loadDomains).toHaveBeenCalledWith('已有本体') })
    fireEvent.click(screen.getByRole('button', { name: zh.backToOverview }))
    expect(screen.getByRole('heading', { name: zh.overviewOntologies })).toBeTruthy()
  })

  it.each([
    ['directory', zh.startDirectoryError], ['session', zh.startError],
    ['binding', zh.startBindingError], ['draft', zh.startDraftError],
  ] satisfies Array<[G1brainPreparationStage, string]>)('keeps the form and reports the failed %s operation accurately', async (stage, message) => {
    const { openSession } = home(true)
    openSession.mockRejectedValueOnce(new G1brainPreparationError(stage, new Error('fixture failure')))
    await screen.findByText(zh.connected)
    fireEvent.click(screen.getByRole('button', { name: zh.modeNew }))
    fireEvent.change(screen.getByPlaceholderText(zh.ontologyNamePlaceholder), { target: { value: '周报本体' } })
    fireEvent.change(screen.getByPlaceholderText(zh.domainNewPlaceholder), { target: { value: '周报领域' } })
    fireEvent.change(screen.getByPlaceholderText(zh.libraryNamePlaceholder), { target: { value: '周报文档' } })
    fireEvent.change(screen.getByLabelText(zh.directoryPath), { target: { value: 'C:\\Users\\lisa\\Downloads\\周报本体' } })
    fireEvent.click(screen.getByRole('button', { name: zh.proceed }))
    expect((await screen.findByRole('alert')).textContent).toBe(message)
    expect(screen.getByDisplayValue('周报本体')).toBeTruthy()
    expect(screen.getByDisplayValue('C:\\Users\\lisa\\Downloads\\周报本体')).toBeTruthy()
    expect(openSession.mock.calls[0]?.[0].target.folderPath).toBe('C:\\Users\\lisa\\Downloads\\周报本体')
    expect(screen.getByRole('button', { name: zh.proceed }).hasAttribute('disabled')).toBe(false)
  })

  it('can inspect a longer catalog and carry a selected document library into preparation', async () => {
    const loadCatalog = vi.fn(async () => ({ configured: true, mode: 'oauth' as const,
      ontologies: Array.from({ length: 7 }, (_, index) => ({ name: `本体${index + 1}` })),
      libraries: [{ name: '资料库标识', displayName: '设计资料库' }],
    }))
    render(<G1brainHome t={t} loadCatalog={loadCatalog} loadDomains={async () => []} pickDirectory={async () => null}
      openSession={async () => {}} />)
    expect(await screen.findByText(zh.connected)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '本体7 完善' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '查看全部 7 项' }))
    expect(screen.getByRole('button', { name: '本体7 完善' })).toBeTruthy()
    expect(screen.getByRole('region', { name: zh.overviewOntologies }).querySelectorAll('svg line')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '设计资料库（资料库标识） 使用' }))
    expect(screen.getByLabelText<HTMLSelectElement>(zh.libraryExistingLabel).value).toBe('资料库标识')
    expect(screen.getByRole('option', { name: '设计资料库（资料库标识）' })).toBeTruthy()
  })
})
