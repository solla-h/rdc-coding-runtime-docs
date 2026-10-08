import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const commands = [
  { cli: "how-to-use.mjs", name: "how-to-use" },
  { cli: "rdc-cap.mjs", name: "rdc-cap" },
  { cli: "skill-hub.mjs", name: "skill-hub" },
];

function isolatedInvocation(t, cli, flag) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rdc-cli-inspection-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, HOMEDRIVE: "", HOMEPATH: "" };
  const start = Date.now();
  const output = spawnSync(process.execPath, [path.join(here, cli), flag], {
    cwd: home, env, encoding: "utf8", timeout: 4000, windowsHide: true,
  });
  assert.equal(output.status, 0, output.stderr);
  assert.equal(output.signal, null);
  assert.ok(Date.now() - start < 4000, "introspection must not launch a model");
  assert.ok(!output.stderr.includes("advisor_running"), "inspection started an advisor");
  assert.equal(fs.existsSync(path.join(home, ".rdc")), false, "inspection created runtime state");
  return output.stdout.trim();
}

for (const { cli, name } of commands) {
  test(name + " --help is local, synchronous and model-free", t => {
    const output = isolatedInvocation(t, cli, "--help");
    assert.match(output, /Usage:/i);
    if (name === "how-to-use") {
      assert.match(output, /--parallel-advisor/);
      assert.match(output, /--version/);
    }
  });
  test(name + " --version is local, synchronous and model-free", t => {
    const output = isolatedInvocation(t, cli, "--version");
    assert.equal(output, name + " 0.7.0-dev.5");
  });
}

test("how-to-use -h and -V aliases never call Pi", t => {
  assert.match(isolatedInvocation(t, "how-to-use.mjs", "-h"), /Usage/);
  assert.equal(isolatedInvocation(t, "how-to-use.mjs", "-V"), "how-to-use 0.7.0-dev.5");
});

test("ordinary semantic task path still requires validated Pi backend", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rdc-cli-guard-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const output = spawnSync(process.execPath,
    [path.join(here, "how-to-use.mjs"), "Recommend a CLI for a local database task"], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: "utf8", timeout: 4000, windowsHide: true,
    });
  assert.notEqual(output.status, 0);
  assert.match(output.stderr, /Pi backend is not verified/);
  assert.doesNotMatch(output.stderr, /advisor_running/);
  assert.equal(fs.existsSync(path.join(home, ".rdc")), false);
});


test("help alongside workspace or setup options cannot start Pi or bootstrap", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rdc-cli-help-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const argv of [
    ["--help", "--workspace", home],
    ["--workspace", home, "--help"],
    ["--bootstrap", "--help"],
  ]) {
    const run = spawnSync(process.execPath, [path.join(here, "how-to-use.mjs"), ...argv], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: "utf8", timeout: 3000, windowsHide: true,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Usage/);
    assert.doesNotMatch(run.stderr, /advisor_running/);
    assert.equal(fs.existsSync(path.join(home, ".rdc")), false);
  }
});
