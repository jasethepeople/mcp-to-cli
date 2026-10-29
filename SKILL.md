---
name: mcp-to-cli
description: Generates an agent-first Go CLI from an OpenAPI spec or MCP server repo. Cross-compiles for all platforms, uploads binaries, and delivers a README.md with one-liner install commands, demo GIF, and full command reference. Triggers on "generate CLI from API", "OpenAPI to CLI", "MCP to CLI", "CLI from spec", "create CLI package", "API to CLI".
---

# MCP to CLI Generator

You turn API specs and MCP servers into **agent-friendly Go CLIs**. The end deliverable is a **README.md** — a single document with platform install commands at the top, a demo GIF, full command reference, and env var docs. The Go source code, cross-compilation, and binary uploads are intermediate steps the user never sees.

## Bundled Scripts

| Script | Purpose | Usage |
|---|---|---|
| `extract-openapi.ts` | OpenAPI 2.0/3.x → normalized JSON | `bun run <skill>/scripts/extract-openapi.ts <spec-url-or-path> --name <cli-name>` |
| `extract-mcp.ts` | MCP server → normalized JSON | `bun run <skill>/scripts/extract-mcp.ts --cmd "<cmd>" --name <name>` or `--repo <github-url>` |
| `generate-tape.ts` | Normalized JSON → VHS `.tape` file | `bun run <skill>/scripts/generate-tape.ts <json-path> <output.tape> --bin "<cli-cmd>"` |
| `generate-install.ts` | Binary URLs → `install.sh` | `bun run <skill>/scripts/generate-install.ts --name <n> --version <v> --linux-amd64 <url> ...` |

**Before running scripts:** `cd <skill>/scripts && bun add yaml @modelcontextprotocol/sdk`

## Agent-First CLI Rules

Non-negotiable for every generated CLI:

1. **Stdout = data.** JSON only. Stderr = everything else.
2. **Zero prompts.** Missing value → exit with error, not a question.
3. **Env-var auth.** Which vars? Decide based on the API.
4. **Semantic exit codes.** 0=success, 1=input, 2=auth, 3=not found, 4=server, 5=network.
5. **Stdin piping.** Body commands get `--stdin` and `--data <json>`.
6. **JSON default.** `--output table` for humans. JSON is the contract.
7. **Complete `--help`.** Every flag, type, required/optional, env var.
8. **1:1 mapping.** Commands map directly to API operations or MCP tools.

## Final Deliverable

A **README.md** file (delivered via the `file` type) containing:

1. **CLI name + one-line description**
2. **Demo GIF** (uploaded, embedded as image)
3. **Install section** — platform-specific commands at the top:
   ```
   # macOS (Apple Silicon)
   curl -fsSL <url> -o /usr/local/bin/<cli> && chmod +x /usr/local/bin/<cli>

   # macOS (Intel)
   curl -fsSL <url> -o /usr/local/bin/<cli> && chmod +x /usr/local/bin/<cli>

   # Linux (x86_64)
   curl -fsSL <url> -o /usr/local/bin/<cli> && chmod +x /usr/local/bin/<cli>

   # Linux (ARM64)
   curl -fsSL <url> -o /usr/local/bin/<cli> && chmod +x /usr/local/bin/<cli>

   # Windows (PowerShell)
   Invoke-WebRequest -Uri <url> -OutFile <cli>.exe

   # Or auto-detect your platform:
   curl -fsSL <install-script-url> | sh
   ```
4. **Quick start** — env var setup + example commands
5. **Environment variables table**
6. **Command reference table** (command, description, flags)
7. **Exit codes table**
8. **Piping/composition examples**

<preflight>
Before generating, ask the user:

1. **Source?** — OpenAPI spec (URL or file), MCP repo URL, or MCP start command
2. **CLI name?** — e.g., `petstore`, `gh-tools`

Then run the extraction script, review the normalized output, and present:
- Source type and version detected
- Number of command groups and total commands
- Auth schemes found and how you'll handle them
- Any edge cases

Get approval before writing code.
</preflight>

## Execution

### Phase 1: Extract
Run the appropriate extraction script → normalized JSON. Review output.

### Phase 2: Write Go CLI

Ensure Go is available:
```bash
which go || {
  curl -fsSL "https://go.dev/dl/go1.24.1.linux-amd64.tar.gz" -o /tmp/go.tar.gz
  sudo rm -rf /usr/local/go && sudo tar -C /usr/local -xzf /tmp/go.tar.gz
}
export PATH=$PATH:/usr/local/go/bin
```

Write the CLI in a temp working directory. Go + Cobra. `net/http` for API calls (no extra deps). The agent writes real Go code based on the normalized JSON — auth, error handling, response shaping all based on the specific API.

### Phase 3: Test
```bash
go build -o <cli> . && ./<cli> --help
echo '{}' | ./<cli> <cmd> --stdin 2>/dev/null | jq .
```

### Phase 4: Cross-Compile + Upload

```bash
mkdir -p dist
for target in linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64; do
  os="${target%/*}"; arch="${target#*/}"
  ext=""; [ "$os" = "windows" ] && ext=".exe"
  CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -ldflags="-s -w" -o "dist/<cli>-${os}-${arch}${ext}" .
done
```

Upload every binary via `upload` command. Collect all URLs.

### Phase 5: Generate install.sh + Upload

Use `generate-install.ts` to create `install.sh` from the uploaded binary URLs. Upload `install.sh` via `upload`.

### Phase 6: Demo GIF

```bash
which vhs || {
  curl -fsSL -L "https://github.com/charmbracelet/vhs/releases/download/v0.11.0/vhs_0.11.0_Linux_x86_64.tar.gz" -o /tmp/vhs.tar.gz
  tar xzf /tmp/vhs.tar.gz -C /tmp && sudo cp /tmp/vhs_0.11.0_Linux_x86_64/vhs /usr/local/bin/vhs
}
which ttyd || {
  curl -fsSL -L "https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64" -o /tmp/ttyd
  sudo mv /tmp/ttyd /usr/local/bin/ttyd && chmod +x /usr/local/bin/ttyd
}
which jq || sudo apt-get install -y jq
```

Generate tape, record GIF, upload GIF via `upload`.

### Phase 7: Write README.md + Deliver

Assemble the README.md with:
- Uploaded demo GIF URL as image
- Per-platform direct download URLs
- Auto-detect install script URL
- Full command reference from normalized JSON
- Everything a user needs to install and use the CLI without reading source code

**Deliver the README.md as a `file` artifact.** This is the only deliverable the user cares about.
