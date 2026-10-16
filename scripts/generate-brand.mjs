import { Resvg } from '@resvg/resvg-js'
import { mkdir, writeFile } from 'node:fs/promises'
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="32" fill="#171c19"/><g fill="#c4f269"><rect x="24" y="30" width="13" height="68" rx="6.5"/><rect x="46" y="30" width="13" height="68" rx="6.5"/><rect x="68" y="30" width="13" height="68" rx="6.5"/><rect x="90" y="30" width="13" height="68" rx="6.5"/></g></svg>`
await mkdir('public/brand', { recursive: true })
await writeFile('public/favicon.svg', svg)
await writeFile('public/brand/logo.svg', svg)
for (const size of [16, 32, 64, 128, 180, 192, 256, 512]) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()
  await writeFile(`public/brand/logo-${size}.png`, png)
  if (size === 16 || size === 32) await writeFile(`public/favicon-${size}x${size}.png`, png)
  if (size === 180) await writeFile('public/apple-touch-icon.png', png)
  if (size === 192 || size === 512) await writeFile(`public/android-chrome-${size}x${size}.png`, png)
  if (size === 512) await writeFile('public/llll_logo.png', png)
}

const icon = new Resvg(svg, { fitTo: { mode: 'width', value: 1024 } }).render().asPng()
await writeFile('apps/mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png', icon)
const png32 = new Resvg(svg, { fitTo: { mode: 'width', value: 32 } }).render().asPng()
const ico = Buffer.alloc(22)
ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico[6] = 32; ico[7] = 32; ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); ico.writeUInt32LE(png32.length, 14); ico.writeUInt32LE(22, 18)
await writeFile('public/favicon.ico', Buffer.concat([ico, png32]))
const og = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="1200" height="630" fill="#111713"/><g transform="translate(72 70) scale(.8)">${svg.replace(/<svg[^>]*>|<\/svg>/g, '')}</g><text x="72" y="330" fill="#f1f6ed" font-family="Arial" font-size="92" font-weight="700">Your places, together.</text><text x="76" y="425" fill="#bdc9bc" font-family="Arial" font-size="34">Independent communities on infrastructure you control.</text><text x="76" y="550" fill="#c4f269" font-family="Arial" font-size="32">L4 · llll.gg</text></svg>`
await writeFile('public/og-image.png', new Resvg(og).render().asPng())
