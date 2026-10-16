# L4 · llll.gg

Independent servers. One client.

L4 is free, MIT licensed software for conversations, calls, tasks, mail, data and internal apps. Run an installation on your Cloudflare account or on your VPS with celld.

An installation owns accounts and a directory of servers. Every server gets a separate Worker, D1 database, files bucket and Durable Objects. Backups use a separately configured destination.

The shared Nuxt client groups servers by installation and connects through HTTPS and WebSockets. Each installation also serves its own client.

See [installation](docs/installation.md), [architecture](docs/architecture.md), and [self-hosting](self-host/README.md).

The runtime continues work originally developed in Discoflare; the client also incorporates work from Anycord. Original MIT notices are retained.
