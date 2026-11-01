# shellcheck shell=sh disable=SC2123
# managed-by: tyler-dotfiles
# Personal PATH for checksum-pinned CLIs (~/.local/bin) and mise shims.
# install.sh sources this from ~/.bashrc and ~/.profile. Non-interactive
# shells that never read those files still see the CLIs when the image
# already puts ~/.local/bin on PATH.
export MISE_DATA_DIR="${MISE_DATA_DIR:-${HOME}/.local/share/mise}"
export MISE_CACHE_DIR="${MISE_CACHE_DIR:-${HOME}/.cache/mise}"
case ":${PATH}:" in
  *:"${HOME}/.local/bin":*) ;;
  *) PATH="${HOME}/.local/bin${PATH:+:${PATH}}" ;;
esac
case ":${PATH}:" in
  *:"${MISE_DATA_DIR}/shims":*) ;;
  *) PATH="${MISE_DATA_DIR}/shims${PATH:+:${PATH}}" ;;
esac
export PATH
if [ -f "${HOME}/.config/tyler-dotfiles/stitch-env.sh" ]; then
  # shellcheck disable=SC1091
  . "${HOME}/.config/tyler-dotfiles/stitch-env.sh"
fi
