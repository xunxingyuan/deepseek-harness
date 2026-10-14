/** Render the G1brain application artwork for macOS, Windows, and the development bundle. */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const resources = fileURLToPath(new URL('../resources/', import.meta.url))
const variants = [
  ['icon.svg', 'icon.png'],
  ['icon-macos.svg', 'icon-macos.png'],
  ['icon-windows.svg', 'icon-windows.png'],
] as const

async function render(): Promise<void> {
  for (const [source, output] of variants) {
    await sharp(await readFile(join(resources, source)), { density: 72 }).resize(1024, 1024).png()
      .toFile(join(resources, output))
  }
  if (process.platform !== 'darwin') return
  const iconset = await mkdtemp(join(tmpdir(), 'g1brain-app-icon-'))
  const directory = `${iconset}.iconset`
  try {
    const source = await readFile(join(resources, 'icon-macos.svg'))
    const names = [
      [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'],
      [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
      [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
      [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
      [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
    ] as const
    await mkdir(directory)
    for (const [size, name] of names) {
      await sharp(source, { density: 72 }).resize(size, size).png().toFile(join(directory, name))
    }
    execFileSync('/usr/bin/iconutil', ['-c', 'icns', directory, '-o', join(resources, 'icon-macos.icns')])
  } finally {
    await rm(directory, { recursive: true, force: true })
    await rm(iconset, { recursive: true, force: true })
  }
}

await render()
