#!/usr/bin/env bun
/**
 * generate-tape.ts
 *
 * Generates a Charmbracelet VHS .tape file from normalized command JSON.
 * Demos agent-style usage: --help, env-var auth, jq piping, stdin input.
 *
 * Usage:
 *   bun run generate-tape.ts <normalized-json-path> <output-tape-path> [--bin <cli-binary-path>]
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

interface Param {
  name: string;
  description: string;
  type: string;
  required: boolean;
  default?: unknown;
  enum?: string[];
  in: string;
}

interface Command {
  name: string;
  description: string;
  method: string;
  path: string;
  params: Param[];
}

interface Group {
  name: string;
  description: string;
  commands: Command[];
}

interface NormalizedSpec {
  name: string;
  description: string;
  version: string;
  source: "openapi" | "mcp";
  groups: Group[];
}

function envPrefix(name: string): string {
  return name
    .replace(/-cli$/, "")
    .replace(/-/g, "_")
    .toUpperCase();
}

function generateTape(spec: NormalizedSpec, cliBin: string): string {
  const lines: string[] = [];
  const prefix = envPrefix(spec.name);

  lines.push(`# ${spec.name} — Agent-First CLI Demo`);
  lines.push(`# Structured output, env-var auth, unix piping`);
  lines.push(``);
  lines.push(`Output demo.gif`);
  lines.push(`Output demo.webm`);
  lines.push(``);
  lines.push(`Set FontSize 16`);
  lines.push(`Set Width 960`);
  lines.push(`Set Height 540`);
  lines.push(`Set WindowBar Colorful`);
  lines.push(`Set WindowBarSize 40`);
  lines.push(`Set BorderRadius 8`);
  lines.push(`Set Padding 20`);
  lines.push(`Set TypingSpeed 40ms`);
  lines.push(`Set CursorBlink false`);
  lines.push(`Set Shell bash`);
  lines.push(`Set Theme { "name": "Custom", "black": "#000000", "red": "#ff5555", "green": "#50fa7b", "yellow": "#f1fa8c", "blue": "#6272a4", "magenta": "#ff79c6", "cyan": "#8be9fd", "white": "#f8f8f2", "brightBlack": "#6272a4", "brightRed": "#ff6e6e", "brightGreen": "#69ff94", "brightYellow": "#ffffa5", "brightBlue": "#d6acff", "brightMagenta": "#ff92df", "brightCyan": "#a4ffff", "brightWhite": "#ffffff", "background": "#000000", "foreground": "#f8f8f2", "selection": "#44475a", "cursor": "#f8f8f2" }`);
  lines.push(``);

  // Show root help
  lines.push(`# Help — agents read this first`);
  lines.push(`Type "${cliBin} --help"`);
  lines.push(`Enter`);
  lines.push(`Sleep 3s`);
  lines.push(``);

  // Show group help for OpenAPI
  const firstGroup = spec.groups[0];
  if (firstGroup && spec.source === "openapi") {
    lines.push(`# Group help`);
    lines.push(`Type "${cliBin} ${firstGroup.name} --help"`);
    lines.push(`Enter`);
    lines.push(`Sleep 2.5s`);
    lines.push(``);
  }

  // Set env var auth
  lines.push(`# Auth via env var — no config files, no prompts`);
  lines.push(`Type "export ${prefix}_API_KEY=demo-key-12345"`);
  lines.push(`Enter`);
  lines.push(`Sleep 1s`);
  lines.push(``);

  // Demo commands with jq piping
  const allCommands = spec.groups.flatMap((g) =>
    g.commands.map((c) => ({ group: g.name, ...c }))
  );

  // Find a GET command for read demo
  const getCmd = allCommands.find((c) => c.method === "GET" || c.method === "TOOL");
  if (getCmd) {
    const flagParts: string[] = [];
    for (const param of getCmd.params.filter((p) => p.required).slice(0, 2)) {
      const val = param.type === "number" ? "1"
        : param.enum?.[0] || `"example"`;
      flagParts.push(`--${param.name} ${val}`);
    }
    const prefix_cmd = spec.source === "openapi" ? `${getCmd.group} ` : "";
    const flags = flagParts.length > 0 ? " " + flagParts.join(" ") : "";

    lines.push(`# Structured JSON output — pipe to jq`);
    lines.push(`Type "${cliBin} ${prefix_cmd}${getCmd.name}${flags} | jq '.'"`);
    lines.push(`Enter`);
    lines.push(`Sleep 2.5s`);
    lines.push(``);
  }

  // Find a POST/PUT command for stdin demo
  const mutCmd = allCommands.find((c) => ["POST", "PUT", "PATCH"].includes(c.method));
  if (mutCmd) {
    const prefix_cmd = spec.source === "openapi" ? `${mutCmd.group} ` : "";
    const bodyObj: Record<string, string> = {};
    for (const p of mutCmd.params.filter((p) => p.in === "body").slice(0, 2)) {
      bodyObj[p.name] = p.type === "number" ? "1" : "example";
    }
    const bodyJson = JSON.stringify(bodyObj).replace(/"/g, '\\"');

    // Required path/query params
    const reqFlags = mutCmd.params
      .filter((p) => p.required && p.in !== "body")
      .slice(0, 2)
      .map((p) => `--${p.name} ${p.type === "number" ? "1" : '"example"'}`)
      .join(" ");
    const flagStr = reqFlags ? " " + reqFlags : "";

    lines.push(`# Stdin piping — composable input`);
    lines.push(`Type "echo '${JSON.stringify(bodyObj)}' | ${cliBin} ${prefix_cmd}${mutCmd.name}${flagStr} --stdin"`);
    lines.push(`Enter`);
    lines.push(`Sleep 2.5s`);
    lines.push(``);
  }

  lines.push(`Sleep 2s`);

  return lines.join("\n");
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const jsonPath = args.find((a) => !a.startsWith("--"));
  const outputIdx = args.indexOf("--output") !== -1 ? args.indexOf("--output") : 1;
  const outputPath = args[outputIdx] && !args[outputIdx].startsWith("--") ? args[outputIdx] : "demo.tape";
  const binIdx = args.indexOf("--bin");
  const cliBin = binIdx !== -1 ? args[binIdx + 1] : "./bin/cli.ts";

  if (!jsonPath) {
    console.error("Usage: bun run generate-tape.ts <normalized-json> [output.tape] [--bin <path>]");
    process.exit(1);
  }

  const spec: NormalizedSpec = JSON.parse(readFileSync(resolve(jsonPath), "utf-8"));
  const tape = generateTape(spec, cliBin);
  writeFileSync(resolve(outputPath), tape);
  process.stderr.write(`Generated tape: ${outputPath}\n`);
}

main();
