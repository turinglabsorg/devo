import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  COMMAND_CATALOG,
  applyTenantTemplate,
  normalizeProvider,
  resolveTenant,
  runDoctor,
} from "../scripts/doctor.mjs";

function writeConfig(directory, tenant) {
  const configPath = join(directory, "devo.config.json");
  writeFileSync(configPath, JSON.stringify({ version: 1, tenants: { zonzo: tenant } }));
  return configPath;
}

test("normalizes DigitalOcean provider aliases", () => {
  assert.equal(normalizeProvider("digitalocean"), "digitalocean");
  assert.equal(normalizeProvider("digital-ocean"), "digitalocean");
  assert.equal(normalizeProvider("do"), "digitalocean");
});

test("requires a named doctl context and rejects embedded credentials", () => {
  const directory = mkdtempSync(join(tmpdir(), "devo-do-config-"));

  try {
    const missingContext = writeConfig(directory, { provider: "digitalocean" });
    assert.throws(() => resolveTenant("zonzo", { configPath: missingContext }), /must define doctlContext/);

    const embeddedToken = writeConfig(directory, {
      provider: "digitalocean",
      doctlContext: "zonzo",
      accessToken: "must-not-live-here",
    });
    assert.throws(() => resolveTenant("zonzo", { configPath: embeddedToken }), /forbidden credential field/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("renders every DigitalOcean audit command with the tenant context", () => {
  const tenant = { provider: "digitalocean", doctlContext: "zonzo" };
  const commands = Object.values(COMMAND_CATALOG.digitalocean).flat();

  for (const command of commands) {
    const rendered = applyTenantTemplate(command, tenant);
    assert.doesNotMatch(rendered, /DOCTL_CONTEXT/);
    if (command.startsWith("doctl --context")) assert.match(rendered, /doctl --context zonzo/);
  }
});

test("runs DigitalOcean tenant doctor with only the configured context", () => {
  const directory = mkdtempSync(join(tmpdir(), "devo-do-doctor-"));
  const originalPath = process.env.PATH;

  try {
    const doctlPath = join(directory, "doctl");
    writeFileSync(doctlPath, `#!/bin/sh
if [ "$1" = "version" ]; then
  echo "doctl version test"
  exit 0
fi
if [ "$1" != "--context" ] || [ "$2" != "zonzo" ]; then
  echo "missing or incorrect context" >&2
  exit 2
fi
if [ "$3" = "account" ] && [ "$4" = "get" ]; then
  echo '{"email":"operator@example.com","status":"active"}'
  exit 0
fi
if [ "$3" = "projects" ] && [ "$4" = "list" ]; then
  echo '[]'
  exit 0
fi
echo "unexpected arguments" >&2
exit 3
`);
    chmodSync(doctlPath, 0o755);
    process.env.PATH = `${directory}:${originalPath}`;

    const configPath = writeConfig(directory, {
      provider: "digitalocean",
      doctlContext: "zonzo",
      teamName: "Zonzo",
      defaultRegion: "fra",
    });
    const report = runDoctor({ tenantName: "zonzo", configPath });

    assert.equal(report.tenant, "zonzo");
    assert.equal(report.providers.length, 1);
    assert.equal(report.providers[0].provider, "digitalocean");
    assert.equal(report.providers[0].ok, true);
    assert.deepEqual(report.providers[0].checks.map((check) => check.ok), [true, true, true]);
  } finally {
    process.env.PATH = originalPath;
    rmSync(directory, { recursive: true, force: true });
  }
});
