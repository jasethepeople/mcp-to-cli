#!/usr/bin/env bun
/**
 * generate-install.ts
 *
 * Generates a curl-installable install.sh script from a map of
 * platform binary URLs.
 *
 * Usage:
 *   bun run generate-install.ts --name <cli-name> --version <version> \
 *     --linux-amd64 <url> --linux-arm64 <url> \
 *     --darwin-amd64 <url> --darwin-arm64 <url> \
 *     --windows-amd64 <url> --windows-arm64 <url> \
 *     > install.sh
 */

function getArg(args: string[], flag: string): string {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : "";
}

const args = process.argv.slice(2);
const name = getArg(args, "--name") || "mycli";
const version = getArg(args, "--version") || "1.0.0";

const urls: Record<string, string> = {
  "linux/amd64": getArg(args, "--linux-amd64"),
  "linux/arm64": getArg(args, "--linux-arm64"),
  "darwin/amd64": getArg(args, "--darwin-amd64"),
  "darwin/arm64": getArg(args, "--darwin-arm64"),
  "windows/amd64": getArg(args, "--windows-amd64"),
  "windows/arm64": getArg(args, "--windows-arm64"),
};

const script = `#!/bin/sh
set -e

# ${name} installer — v${version}
# Usage: curl -fsSL <url> | sh

NAME="${name}"
VERSION="${version}"

# ── Detect platform ──────────────────────────────────────────────────────────

detect_os() {
  case "$(uname -s | tr '[:upper:]' '[:lower:]')" in
    linux*)  echo "linux" ;;
    darwin*) echo "darwin" ;;
    mingw*|msys*|cygwin*) echo "windows" ;;
    *) echo "unsupported" ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo "amd64" ;;
    aarch64|arm64) echo "arm64" ;;
    *) echo "unsupported" ;;
  esac
}

OS=$(detect_os)
ARCH=$(detect_arch)

if [ "$OS" = "unsupported" ] || [ "$ARCH" = "unsupported" ]; then
  echo "Error: unsupported platform $(uname -s)/$(uname -m)" >&2
  exit 1
fi

# ── Binary URLs ──────────────────────────────────────────────────────────────

get_url() {
  case "\${OS}/\${ARCH}" in
    linux/amd64)   echo "${urls["linux/amd64"]}" ;;
    linux/arm64)   echo "${urls["linux/arm64"]}" ;;
    darwin/amd64)  echo "${urls["darwin/amd64"]}" ;;
    darwin/arm64)  echo "${urls["darwin/arm64"]}" ;;
    windows/amd64) echo "${urls["windows/amd64"]}" ;;
    windows/arm64) echo "${urls["windows/arm64"]}" ;;
    *) echo "" ;;
  esac
}

URL=$(get_url)
if [ -z "$URL" ]; then
  echo "Error: no binary available for \${OS}/\${ARCH}" >&2
  exit 1
fi

# ── Install ──────────────────────────────────────────────────────────────────

BINARY="$NAME"
[ "$OS" = "windows" ] && BINARY="\${NAME}.exe"

# Determine install directory
if [ -w /usr/local/bin ]; then
  INSTALL_DIR="/usr/local/bin"
elif command -v sudo >/dev/null 2>&1; then
  INSTALL_DIR="/usr/local/bin"
  SUDO="sudo"
else
  INSTALL_DIR="\${HOME}/.local/bin"
  mkdir -p "$INSTALL_DIR"
fi

TMPFILE=$(mktemp)
echo "Downloading $NAME v$VERSION for \${OS}/\${ARCH}..." >&2
curl -fsSL "$URL" -o "$TMPFILE"
chmod +x "$TMPFILE"

echo "Installing to \${INSTALL_DIR}/\${BINARY}..." >&2
\${SUDO:-} mv "$TMPFILE" "\${INSTALL_DIR}/\${BINARY}"

# Verify
if command -v "$NAME" >/dev/null 2>&1; then
  echo "✓ $NAME v$VERSION installed successfully" >&2
  $NAME --version 2>/dev/null || true
else
  echo "✓ Installed to \${INSTALL_DIR}/\${BINARY}" >&2
  echo "  Add \${INSTALL_DIR} to your PATH if not already there" >&2
fi
`;

console.log(script);
