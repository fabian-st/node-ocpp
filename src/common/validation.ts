import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import AjvModule, { type ValidateFunction } from 'ajv';
import Ajv04Module from 'ajv-draft-04';
import formatsModule from 'ajv-formats';
import type { ValidationIssue } from './errors.js';
import type { ProtocolSpec } from './protocol.js';

/** `strict` rejects invalid messages, `warn` processes them but emits `validation_error`. */
export type ValidationMode = 'strict' | 'warn' | 'off';

export interface ValidationConfig {
  inbound: ValidationMode;
  outbound: ValidationMode;
}

/** `true` = strict both ways, `false` = off; or a mode for both, or per direction. */
export type ValidationOption = boolean | ValidationMode | Partial<ValidationConfig>;

export function resolveValidation(option: ValidationOption = true): ValidationConfig {
  if (typeof option === 'object') {
    return { inbound: option.inbound ?? 'strict', outbound: option.outbound ?? 'strict' };
  }
  const mode = option === true ? 'strict' : option === false ? 'off' : option;
  return { inbound: mode, outbound: mode };
}

// CommonJS interop: these packages expose their main export as `module.exports.default`.
const Ajv = AjvModule.default;
const Ajv04 = Ajv04Module.default;
const addFormats = formatsModule.default;

/**
 * Validates payloads against the official JSON schemas of one protocol version.
 * Schemas are compiled lazily on first use and shared process-wide.
 */
export class JsonSchemaValidator {
  static readonly #instances = new Map<string, JsonSchemaValidator>();

  static for(spec: ProtocolSpec): JsonSchemaValidator {
    const key = spec.schemas.dir.href;
    let instance = this.#instances.get(key);
    if (!instance) this.#instances.set(key, (instance = new JsonSchemaValidator(spec)));
    return instance;
  }

  readonly #dir: URL;
  readonly #ajv: InstanceType<typeof Ajv>;
  readonly #compiled = new Map<string, ValidateFunction>();

  private constructor(spec: ProtocolSpec) {
    this.#dir = spec.schemas.dir;
    // `strict: false`: the official schemas contain non-standard keywords (`javaType`, `comment`).
    const options = { strict: false, allErrors: false };
    this.#ajv = spec.schemas.draft === 4 ? new Ajv04(options) : new Ajv(options);
    if (spec.schemas.draft === 6) {
      const require = createRequire(import.meta.url);
      this.#ajv.addMetaSchema(require('ajv/dist/refs/json-schema-draft-06.json'));
    }
    addFormats(this.#ajv);
  }

  /** Validates `payload` against `<messageName>.json`; returns an empty list when valid. */
  validate(messageName: string, payload: unknown): ValidationIssue[] {
    const validate = this.#schema(messageName);
    if (validate(payload)) return [];
    return (validate.errors ?? []).map((e) => ({
      path: e.instancePath,
      message: e.message ?? 'is invalid',
      keyword: e.keyword,
    }));
  }

  #schema(messageName: string): ValidateFunction {
    let fn = this.#compiled.get(messageName);
    if (!fn) {
      const file = new URL(`${messageName}.json`, this.#dir);
      fn = this.#ajv.compile(JSON.parse(readFileSync(file, 'utf8')));
      this.#compiled.set(messageName, fn);
    }
    return fn;
  }
}
