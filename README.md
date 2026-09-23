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
- TeamSpeak Client **3.1.10**
- TeamSpeak ClientQuery + OMNILINK TeamSpeak Bridge
- Automatic TeamSpeak bridge watchdog/reconnect
- systemd services for OMNILINK and the TeamSpeak stack
- Initial admin password: `123456` (must be changed on first login)
- Startup, TeamSpeak ClientQuery, bridge, and health verification

## Requirements

### Supported Linux architecture

- x86_64 / amd64

TeamSpeak Client 3.1.10 in this installer is x86_64/amd64 only.

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
| `OMNILINK_TS_SERVER_HOST` | `ts3.my.id` |
| `OMNILINK_TS_VOICE_PORT` | `9987` |
| `OMNILINK_TS_QUERY_PORT` | `10011` |
| `OMNILINK_TS_NICKNAME` | `Universal OMNILINK Bridge` |
| `OMNILINK_TS_CHANNEL_ID` | `3833` |
| `OMNILINK_TS_CHANNEL_NAME` | `omni test` |
| `OMNILINK_TS_CHANNEL_PASSWORD` | empty |
| `OMNILINK_TS_SERVER_PASSWORD` | empty |
| `OMNILINK_TS_CALLSIGN` | `TEST1` |
| `OMNILINK_TS3_CLIENT_FILE` | empty; optional local TeamSpeak 3.1.10 installer file |
| `OMNILINK_TS3_CLIENT_URL` | installer mirror for TeamSpeak 3.1.10 |
| `OMNILINK_FORCE` | `0` |

## Reinstall

The installer refuses to overwrite an existing OmniLink installation unless explicitly requested.

Example:

```bash
sudo OMNILINK_FORCE=1 bash install.sh
```

**Warning:** reinstalling an existing installation can replace application files and should only be used intentionally.

## TeamSpeak Services

The installer manages the complete TeamSpeak stack automatically:

```text
omnilink-teamspeak-client.service
omnilink-teamspeak-bridge.service
omnilink-teamspeak-watchdog.service
```

The TeamSpeak Client version is fixed to **3.1.10** in this installer. The installer verifies the package SHA-256 before extraction.

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

The public application listens on:

```
TCP 18787  HTTP
TCP 18788  HTTPS (when TLS is configured)
```

The TeamSpeak Client connects outbound to the configured TeamSpeak server. ClientQuery (`127.0.0.1:25639`) and bridge health (`127.0.0.1:18891`) are local integration endpoints and should not be exposed publicly.

If the server is behind a firewall, reverse proxy, router, or cloud security group, allow the required public application port(s).

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
- TeamSpeak runtime state or ClientQuery API keys from PP7
- PP7 logs
- local cache/build artifacts
- machine-specific configuration

The installer creates a new TeamSpeak 3.1.10 client profile and ClientQuery key on each machine, keeping every installation independent.

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
