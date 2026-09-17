#!/bin/sh
# Dispatches the CLI verbs. Anything else runs verbatim, which keeps `sh` available for a poke around.
set -e
case "$1" in
  scan|rate|apply|report|refit|freeze|help)
    exec node /app/dist/cli.js "$@"
    ;;
  *)
    exec "$@"
    ;;
esac
