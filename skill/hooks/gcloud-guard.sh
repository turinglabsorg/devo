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
# A copy off this disk leaves the root as surely as a mount leaves the machine,
# and a copy is what gets committed by accident, so the copying tools are judged
# with the mount. And nothing here rests on spelling: the text is first read the way
# the shell reads it, so a verb is the tool it names (`/bin/cp`, `\cp`, `c\p`,
# another case) and a root is the directory it denotes (`~/.config//gcloud`,
# `~/.config/./gcloud`, `gclou\d`), a root is recognised both as a path and as the
# variable that can point at one, a pin is read as the value it names rather than as
# a word to be dropped, and the compose file is read because it hides a mount from
# the command line -- from the directory Compose itself would use, which is the one
# a `cd` on the same line changes. A `cd` whose target the shell builds (`$VAR`) is
# not a directory this text can read, and a compose call after one is refused rather
# than passed: the file that would be read is the one thing the rule cannot see.
# What these rules still cannot see is recorded as a residual test in
# test/gcloud-guard.test.mjs rather than claimed here: a root the shell builds out
# of parts this text does not contain (a glob, a brace, a command substitution over
# a directory that is not itself a root), a compose file pulled in by `include:`,
# a copying tool that is not on the list, and a root under a
# DEVO_GCLOUD_PROFILES_DIR other than the one this workstation keeps.
#
# Reads the hook payload on stdin. Exit 2 blocks the call and returns the
# message on stderr.
set -eu

payload=$(cat)
command=$(printf '%s' "$payload" | jq -r '.tool_input.command // ""')
cwd=$(printf '%s' "$payload" | jq -r '.cwd // ""')

[ -n "$command" ] || exit 0

# An identity root, however it is spelled: the ambient root, any profile root,
# the ADC file, a credential store inside one of them, or the variable the
# identity rules name a root with. Matched case-insensitively further down: on a
# case-insensitive filesystem another case is the same directory, and the spelling
# of a variable that points at a root is a root named.
GCLOUD_PATH='([.]config/gcloud|GOOGLE_APPLICATION_CREDENTIALS[=/]|CLOUDSDK_CONFIG|application_default_credentials[.]json|legacy_credentials|access_tokens[.]db|credentials[.]db)'
# Ways of handing a path to something other than a local gcloud: a container or
# another host, and -- for the copying tools -- a place on this disk that is not
# the root. A copy leaves the protected root just as a mount leaves the machine,
# and a copy is what ends up committed by accident.
TRANSFER_VERB='(docker|docker-compose|podman|nerdctl|colima|limactl|vagrant|kubectl|ssh|scp|rsync|cp|mv|tar|zip)'
# What may stand in front of the verb without changing which tool is called: a
# directory (`/bin/cp`, `/usr/local/bin/rsync`). A transfer verb is judged as the
# tool it names, not as the word it is written with; the escapes that used to be
# named here are removed from the text before it is matched at all.
TRANSFER_WORD='(^|[[:space:];|&(])([^[:space:];|&]*/)?'
# A run of global flags, each optionally followed by the value it takes:
# `--project <id>`, `--verbosity debug`, `-q`. It stands in front of the
# subcommand of a gcloud call and in front of `compose`, and both rules used to
# read only the one-token spelling (`--project=<id>`): the two-token spelling,
# which is how the flag is normally written, was a call neither of them saw.
FLAGS='([[:space:]]+-[^[:space:]]+([[:space:]]+[^-][^[:space:]]*)?)*'


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
  printf 'An identity root must never be mounted into, copied to, or packed for anything else:\n' >&2
  printf '  docker run -v <gcloud path>:<path>   docker cp   ssh   scp   rsync   cp   mv   tar   zip\n' >&2
  printf 'That is how a container on this Mac was reading the ambient shared root.\n' >&2
  printf 'Keep the roots off every mount, and route gcloud calls through the profile:\n' >&2
  printf '  devo gcloud --profile <name> [--project <id>] -- <gcloud args...>\n' >&2
  printf 'Known profiles: devo profiles\n' >&2
  exit 2
}

# What the shell hands the tool is not what the line looks like, and the rules below
# all read the same rewritten text. Three differences are removed here, each because
# it was a way past a rule that reads spelling:
#
# Quotes, because they are how a path with a space in it is written and a root
# written that way is the same root: removing them is what lets the rules read
# `-v "<root>":/gc`, `-f "compose.yaml"` and `cat "<root>/credentials.db"` as the
# names they are.
#
# A backslash before a newline, which the shell removes without separating the
# words: `gcloud \` on one line and `  auth login` on the next is one command, and
# read line by line it was two -- the call the unprefixed rule exists for, written
# across two lines, passed. The same removal is why the sanctioned bootstrap in
# references/gcp.md, whose pin is on its first line and whose gcloud word is on its
# second, was *refused*: the pin was dropped from one line and the call judged on
# the next. Joining them first answers both readings, which were wrong the same way.
# Only an odd run of backslashes joins: two of them are one escaped backslash, and
# the newline after it still ends the command, so a word ending in `\\` keeps the
# boundary a rule needs before a verb.
#
# And a backslash inside a word, which the shell removes the same way: it is what
# makes `c\p` the tool `cp`, `gclou\d` the word `gcloud`, and `~/.config//gcloud`,
# `~/.config/./gcloud` the one directory `.config/gcloud` denotes -- the shell does
# not collapse those, the kernel does, and every rule here knows the root by name.
#
# Nothing else about the text is rewritten: expansions and globs belong to the
# shell, and a guard that claimed to follow them would only look like one that does.
readable=$(printf '%s' "$command" \
  | awk '{ n = 0; i = length($0)
           while (i > 0 && substr($0, i, 1) == "\\") { n++; i-- }
           if (n % 2 == 1) { sub(/\\$/, ""); printf "%s", $0; next }
           print }' \
  | tr -d '\042\047' \
  | sed -E -e 's/\\//g' -e 's#//+#/#g' -e 's#/\./#/#g')

# A compose file hides the mount from the command line, so the file itself is
# read. Judged before the gcloud trigger below, because `docker compose up -d`
# names neither gcloud nor a path.
#
# The call is matched the way the rest of this file matches spelling: the tool is
# judged by the name it carries, and a run of whitespace is a run of whitespace,
# so `docker  compose`, a tab and another case are all the call being made -- each
# of them reaches the same CLI and reads the same file. So is the run of flags a
# caller puts between them (`docker --context <ctx> compose up`), and so is the
# hyphenated sibling of each tool: `docker-compose`, `podman-compose` and
# `nerdctl-compose` are the same program under another name.
if printf '%s' "$readable" | grep -qiE "(^|[^[:alnum:]_-])(docker|podman|nerdctl)${FLAGS}[[:space:]]+compose([[:space:]]|\$)" \
  || printf '%s' "$readable" | grep -qiE '(^|[^[:alnum:]_-])(docker|podman|nerdctl)-compose([[:space:]]|$)'; then
  compose_files=$(printf '%s' "$readable" | tr ' =' '\n\n' | grep -E '\.ya?ml$' || true)

  # Which directory Compose would read from. The working directory is where it
  # starts, but a `cd` earlier on the same line moves it, and the file it finds
  # there is the one that matters: reading only the working directory let `cd
  # hostile && docker compose up` mount the root one directory away from the
  # check. A shell cannot be followed line by line by a text rule, so every
  # directory the line changes to is tried as well -- reading a file Compose would
  # not reach can only add a refusal, never a pass. A `cd` after the call is read
  # with the rest of them, for the same reason: the rule reads the line, not the
  # order the shell reaches it in.
  if [ -z "$compose_files" ]; then
    # The targets in the order the line writes them, with the spellings a target may
    # carry: `command cd` calls the same builtin, and `--`, `-L` and `-P` are what it
    # accepts before the directory.
    targets=$(printf '%s' "$readable" | tr ';|&(' '\n\n\n\n' \
      | sed -nE 's/^[[:space:]]*(command[[:space:]]+)?cd[[:space:]]+/cd /p' \
      | sed -E 's/^cd[[:space:]]+(-[LP]+[[:space:]]+|--[[:space:]]+)*/cd /' \
      | sed -nE 's/^cd[[:space:]]+([^[:space:];|&]+).*/\1/p')

    # Each target is resolved against the directory the line is in when it reaches
    # it, which for the second `cd` is where the first left it: `cd /a && cd b`
    # reads /a/b, and resolving `b` against the working directory looked one
    # directory away from the compose file that matters.
    last=${cwd:-.}
    bases=$last
    for directory in $targets; do
      case "$directory" in
        *'$'*|*'`'*|*'*'*|*'?'*|*'['*)
          # The shell builds this one, so which directory the call ends up in is
          # exactly what this rule cannot read, and the file it would read is the
          # mount the rule exists to see. An unreadable target is refused instead of
          # passed, and it is the target that is refused: a compose call whose
          # directory can be read is judged as before.
          deny_transfer "the directory this line changes to (cd $directory) is built by the shell, so the compose file it would read cannot be determined. Write the path, or run the call from that directory."
          ;;
        '~'*) last=${HOME:-$last}${directory#'~'} ;;
        /*) last=$directory ;;
        *) last=$last/$directory ;;
      esac
      bases="$bases
$last"
    done

    # Compose walks up from where it runs: measured on v2.36, a call in a
    # subdirectory with no compose file of its own resolves the parent's. So the
    # guard walks up too and stops at the first directory that has one, which is
    # where Compose would stop.
    #
    # The function returns success on every path, and that is not decoration:
    # under `set -e` a command substitution whose last test fails kills the whole
    # guard, which would turn a deny into a silent pass-through.
    files_from() {
      directory=$1
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
      return 0
    }

    compose_files=$(printf '%s\n' "$bases" | while IFS= read -r base; do
      if [ -n "$base" ]; then files_from "$base"; fi
    done)
  fi

  for compose_file in $compose_files; do
    case "$compose_file" in
      /*) compose_path=$compose_file ;;
      *) compose_path=${cwd:-.}/$compose_file ;;
    esac
    [ -f "$compose_path" ] || continue
    hit=$(grep -niE "$GCLOUD_PATH" "$compose_path" 2>/dev/null | head -3 || true)
    if [ -n "$hit" ]; then
      deny_transfer "the compose file $compose_path mounts or names a gcloud identity root:
  $hit"
    fi
  done
fi

# Before the trigger below, because the flag names identity material itself and
# does not have to stand next to a gcloud word: in a spelling like `devo auth
# repair master --update-adc` the flag is the only token the trigger would have to
# recognise, and writing the ambient root's ADC is what the flag does.
if printf '%s' "$readable" | grep -q -- '--update-adc'; then
  deny "--update-adc overwrites the application default credentials of the ambient root."
fi

# Everything below is about gcloud itself or about a credential store on disk;
# a command naming none of them has nothing to answer for. CLOUDSDK_CONFIG is in
# the list for the same reason the rest of them are: it is how a root gets named
# without any of the letters of its path, and a root relocated that way would
# otherwise leave the guard at this line.
printf '%s' "$readable" | grep -qiE '(gcloud|GOOGLE_APPLICATION_CREDENTIALS|CLOUDSDK_CONFIG|application_default_credentials|legacy_credentials|access_tokens[.]db|credentials[.]db)' || exit 0

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
judged=$(printf '%s' "$readable" | sed -E 's/(^|[;|&({])[[:space:]]*CLOUDSDK_CONFIG=[^[:space:];|&)]*/\1/g')

# What the dropped assignment named, kept: the pin is not a handover by itself,
# but nothing stops the same command from naming that root a second time as an
# argument, and by then the value has been removed from the line the root test
# reads. That is how a root relocated through the variable -- carrying none of the
# letters of the default path -- left through `CLOUDSDK_CONFIG=<root> cp -R <root>
# <elsewhere>`: the assignment was dropped as a pin and the argument matched no
# root spelling, so the copy of the root passed. A value named again outside its
# own assignment is a root named, and the transfer test below judges it as one.
pinned=$(printf '%s' "$readable" | tr ';|&(' '\n\n\n\n' \
  | sed -nE 's/^[[:space:]]*CLOUDSDK_CONFIG=([^[:space:];|&)]*).*/\1/p')

# A transfer verb plus a root path: the directory leaves the root -- into a
# container, onto another host, or into a copy on this disk -- without gcloud
# being called at all. The verb is read with whatever leads up to it, because a
# directory in front of the name is the same tool being called (`/bin/cp`,
# `/usr/local/bin/rsync`); the escapes that used to be judged here (`\cp`, `c\p`)
# are removed from the text before it is read at all, from the same line that
# removes them for the paths. And both halves are matched without regard to case,
# since the same directory answers to both cases on this filesystem.
if printf '%s' "$judged" | grep -qiE "${TRANSFER_WORD}${TRANSFER_VERB}[[:space:]]"; then
  if printf '%s' "$judged" | grep -qiE "$GCLOUD_PATH"; then
    deny_transfer "this hands a gcloud identity root to a container, to another host, or to a copy outside the root."
  fi

  # The value is judged as the path it is, word by word, and not as a substring of
  # the line: `master` was a match inside `master-old`, and the ambient root was a
  # match inside the profiles directory beside it -- two refusals about a path
  # nobody handed over, neither of them a root named again.
  for value in $pinned; do
    for word in $(printf '%s' "$judged" | tr -s ' \t;|&()=:' '\n'); do
      case "$word" in
        "$value"|"$value"/*)
          deny_transfer "this pins $value for a local process and then names the same root to a container, to another host, or to a copy outside it."
          ;;
      esac
    done
  done
fi

# A ban is judged per shell segment, so a correct prefix elsewhere on the line
# cannot launder an unprefixed call. The exemption is the assignment that opens a
# segment, and only that: the whole segment goes with it, because the segment is
# the pinned call. Testing for the letters anywhere on the segment let a call
# launder itself by naming the variable somewhere else -- as an argument, or in a
# trailing comment -- which is not a pin of anything.
#
# The call is read as gcloud plus its subcommand, with the global flags a caller
# may put between them and the value each of those flags takes: `gcloud -q auth
# login` and `gcloud --project <id> auth login` write the ambient root exactly as
# `gcloud auth login` does, and a flag in between is not a different call. Reading
# only the one-token form of a flag (`--project=<id>`) left the two-token form --
# how the flag is normally written -- as a call this rule could not see.
# `activate-service-account` and `config set account` are on the list because they
# write into that root too: the first stores a credential in it, the second changes
# which identity an unprefixed call will silently use.
unprefixed=$(printf '%s' "$readable" | tr ';|&(' '\n\n\n\n' \
  | sed -E '/^[[:space:]]*CLOUDSDK_CONFIG=/d' \
  | grep -iE "gcloud${FLAGS}[[:space:]]+(auth[[:space:]]+(login|application-default|activate-service-account)|config[[:space:]]+(configurations[[:space:]]+activate|set[[:space:]]+account))" || true)

if [ -n "$unprefixed" ]; then
  deny "gcloud authentication/configuration command without CLOUDSDK_CONFIG:
  $unprefixed"
fi

# A store read is judged last, after the trigger above -- and it is still reached
# on its own, because that trigger's list names the stores as well: a line that
# reads one carries the same spellings the trigger looks for. Judged here rather
# than before it because a store is judged by its name alone, with no call to
# read: `cat <store>` is the whole command.
if printf '%s' "$readable" | grep -qiE '(access_tokens\.db|credentials\.db|application_default_credentials\.json|legacy_credentials)'; then
  deny "reading or copying a gcloud credential store is never allowed."
fi

exit 0
