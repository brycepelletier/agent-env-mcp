import assert from "node:assert/strict";
import test from "node:test";
import {
  hardenedGitArgs,
  normalizedRelative,
  sanitizedChildEnvironment,
  validateGitArgs,
  validateProgram,
} from "../runtime/helper.mjs";

test("workspace paths reject traversal and protected metadata", () => {
  assert.equal(normalizedRelative("src/main.cpp"), "src/main.cpp");
  for (const value of ["../outside", "/etc/passwd", "C:\\secret", ".git/config", ".ssh/id_rsa", ".gnupg/key"]) {
    assert.throws(() => normalizedRelative(value));
  }
});

test("child environment strips credentials and hardens Git", () => {
  const result = sanitizedChildEnvironment({
    PATH: "/usr/bin",
    GITHUB_TOKEN: "secret",
    GH_TOKEN: "secret",
    API_SECRET: "secret",
    SSH_AUTH_SOCK: "/tmp/agent",
  });
  assert.equal(result.PATH, "/usr/bin");
  for (const key of ["GITHUB_TOKEN", "GH_TOKEN", "API_SECRET", "SSH_AUTH_SOCK"]) {
    assert.equal(Object.hasOwn(result, key), false);
  }
  assert.equal(result.GIT_TERMINAL_PROMPT, "0");
  assert.equal(result.GIT_CONFIG_GLOBAL, "/dev/null");
});

test("engineering commands block Git, shells, Docker, and absolute executables", () => {
  assert.doesNotThrow(() => validateProgram("pio"));
  for (const program of ["git", "bash", "sh", "docker", "ssh", "/usr/bin/pio"]) {
    assert.throws(() => validateProgram(program));
  }
  assert.doesNotThrow(() => validateProgram("git", { allowGit: true }));
});

test("local Git policy permits bounded operations and blocks remote or destructive ones", () => {
  for (const args of [["status"], ["diff", "--cached"], ["log", "--oneline"], ["commit", "-m", "message"]]) {
    assert.doesNotThrow(() => validateGitArgs(args));
  }
  for (const args of [
    ["fetch"], ["pull"], ["push"], ["status", "--force"],
    ["rebase", "--exec=evil"], ["branch", "--delete", "main"],
    ["commit", "--amend"], ["stash", "clear"],
  ]) {
    assert.throws(() => validateGitArgs(args));
  }
});

test("hardened Git arguments disable hooks, signing, credentials, and file transport", () => {
  const args = hardenedGitArgs(["status"]);
  for (const setting of [
    "core.hooksPath=/dev/null",
    "commit.gpgSign=false",
    "tag.gpgSign=false",
    "credential.helper=",
    "protocol.file.allow=never",
  ]) {
    assert.ok(args.includes(setting));
  }
});
