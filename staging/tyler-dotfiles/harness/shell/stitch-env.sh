# shellcheck shell=sh
# managed-by: tyler-dotfiles
# Optional personal Stitch key. The file is not created or committed.
# Put the key in ~/.config/tyler-dotfiles/stitch-api-key (mode 600).
key_file="${HOME}/.config/tyler-dotfiles/stitch-api-key"
if [ -f "${key_file}" ]; then
  STITCH_API_KEY="$(tr -d '\r\n' < "${key_file}")"
  export STITCH_API_KEY
fi
