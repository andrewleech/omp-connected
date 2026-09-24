#!/usr/bin/env bash
# Install omp-connected on this host: checks omp and tmux, links the
# extension as an OMP plugin, and links `ompc` into ~/.local/bin.
# Idempotent — re-run after updating this checkout.
set -euo pipefail

repo=$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")
bin_dir=${OMPC_BIN_DIR:-$HOME/.local/bin}
host_env=${OMP_HOST_ENV:-${XDG_CONFIG_HOME:-$HOME/.config}/omp-connected/omp-host.env}
readme="$repo/README.md#adding-hosts-to-the-fleet"

ok() { printf '  ok    %s\n' "$*"; }
warn() { printf '  warn  %s\n' "$*"; }
die() { printf '  error %s\n' "$*" >&2; exit 1; }

echo "omp-connected: installing from $repo"

# omp — non-interactive shells (ssh host cmd) often lack the installers'
# PATH entries, so also look where bun and the official installer put it.
# Either build works: the standalone binary or the bun install.
omp=$(command -v omp || true)
for candidate in "$HOME/.bun/bin/omp" "$HOME/.local/bin/omp"; do
	[[ -n $omp ]] && break
	[[ -x $candidate ]] && omp=$candidate
done
[[ -n $omp ]] || die "omp not found. Install it with: curl -fsSL https://omp.sh/install | sh"
# A bun-installed omp is a bun script; make bun resolvable for it.
[[ -d $HOME/.bun/bin ]] && PATH="$PATH:$HOME/.bun/bin"
ok "omp $("$omp" --version 2>/dev/null | tail -n1) ($omp)"

# tmux — ompc refuses to start without it; the bundled config wants 3.5+.
command -v tmux >/dev/null 2>&1 || die "tmux not found. Install it with your package manager (3.5+ recommended)."
tmux_version=$(tmux -V | sed -E 's/^tmux (next-)?//')
if [[ $(printf '%s\n' 3.5 "$tmux_version" | sort -V | head -n1) == 3.5 ]]; then
	ok "tmux $tmux_version"
else
	warn "tmux $tmux_version: works, but 3.5+ is needed for csi-u modified keys (e.g. Shift+Enter) and 3.3+ for clipboard/image passthrough"
fi

# Extension — `omp plugin link` replaces an existing link, so re-running is safe.
"$omp" plugin link "$repo/extension" >/dev/null
ok "plugin omp-connected linked -> $repo/extension"

# Launcher — a symlink, so updates to this checkout take effect immediately.
mkdir -p "$bin_dir"
ln -sfn "$repo/extension/bin/ompc" "$bin_dir/ompc"
ok "ompc linked -> $bin_dir/ompc"
case ":$PATH:" in
	*":$bin_dir:"*) ;;
	*) warn "$bin_dir is not on PATH in this shell (most distros add it via ~/.profile at login; check with a new login shell)" ;;
esac

# Hub connection — reported, not configured: the URL, token, and relay are
# per-fleet. See the README section for what to set.
echo "Hub connection:"
if [[ -f $host_env ]] && grep -q '^OMP_HUB_URL=' "$host_env" && grep -q '^OMP_HUB_HOST_TOKEN=' "$host_env"; then
	ok "$host_env ($(sed -n 's/^OMP_HUB_URL=//p' "$host_env"))"
else
	warn "$host_env missing OMP_HUB_URL / OMP_HUB_HOST_TOKEN — sessions won't register with a hub"
fi
relay=$("$omp" config get collab.relayUrl 2>/dev/null || true)
autostart=$("$omp" config get collab.autoStart 2>/dev/null || true)
if [[ -n $relay && -n $autostart && $autostart != off ]]; then
	ok "collab.relayUrl=$relay collab.autoStart=$autostart"
else
	warn "collab.relayUrl / collab.autoStart not set — sessions can't register without a Collab host"
fi
echo "Hub setup and per-host configuration: $readme"
