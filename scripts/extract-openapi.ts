#!/usr/bin/env bun
/**
 * extract-openapi.ts
 *
 * Parses an OpenAPI 3.x (or 2.0 via conversion) spec from a file path or URL
 * and outputs a normalized command JSON to stdout.
 *
 * Usage:
 *   bun run extract-openapi.ts <spec-path-or-url> [--name <cli-name>]
 *
 * Output (JSON to stdout):
 *   {
 *     name: string,
 *     description: string,
 *     version: string,
 *     baseUrl: string,
 *     auth: AuthScheme[],
 *     groups: Group[]
 *   }
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { parse as parseYaml } from "yaml";

// ── Types ────────────────────────────────────────────────────────────────────

interface Param {
  name: string;
  description: string;
  type: "string" | "number" | "boolean" | "array" | "object";
  required: boolean;
  default?: unknown;
  enum?: string[];
  in: "query" | "path" | "header" | "cookie" | "body";
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

interface AuthScheme {
  type: "apiKey" | "http" | "oauth2" | "openIdConnect";
  name: string;
  in?: string;
  scheme?: string;
  description?: string;
}

interface NormalizedSpec {
  name: string;
  description: string;
  version: string;
  baseUrl: string;
  auth: AuthScheme[];
  groups: Group[];
  source: "openapi";
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function kebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
}

function resolveRef(spec: any, ref: string): any {
  if (!ref.startsWith("#/")) return {};
  const parts = ref.replace("#/", "").split("/");
  let current = spec;
  for (const part of parts) {
    current = current?.[part];
    if (!current) return {};
  }
  // Recursively resolve if the result itself is a $ref
  if (current?.$ref) return resolveRef(spec, current.$ref);
  return current;
}

function deepResolveRefs(spec: any, obj: any): any {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((item) => deepResolveRefs(spec, item));
  if (obj.$ref) {
    const resolved = resolveRef(spec, obj.$ref);
    return deepResolveRefs(spec, resolved);
  }
  const result: any = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = deepResolveRefs(spec, value);
  }
  return result;
}

function mapSchemaType(schema: any): Param["type"] {
  if (!schema) return "string";
  if (schema.type === "integer" || schema.type === "number") return "number";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "array") return "array";
  if (schema.type === "object") return "object";
  return "string";
}

function extractParamsFromSchema(
  schema: any,
  location: Param["in"]
): Param[] {
  if (!schema || schema.type !== "object" || !schema.properties) return [];
  const required = new Set(schema.required || []);
  return Object.entries(schema.properties).map(
    ([name, prop]: [string, any]) => ({
      name: kebabCase(name),
      description: prop.description || "",
      type: mapSchemaType(prop),
      required: required.has(name),
      default: prop.default,
      enum: prop.enum,
      in: location,
    })
  );
}

// ── Spec Loading ─────────────────────────────────────────────────────────────

async function loadSpec(pathOrUrl: string): Promise<any> {
  let raw: string;

  if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) {
    const resp = await fetch(pathOrUrl);
    if (!resp.ok) throw new Error(`Failed to fetch spec: ${resp.status} ${resp.statusText}`);
    raw = await resp.text();
  } else {
    raw = readFileSync(resolve(pathOrUrl), "utf-8");
  }

  // Try JSON first, fall back to YAML
  try {
    return JSON.parse(raw);
  } catch {
    return parseYaml(raw);
  }
}

// ── Swagger 2.0 → OpenAPI 3.x conversion (minimal) ──────────────────────────

function convertSwagger2ToOpenAPI3(spec: any): any {
  const converted: any = {
    openapi: "3.0.0",
    info: spec.info || { title: "API", version: "1.0.0" },
    paths: {},
    components: {
      schemas: spec.definitions || {},
      securitySchemes: {},
    },
  };

  // Base URL
  const scheme = spec.schemes?.[0] || "https";
  const host = spec.host || "localhost";
  const basePath = spec.basePath || "";
  converted.servers = [{ url: `${scheme}://${host}${basePath}` }];

  // Security definitions → securitySchemes
  if (spec.securityDefinitions) {
    for (const [name, def] of Object.entries<any>(spec.securityDefinitions)) {
      if (def.type === "apiKey") {
        converted.components.securitySchemes[name] = {
          type: "apiKey",
          name: def.name,
          in: def.in,
        };
      } else if (def.type === "basic") {
        converted.components.securitySchemes[name] = {
          type: "http",
          scheme: "basic",
        };
      } else if (def.type === "oauth2") {
        converted.components.securitySchemes[name] = {
          type: "oauth2",
          flows: {},
          description: def.description,
        };
      }
    }
  }

  // Paths
  for (const [path, methods] of Object.entries<any>(spec.paths || {})) {
    converted.paths[path] = {};
    for (const [method, op] of Object.entries<any>(methods)) {
      if (["get", "post", "put", "patch", "delete", "head", "options"].indexOf(method) === -1) continue;

      const newOp: any = {
        operationId: op.operationId,
        summary: op.summary,
        description: op.description,
        tags: op.tags,
        parameters: [],
      };

      // Convert parameters
      for (const param of op.parameters || []) {
        if (param.in === "body") {
          newOp.requestBody = {
            content: {
              "application/json": {
                schema: param.schema,
              },
            },
            required: param.required,
          };
        } else {
          newOp.parameters.push({
            name: param.name,
            in: param.in,
            description: param.description,
            required: param.required,
            schema: { type: param.type || "string", default: param.default, enum: param.enum },
          });
        }
      }

      // Responses
      newOp.responses = op.responses;
      converted.paths[path][method] = newOp;
    }
  }

  return converted;
}

// ── Main Extraction ──────────────────────────────────────────────────────────

function extractAuth(spec: any): AuthScheme[] {
  const schemes = spec.components?.securitySchemes || {};
  return Object.entries<any>(schemes).map(([name, scheme]) => ({
    type: scheme.type,
    name,
    in: scheme.in,
    scheme: scheme.scheme,
    description: scheme.description,
  }));
}

function extractCommands(spec: any): Group[] {
  const groupMap = new Map<string, Command[]>();
  const resolved = deepResolveRefs(spec, spec.paths);

  for (const [path, methods] of Object.entries<any>(resolved)) {
    for (const [method, op] of Object.entries<any>(methods)) {
      if (["get", "post", "put", "patch", "delete", "head", "options"].indexOf(method) === -1) continue;
      if (!op || typeof op !== "object") continue;

      const tag = op.tags?.[0] || "default";
      const operationId = op.operationId || `${method}-${path.replace(/[^a-zA-Z0-9]/g, "-")}`;
      const commandName = kebabCase(operationId);

      const params: Param[] = [];

      // Path/query/header parameters
      for (const param of op.parameters || []) {
        params.push({
          name: kebabCase(param.name),
          description: param.description || "",
          type: mapSchemaType(param.schema),
          required: param.required || false,
          default: param.schema?.default,
          enum: param.schema?.enum,
          in: param.in,
        });
      }

      // Request body parameters
      if (op.requestBody) {
        const content = op.requestBody.content;
        const schema =
          content?.["application/json"]?.schema ||
          content?.["application/x-www-form-urlencoded"]?.schema ||
          Object.values(content || {})[0]?.schema;

        if (schema) {
          const bodyParams = extractParamsFromSchema(
            deepResolveRefs(spec, schema),
            "body"
          );
          params.push(...bodyParams);
        }
      }

      const command: Command = {
        name: commandName,
        description: op.summary || op.description || "",
        method: method.toUpperCase(),
        path,
        params,
      };

      if (!groupMap.has(tag)) groupMap.set(tag, []);
      groupMap.get(tag)!.push(command);
    }
  }

  return Array.from(groupMap.entries()).map(([name, commands]) => ({
    name: kebabCase(name),
    description: name,
    commands,
  }));
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const specPath = args.find((a) => !a.startsWith("--"));
  const nameIdx = args.indexOf("--name");
  const cliName = nameIdx !== -1 ? args[nameIdx + 1] : undefined;

  if (!specPath) {
    console.error("Usage: bun run extract-openapi.ts <spec-path-or-url> [--name <cli-name>]");
    process.exit(1);
  }

  let spec = await loadSpec(specPath);

  // Detect Swagger 2.0 and convert
  if (spec.swagger && spec.swagger.startsWith("2")) {
    spec = convertSwagger2ToOpenAPI3(spec);
  }

  if (!spec.openapi && !spec.swagger) {
    console.error("Error: Not a valid OpenAPI/Swagger spec");
    process.exit(1);
  }

  const title = spec.info?.title || "api";
  const baseUrl =
    spec.servers?.[0]?.url || "http://localhost:3000";

  const result: NormalizedSpec = {
    name: cliName || kebabCase(title) + "-cli",
    description: spec.info?.description || `CLI for ${title}`,
    version: spec.info?.version || "1.0.0",
    baseUrl,
    auth: extractAuth(spec),
    groups: extractCommands(spec),
    source: "openapi",
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
