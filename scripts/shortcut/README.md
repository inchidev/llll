# iPhone Shortcut

`public/L4.shortcut` is the signed Shortcut offered under Settings → Connections → Shortcut. It receives media from the Share Sheet, asks once for a personal link, POSTs the file to that link, and opens the address it gets back. It holds no link, so one file serves every Server.

Rebuild it on a Mac after changing `build.py`. Signing needs macOS and an iCloud account:

```sh
python3 scripts/shortcut/build.py /tmp/L4.plist
cp /tmp/L4.plist /tmp/L4-unsigned.shortcut
shortcuts sign --mode anyone --input /tmp/L4-unsigned.shortcut --output public/L4.shortcut
```

`--mode anyone` signs with a certificate Apple issues to that iCloud account, valid for about a year. Its subject is an opaque hash, with no name or address in the file. The file itself has never been imported on an iPhone.
