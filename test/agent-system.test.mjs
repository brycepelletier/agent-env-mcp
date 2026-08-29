import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { describeAgentSystem } from "../runtime/agent-system.mjs";

function fixture(files) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-system-"));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(directory, name), content);
  }
  return directory;
}

const engineer = `---
name: Software Engineer
description: Implements and validates software.
tools:
  - 'agent-env/*'
agents:
  - GitHub Operator
  - Docker Operator
capability-categories:
  - engineering
  - specialist-orchestration
delegation-tool: runSubagent
---
# Software Engineer
`;

const github = `---
name: GitHub Operator
description: Owns Git and GitHub operations.
tools:
  - 'github/*'
capability-categories:
  - git
  - github
---
# GitHub Operator
`;

const docker = `---
name: Docker Operator
description: Owns Docker infrastructure.
tools:
  - 'docker-app/*'
capability-categories:
  - docker
  - managed-runner-infrastructure
---
# Docker Operator
`;

test("describes ownership and exact explicit delegation without child schemas", () => {
  const directory = fixture({
    "software-engineer.agent.md": engineer,
    "github-operator.agent.md": github,
    "docker-operator.agent.md": docker,
  });

  const result = describeAgentSystem({ definitionsDirectory: directory });
  assert.equal(result.agent.name, "Software Engineer");
  assert.deepEqual(result.agent.direct_capabilities, [
    "engineering",
    "specialist-orchestration",
  ]);
  assert.deepEqual(
    result.delegates.map(({ name, owns, invocation }) => ({
      name,
      owns,
      invocation,
    })),
    [
      {
        name: "GitHub Operator",
        owns: ["git", "github"],
        invocation: { tool: "runSubagent", agentName: "GitHub Operator" },
      },
      {
        name: "Docker Operator",
        owns: ["docker", "managed-runner-infrastructure"],
        invocation: { tool: "runSubagent", agentName: "Docker Operator" },
      },
    ]
  );
  assert.equal(result.invocation_contract.required_argument, "agentName");
  assert.equal(result.invocation_contract.omission_allowed, false);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /github\//);
  assert.doesNotMatch(serialized, /docker-app\//);
  assert.doesNotMatch(serialized, /"tools"/);
});

test("fails safely when an allowed specialist definition is missing", () => {
  const directory = fixture({
    "software-engineer.agent.md": engineer,
    "github-operator.agent.md": github,
  });
  assert.throws(
    () => describeAgentSystem({ definitionsDirectory: directory }),
    /Docker Operator.*no matching definition/
  );
});

test("fails safely on malformed metadata", () => {
  const directory = fixture({
    "software-engineer.agent.md": engineer,
    "github-operator.agent.md": github.replace("  - github", "  - GitHub Operations"),
    "docker-operator.agent.md": docker,
  });
  assert.throws(
    () => describeAgentSystem({ definitionsDirectory: directory }),
    /lowercase kebab-case/
  );
});

test("fails safely on duplicate agent names", () => {
  const directory = fixture({
    "software-engineer.agent.md": engineer,
    "github-operator.agent.md": github,
    "duplicate.agent.md": github,
    "docker-operator.agent.md": docker,
  });
  assert.throws(
    () => describeAgentSystem({ definitionsDirectory: directory }),
    /Duplicate agent name 'GitHub Operator'/
  );
});

test("rejects an incorrect or omitted delegation tool contract", () => {
  for (const changed of [
    engineer.replace("runSubagent", "delegate"),
    engineer.replace("delegation-tool: runSubagent\n", ""),
  ]) {
    const directory = fixture({
      "software-engineer.agent.md": changed,
      "github-operator.agent.md": github,
      "docker-operator.agent.md": docker,
    });
    assert.throws(() => describeAgentSystem({ definitionsDirectory: directory }));
  }
});
