import { Ajv2020 } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
import type { ErrorObject } from "ajv";
import type { AnySchema } from "ajv";
import type { ContractError, Element, Json, OperationMeta } from "../generated/index.js";
import { schemasById, schemasByPath } from "../generated/schemas.js";
export type * from "../generated/index.js";
export type JsonSchema = Exclude<AnySchema, boolean>;
export const CONTRACT_VERSION = "1.0";
export class BoundaryError extends Error {
  constructor(readonly contract: ContractError) {
    super(contract.message);
  }
}
export function fail(code: ContractError["code"], message: string, details?: Json): never {
  throw new BoundaryError({
    code,
    message,
    retryable: ["unavailable", "rate_limited"].includes(code),
    ...(details === undefined ? {} : { details }),
  });
}
export function errorOf(error: unknown): ContractError {
  return error instanceof BoundaryError
    ? error.contract
    : { code: "internal", message: "Internal engine error", retryable: false };
}
export function inlineText(text: string): boolean {
  if (/^\s*(#{1,6}\s|[-+*]\s|\d+[.)]\s|>\s|```)/m.test(text)) return false;
  function scan(s: string): boolean {
    const marks: {
      size: number;
      start: number;
    }[] = [];
    let i = 0;
    while (i < s.length) {
      if (s[i] === "\\") {
        if (i + 1 >= s.length) return false;
        i += 2;
        continue;
      }
      if (s[i] === "`") {
        const end = s.indexOf("`", i + 1);
        if (end <= i + 1) return false;
        i = end + 1;
        continue;
      }
      if (s[i] === "<" && /^<\/?[A-Za-z!]/.test(s.slice(i))) return false;
      if (s.startsWith("~~", i) || s.startsWith("__", i) || s.startsWith("[^", i) || s.startsWith("![", i))
        return false;
      if (s[i] === "*") {
        let count = 0;
        while (s[i + count] === "*") count++;
        const run = count;
        while (count) {
          const top = marks.at(-1);
          if (top && (top.size === count || count >= 3)) {
            if (i <= top.start + top.size) return false;
            count -= top.size;
            marks.pop();
          } else {
            const size = count >= 2 ? 2 : 1;
            marks.push({ size, start: i });
            count -= size;
          }
        }
        i += run;
        continue;
      }
      if (s[i] === "[") {
        let end = i + 1;
        while (end < s.length) {
          if (s[end] === "\\") {
            end += 2;
            continue;
          }
          if (s[end] === "]") break;
          end++;
        }
        if (s.slice(end, end + 2) !== "](") return false;
        const close = s.indexOf(")", end + 2);
        if (close < 0 || !scan(s.slice(i + 1, end)) || /[\s()]/.test(s.slice(end + 2, close))) return false;
        i = close + 1;
        continue;
      }
      i++;
    }
    return marks.length === 0;
  }
  return scan(text);
}
const base = "https://vibecab.local/schemas/";
export class Contract {
  private readonly ajv = new Ajv2020({ allErrors: true, strict: true });
  readonly operations = new Map<
    string,
    {
      kind: "command" | "query";
      meta: OperationMeta;
    }
  >();
  private readonly children: Record<string, string[]>;
  constructor() {
    for (const [format, validator] of Object.entries(fullFormats)) this.ajv.addFormat(format, validator);
    this.ajv.addKeyword({
      keyword: "inlineText",
      type: "string",
      schemaType: "boolean",
      validate: (_: boolean, data: string) => inlineText(data),
    });
    this.ajv.addKeyword({ keyword: "operation", valid: true });
    this.ajv.addKeyword({ keyword: "docChildren", valid: true });
    this.ajv.addKeyword({
      keyword: "docTree",
      type: "array",
      schemaType: "boolean",
      validate: (_: boolean, data: unknown[]) => this.validTree(data),
    });
    const childSchema = this.ajv.compile<{
      docChildren: Record<string, string[]>;
    }>({
      type: "object",
      required: ["docChildren"],
      properties: {
        docChildren: {
          type: "object",
          additionalProperties: { type: "array", items: { type: "string" } },
        },
      },
    });
    const element: unknown = schemasById[schemasByPath["element.json"] ?? ""];
    if (!childSchema(element)) throw new Error("Invalid child rules");
    this.children = element.docChildren;
    const metaSchema = this.ajv.compile<{
      operation: {
        name: string;
        kind: "command" | "query";
        meta: OperationMeta;
      };
    }>({
      type: "object",
      required: ["operation"],
      properties: {
        operation: {
          type: "object",
          required: ["name", "kind", "meta"],
          properties: {
            name: { type: "string" },
            kind: { enum: ["command", "query"] },
            meta: {
              type: "object",
              required: ["effect", "irreversible", "channels"],
              properties: {
                effect: { enum: ["read", "collaborate", "admin"] },
                irreversible: { type: "boolean" },
                destructive: { type: "boolean" },
                channels: {
                  type: "array",
                  items: { enum: ["in_process", "http", "cli", "mcp"] },
                },
              },
            },
          },
        },
      },
    });
    for (const schema of Object.values(schemasById)) {
      if (!schema || typeof schema !== "object") throw new Error("Invalid schema");
      this.ajv.addSchema(schema);
      if (metaSchema(schema))
        this.operations.set(schema.operation.name, {
          kind: schema.operation.kind,
          meta: schema.operation.meta,
        });
    }
  }
  read<T>(name: string, value: unknown, fragment = ""): T {
    const validate = this.ajv.getSchema<T>(base + name + ".json" + fragment);
    if (!validate) throw new Error("Missing schema: " + name);
    if ("$async" in validate) throw new Error("Asynchronous schema validation is unsupported");
    if (!validate(value)) fail("invalid", "Contract validation failed", this.paths(validate.errors));
    return value;
  }
  schema(name: string): JsonSchema {
    const validator = this.ajv.getSchema(base + name + ".json");
    if (!validator || typeof validator.schema !== "object" || validator.schema === null)
      throw new Error("Missing object schema: " + name);
    return validator.schema as JsonSchema;
  }
  validates(schema: JsonSchema, value: unknown): boolean {
    try {
      const validate = this.ajv.compile(schema);
      return "$async" in validate ? false : validate(value);
    } catch {
      return false;
    }
  }
  schemaIsValid(schema: JsonSchema): boolean {
    try {
      const validate = this.ajv.compile(schema);
      return !("$async" in validate);
    } catch {
      return false;
    }
  }
  private paths(errors: ErrorObject[] | null | undefined): Json {
    // Never echo input values or parser messages: payloads may contain secrets.
    return { paths: [...new Set((errors ?? []).map((e) => e.instancePath))] };
  }
  allows(parent: Element | undefined, child: Element): boolean {
    return parent
      ? (this.children[parent.type] ?? []).includes(child.type)
      : !["list_item", "table_row", "table_cell"].includes(child.type);
  }
  private validTree(values: unknown[]): boolean {
    const elements: Element[] = [];
    try {
      for (const v of values) elements.push(this.read<Element>("element", v));
    } catch {
      return false;
    }
    const map = new Map(elements.map((e) => [e.elementId, e]));
    if (map.size !== elements.length) return false;
    const siblings = new Set<string>();
    for (const element of elements) {
      const parent = element.parentId === null ? undefined : map.get(element.parentId);
      if ((element.parentId !== null && !parent) || !this.allows(parent, element)) return false;
      const key = JSON.stringify([element.parentId, element.order]);
      if (siblings.has(key)) return false;
      siblings.add(key);
      const visited = new Set([element.elementId]);
      let next = parent;
      while (next) {
        if (visited.has(next.elementId)) return false;
        visited.add(next.elementId);
        next = next.parentId === null ? undefined : map.get(next.parentId);
      }
    }
    return true;
  }
}
