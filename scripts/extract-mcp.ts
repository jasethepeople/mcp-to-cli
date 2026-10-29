#!/usr/bin/env bun
/**
 * extract-mcp.ts
 *
 * Connects to an MCP server via stdio using the official SDK,
 * calls tools/list, and outputs normalized command JSON to stdout.
 *
 * Usage:
 *   bun run extract-mcp.ts --cmd "<command> [args...]" [--name <cli-name>]
 *   bun run extract-mcp.ts --repo <github-url> [--name <cli-name>]
 *
 * Requires: @modelcontextprotocol/sdk (auto-installed if missing)
 *
 * Output: same normalized JSON format as extract-openapi.ts
 */

import { existsSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

// ── Types ────────────────────────────────────────────────────────────────────

interface Param {
  name: string;
  description: string;
  type: "string" | "number" | "boolean" | "array" | "object";
  required: boolean;
  default?: unknown;
  enum?: string[];
  in: "body";
}

interface Command {
  name: string;
  description: string;
  method: string;
  path: string;
  params: Param[];
}

interface NormalizedSpec {
  name: string;
  description: string;
  version: string;
  baseUrl: string;
  auth: { type: string; name: string; description?: string }[];
  groups: Array<{
    name: string;
    description: string;
    commands: Command[];
  }>;
  source: "mcp";
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function kebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
}

function mapJsonSchemaType(schema: any): Param["type"] {
  if (!schema) return "string";
  if (schema.type === "integer" || schema.type === "number") return "number";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "array") return "array";
  if (schema.type === "object") return "object";
  return "string";
}

function extractParamsFromInputSchema(inputSchema: any): Param[] {
  if (!inputSchema || !inputSchema.properties) return [];
  const required = new Set<string>(inputSchema.required || []);
  return Object.entries<any>(inputSchema.properties).map(([name, prop]) => ({
    name: kebabCase(name),
    description: prop.description || "",
    type: mapJsonSchemaType(prop),
    required: required.has(name),
    default: prop.default,
    enum: prop.enum,
    in: "body" as const,
  }));
}

// ── Ensure SDK is installed ──────────────────────────────────────────────────

async function ensureSdk(): Promise<void> {
  try {
    await import("@modelcontextprotocol/sdk/client/index.js");
  } catch {
    process.stderr.write("Installing @modelcontextprotocol/sdk...\n");
    Bun.spawnSync(["bun", "add", "@modelcontextprotocol/sdk"], {
      cwd: import.meta.dir,
      stderr: "pipe",
      stdout: "pipe",
    });
  }
}

// ── MCP Connection via Official SDK ──────────────────────────────────────────

async function connectAndExtract(
  command: string,
  args: string[],
  cwd?: string
): Promise<{ serverInfo: any; tools: any[] }> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/stdio.js"
  );

  const transport = new StdioClientTransport({
    command,
    args,
    ...(cwd ? { cwd } : {}),
    env: { ...process.env } as Record<string, string>,
  });

  const client = new Client({ name: "api-to-cli-extractor", version: "1.0.0" });

  process.stderr.write(`Connecting to: ${command} ${args.join(" ")}\n`);
  await client.connect(transport);

  const serverInfo = client.getServerVersion?.() || {};
  process.stderr.write(
    `Server: ${serverInfo?.name || "unknown"} v${serverInfo?.version || "?"}\n`
  );

  process.stderr.write("Listing tools...\n");
  const result = await client.listTools();
  const tools = result?.tools || [];
  process.stderr.write(`Found ${tools.length} tools\n`);

  await client.close();
  return { serverInfo, tools };
}

// ── Repo Handling ────────────────────────────────────────────────────────────

async function cloneAndPrepareRepo(
  repoUrl: string
): Promise<{ dir: string; startCmd: string; startArgs: string[] }> {
  const tmpDir = join("/tmp", `mcp-extract-${randomUUID().slice(0, 8)}`);
  mkdirSync(tmpDir, { recursive: true });

  const gitUrl = repoUrl.endsWith(".git") ? repoUrl : `${repoUrl}.git`;
  process.stderr.write(`Cloning ${repoUrl}...\n`);
  const cloneProc = Bun.spawnSync(["git", "clone", "--depth", "1", gitUrl, tmpDir], {
    stderr: "pipe",
    stdout: "pipe",
  });
  if (cloneProc.exitCode !== 0) {
    throw new Error(`Failed to clone: ${cloneProc.stderr.toString()}`);
  }

  // Detect package manager
  const hasBunLock =
    existsSync(join(tmpDir, "bun.lockb")) || existsSync(join(tmpDir, "bun.lock"));
  const hasPnpmLock = existsSync(join(tmpDir, "pnpm-lock.yaml"));
  const hasYarnLock = existsSync(join(tmpDir, "yarn.lock"));

  let installCmd: string[];
  if (hasBunLock) installCmd = ["bun", "install"];
  else if (hasPnpmLock) installCmd = ["pnpm", "install"];
  else if (hasYarnLock) installCmd = ["yarn", "install"];
  else installCmd = ["npm", "install"];

  process.stderr.write(`Installing deps with ${installCmd[0]}...\n`);
  Bun.spawnSync(installCmd, { cwd: tmpDir, stderr: "pipe", stdout: "pipe" });

  const pkgPath = join(tmpDir, "package.json");
  if (!existsSync(pkgPath)) {
    throw new Error("No package.json found in repo");
  }

  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

  // Build if needed
  if (pkg.scripts?.build) {
    process.stderr.write("Building...\n");
    Bun.spawnSync(
      installCmd[0] === "bun" ? ["bun", "run", "build"] : ["npm", "run", "build"],
      { cwd: tmpDir, stderr: "pipe", stdout: "pipe" }
    );
  }

  // Detect entry point
  let startCmd = "node";
  let startArgs: string[] = [];

  if (pkg.bin) {
    const binEntry =
      typeof pkg.bin === "string" ? pkg.bin : (Object.values(pkg.bin)[0] as string);
    startCmd = "node";
    startArgs = [join(tmpDir, binEntry)];
  } else if (pkg.main) {
    startCmd = "node";
    startArgs = [join(tmpDir, pkg.main)];
  } else if (existsSync(join(tmpDir, "dist", "index.js"))) {
    startCmd = "node";
    startArgs = [join(tmpDir, "dist", "index.js")];
  } else if (existsSync(join(tmpDir, "src", "index.ts"))) {
    startCmd = "bun";
    startArgs = ["run", join(tmpDir, "src", "index.ts")];
  } else if (pkg.scripts?.start) {
    const parts = pkg.scripts.start.split(/\s+/);
    startCmd = parts[0];
    startArgs = parts.slice(1);
  }

  return { dir: tmpDir, startCmd, startArgs };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  await ensureSdk();

  const args = process.argv.slice(2);
  const cmdIdx = args.indexOf("--cmd");
  const repoIdx = args.indexOf("--repo");
  const nameIdx = args.indexOf("--name");
  const cliName = nameIdx !== -1 ? args[nameIdx + 1] : undefined;

  let command: string;
  let commandArgs: string[];
  let cwd: string | undefined;

  if (cmdIdx !== -1) {
    const fullCmd = args[cmdIdx + 1];
    if (!fullCmd) {
      console.error(
        "Usage: bun run extract-mcp.ts --cmd '<command>' [--name <cli-name>]"
      );
      process.exit(1);
    }
    const parts = fullCmd.split(/\s+/);
    command = parts[0];
    commandArgs = parts.slice(1);
  } else if (repoIdx !== -1) {
    const repoUrl = args[repoIdx + 1];
    if (!repoUrl) {
      console.error(
        "Usage: bun run extract-mcp.ts --repo <github-url> [--name <cli-name>]"
      );
      process.exit(1);
    }
    const repo = await cloneAndPrepareRepo(repoUrl);
    command = repo.startCmd;
    commandArgs = repo.startArgs;
    cwd = repo.dir;
  } else {
    console.error(
      "Usage:\n  bun run extract-mcp.ts --cmd '<command>' [--name <cli-name>]\n  bun run extract-mcp.ts --repo <github-url> [--name <cli-name>]"
    );
    process.exit(1);
  }

  const { serverInfo, tools } = await connectAndExtract(command, commandArgs, cwd);

  const commands: Command[] = tools.map((tool: any) => ({
    name: kebabCase(tool.name),
    description: tool.description || "",
    method: "TOOL",
    path: tool.name,
    params: extractParamsFromInputSchema(tool.inputSchema),
  }));

  const serverName = serverInfo?.name || "mcp-server";

  const result: NormalizedSpec = {
    name: cliName || kebabCase(serverName) + "-cli",
    description: `CLI for ${serverName} MCP server`,
    version: serverInfo?.version || "1.0.0",
    baseUrl: "",
    auth: [],
    groups: [{ name: "tools", description: "Available tools", commands }],
    source: "mcp",
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
