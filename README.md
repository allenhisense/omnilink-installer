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
- Initial admin password: `123456` (must be changed on first login)
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

### Access URLs

The installer uses the **actual public IP address or hostname of the machine where OMNILINK is hosted**. It also prints the resolved addresses after installation.

```text
Web Client:
http://SERVER_IP:18787/

Admin Web:
http://SERVER_IP:18787/admin/

Server Address pada Android/PC Client:
SERVER_IP:18787

Health Check:
http://SERVER_IP:18787/health
```

Replace `SERVER_IP` with the public IP address or DNS hostname of the OMNILINK server.

Example for the laboratory VPS only:

```text
Web Client:
http://38.47.180.47:18787/

Admin Web:
http://38.47.180.47:18787/admin/

Server Address pada Android/PC Client:
38.47.180.47:18787

Health Check:
http://38.47.180.47:18787/health
```

Other hosting environments must use their own public IP address or hostname. Use `OMNILINK_PUBLIC_HOST` when a public DNS name should be displayed by the installer.

```bash
sudo OMNILINK_PUBLIC_HOST=omnilink.example.com bash install.sh
```

For Android / PC clients, enter the **Server Address** in `HOST:PORT` format. Do not enter the Web Client or Admin Web URL in the native client server-address field.

### Initial Admin Password

Every fresh installation starts with:

```text
Callsign: ADMIN
Initial password: 123456
```

The initial password is temporary. The administrator must change it on the first Admin Web login before normal administration is allowed.

### Service Checks

Check service status:

```bash
sudo systemctl status omnilink
```

Check health locally:

```bash
curl http://127.0.0.1:18787/health
```

View logs:

```bash
sudo journalctl -u omnilink -f
```

Do not publish or commit administrator credentials.

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
| `OMNILINK_PUBLIC_HOST` | auto-detected public IP |
| `OMNILINK_ENV_DIR` | `/etc/omnilink` |
| `OMNILINK_ADMIN_TOKEN` | `123456` on fresh installation |
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

Fresh installations use administrator callsign `ADMIN` and temporary password `123456`; the password must be changed at first login.

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
