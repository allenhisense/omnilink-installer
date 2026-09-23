# OMNILINK Linux Installer

**AJF Tech Malang**

One-command installer for a fresh self-hosted OMNILINK server on Linux.

## Quick Install

Run on the target Linux server:

```bash
curl -fsSL https://raw.githubusercontent.com/allenhisense/omnilink-installer/main/install.sh | sudo bash
```

The installer is designed for a **fresh OMNILINK server**. It creates a clean server state and does not copy AJF/PP7 runtime credentials or database data.

## What It Installs

- OMNILINK Server Core
- Web Client
- Admin Panel
- Fresh server state/database
- systemd service: `omnilink.service`
- Automatic admin token generation
- Startup and health verification

## Requirements

### Supported Linux architecture

- x86_64 / amd64
- arm64 / aarch64

### Runtime

Node.js **20 or newer** is required.

When Node.js is missing, the installer can install Node.js 22 using:

- apt
- dnf
- yum

The target system must use **systemd** for automatic service management.

## Default Paths

| Item | Default |
|---|---|
| Install directory | `/opt/omnilink` |
| Configuration directory | `/etc/omnilink` |
| HTTP port | `18787` |
| HTTPS port | `18788` |
| Service | `omnilink.service` |

Runtime data is stored below:

```
/opt/omnilink/data
```

## After Installation

Check service status:

```bash
sudo systemctl status omnilink
```

Check health:

```bash
curl http://127.0.0.1:18787/health
```

View logs:

```bash
sudo journalctl -u omnilink -f
```

The generated admin credential is stored locally on the server in:

```
/etc/omnilink/credentials.txt
```

Do not publish or share this file.

## Configuration Overrides

The installer supports environment overrides.

Example:

```bash
sudo OMNILINK_PORT=18087 bash install.sh
```

Useful variables:

| Variable | Default |
|---|---|
| `OMNILINK_ROOT` | `/opt/omnilink` |
| `OMNILINK_PORT` | `18787` |
| `OMNILINK_HTTPS_PORT` | `18788` |
| `OMNILINK_ENV_DIR` | `/etc/omnilink` |
| `OMNILINK_ADMIN_TOKEN` | generated automatically |
| `OMNILINK_FORCE` | `0` |

## Reinstall

The installer refuses to overwrite an existing OmniLink installation unless explicitly requested.

Example:

```bash
sudo OMNILINK_FORCE=1 bash install.sh
```

**Warning:** reinstalling an existing installation can replace application files and should only be used intentionally.

## Service Management

Start:

```bash
sudo systemctl start omnilink
```

Stop:

```bash
sudo systemctl stop omnilink
```

Restart:

```bash
sudo systemctl restart omnilink
```

Enable automatic startup:

```bash
sudo systemctl enable omnilink
```

## Firewall / Network

The application listens on:

```
TCP 18787  HTTP
TCP 18788  HTTPS (when TLS is configured)
```

If the server is behind a firewall, reverse proxy, router, or cloud security group, allow the required port(s).

## Security Notes

The installer generates a fresh administrator credential for each installation.

Never commit:

- admin tokens
- user/gateway tokens
- private keys
- TLS certificates containing private material
- production databases
- production logs
- server-specific credentials

The public installer repository contains only deployment material intended for distribution.

## Scope

The public Linux installer intentionally does **not** package the live AJF/PP7 runtime environment, including:

- production database/state
- production user and gateway tokens
- TLS private keys
- TeamSpeak/Mumble runtime state
- PP7 logs
- local cache/build artifacts
- machine-specific configuration

This keeps each new OMNILINK installation independent.

## Troubleshooting

### Service does not start

Check:

```bash
sudo systemctl status omnilink --no-pager
sudo journalctl -u omnilink -n 100 --no-pager
```

### Port already in use

Check:

```bash
sudo ss -lntp | grep -E ':18787|:18788'
```

Install using another port:

```bash
sudo OMNILINK_PORT=28787 bash install.sh
```

### Health check

Expected response:

```json
{
  "ok": true,
  "service": "omnilink-server"
}
```

## Version

Current installer release:

**2.2.1**

Release tag:

```
v2.2.1
```

## Repository

https://github.com/allenhisense/omnilink-installer

## License

OMNILINK is developed by AJF Tech Malang.

Use and redistribution should follow the licensing terms defined by the OMNILINK project owner.
