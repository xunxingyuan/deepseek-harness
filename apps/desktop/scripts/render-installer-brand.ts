/** Build Windows installer brand panels from the committed G1brain application icon. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const appRoot = fileURLToPath(new URL('../', import.meta.url))
const assets = join(appRoot, 'installer', 'assets')
const icon = await readFile(join(appRoot, 'resources', 'icon-windows.png'))

function labelSvg(color: string): Buffer {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="196" viewBox="0 0 600 196">
    <text x="205" y="91" fill="${color}" font-family="Arial,Helvetica,sans-serif" font-size="45" font-weight="700">G1brain</text>
    <text x="207" y="135" fill="${color}" font-family="Arial,Helvetica,sans-serif" font-size="30" font-weight="500">X DeepSeek</text>
  </svg>`)
}

for (const [variant, color] of [['brand', '#1B2A43'], ['brand-dark', '#F2F7FF']] as const) {
  for (const scale of [1, 2] as const) {
    const width = 600 * scale
    const height = 196 * scale
    const iconSize = 142 * scale
    const artwork = await sharp(icon).resize(iconSize, iconSize).png().toBuffer()
    const words = await sharp(labelSvg(color)).resize(width, height).png().toBuffer()
    await sharp({ create: { width, height, channels: 4, background: '#00000000' } })
      .composite([{ input: artwork, left: 38 * scale, top: 27 * scale }, { input: words, left: 0, top: 0 }])
      .png().toFile(join(assets, `${variant}${scale === 2 ? '-2x' : ''}.png`))
  }
}

const sidebar = await sharp(icon).resize(108, 108).png().toBuffer()
await sharp({ create: { width: 164, height: 314, channels: 3, background: '#F3F6FA' } })
  .composite([{ input: sidebar, left: 28, top: 102 }]).png().toFile(join(assets, 'uninstaller-sidebar.png'))
