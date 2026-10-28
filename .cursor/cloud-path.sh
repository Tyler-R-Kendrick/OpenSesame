# Shared PATH setup for login, interactive and BASH_ENV cloud shells.
case ":${PATH:-}:" in
  *:/usr/local/bin:*) ;;
  *) PATH="/usr/local/bin${PATH:+:$PATH}" ;;
esac
if [ -n "${HOME:-}" ]; then
  case ":${PATH}:" in
    *:"${HOME}/.local/bin":*) ;;
    *) PATH="${HOME}/.local/bin${PATH:+:$PATH}" ;;
  esac
  if [ -d "${HOME}/.kimi-code/bin" ]; then
    case ":${PATH}:" in
      *:"${HOME}/.kimi-code/bin":*) ;;
      *) PATH="${HOME}/.kimi-code/bin:${PATH}" ;;
    esac
  fi
fi
export PATH
