# OMNILINK Linux Installer

AJF Tech Malang

## One-command installation

```bash
curl -fsSL https://raw.githubusercontent.com/allenhisense/omnilink-installer/main/install.sh | sudo bash
```

The installer deploys a fresh OMNILINK server and does not copy the live PP7 database,
tokens, TLS private keys, logs, TeamSpeak runtime, or other server-specific state.

## Defaults

- Install root: `/opt/omnilink`
- HTTP: `18787`
- HTTPS: `18788`
- Service: `omnilink.service`
- Admin token: generated automatically during installation

## Requirements

Linux with systemd and either Node.js 20+ already installed, or apt/dnf/yum
so the installer can install Node.js 22.

## Version

2.2.1
