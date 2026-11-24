# Claude Agent's shell on a Cloud computer (CLAUDE_ENV_FILE, cloudLink/tools.ts). claude itself starts with the
# system directories first on PATH, so nothing in the agent's home stands in for a git or shell it starts. The
# agent's own commands get the tools container's PATH back: mise's toolchains first, as setup installed them.
export PATH="${MISE_DATA_DIR:-$HOME/.local/share/mise}/shims:$HOME/.local/bin:$PATH"
