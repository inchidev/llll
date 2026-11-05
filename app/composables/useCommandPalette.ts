export function useCommandPalette() {
  const open = useState('command-palette:open', () => false)
  return { open, show: () => { open.value = true } }
}
