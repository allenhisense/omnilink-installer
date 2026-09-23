#!/usr/bin/env python3
import os
import signal
import socket
import subprocess
import time
from pathlib import Path

MAIN_UNIT = "omnilink-teamspeak-client.service"
HOME = Path(os.environ.get("OMNILINK_HOME", "/opt/omnilink"))
API_FILE = HOME / ".ts3client" / "clientquery.ini"
LOG = HOME / "logs" / "ts-client-watchdog.log"
CHECK_SEC = 5
CONNECT_GRACE_SEC = 25
DISCONNECT_STREAK_LIMIT = 3

def log(msg):
    line = time.strftime("%Y-%m-%d %H:%M:%S%z") + " " + msg + "\n"
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a") as f:
        f.write(line)

def read_api():
    try:
        for line in API_FILE.read_text(errors="ignore").splitlines():
            if line.startswith("api_key="):
                return line.split("=", 1)[1].strip()
    except Exception:
        return ""
    return ""

def query_connected():
    api = read_api()
    if not api:
        return None
    try:
        s = socket.create_connection(("127.0.0.1", 25639), 2)
        s.settimeout(2)
        def cmd(c):
            s.sendall((c + "\n").encode())
            data = b""
            while b"error id=" not in data:
                part = s.recv(16384)
                if not part:
                    break
                data += part
            return data.decode("utf-8", "replace")
        cmd("auth apikey=" + api)
        cmd("use 1")
        out = cmd("whoami")
        s.close()
        if "error id=1794" in out:
            return False
        if "clid=" in out:
            return True
        return False
    except Exception:
        return None

def service_main_pid():
    try:
        p = subprocess.check_output(
            ["systemctl", "show", "-p", "MainPID", "--value", MAIN_UNIT],
            text=True
        ).strip()
        return int(p) if p.isdigit() else 0
    except Exception:
        return 0

def client_pid():
    main = service_main_pid()
    if not main:
        return 0
    try:
        out = subprocess.check_output(
            ["pgrep", "-P", str(main), "-f", "ts3client_runscript.sh"],
            text=True,
            stderr=subprocess.DEVNULL
        ).splitlines()
        return int(out[0]) if out else 0
    except Exception:
        return 0

def kill_client_group(pid):
    try:
        pgid = os.getpgid(pid)
        if pgid in (0, os.getpgrp()):
            return False
        os.killpg(pgid, signal.SIGCONT)
        time.sleep(0.2)
        os.killpg(pgid, signal.SIGTERM)
        time.sleep(0.5)
        try:
            os.killpg(pgid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        log(f"KILL_DISCONNECTED_CLIENT pid={pid} pgid={pgid}")
        return True
    except ProcessLookupError:
        return True
    except Exception as e:
        log(f"KILL_FAILED pid={pid} err={type(e).__name__}")
        return False

def main():
    current_pid = 0
    first_seen = 0.0
    connected = False
    disconnect_streak = 0

    log("START watchdog")
    while True:
        pid = client_pid()
        now = time.time()

        if pid != current_pid:
            current_pid = pid
            first_seen = now if pid else 0.0
            connected = False
            disconnect_streak = 0
            if pid:
                log(f"CLIENT_SEEN pid={pid}")

        if pid:
            state = query_connected()
            if state is True:
                if not connected:
                    log(f"CONNECTED pid={pid}")
                connected = True
                disconnect_streak = 0
            elif state is False or state is None:
                if connected:
                    disconnect_streak += 1
                    if disconnect_streak >= DISCONNECT_STREAK_LIMIT:
                        kill_client_group(pid)
                        connected = False
                        disconnect_streak = 0
                elif first_seen and now - first_seen >= CONNECT_GRACE_SEC:
                    kill_client_group(pid)
                    first_seen = now
            else:
                disconnect_streak = 0

        time.sleep(CHECK_SEC)

if __name__ == "__main__":
    main()
