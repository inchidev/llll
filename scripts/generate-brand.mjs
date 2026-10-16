// Web and PWA assets only. Native packaging is intentionally frozen.
import { Resvg } from '@resvg/resvg-js'
import { mkdir, writeFile } from 'node:fs/promises'
const mark = 'M2 2h4v8h8v4H2V2Zm16 0h4v8h8v4H18V2ZM2 18h4v8h8v4H2V18Zm16 0h4v8h8v4H18V18Z'
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="24" fill="#000"/><path transform="translate(24 24) scale(2.5)" d="${mark}" fill="#fff"/></svg>`
for (const directory of ['public', 'apps/site/public']) {
  await mkdir(`${directory}/brand`, { recursive: true })
  await writeFile(`${directory}/favicon.svg`, svg)
  await writeFile(`${directory}/brand/logo.svg`, svg)
  for (const size of [16, 32, 64, 128, 180, 192, 256, 512]) {
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()
    await writeFile(`${directory}/brand/logo-${size}.png`, png)
    if (size === 16 || size === 32) await writeFile(`${directory}/favicon-${size}x${size}.png`, png)
    if (size === 180) await writeFile(`${directory}/apple-touch-icon.png`, png)
    if (size === 192 || size === 512) await writeFile(`${directory}/android-chrome-${size}x${size}.png`, png)
    if (size === 512) await writeFile(`${directory}/llll_logo.png`, png)
  }
  const png32 = new Resvg(svg, { fitTo: { mode: 'width', value: 32 } }).render().asPng()
  const ico = Buffer.alloc(22)
  ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico[6] = 32; ico[7] = 32; ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); ico.writeUInt32LE(png32.length, 14); ico.writeUInt32LE(22, 18)
  await writeFile(`${directory}/favicon.ico`, Buffer.concat([ico, png32]))
  const og = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="1200" height="630" fill="#000"/><path d="M64 0V630M1136 0V630M0 560H1200" stroke="#262626"/><path transform="translate(96 64) scale(2)" d="${mark}" fill="#fff"/><text x="96" y="292" fill="#fafafa" font-family="Arial" font-size="92" font-weight="700" letter-spacing="-5">Chat. Work.</text><text x="96" y="392" fill="#a3a3a3" font-family="Arial" font-size="92" font-weight="700" letter-spacing="-5">On your terms.</text><text x="96" y="510" fill="#a3a3a3" font-family="Arial" font-size="28">Open source. Your infrastructure.</text><text x="96" y="606" fill="#fafafa" font-family="Arial" font-size="24">L4 / llll.gg</text></svg>`
  await writeFile(`${directory}/og-image.png`, new Resvg(og).render().asPng())
}
