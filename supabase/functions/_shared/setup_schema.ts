// A small JSON Schema checker for the setup assistant (no dependency, works offline): the subset our two schemas use.
//   validate(schema, value, root?)  -> list of "path: problem" (empty = valid)
//   wireSchema(schema)              -> the schema as sent to the model API: structured outputs reject numeric / length / pattern
//                                      constraints and array sizes above 1, so they are removed there and checked here instead.
// Supported keywords: type (string or list), const, enum, properties, required, additionalProperties: false, items, minItems,
// maxItems, minLength, maxLength, pattern, minimum, maximum, anyOf, $ref "#/$defs/<name>".
// deno-lint-ignore-file no-explicit-any
export type Schema = Record<string, any>;

const typeOf = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;
const typeOk = (want: string, v: unknown) => {
  const t = typeOf(v);
  return want === t || (want === "number" && t === "integer");
};

export function validate(schema: Schema, value: unknown, root: Schema = schema, path = "$"): string[] {
  if (schema.$ref) {
    const name = String(schema.$ref).replace(/^#\/\$defs\//, "");
    const target = root.$defs?.[name];
    if (!target) return [`${path}: unknown $ref ${schema.$ref}`];
    return validate(target, value, root, path);
  }
  if (schema.anyOf) {
    const all = (schema.anyOf as Schema[]).map((s) => validate(s, value, root, path));
    if (all.some((e) => e.length === 0)) return [];
    // report the branch that got furthest (fewest problems) so the message stays useful
    return all.sort((a, b) => a.length - b.length)[0];
  }
  const errs: string[] = [];
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t: string) => typeOk(t, value))) return [`${path}: expected ${types.join("|")}, got ${typeOf(value)}`];
  }
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) errs.push(`${path}: expected ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((e: unknown) => JSON.stringify(e) === JSON.stringify(value))) errs.push(`${path}: not one of the allowed values`);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) errs.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) errs.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) errs.push(`${path}: does not match the pattern`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${path}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${path}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => errs.push(...validate(schema.items, v, root, `${path}[${i}]`)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const k of schema.required ?? []) if (!(k in obj)) errs.push(`${path}.${k}: required`);
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(obj)) {
      if (props[k]) errs.push(...validate(props[k], v, root, `${path}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${path}.${k}: not allowed`);
    }
  }
  return errs;
}

const STRIP = new Set(["minLength", "maxLength", "pattern", "minimum", "maximum", "maxItems", "$comment"]);
/** Copy without the keywords structured outputs do not accept (minItems above 1 is dropped too). */
export function wireSchema(schema: Schema): Schema {
  if (Array.isArray(schema)) return schema.map(wireSchema) as unknown as Schema;
  if (!schema || typeof schema !== "object") return schema;
  const out: Schema = {};
  for (const [k, v] of Object.entries(schema)) {
    if (STRIP.has(k)) continue;
    if (k === "minItems" && typeof v === "number" && v > 1) continue;
    out[k] = v && typeof v === "object" ? wireSchema(v as Schema) : v;
  }
  return out;
}
