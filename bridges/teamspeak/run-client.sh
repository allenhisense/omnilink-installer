#!/bin/bash
set -u

APP_HOME="${OMNILINK_HOME:-/opt/omnilink}"
HOME="${HOME:-/var/lib/omnilink-ts}"
CFG="$APP_HOME/data/teamspeak.json"
RUNTIME="$APP_HOME/data/teamspeak-runtime.json"
LOG="$APP_HOME/logs/ts-client.log"

export HOME
export OMNILINK_HOME="$APP_HOME"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/omnilink-runtime}"
export PULSE_RUNTIME_PATH="$XDG_RUNTIME_DIR/pulse"
export PULSE_LATENCY_MSEC=120
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$APP_HOME/config}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$APP_HOME/cache}"
export DISPLAY="${DISPLAY:-:99}"
export QT_X11_NO_MITSHM=1
export QT_QPA_PLATFORM=xcb
export QT_XCB_GL_INTEGRATION="${QT_XCB_GL_INTEGRATION:-xcb_glx}"
export LIBGL_ALWAYS_SOFTWARE="${LIBGL_ALWAYS_SOFTWARE:-1}"
export OPENSSL_CONF="${OPENSSL_CONF:-/dev/null}"
TSCLIENT_DIR="${TSCLIENT_DIR:-/opt/teamspeak3-client-current}"

mkdir -p "$XDG_RUNTIME_DIR" "$PULSE_RUNTIME_PATH" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$APP_HOME/logs"
chmod 700 "$XDG_RUNTIME_DIR" "$PULSE_RUNTIME_PATH"

# Singleton guard: only the systemd-owned supervisor may run the TeamSpeak client.
LOCKFILE="$APP_HOME/data/teamspeak-client.lock"
exec 9>"$LOCKFILE"
if ! flock -n 9; then
  exit 0
fi

# pgrep/pkill -x cannot match names longer than 15 chars on procps.
# Use a command-line anchored match so the real TS3 binary is always managed.
ts_pids() {
  pgrep -u "$(id -u)" -f '^\./ts3client_linux_amd64( |$)' 2>/dev/null || true
}
kill_ts_clients() {
  local sig="${1:-TERM}"
  local pids
  pids="$(ts_pids)"
  if [ -n "$pids" ]; then
    kill -"$sig" $pids >/dev/null 2>&1 || true
  fi
}
kill_ts_wrappers() {
  local pids
  pids="$(pgrep -u "$(id -u)" -f 'ts3client_runscript\.sh' 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    kill -TERM $pids >/dev/null 2>&1 || true
  fi
}

write_runtime() {
  local st="$1"
  local err="${2:-}"
  local msg="${3:-}"
  local pid="${CLIENT:-}"
  python3 - "$RUNTIME" "$st" "$err" "$msg" "$pid" <<'PY'
import json,sys,os,tempfile,time
p,st,err,msg,pid=sys.argv[1:]
d={"state":st,"lastError":err,"lastMessage":msg,"lastChange":time.strftime("%Y-%m-%dT%H:%M:%S%z"),"pid":int(pid) if pid.isdigit() else None}
fd,tmp=tempfile.mkstemp(prefix=".teamspeak-runtime.",dir=os.path.dirname(p))
with os.fdopen(fd,"w") as f:
    json.dump(d,f,indent=2); f.write("\n")
os.chmod(tmp,0o640)
os.replace(tmp,p)
PY
}

read_cfg() {
  CONNECTHOST=""
  eval "$(python3 - "$CFG" <<'PY'
import json,sys,shlex
d=json.load(open(sys.argv[1]))
keys=("enabled","connectRequested","serverHost","connectHost","voicePort","serverPassword","nickname",
      "channelName","channelPassword","channelId","autoReconnect","reconnectDelaySec")
for k in keys:
    v=d.get(k, True if k in ("enabled","connectRequested","autoReconnect") else "")
    print(k.upper()+"="+shlex.quote(str(v)))
PY
)"
}


query_connected() {
  python3 - "$APP_HOME/.ts3client/clientquery.ini" <<'PY'
import socket,sys
from pathlib import Path
api=""
try:
    for line in Path(sys.argv[1]).read_text(errors="ignore").splitlines():
        if line.startswith("api_key="):
            api=line.split("=",1)[1].strip()
except Exception:
    raise SystemExit(1)
if not api:
    raise SystemExit(1)
try:
    s=socket.create_connection(("127.0.0.1",25639),2)
    s.settimeout(2)
    def cmd(c):
        s.sendall((c+"\n").encode())
        d=b""
        while b"error id=" not in d:
            x=s.recv(16384)
            if not x:
                break
            d+=x
        return d.decode("utf8","replace")
    cmd("auth apikey="+api)
    cmd("use 1")
    out=cmd("whoami")
    s.close()
    raise SystemExit(0 if "error id=1794" not in out else 1)
except Exception:
    raise SystemExit(1)
PY
}

while true; do
  read_cfg
  RECONNECTDELAYSEC="\${RECONNECTDELAYSEC:-5}"
  AUTORECONNECT="\${AUTORECONNECT:-True}"

  if [ "$ENABLED" != "True" ] && [ "$ENABLED" != "true" ] && [ "$ENABLED" != "1" ]; then
    write_runtime "disabled" "" "bridge disabled"
    sleep 3
    continue
  fi

  if [ "$CONNECTREQUESTED" != "True" ] && [ "$CONNECTREQUESTED" != "true" ] && [ "$CONNECTREQUESTED" != "1" ]; then
    write_runtime "disconnected" "" "waiting for CONNECT"
    sleep 2
    continue
  fi

  rm -f "/tmp/.X${DISPLAY#:}-lock"

  Xvfb "$DISPLAY" -screen 0 1280x900x24 -nolisten tcp -extension RANDR >"$APP_HOME/logs/ts-xvfb.log" 2>&1 &
  XVFB=$!
  trap 'if [ -n "${CLIENT:-}" ]; then kill "$CLIENT" >/dev/null 2>&1 || true; fi; if [ -n "${CLIENT_WRAPPER:-}" ]; then kill "$CLIENT_WRAPPER" >/dev/null 2>&1 || true; fi; kill_ts_clients TERM; sleep 0.1; kill_ts_clients KILL; kill_ts_wrappers; pulseaudio --kill >/dev/null 2>&1 || true; kill "$XVFB" >/dev/null 2>&1 || true' EXIT INT TERM
  sleep 2

  unset PULSE_SERVER
  if [ -f "$PULSE_RUNTIME_PATH/pid" ]; then
    PA_OLD_PID=$(cat "$PULSE_RUNTIME_PATH/pid" 2>/dev/null || true)
    if [ -z "$PA_OLD_PID" ] || ! kill -0 "$PA_OLD_PID" 2>/dev/null; then
      rm -f "$PULSE_RUNTIME_PATH/pid" "$PULSE_RUNTIME_PATH/native"
    fi
  fi
  pulseaudio --file=/etc/pulse/default.pa --start --exit-idle-time=-1 >"$APP_HOME/logs/ts-pulse.log" 2>&1 || true
  PA_READY=0
  for _ in $(seq 1 20); do
    if [ -S "$PULSE_RUNTIME_PATH/native" ]; then PA_READY=1; break; fi
    sleep 0.25
  done
  if [ "$PA_READY" -ne 1 ]; then
    write_runtime "error" "pulseaudio_unavailable" "PulseAudio socket did not become ready"
    sleep 2
    continue
  fi
  export PULSE_SERVER=unix:"$PULSE_RUNTIME_PATH/native"
  sleep 1

  CFG_MTIME=$(stat -c %Y.%N "$CFG" 2>/dev/null || echo 0)
  LOG_START=$(wc -l <"$LOG" 2>/dev/null || echo 0)

  CONNECTHOST="${CONNECTHOST:-$SERVERHOST}"

  CONNECT_URL=$(python3 - "$CONNECTHOST" "$VOICEPORT" "$SERVERPASSWORD" "$NICKNAME" "$CHANNELID" "$CHANNELPASSWORD" "$CHANNELNAME" <<'PY'
import sys
from urllib.parse import quote
host,port,server_pw,nick,cid,cpw,cname=sys.argv[1:]
params=[("port",port),("nickname",nick)]
if cid and cid != "0":
    params.append(("cid",cid))
elif cname:
    params.append(("channel",cname))
if cpw:
    params.append(("channelpassword",cpw))
if server_pw:
    params.append(("password",server_pw))
q="&".join(quote(k,safe="")+"="+quote(v,safe="") for k,v in params)
print("ts3server://"+host+"?"+q)
PY
)

  write_runtime "connecting" "" "connecting to $SERVERHOST:$VOICEPORT"

  if [ ! -x "$TSCLIENT_DIR/ts3client_linux_amd64" ]; then write_runtime "error" "client_missing" "TeamSpeak client binary missing: $TSCLIENT_DIR"; sleep 10; continue; fi

  # Ensure this service owns exactly one TeamSpeak client instance.
  kill_ts_clients TERM
  kill_ts_wrappers
  sleep 0.5
  # Old TS3 clients occasionally ignore TERM; do not launch a second instance.
  kill_ts_clients KILL
  sleep 0.2

  if [[ "$TSCLIENT_DIR" == *"3.0.19.4"* ]]; then
    env -u OPENSSL_CONF -u OPENSSL_MODULES LD_PRELOAD="$TSCLIENT_DIR/libssl.so.1.0.0:$TSCLIENT_DIR/libcrypto.so.1.0.0" LD_LIBRARY_PATH="$TSCLIENT_DIR" "$TSCLIENT_DIR/ts3client_runscript.sh" -nosingleinstance "$CONNECT_URL" >>"$LOG" 2>&1 &
  else
    env OPENSSL_CONF=/dev/null OPENSSL_MODULES=/usr/lib/x86_64-linux-gnu/ossl-modules LD_LIBRARY_PATH="$TSCLIENT_DIR" "$TSCLIENT_DIR/ts3client_runscript.sh" -nosingleinstance "$CONNECT_URL" >>"$LOG" 2>&1 &
  fi
  CLIENT_WRAPPER=$!
  CLIENT=$CLIENT_WRAPPER
  for _ in $(seq 1 30); do
    REAL_CLIENT=$(ts_pids | tail -n 1 || true)
    if [ -n "$REAL_CLIENT" ]; then CLIENT="$REAL_CLIENT"; break; fi
    if ! kill -0 "$CLIENT_WRAPPER" 2>/dev/null; then break; fi
    sleep 0.1
  done

  # TeamSpeak 3.1.x may present the cached license agreement on first
  # headless start. Accept it automatically so the voice session is not
  # dropped by the modal dialog.
  (
    for _ in $(seq 1 100); do
      if command -v xdotool >/dev/null 2>&1; then
        for wid in $(DISPLAY="$DISPLAY" xdotool search --name "^I accept$" 2>/dev/null || true); do
          DISPLAY="$DISPLAY" xdotool windowactivate "$wid" key Return >/dev/null 2>&1 || true
        done
        for wid in $(DISPLAY="$DISPLAY" xdotool search --name "^I Accept$" 2>/dev/null || true); do
          DISPLAY="$DISPLAY" xdotool windowactivate "$wid" key Return >/dev/null 2>&1 || true
        done
      fi
      sleep 0.1
    done
  ) &

  connected_seen=0
  CONNECTED_ONCE=0
  DISCONNECT_STREAK=0
  DISCONNECTED_AT=0
  CLIENT_START_EPOCH=$(date +%s)
  CHANNEL_TICK=0

  while kill -0 "$CLIENT" 2>/dev/null; do
    sleep 2

    # TeamSpeak 3.1.x warns that the settings database is from a newer client.
    # In headless operation we explicitly choose Ignore so startup can continue.
    if command -v xdotool >/dev/null 2>&1; then
      for wid in $(DISPLAY=:100 xdotool search --name "^Information$" 2>/dev/null || true); do
        DISPLAY=:100 xdotool key --window "$wid" Tab Return >/dev/null 2>&1 || true
      done
    fi

    # ClientQuery is the authoritative voice-session health signal.
    # The TS3 GUI process can remain alive after its voice connection drops.
    if [ "$CONNECTED_ONCE" -eq 1 ]; then
      if query_connected >/dev/null 2>&1; then
        write_runtime "connected" "" "TeamSpeak voice connection established"
        DISCONNECT_STREAK=0
        DISCONNECTED_AT=0
      else
        DISCONNECT_STREAK=$((DISCONNECT_STREAK + 1))
        if [ "$DISCONNECT_STREAK" -ge 2 ]; then
          DISCONNECTED_AT=$(date +%s)
          write_runtime "connecting" "" "ClientQuery reports TeamSpeak disconnected; restarting client"
          kill "$CLIENT" 2>/dev/null || true
          if [ -n "$CLIENT_WRAPPER" ]; then kill "$CLIENT_WRAPPER" 2>/dev/null || true; fi
          kill_ts_clients TERM
          break
        fi
      fi
    fi

    NEW_LINES=$(wc -l <"$LOG" 2>/dev/null || echo 0)
    if [ "$NEW_LINES" -gt "$LOG_START" ]; then
      CHUNK=$(sed -n "$((LOG_START+1)),$NEW_LINES p" "$LOG" 2>/dev/null || true)

      if printf '%s\n' "$CHUNK" | grep -Eq "Connect status: Connected|Connection established"; then
        if [ "$CONNECTED_ONCE" -eq 0 ]; then
          CONNECTED_ONCE=1
          connected_seen=1
          DISCONNECT_STREAK=0
          write_runtime "connected" "" "TeamSpeak voice connection established"
        fi
      fi

      if printf '%s\n' "$CHUNK" | grep -Eq "Connect status: Disconnected|Failed to connect to server"; then
        DISCONNECT_STREAK=$((DISCONNECT_STREAK + 1))
        [ "$DISCONNECTED_AT" -eq 0 ] && DISCONNECTED_AT=$(date +%s)
        write_runtime "disconnected" "" "TeamSpeak voice disconnected; reconnect watchdog active"
      fi
      if printf '%s\n' "$CHUNK" | grep -Eq "Connect status: Connection established"; then
        DISCONNECT_STREAK=0
        DISCONNECTED_AT=0
      fi

      LOG_START=$NEW_LINES
    fi


    # TeamSpeak client reports autoreconnect=0 and can remain alive while disconnected.
    # Force a clean client-cycle after a confirmed disconnect; outer loop reconnects in 5s.
    if [ "$DISCONNECTED_AT" -gt 0 ] && [ $(( $(date +%s) - DISCONNECTED_AT )) -ge 3 ]; then
      write_runtime "connecting" "" "disconnect watchdog: restarting TeamSpeak client in ${RECONNECTDELAYSEC}s"
      kill "$CLIENT" 2>/dev/null || true; [ -n "${CLIENT_WRAPPER:-}" ] && kill "$CLIENT_WRAPPER" 2>/dev/null || true; kill_ts_clients TERM
      break
    fi


    NEW_MTIME=$(stat -c %Y.%N "$CFG" 2>/dev/null || echo 0)
    if [ "$NEW_MTIME" != "$CFG_MTIME" ]; then
      write_runtime "connecting" "" "configuration changed"
      kill "$CLIENT" 2>/dev/null || true; [ -n "${CLIENT_WRAPPER:-}" ] && kill "$CLIENT_WRAPPER" 2>/dev/null || true; kill_ts_clients TERM
      break
    fi
  done

  wait "$CLIENT" 2>/dev/null || true

  pulseaudio --kill >/dev/null 2>&1 || true
  kill "$XVFB" >/dev/null 2>&1 || true
  trap - EXIT INT TERM

  read_cfg

  if [ "$CONNECTREQUESTED" = "True" ] || [ "$CONNECTREQUESTED" = "true" ] || [ "$CONNECTREQUESTED" = "1" ]; then
    if [ "$AUTORECONNECT" = "True" ] || [ "$AUTORECONNECT" = "true" ] || [ "$AUTORECONNECT" = "1" ]; then
      write_runtime "connecting" "" "auto reconnect in ${RECONNECTDELAYSEC}s"
      sleep "${RECONNECTDELAYSEC:-5}"
    else
      write_runtime "disconnected" "" "auto reconnect disabled"
      sleep 2
    fi
  else
    write_runtime "disconnected" "" "waiting for CONNECT"
    sleep 2
  fi
done
