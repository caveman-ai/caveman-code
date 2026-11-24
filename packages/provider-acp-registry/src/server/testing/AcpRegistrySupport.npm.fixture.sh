#!/bin/sh
# Ported from T3 Code (MIT), packages/provider-acp-registry/src/server/testing/AcpRegistrySupport.npm.fixture.sh @ ab3a3cd1.
# Settings written beside the fake reach it under an ACP agent's contained environment too.
[ -r "$0.env" ] && . "$0.env"
printf '%s\n' "$*" >> "$FAKE_NPM_LOG"
prefix="${npm_config_prefix:-$FAKE_NPM_PREFIX}"
# npm's layouts: <prefix>/lib/node_modules and <prefix>/bin/<command>; on Windows (Git Bash
# runs this there) <prefix>/node_modules and a <prefix>/<command>.cmd shim.
case "$OSTYPE" in
  msys* | cygwin*) root="$prefix/node_modules" executable="$prefix/example-agent.cmd" ;;
  *) root="$prefix/lib/node_modules" executable="$prefix/bin/example-agent" ;;
esac
if [ "$1" = "root" ] && [ "$2" = "--global" ]; then
  printf '%s\n' "$root"
  exit 0
fi
if [ "$1" = "prefix" ] && [ "$2" = "--global" ]; then
  printf '%s\n' "$prefix"
  exit 0
fi
if [ "$1" = "install" ] && [ "$2" = "--global" ]; then
  # The variables a package's install scripts would see.
  awk 'BEGIN { for (name in ENVIRON) print "env " name }' >> "$FAKE_NPM_LOG"
  package_root="$root/@example/acp"
  mkdir -p "$package_root" "${executable%/*}"
  printf '%s' "$FAKE_NPM_MANIFEST" > "$package_root/package.json"
  printf '#!/bin/sh\n' > "$executable"
  chmod 755 "$executable"
  exit 0
fi
exit 64
