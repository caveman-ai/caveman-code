#!/bin/sh
# Ported from T3 Code (MIT), packages/provider-acp-registry/src/server/testing/AcpRegistrySupport.uv.fixture.sh @ ab3a3cd1.
# Settings written beside the fake reach it under an ACP agent's contained environment too.
[ -r "$0.env" ] && . "$0.env"
printf '%s\n' "$*" >> "$FAKE_UV_LOG"
tool_bin="${UV_TOOL_BIN_DIR:-$FAKE_UV_BIN}"
# uv puts an .exe launcher in its bin directory on Windows (Git Bash runs this there).
case "$OSTYPE" in
  msys* | cygwin*) executable="$tool_bin/fast-agent.exe" ;;
  *) executable="$tool_bin/fast-agent" ;;
esac
printf "tool-dir=%s bin-dir=%s\n" "$UV_TOOL_DIR" "$UV_TOOL_BIN_DIR" >> "$FAKE_UV_LOG"
if [ "$1" = "tool" ] && [ "$2" = "dir" ] && [ "$3" = "--bin" ]; then
  printf '%s\n' "$tool_bin"
  exit 0
fi
if [ "$1" = "tool" ] && [ "$2" = "list" ]; then
  if [ -x "$executable" ]; then
    printf 'fast-agent-acp v0.10.1\n- fast-agent\n'
  fi
  exit 0
fi
if [ "$1" = "tool" ] && [ "$2" = "install" ] && [ "$3" = "--force" ]; then
  # The variables an sdist build would see.
  awk 'BEGIN { for (name in ENVIRON) print "env " name }' >> "$FAKE_UV_LOG"
  mkdir -p "$tool_bin"
  printf '#!/bin/sh\n' > "$executable"
  chmod 755 "$executable"
  exit 0
fi
exit 64
