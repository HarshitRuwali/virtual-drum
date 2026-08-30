#!/usr/bin/env bash
# Issue the self-signed certificate the dev server needs.
#
# WHY THIS EXISTS: getUserMedia is gated on a secure context. `http://localhost`
# is exempt by spec, `http://10.10.50.125:5199` is not -- and the failure is
# silent-ish: Chrome does not even define `navigator.mediaDevices` on an
# insecure origin, so the app dies on a TypeError that says nothing about TLS.
# Testing the tool on the machine that has the camera therefore needs HTTPS.
#
# Runs inside the compose `certs` service (PLAN 9), never on the host: openssl
# is taken from the node image, not installed here.
set -euo pipefail

dir="${VD_CERT_DIR:-docker/certs}"
key="$dir/dev-key.pem"
crt="$dir/dev-cert.pem"
stamp="$dir/.hosts"

hosts="localhost,127.0.0.1,::1${VD_HOSTS:+,$VD_HOSTS}"

# Split into DNS: / IP: entries and de-duplicate. openssl rejects a hostname
# under IP:, and a browser ignores an address that is only listed under DNS:,
# so guessing wrong here produces a cert that looks fine and is not accepted.
san=""
seen=","
for h in $(printf '%s' "$hosts" | tr ',' ' '); do
  case "$seen" in *",$h,"*) continue ;; esac
  seen="$seen$h,"
  if printf '%s' "$h" | grep -Eq '^[0-9]+(\.[0-9]+){3}$|:'; then
    san="$san,IP:$h"
  else
    san="$san,DNS:$h"
  fi
done
san="${san#,}"

mkdir -p "$dir"

# Re-issuing on every `up` would invalidate the browser exception the user
# already clicked through, on every restart. Only the host list forces a reissue.
if [ -f "$key" ] && [ -f "$crt" ] && [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$san" ]; then
  echo "cert: current, covers $san"
  exit 0
fi

openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 365 \
  -keyout "$key" -out "$crt" \
  -subj "/CN=virtual-drum dev" \
  -addext "subjectAltName=$san" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth" 2>/dev/null

# The key is a credential even though it is throwaway: keep it off the terminal
# and off other users on this box.
chmod 600 "$key"
chmod 644 "$crt"
printf '%s' "$san" > "$stamp"
echo "cert: issued, covers $san"
