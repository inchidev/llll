/** Read the exec transport directly, including for immutable images whose CLI reopens /dev/stdin. */
export const cloudCodeBridge = String.raw`
try {
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 8000) throw new Error('Invalid storage request');
    chunks.push(chunk);
  }
  const { codeState } = await import('file:///opt/l4/cloud-io.mjs');
  process.stdout.write(JSON.stringify(await codeState(JSON.parse(Buffer.concat(chunks).toString()))));
} catch {
  process.stdout.write(JSON.stringify({ ok: false, message: 'Code checkpoint or restoration failed. Inspect storage and recovery before continuing.' }));
}
`
