# Development environment for the local CLI and daemon sessions.
# Sourced, not executed. Secrets stay mode 0600 under the state directory and
# are never printed. Same files pages-dev.sh uses, so the three sessions share
# one operator token.
if [[ -z "${OPENSESAME_DEV_ENV_LOADED:-}" ]]; then
  export OPENSESAME_DEV_ENV_LOADED=1
  _os_dev_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  export OPENSESAME_ENV="${OPENSESAME_ENV:-development}"
  export OPENSESAME_ALLOW_DEV_DEFAULTS="${OPENSESAME_ALLOW_DEV_DEFAULTS:-1}"
  umask 077
  _os_secret_dir="${OPENSESAME_DEV_SECRET_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/opensesame/development}"
  mkdir -p "$_os_secret_dir"
  chmod 700 "$_os_secret_dir"
  for _os_name in OPENSESAME_OPERATOR_TOKEN OPENSESAME_CLAIM_PEPPER OPENSESAME_CONNECTION_KEY OPENSESAME_RECEIPT_SIGNING_KEY; do
    if [[ -z "${!_os_name:-}" ]]; then
      _os_path="$_os_secret_dir/$_os_name"
      if [[ ! -e "$_os_path" ]]; then
        (set -o noclobber; openssl rand -base64 32 > "$_os_path") || return 1
      fi
      [[ -f "$_os_path" && ! -L "$_os_path" && -O "$_os_path" ]] || return 1
      chmod 600 "$_os_path"
      export "$_os_name=$(<"$_os_path")"
    fi
  done
  mkdir -p "$_os_dev_root/.tools/run"
  export OPENSESAME_DB="${OPENSESAME_DB:-sqlite://${_os_dev_root}/.tools/run/opensesame.db?mode=rwc}"
  # Host defaults (https://opensesame.local, https://keycloak.local) are not
  # loopback, so development defaults refuse to boot until these are local.
  export OPENSESAME_LISTEN="${OPENSESAME_LISTEN:-127.0.0.1:8787}"
  export OPENSESAME_PUBLIC_URL="${OPENSESAME_PUBLIC_URL:-http://127.0.0.1:8787}"
  export OPENSESAME_RESOURCE="${OPENSESAME_RESOURCE:-$OPENSESAME_PUBLIC_URL}"
  export OPENSESAME_HOST_API="${OPENSESAME_HOST_API:-$OPENSESAME_PUBLIC_URL}"
  export OPENSESAME_ISSUER="${OPENSESAME_ISSUER:-http://127.0.0.1:8788}"
  export OPENSESAME_IDENTITY_API="${OPENSESAME_IDENTITY_API:-$OPENSESAME_ISSUER}"
  export OPENSESAME_DAEMON_LISTEN="${OPENSESAME_DAEMON_LISTEN:-127.0.0.1:18790}"
  export OPENSESAME_DAEMON_API="${OPENSESAME_DAEMON_API:-http://127.0.0.1:18790}"
  export OPENSESAME_CORS_ORIGINS="${OPENSESAME_CORS_ORIGINS:-http://127.0.0.1:5180,http://localhost:5180}"
  unset _os_dev_root _os_secret_dir _os_name _os_path
fi
