# GCP Audit Reference

Use this reference when the task involves GCP, `gcloud`, Cloud Run, GKE, Compute Engine, Cloud SQL, Cloud Logging, IAM, billing, or service inventory.

## Scope First

Always identify:

- Project ID
- Active account
- Region or multi-region scope
- Target service
- Time window for logs and metrics

Prefer explicit `--project PROJECT_ID` flags. Do not change global `gcloud config` unless requested.

## Local Identity Profiles

This workstation uses fully isolated gcloud roots. Treat these names as identity profiles, not ordinary named configurations:

| Profile | Account | Configuration root | Use |
| --- | --- | --- | --- |
| `master` | `sebastiano.cataudo@gmail.com` | `/Users/zencrust/.config/gcloud-profiles/master` | Default for PrismaNews and general GCP operations unless the user explicitly selects another identity. |
| `nobrainer` | `seer@nobraineragency.com` | `/Users/zencrust/.config/gcloud-profiles/nobrainer` | Operations explicitly associated with the Nobrainer identity or a project confirmed to require it. |
| `credilex` | `seba@credilex.it` | `/Users/zencrust/.config/gcloud-profiles/credilex` | Credilex GCP only. Isolated defaults: account `seba@credilex.it`, project `credilex-gstaging`. Credentials stay in this root (`credentials.db`); never log in to the global `ragusa` config for Credilex. Also visible: `linear-analyst-493018-u6`. Never use `master` or `nobrainer` for Credilex. |

Set `CLOUDSDK_CONFIG` on every gcloud invocation. Also pass the account, project, and region explicitly when supported:

```bash
CLOUDSDK_CONFIG=/Users/zencrust/.config/gcloud-profiles/master \
  gcloud --account=sebastiano.cataudo@gmail.com \
  --project=PROJECT_ID COMMAND
```

```bash
CLOUDSDK_CONFIG=/Users/zencrust/.config/gcloud-profiles/nobrainer \
  gcloud --account=seer@nobraineragency.com \
  --project=PROJECT_ID COMMAND
```

```bash
CLOUDSDK_CONFIG=/Users/zencrust/.config/gcloud-profiles/credilex \
  gcloud --account=seba@credilex.it \
  --project=credilex-gstaging COMMAND
```

The same environment prefix is mandatory for Cloud SQL Auth Proxy, client libraries, Terraform/OpenTofu helpers, scripts that invoke gcloud, and any other process that consumes Application Default Credentials. A process without the prefix may silently use the unrelated global ADC file.

## Route Calls Through The Router

Writing the prefix by hand is where this goes wrong: an unprefixed gcloud call
does not fail, it uses the shared global config and whatever account is active
there, and the resulting `PERMISSION_DENIED` reads like a real permission
problem. Use the router, which derives the root, the account and the project
from the registry in `scripts/profiles.mjs`:

```bash
devo profiles
devo gcloud --profile credilex --project credilex-gprod -- run services list --region europe-west8
devo gcloud --profile credilex -- run services describe credilex-api --region europe-west8
```

- `--profile` is mandatory; omitting it is an error, never a fallback.
- A project that belongs to another profile's scope is refused, even when the
  calling profile declares no patterns of its own.
- Mutating `auth`/`config` subcommands are refused unless `--allow-mutation` is
  passed; a credential repair goes through `devo auth repair <profile>`. The list
  is `auth login`, `auth application-default login`, `auth activate-service-account`,
  `config set`, `config unset` and `config configurations`: the first two change
  the authentication of the root, the third stores a credential in it, and the
  three `config` ones rewrite which identity the root will use. The subcommand is
  read past the run of global flags a caller may put in front of it -- `gcloud -q
  auth login`, `gcloud --project <id> auth login`, `gcloud --verbosity debug auth
  login` all write the root exactly as the bare spelling does -- so each of them is
  the mutation it is, and reading the subcommand at the first argument was how a
  flag became a way around the guard. A flag whose value is a separate token is
  stepped over by gcloud's own flag list; a flag this guard does not know is read
  both ways (its value, or the subcommand), and the reading that shows the mutation
  is the one that refuses. The same reading decides whether a call is
  identity-scoped: an `auth` or `config` call reached behind a flag keeps the
  project and the account off its command line, and the account drift check steps
  aside for it, exactly as for the bare spelling.
- A dead refresh token is rewritten into the exact repair command instead of the
  raw gcloud text.
- `--tty` hands the terminal to gcloud, for commands that prompt.
- `devo exec --profile <name> [--project <id>] -- <command...>` pins the same root
  for a process that is not gcloud: the docker CLI and the credential helper it
  spawns, terraform, an ADC client library. It refuses any argument that names a
  root or a credential store, and judges that argument as a path rather than as
  text: a root relocated through `DEVO_GCLOUD_PROFILES_DIR`, a symlink to one, a
  parent of one and the filesystem root itself all denote a root -- or hold every
  root -- and are all refused, so the route cannot hand over what it just pinned.
  A credential store is judged by the name it carries (`credentials.db`,
  `access_tokens.db`, `legacy_credentials`, `application_default_credentials.json`),
  which is what catches the one named where no root is and nothing can be resolved.
  Each argument is read twice, because the tools it may be handed to disagree
  about `..` after a symlink: the kernel follows the link and applies `..` to the
  directory it reached, a text-first tool collapses `..` before following
  anything, and `<link to a directory inside the root>/..` is the root to an
  `open` or a `tar -C` but only the link's own directory to the other reading.
  The one argument that is not a path is the command word: `ls` is a name looked up
  on PATH, and PATH is not the working directory, so the route does not resolve it
  against the directory the caller happens to be in -- a command word written as a
  path (`./ls`, `/bin/gcloud`) is still judged as one.
  The route also names the profile's own `application_default_credentials.json`
  for the child, because `CLOUDSDK_CONFIG` is where gcloud looks and not where a
  client library looks; a profile with no such file leaves the child on the
  ambient identity, which is reported as a warning rather than refused, and
  recorded as a residual in `test/exec.test.mjs`. In that state an inherited
  `GOOGLE_APPLICATION_CREDENTIALS` is removed from the child's environment rather
  than passed on: it names another identity's credentials, and a child that
  resolves ADC by that variable would authenticate as one client while the route
  reports the other as pinned.
  A `gcloud` command word reached directly is refused unless `--allow-mutation` is
  passed, so prefixing a call with `devo exec` is not a way around the router's
  guard -- directly, as a path (`/usr/local/bin/gcloud` is the same program), and
  in another case (`Gcloud` is the same file on this filesystem, and reading the
  case would have made the letter a way around it). That reading covers the
  command word: a shell wrapper that runs gcloud itself is not inspected (see the
  residual in `test/exec.test.mjs`), which is what the harness hook is for.

A PreToolUse hook (`~/.claude/hooks/gcloud-guard.sh`) denies an unprefixed
`gcloud auth login`, `gcloud auth application-default login`, `gcloud auth
activate-service-account`, `gcloud config configurations activate`, `gcloud
config set account`, `--update-adc`, any read of a credential store
(`credentials.db`, `access_tokens.db`, `application_default_credentials.json`,
`legacy_credentials`), and any mount, copy or archive of an identity root by a
container, another host, or a copying tool (`docker`, `docker-compose`, `podman`,
`nerdctl`, `colima`, `limactl`, `vagrant`, `kubectl`, `ssh`, `scp`, `rsync`,
`cp`, `mv`, `tar`, `zip`).

The text is first read the way the shell reads it, because every difference
between the two is a way past a rule that reads spelling:

- a backslash before a newline joins the lines into the one command they are:
  `gcloud \` on one line and `auth login` on the next is the call the unprefixed
  rule exists for. Only an odd run of backslashes joins -- two of them are one
  escaped backslash and the newline after it still ends the command, so a word
  ending in `\\` keeps the boundary a rule needs in front of a verb;
- a backslash inside a word is removed, which makes `c\p` the tool `cp` and
  `gclou\d` the word `gcloud`;
- quotes are removed, because a shell hands the program the same words with or
  without them: a root inside quotes still carries the letters of its path, while
  `"cp"` carries none of the letters of the tool it names;
- a repeated slash and a `.` segment are collapsed, because `~/.config//gcloud`
  and `~/.config/./gcloud` are the one directory `.config/gcloud` denotes.

A verb is judged as the tool it names, so a directory in front of it (`/bin/cp`,
`/usr/local/bin/rsync`) is the same tool. A root is recognised by its path and by
the variable that can name one (`CLOUDSDK_CONFIG`), because a relocated root
carries none of the letters of the default path. Every half of every test ignores
case, because on this filesystem another case is the same file.

The auth rule reads the call as the word, the run of global flags a caller may
put between the word and the subcommand, and the value each of those flags takes:
`gcloud -q auth login`, `gcloud --project <id> auth login` and `gcloud --project
<id> --verbosity debug auth login` all write the ambient root exactly as the bare
spelling does. `activate-service-account` stores a credential in that root and
`config set account` changes which identity an unprefixed call will silently use,
so both are on the subcommand list for the same reason. `--update-adc` is judged
before the trigger that looks for a `gcloud` spelling, because in `devo auth
repair master --update-adc` the flag is the only token naming identity material
at all. The credential-store rule sits after that trigger, which reaches every
store because the trigger's own list names them.

A `CLOUDSDK_CONFIG=<root>` assignment that opens a shell segment is read as the
environment pin it is, so a prefixed local call passes it; a root named as an
argument does not, and neither does a pin spelled as an argument to a builtin
(`export CLOUDSDK_CONFIG=<root>; cp ...`), which the guard refuses as the safe
reading -- a false positive it accepts. The value the dropped assignment named is
kept and judged separately, as the path it is and not as a substring of the line:
`/tmp/root` is not a match inside `/tmp/root2`, and a line that pins a root and
then hands that same root to a copy or a mount is refused rather than exempted by
its own prefix.

The compose file is read too, because it hides a mount from the command line. The
call is recognised the way the rest of the file is read -- another case, any run
of whitespace, a flag and its value in front of `compose`, the hyphenated sibling
of each container front-end -- and the file is resolved the way Compose resolves
it: the working directory, each directory the line `cd`s to (each against the
directory the previous one reached), then each parent of those until one holds a
compose file. Reading a file Compose would not reach can only add a refusal,
never a pass. A `cd` target the shell builds is the one thing the rule cannot
read, so a compose call after `cd $VAR` is refused rather than passed, unless the
file is named with `-f` and the directory never has to be found.

The rule is a list of tools, and its boundaries are declared as tests in
`test/gcloud-guard.test.mjs` rather than left to read like guarantees: a program
that reads a file instead of copying it, a verb reached through a variable, a
copying tool that is not on the list, an ancestor of a root, a socket mount, a
root the shell builds out of parts the command does not contain (a glob, a brace,
a command substitution over a directory that is not itself a root), a compose
file pulled in by another one's `include:`, a relocated root named only by its
path -- the guard cannot tell `/tmp/roots/master` from any other directory -- and
a root under a `DEVO_GCLOUD_PROFILES_DIR` other than the one this workstation
keeps. A residual is a test named as a residual, never an expectation that reads
like intended behaviour.

Prefer `devo exec` when a non-gcloud process needs the same root, and `devo
gcloud` for audit commands. The raw `CLOUDSDK_CONFIG` form below is for
bootstrapping a root and for explaining the prefix to the user.

### Bootstrap Or Repair

Authentication is an external mutation and may open a browser. Run these commands only when the user explicitly asks to authenticate or repair a profile. Never run bare `gcloud auth login`, never activate a shared global configuration, and never use `--update-adc`.

Preferred form, which resolves the root and the account from the registry:

```bash
devo auth repair credilex
devo auth repair master
devo auth repair nobrainer
```

Expanded, for the gcloud CLI credential store:

```bash
CLOUDSDK_CONFIG=/Users/zencrust/.config/gcloud-profiles/master \
  gcloud auth login sebastiano.cataudo@gmail.com
```

```bash
CLOUDSDK_CONFIG=/Users/zencrust/.config/gcloud-profiles/nobrainer \
  gcloud auth login seer@nobraineragency.com
```

```bash
CLOUDSDK_CONFIG=/Users/zencrust/.config/gcloud-profiles/credilex \
  gcloud auth login seba@credilex.it
```

Only when the target command uses ADC, initialize the matching ADC file separately:

```bash
CLOUDSDK_CONFIG=/Users/zencrust/.config/gcloud-profiles/master \
  gcloud auth application-default login sebastiano.cataudo@gmail.com
```

```bash
CLOUDSDK_CONFIG=/Users/zencrust/.config/gcloud-profiles/nobrainer \
  gcloud auth application-default login seer@nobraineragency.com
```

```bash
CLOUDSDK_CONFIG=/Users/zencrust/.config/gcloud-profiles/credilex \
  gcloud auth application-default login seba@credilex.it
```

Credential files remain inside the corresponding configuration root and must never be read, printed, copied into this skill, or committed. Validate a profile with a read-only API call, not with `gcloud auth list`: `auth list` answers from the local store and reports green on a dead token.

```bash
devo profiles --probe
```

Do not print access tokens or ADC contents.

If a command returns `PERMISSION_DENIED`, first verify that the selected profile matches the intended client/project. Do not fall back to the other profile unless project ownership is confirmed; this prevents cross-client access and misleading audit results.

## Identity And Configuration

Replace `PROFILE_ROOT`, `ACCOUNT`, `PROJECT_ID`, and `REGION` with the selected profile values and target scope.

```bash
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud auth list --filter=status:ACTIVE --format=json
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud config list --format=json
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID projects describe PROJECT_ID --format=json
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID billing projects describe PROJECT_ID
```

## Service Inventory

```bash
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID services list --enabled
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID run services list --region=REGION
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID compute instances list
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID container clusters list
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID sql instances list
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID app services list
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID scheduler jobs list --location=REGION
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID pubsub topics list
```

## IAM And Secrets Surface

List names and bindings only. Do not print secret payloads or service account key contents.

```bash
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID projects get-iam-policy PROJECT_ID --format=json
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID iam service-accounts list
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID iam service-accounts keys list --iam-account=SERVICE_ACCOUNT_EMAIL
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID secrets list
```

Red flags:

- User-managed service account keys older than the rotation policy.
- Broad primitive roles such as Owner or Editor granted to users or default service accounts.
- Enabled APIs without matching active services.
- Public ingress on services expected to be internal.

## Cloud Run Checks

```bash
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID run services describe SERVICE --region=REGION --format=json
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID run revisions list --service=SERVICE --region=REGION
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID run services get-iam-policy SERVICE --region=REGION --format=json
```

Check ingress, authentication, min/max instances, CPU/memory, container image digest, environment variable names, and recent revision rollout.

## Logs

Use narrow filters and explicit freshness:

```bash
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="SERVICE"' --freshness=1h --limit=100 --format=json
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID logging read 'severity>=ERROR' --freshness=24h --limit=100 --format=json
```

For cross-service investigations, load `references/logs.md`.

## Costs

Start with billing attachment, then use Billing Export to BigQuery when available:

```bash
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT billing accounts list
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID billing projects describe PROJECT_ID
```

For deeper cost analysis, load `references/costs.md`.
