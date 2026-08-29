import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const AGENT_FILE_SUFFIX = ".agent.md";
const SAFE_CATEGORY = /^[a-z][a-z0-9-]*$/;

function parseScalar(value) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseAgentFrontmatter(content, filename = "agent definition") {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) {
    throw new Error(`${filename}: missing or malformed YAML frontmatter.`);
  }

  const metadata = {};
  let listKey = null;
  for (const [index, line] of match[1].split(/\r?\n/).entries()) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;

    const item = /^\s+-\s+(.+?)\s*$/.exec(line);
    if (item) {
      if (!listKey) {
        throw new Error(`${filename}: unexpected list item on frontmatter line ${index + 2}.`);
      }
      metadata[listKey].push(parseScalar(item[1]));
      continue;
    }

    const field = /^([a-zA-Z][a-zA-Z0-9-]*):(?:\s*(.*))?$/.exec(line);
    if (!field) {
      throw new Error(`${filename}: malformed frontmatter line ${index + 2}.`);
    }

    listKey = field[2] ? null : field[1];
    metadata[field[1]] = field[2] ? parseScalar(field[2]) : [];
  }

  return metadata;
}

function requireString(metadata, field, filename) {
  const value = metadata[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${filename}: '${field}' must be a non-empty scalar.`);
  }
  return value.trim();
}

function requireStringList(metadata, field, filename) {
  const value = metadata[field];
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => !item)) {
    throw new Error(`${filename}: '${field}' must be a non-empty list.`);
  }
  return value;
}

function loadDefinitions(directory) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Unable to read agent definitions directory '${directory}'.`, {
      cause: error,
    });
  }

  const definitions = new Map();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(AGENT_FILE_SUFFIX)) continue;
    const content = fs.readFileSync(path.join(directory, entry.name), "utf8");
    const metadata = parseAgentFrontmatter(content, entry.name);
    const name = requireString(metadata, "name", entry.name);
    const categories = requireStringList(
      metadata,
      "capability-categories",
      entry.name
    );
    if (categories.some((category) => !SAFE_CATEGORY.test(category))) {
      throw new Error(
        `${entry.name}: capability categories must be lowercase kebab-case identifiers.`
      );
    }
    if (definitions.has(name)) {
      throw new Error(`Duplicate agent name '${name}' in '${entry.name}'.`);
    }
    definitions.set(name, {
      filename: entry.name,
      content,
      metadata,
      name,
      description: requireString(metadata, "description", entry.name),
      categories,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }

  if (definitions.size === 0) {
    throw new Error(`No '${AGENT_FILE_SUFFIX}' definitions found in '${directory}'.`);
  }
  return definitions;
}

export function describeAgentSystem({
  definitionsDirectory =
    process.env.AGENT_DEFINITIONS_DIR || path.join(os.homedir(), ".agents"),
} = {}) {
  const definitions = loadDefinitions(path.resolve(definitionsDirectory));
  const orchestrators = [...definitions.values()].filter(
    ({ metadata }) =>
      Array.isArray(metadata.agents) &&
      metadata.agents.length > 0 &&
      Array.isArray(metadata.tools) &&
      metadata.tools.some(
        (tool) => tool === "agent-env/*" || tool === "agent-env/describe_agent_system"
      )
  );

  if (orchestrators.length !== 1) {
    throw new Error(
      `Expected exactly one agent-env orchestrator definition; found ${orchestrators.length}.`
    );
  }

  const orchestrator = orchestrators[0];
  const delegationTool = requireString(
    orchestrator.metadata,
    "delegation-tool",
    orchestrator.filename
  );
  if (delegationTool !== "runSubagent") {
    throw new Error(
      `${orchestrator.filename}: delegation-tool must be exactly 'runSubagent'.`
    );
  }

  const allowedAgents = requireStringList(
    orchestrator.metadata,
    "agents",
    orchestrator.filename
  );
  const delegates = allowedAgents.map((name) => {
    const definition = definitions.get(name);
    if (!definition) {
      throw new Error(
        `${orchestrator.filename}: permitted agent '${name}' has no matching definition.`
      );
    }
    return {
      name: definition.name,
      description: definition.description,
      owns: definition.categories,
      invocation: { tool: delegationTool, agentName: definition.name },
      source: { filename: definition.filename, sha256: definition.sha256 },
    };
  });

  return {
    agent: {
      name: orchestrator.name,
      description: orchestrator.description,
      direct_capabilities: orchestrator.categories,
      source: { filename: orchestrator.filename, sha256: orchestrator.sha256 },
    },
    delegates,
    invocation_contract: {
      tool: delegationTool,
      required_argument: "agentName",
      omission_allowed: false,
      verify_returned_identity: true,
      mismatch_action: "reject-and-retry-with-explicit-agentName",
    },
  };
}
