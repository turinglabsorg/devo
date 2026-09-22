---
name: devo
description: DevOps specialist for auditing GCP, AWS, and DigitalOcean environments with isolated tenant contexts. Use when the user asks to verify gcloud, AWS, or doctl configuration; inspect cloud services; compare logs; review costs; check cloud health; investigate incidents; audit IAM, billing, or service state; deploy explicitly requested changes; or produce a cloud operations report.
---

# Devo

Devo is a cloud operations specialist for GCP, AWS, and DigitalOcean. It helps Codex inspect cloud state, compare logs, verify costs, and explain operational risks while staying read-only by default.

## Core Workflow

1. Define scope: provider, account or project, region, services, and time window.
2. Run local readiness checks with the Devo CLI when useful:

```bash
devo doctor --provider all
devo doctor --tenant letzgo
```

When working from the repo without installing:

```bash
node devo/skill/index.js doctor --provider all
```

3. Load only the reference needed for the task:
   - GCP or `gcloud`: read `references/gcp.md`.
   - AWS: read `references/aws.md`.
   - DigitalOcean or `doctl`: read `references/digitalocean.md`.
   - Cost or billing review: read `references/costs.md`.
   - Log comparison or incident review: read `references/logs.md`.
   - Tenant/client mapping: read `references/tenants.md`.
4. Run provider commands with explicit project/profile/region flags. For GCP, resolve the identity profile from `references/gcp.md` and route every call through `devo gcloud`, which pins `CLOUDSDK_CONFIG`, `--account`, and `--project`; never depend on the globally active gcloud configuration.
5. Report findings as facts, evidence, risk, and next action. Include command summaries, not raw credential-like output.

## Identity Profiles

A GCP call without its profile root does not fail: it silently uses the shared
global config and whatever account is active there. That produces wrong-identity
errors that read like permission problems, so every gcloud call must be routed:

```bash
devo profiles                      # which profiles exist, where, and with which account
devo profiles --probe              # the same, plus a read-only live token check
devo gcloud --profile acme --project acme-gprod -- run services list --region europe-west8
devo exec --profile master -- docker push REGISTRY/IMAGE:TAG
devo auth status                   # one line per profile; non-zero exit if one is dead
devo auth status --quiet --notify  # silent unless a profile is dead, then a desktop notice
devo auth watch                    # the hourly watchdog, plus any alert standing now
devo auth bootstrap acme           # move the profile onto its service account, or print how to create one
devo auth repair acme              # the human credential, one time, when a repair is what is needed
```

`auth status` is a detector, not a keep-alive: a refresh token is not expired by
short inactivity, so polling cannot stop it from dying. It buys early warning.
Nothing local keeps a *user* refresh token alive -- it dies on an account-level
event, at Google's discretion, whatever is polling it. The identity that does not
die is a service account key, and `devo auth bootstrap` is the flow that moves a
profile onto one: it looks for the key in hush, activates the profile from it if
it is there, and prints the exact sequence that creates it if it is not. The
human credential is then only needed again if the service account is revoked.

A dead profile does not depend on the desktop banner to be noticed, because that
banner fails silently: macOS Focus suppresses it while osascript still exits 0, so
"delivered" and "seen" are two different answers. The alert is therefore a marker
beside the profile's own record, at `~/.devo/auth-status/<profile>.alert`, written
whatever the desktop does and printed by the next `devo auth status` -- even a
`--quiet` run, and even a run scoped to a profile that is healthy. It carries the
first failure's time and how many runs have failed since, and only a probe that
answers clears it. Run `devo auth status` before a batch of work, not after its
first command fails.

An identity that belongs to an organisation is declared next to its root, in
`profiles.local.json` under the profiles directory (`~/.config/gcloud-profiles/`
by default), never in this repository: the registry that ships with the skill
carries generic identities only, so that a skill anyone can read never names a
client. A local entry has the registry's own shape -- `account`, `healthProject`,
`projectPatterns`, and a `serviceAccount` with its `email`, its vault `keyName`
and the `project` it lives in -- and is merged onto the committed entry rather
than replacing it, so no local file can drop a profile's account or narrow its
project guard. `serviceAccount.keyName` is a name, never a value: the key stays
in the vault.

`devo gcloud` refuses to run without `--profile`, refuses a project that belongs
to another profile's scope, refuses a mutating `auth`/`config` subcommand unless
`--allow-mutation` is passed, and rewrites a dead refresh token into the exact
repair command. gcloud refreshes its own access token from the stored refresh
token; nothing in this skill can renew a refresh token Google has rejected.
A lock keeps a second command for the same profile from opening that store
until the first has exited. `devo exec` and `devo auth repair` hold the same
lock. `devo doctor` probes each profile with a real API call, because
`gcloud auth list` answers from the local store and stays green on a dead token;
it exits non-zero when any check fails.

A process that is not gcloud -- the docker CLI and the credential helper it
spawns, terraform, an ADC client library -- needs the same root and has no gcloud
flags to carry it. `devo exec` pins the root for the command it starts, so the
caller names a profile instead of a directory, and refuses to pass on any
argument that names a root or a credential store -- judged by the path the
argument denotes, so a relocated, symlinked or parental spelling of a root is
refused as well, and so is the filesystem root, which holds every root there is.
Each argument is read twice, because the tools it may be handed to disagree about
`..` after a symlink; and because `CLOUDSDK_CONFIG` is where gcloud looks and not
where a client library looks, the route names the profile's own ADC file for the
child as well, reporting a profile that has none instead of refusing it.
`devo doctor --provider install` reports installed copies that no longer match
the digests `skill/install.sh` recorded, which is how a copy edited in place is
found; a manifest that records no copies is a failure rather than a green line,
and an install left on disk with no manifest at all is one too, because deleting
that file must not be a way to silence the check. Every destination the install
writes into is made absolute first, and a copy recorded at a relative path is
reported rather than resolved: a path that means a different file in every
directory the doctor might run in is not a comparison.

## Safety Rules

- Stay read-only unless the user explicitly requests a change.
- Never print secrets, access tokens, private keys, full environment dumps, or service account key contents.
- Never store gcloud credential databases, ADC JSON, OAuth tokens, cookies, or exported credentials in this skill, a repository, tenant metadata, or generated documentation. The skill stores only profile names, account identifiers, and paths; gcloud owns the credential files inside each isolated profile directory.
- Never run `gcloud` without a profile. A bare `gcloud`, including a read, uses `~/.config/gcloud` and whichever account was logged in there last. The Bash hook refuses it. Use `devo gcloud --profile <name> -- <args>`. Never pass `--update-adc`. Use `devo auth repair <profile>` to log in.
- Confirm the active cloud identity before interpreting service state or costs.
- Do not change global CLI defaults unless the user explicitly asks.
- Keep tenant/client contexts isolated. Do not mix costs, logs, service state, or recommendations across tenants.
- For cost investigations, label values as estimated, forecasted, or invoiced.

## CLI

```bash
devo doctor --provider all
devo tenants
devo tenant letzgo
devo doctor --tenant letzgo
devo commands --tenant letzgo services
devo doctor --provider gcp --json
devo commands gcp logs
devo commands aws costs
devo doctor --tenant zonzo
devo commands digitalocean services
devo profiles
devo profiles --probe
devo gcloud --profile acme --project acme-gprod -- projects describe acme-gprod
devo auth status
devo auth repair acme
```

Use `doctor` for local tool/auth/config readiness; it exits non-zero when a check
fails. Use `profiles` for the identity inventory. Use `gcloud` to run a gcloud
command inside one profile root. Use `commands` to print non-destructive audit
command suggestions for a provider and topic, already prefixed with the tenant's
profile root.
