#!/bin/sh
# PreToolUse guard for Bash: refuse the commands that read from, write into, or
# copy out an identity root.
#
# This workstation keeps one CLOUDSDK_CONFIG root per identity. A gcloud call
# without that prefix does not fail; it uses the shared global config and
# whatever account is active there. That is how Credilex credentials once ended
# up in the shared root and how a permission error was misread.
#
# The roots are also reachable without gcloud ever appearing in the command: a
# container or a remote host can simply be handed the directory. A container on
# this Mac was already reading the ambient root through one compose volume line,
# and a `-v` of the gcloud config passed this guard untouched. So the guard
# judges the mounts and the copies too, not only the gcloud invocations.
#
# Reads the hook payload on stdin. Exit 2 blocks the call and returns the
# message on stderr.
set -eu

payload=$(cat)
command=$(printf '%s' "$payload" | jq -r '.tool_input.command // ""')
cwd=$(printf '%s' "$payload" | jq -r '.cwd // ""')

[ -n "$command" ] || exit 0

# An identity root, however it is spelled: the ambient root, any profile root,
# the ADC file, or a credential store inside one of them.
GCLOUD_PATH='([.]config/gcloud|GOOGLE_APPLICATION_CREDENTIALS|application_default_credentials[.]json|access_tokens[.]db|credentials[.]db)'
# Ways of handing a path to something other than a local gcloud.
TRANSFER_VERB='(docker|docker-compose|podman|nerdctl|colima|limactl|vagrant|kubectl|ssh|scp|rsync)'

deny() {
  printf 'BLOCKED by gcloud-guard: %s\n' "$1" >&2
  printf 'Use the profile-aware router instead:\n' >&2
  printf '  devo gcloud --profile <name> [--project <id>] -- <gcloud args...>\n' >&2
  printf '  devo auth repair <profile>     # the only sanctioned credential repair\n' >&2
  printf 'Known profiles: devo profiles\n' >&2
  exit 2
}

deny_transfer() {
  printf 'BLOCKED by gcloud-guard: %s\n' "$1" >&2
  printf 'An identity root must never be mounted into, or copied to, anything else:\n' >&2
  printf '  docker run -v <gcloud path>:<path>   docker cp   ssh   scp   rsync   limactl\n' >&2
  printf 'That is how a container on this Mac was reading the ambient shared root.\n' >&2
  printf 'Keep the roots off every mount, and route gcloud calls through the profile:\n' >&2
  printf '  devo gcloud --profile <name> [--project <id>] -- <gcloud args...>\n' >&2
  printf 'Known profiles: devo profiles\n' >&2
  exit 2
}

# A compose file hides the mount from the command line, so the file itself is
# read. Judged before the gcloud trigger below, because `docker compose up -d`
# names neither gcloud nor a path.
case "$command" in
  *"docker compose"*|*docker-compose*|*"podman compose"*)
    compose_files=$(printf '%s' "$command" | tr ' =' '\n\n' | grep -E '\.ya?ml$' || true)
    if [ -z "$compose_files" ]; then
      # Compose walks up from the working directory: measured on v2.36, a call in
      # a subdirectory with no compose file of its own resolves the parent's.
      # So the guard walks up too and stops at the first directory that has one,
      # which is where Compose would stop. Without this, `cd sub && docker
      # compose up` hands over the root one directory deeper than the check.
      #
      # The `if` is not decoration: a cycle whose last test fails returns 1, and
      # under `set -e` a command substitution that exits non-zero kills the whole
      # guard -- which would turn a deny into a silent pass-through.
      compose_files=$(directory=${cwd:-.}
      while [ -n "$directory" ]; do
        found=""
        for candidate in compose.yaml compose.yml docker-compose.yaml docker-compose.yml; do
          if [ -f "$directory/$candidate" ]; then
            printf '%s\n' "$directory/$candidate"
            found=yes
          fi
        done
        [ -n "$found" ] && break
        parent=$(dirname "$directory")
        [ "$parent" = "$directory" ] && break
        directory=$parent
      done
      true)
    fi
    for compose_file in $compose_files; do
      case "$compose_file" in
        /*) compose_path=$compose_file ;;
        *) compose_path=${cwd:-.}/$compose_file ;;
      esac
      [ -f "$compose_path" ] || continue
      hit=$(grep -nE "$GCLOUD_PATH" "$compose_path" 2>/dev/null | head -3 || true)
      if [ -n "$hit" ]; then
        deny_transfer "the compose file $compose_path mounts or names a gcloud identity root:
  $hit"
      fi
    done
    ;;
esac

# Everything below is about gcloud itself or about a credential store on disk;
# a command naming none of them has nothing to answer for.
printf '%s' "$command" | grep -qE '(gcloud|GOOGLE_APPLICATION_CREDENTIALS|application_default_credentials|access_tokens[.]db|credentials[.]db)' || exit 0

# A command-leading CLOUDSDK_CONFIG assignment pins one profile for one local
# process. The root is not handed over: the docker CLI and the credential helper
# it spawns are themselves local, and pinning the root is what the identity rules
# require of every one of them. Reading the prefix as a transfer made the guard
# refuse the registry push of a release, so the assignment is dropped before the
# transfer test -- and in that spelling only. A root still named as an argument is
# a mount, a copy or a build context, which is the incident this guard exists for:
#   CLOUDSDK_CONFIG=<root> docker push ...    dropped, judged below
#   docker run -v <root>:<path> ...           kept, denied
#   docker run -e CLOUDSDK_CONFIG=<root> ...  kept, denied: not command-leading
# "Command-leading" is shell grammar, not a special case: an assignment may follow
# a separator or open a subshell or a process substitution, and each of those
# begins a command word.
judged=$(printf '%s' "$command" | sed -E 's/(^|[;|&({])[[:space:]]*CLOUDSDK_CONFIG=[^[:space:];|&)]*/\1/g')

# A transfer verb plus a root path: the directory leaves, or enters, the machine
# without gcloud being called at all.
if printf '%s' "$judged" | grep -qE "(^|[[:space:];|&(])${TRANSFER_VERB}[[:space:]]" \
  && printf '%s' "$judged" | grep -qE "$GCLOUD_PATH"; then
  deny_transfer "this hands a gcloud identity root to a container or to another host."
fi

# A ban is judged per shell segment, so a correct prefix elsewhere on the line
# cannot launder an unprefixed call.
unprefixed=$(printf '%s' "$command" | tr ';|&' '\n\n\n' \
  | grep -E 'gcloud[[:space:]]+(auth[[:space:]]+(login|application-default)|config[[:space:]]+configurations[[:space:]]+activate)' \
  | grep -v 'CLOUDSDK_CONFIG=' || true)

if [ -n "$unprefixed" ]; then
  deny "gcloud authentication/configuration command without CLOUDSDK_CONFIG:
  $unprefixed"
fi

if printf '%s' "$command" | grep -q -- '--update-adc'; then
  deny "--update-adc overwrites the application default credentials of the ambient root."
fi

if printf '%s' "$command" | grep -qE '(access_tokens\.db|credentials\.db|application_default_credentials\.json)'; then
  deny "reading or copying a gcloud credential store is never allowed."
fi

exit 0
