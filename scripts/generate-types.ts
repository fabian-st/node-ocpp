/**
 * Generates TypeScript declarations from the official OCPP JSON schemas.
 *
 *   npm run generate
 *
 * For every protocol version this writes
 *   src/<version>/types.generated.ts  – payload interfaces, enums and action maps
 *   src/<version>/meta.generated.ts   – runtime metadata (action directions, date-time field paths)
 *
 * Runs directly on Node ≥ 22.18 via native type stripping (no build step).
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

interface JsonSchema {
  $ref?: string;
  title?: string;
  description?: string;
  type?: string;
  format?: string;
  enum?: string[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  definitions?: Record<string, JsonSchema>;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  multipleOf?: number;
  default?: unknown;
}

interface VersionConfig {
  /** Folder name below schemas/json. */
  schemaDir: string;
  /** Folder name below src. */
  dir: string;
  title: string;
  /** Names of the action maps: [initiated by charge point, initiated by central system]. */
  mapNames: [client: string, server: string];
  /** Actions the charge point initiates. */
  clientActions: string[];
  /** Actions the central system initiates. */
  serverActions: string[];
  /**
   * Names for inline (anonymous) schemas, keyed by `<ParentType>.<property>`.
   * Used to reproduce the type names of the official specification.
   */
  names?: Record<string, string>;
}

const OCPP16: VersionConfig = {
  schemaDir: 'ocpp16',
  dir: 'ocpp16j',
  title: 'OCPP 1.6',
  mapNames: ['ChargePointActions', 'CentralSystemActions'],
  clientActions: [
    'Authorize',
    'BootNotification',
    'DataTransfer',
    'DiagnosticsStatusNotification',
    'FirmwareStatusNotification',
    'Heartbeat',
    'MeterValues',
    'StartTransaction',
    'StatusNotification',
    'StopTransaction',
  ],
  serverActions: [
    'CancelReservation',
    'ChangeAvailability',
    'ChangeConfiguration',
    'ClearCache',
    'ClearChargingProfile',
    'DataTransfer',
    'GetCompositeSchedule',
    'GetConfiguration',
    'GetDiagnostics',
    'GetLocalListVersion',
    'RemoteStartTransaction',
    'RemoteStopTransaction',
    'ReserveNow',
    'Reset',
    'SendLocalList',
    'SetChargingProfile',
    'TriggerMessage',
    'UnlockConnector',
    'UpdateFirmware',
  ],
  // Type names as used in chapter 7 ("Types") of the OCPP 1.6 specification.
  names: {
    'IdTagInfo.status': 'AuthorizationStatus',
    'ChangeAvailabilityResponse.status': 'AvailabilityStatus',
    'ChangeAvailabilityRequest.type': 'AvailabilityType',
    'CancelReservationResponse.status': 'CancelReservationStatus',
    'StatusNotificationRequest.errorCode': 'ChargePointErrorCode',
    'StatusNotificationRequest.status': 'ChargePointStatus',
    'ChargingProfile.chargingProfileKind': 'ChargingProfileKindType',
    'ChargingProfile.chargingProfilePurpose': 'ChargingProfilePurposeType',
    'ClearChargingProfileRequest.chargingProfilePurpose': 'ChargingProfilePurposeType',
    'SetChargingProfileResponse.status': 'ChargingProfileStatus',
    'ChargingSchedule.chargingRateUnit': 'ChargingRateUnitType',
    'GetCompositeScheduleRequest.chargingRateUnit': 'ChargingRateUnitType',
    'ClearCacheResponse.status': 'ClearCacheStatus',
    'ClearChargingProfileResponse.status': 'ClearChargingProfileStatus',
    'ChangeConfigurationResponse.status': 'ConfigurationStatus',
    'DataTransferResponse.status': 'DataTransferStatus',
    'DiagnosticsStatusNotificationRequest.status': 'DiagnosticsStatus',
    'FirmwareStatusNotificationRequest.status': 'FirmwareStatus',
    'GetCompositeScheduleResponse.status': 'GetCompositeScheduleStatus',
    'SampledValue.context': 'ReadingContext',
    'SampledValue.format': 'ValueFormat',
    'SampledValue.measurand': 'Measurand',
    'SampledValue.phase': 'Phase',
    'SampledValue.location': 'Location',
    'SampledValue.unit': 'UnitOfMeasure',
    'TriggerMessageRequest.requestedMessage': 'MessageTrigger',
    'StopTransactionRequest.reason': 'Reason',
    'ChargingProfile.recurrencyKind': 'RecurrencyKindType',
    'BootNotificationResponse.status': 'RegistrationStatus',
    'RemoteStartTransactionResponse.status': 'RemoteStartStopStatus',
    'RemoteStopTransactionResponse.status': 'RemoteStartStopStatus',
    'ReserveNowResponse.status': 'ReservationStatus',
    'ResetResponse.status': 'ResetStatus',
    'ResetRequest.type': 'ResetType',
    'TriggerMessageResponse.status': 'TriggerMessageStatus',
    'UnlockConnectorResponse.status': 'UnlockStatus',
    'SendLocalListResponse.status': 'UpdateStatus',
    'SendLocalListRequest.updateType': 'UpdateType',
    'GetConfigurationResponse.configurationKey': 'KeyValue',
    'SendLocalListRequest.localAuthorizationList': 'AuthorizationData',
    'SetChargingProfileRequest.csChargingProfiles': 'ChargingProfile',
    'RemoteStartTransactionRequest.chargingProfile': 'ChargingProfile',
    'GetCompositeScheduleResponse.chargingSchedule': 'ChargingSchedule',
    'StopTransactionRequest.transactionData': 'MeterValue',
  },
};

const OCPP201: VersionConfig = {
  schemaDir: 'ocpp201',
  dir: 'ocpp201',
  title: 'OCPP 2.0.1',
  mapNames: ['ChargingStationActions', 'CsmsActions'],
  clientActions: [
    'Authorize',
    'BootNotification',
    'ClearedChargingLimit',
    'DataTransfer',
    'FirmwareStatusNotification',
    'Get15118EVCertificate',
    'GetCertificateStatus',
    'Heartbeat',
    'LogStatusNotification',
    'MeterValues',
    'NotifyChargingLimit',
    'NotifyCustomerInformation',
    'NotifyDisplayMessages',
    'NotifyEVChargingNeeds',
    'NotifyEVChargingSchedule',
    'NotifyEvent',
    'NotifyMonitoringReport',
    'NotifyReport',
    'PublishFirmwareStatusNotification',
    'ReportChargingProfiles',
    'ReservationStatusUpdate',
    'SecurityEventNotification',
    'SignCertificate',
    'StatusNotification',
    'TransactionEvent',
  ],
  serverActions: [
    'CancelReservation',
    'CertificateSigned',
    'ChangeAvailability',
    'ClearCache',
    'ClearChargingProfile',
    'ClearDisplayMessage',
    'ClearVariableMonitoring',
    'CostUpdated',
    'CustomerInformation',
    'DataTransfer',
    'DeleteCertificate',
    'GetBaseReport',
    'GetChargingProfiles',
    'GetCompositeSchedule',
    'GetDisplayMessages',
    'GetInstalledCertificateIds',
    'GetLocalListVersion',
    'GetLog',
    'GetMonitoringReport',
    'GetReport',
    'GetTransactionStatus',
    'GetVariables',
    'InstallCertificate',
    'PublishFirmware',
    'RequestStartTransaction',
    'RequestStopTransaction',
    'ReserveNow',
    'Reset',
    'SendLocalList',
    'SetChargingProfile',
    'SetDisplayMessage',
    'SetMonitoringBase',
    'SetMonitoringLevel',
    'SetNetworkProfile',
    'SetVariableMonitoring',
    'SetVariables',
    'TriggerMessage',
    'UnlockConnector',
    'UnpublishFirmware',
    'UpdateFirmware',
  ],
};

// ---------------------------------------------------------------------------

/** Path into a payload; `*` stands for every element of an array. */
type FieldPath = string[];

interface NamedType {
  name: string;
  /** Rendered declaration without doc comment. */
  body: string;
  doc: string;
  /** Structural fingerprint used to de-duplicate identical inline objects. */
  fingerprint: string;
  dateFields: FieldPath[];
}

class Generator {
  private readonly types = new Map<string, NamedType>();
  private readonly byFingerprint = new Map<string, string>();
  private readonly messages: NamedType[] = [];
  private definitions: Record<string, JsonSchema> = {};

  private readonly config: VersionConfig;

  constructor(config: VersionConfig) {
    this.config = config;
  }

  run() {
    const dir = join(ROOT, 'schemas/json', this.config.schemaDir);
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort();

    for (const file of files) {
      const schema = JSON.parse(readFileSync(join(dir, file), 'utf8')) as JsonSchema;
      const name = basename(file, '.json');
      this.definitions = schema.definitions ?? {};
      const { body, dateFields } = this.objectBody(schema, name);
      this.messages.push({
        name,
        body,
        doc: docComment(schema.description, schema),
        fingerprint: '',
        dateFields,
      });
    }

    this.checkActions(files.map((f) => basename(f, '.json')));
    this.write();
  }

  /** Every schema file must belong to exactly the configured actions. */
  private checkActions(names: string[]) {
    const fromSchemas = new Set(names.map((n) => n.replace(/(Request|Response)$/, '')));
    const configured = new Set([...this.config.clientActions, ...this.config.serverActions]);
    const missing = [...fromSchemas].filter((a) => !configured.has(a));
    const unknown = [...configured].filter((a) => !fromSchemas.has(a));
    if (missing.length || unknown.length) {
      throw new Error(
        `${this.config.title}: direction table out of sync. ` +
          `Missing: [${missing.join(', ')}], without schema: [${unknown.join(', ')}]`,
      );
    }
  }

  // --- type rendering -------------------------------------------------------

  /** Renders the TS type expression for `schema`; registers named types as a side effect. */
  private typeOf(
    schema: JsonSchema,
    parent: string,
    prop: string,
  ): { ts: string; dateFields: FieldPath[] } {
    if (schema.$ref) {
      const name = schema.$ref.replace('#/definitions/', '');
      return { ts: name, dateFields: this.registerDefinition(name) };
    }
    if (schema.enum) {
      return { ts: this.registerEnum(schema, this.inlineName(parent, prop, true)), dateFields: [] };
    }
    switch (schema.type) {
      case 'string':
        return schema.format === 'date-time'
          ? { ts: 'Date', dateFields: [[]] }
          : { ts: 'string', dateFields: [] };
      case 'integer':
      case 'number':
        return { ts: 'number', dateFields: [] };
      case 'boolean':
        return { ts: 'boolean', dateFields: [] };
      case 'array': {
        const item = this.typeOf(schema.items ?? {}, parent, prop);
        const ts = /^\w+$/.test(item.ts) ? `${item.ts}[]` : `Array<${item.ts}>`;
        return { ts, dateFields: item.dateFields.map((p) => ['*', ...p]) };
      }
      case 'object':
        return this.registerObject(schema, parent, prop);
      default:
        return { ts: 'unknown', dateFields: [] };
    }
  }

  /**
   * Name for an inline schema: the configured spec name, else the property name for objects
   * (`idTagInfo` → `IdTagInfo`) and parent + property for enums (`ResetRequest.type` → `ResetType`).
   */
  private inlineName(parent: string, prop: string, qualified = false) {
    const configured = this.config.names?.[`${parent}.${prop}`];
    if (configured) return configured;
    return qualified ? parent.replace(/(Request|Response)$/, '') + pascal(prop) : pascal(prop);
  }

  private registerDefinition(name: string): FieldPath[] {
    const existing = this.types.get(name);
    if (existing) return existing.dateFields;
    const schema = this.definitions[name];
    if (!schema) throw new Error(`Unresolved $ref #/definitions/${name}`);
    if (schema.enum) {
      this.registerEnum(schema, name);
      return [];
    }
    // Reserve the name first so recursive references terminate.
    const placeholder: NamedType = { name, body: '', doc: '', fingerprint: name, dateFields: [] };
    this.types.set(name, placeholder);
    const { body, dateFields } = this.objectBody(schema, name);
    Object.assign(placeholder, { body, dateFields, doc: docComment(schema.description, schema) });
    return dateFields;
  }

  private readonly enumValues = new Map<string, string[]>();

  /**
   * Same-named enums are merged into a superset: the official 1.6 schemas are not fully
   * consistent (e.g. `Celsius` is missing from StopTransaction's unit enum). Validation
   * still uses each schema exactly as published.
   */
  private registerEnum(schema: JsonSchema, name: string): string {
    const known = this.enumValues.get(name);
    const values = [...(known ?? []), ...schema.enum!.filter((v) => !known?.includes(v))];
    if (known && values.length !== known.length) {
      console.warn(
        `  ! ${this.config.title}: merged differing enum ${name} (+${values.slice(known.length).join(', ')})`,
      );
    }
    this.enumValues.set(name, values);
    const body = `type ${name} = ${values.map((v) => JSON.stringify(v)).join(' | ')};`;
    const existing = this.types.get(name);
    if (existing) existing.body = body;
    else
      this.types.set(name, {
        name,
        body,
        doc: docComment(schema.description),
        fingerprint: body,
        dateFields: [],
      });
    return name;
  }

  /** Inline objects with identical structure collapse into one named type. */
  private registerObject(schema: JsonSchema, parent: string, prop: string) {
    let name = this.inlineName(parent, prop);
    const rendered = this.objectBody(schema, name);
    // Fingerprint without the declared name, so equal structures match regardless of naming.
    const fingerprint = rendered.body.replace(/^interface \w+/, '');
    const same = this.byFingerprint.get(fingerprint);
    if (same) return { ts: same, dateFields: this.types.get(same)!.dateFields };
    if (this.types.has(name)) name = this.inlineName(parent, prop, true);
    if (this.types.has(name)) throw new Error(`${this.config.title}: name clash for ${name}`);
    rendered.body = rendered.body.replace(/^interface \w+/, `interface ${name}`);
    this.types.set(name, { name, ...rendered, doc: docComment(schema.description), fingerprint });
    this.byFingerprint.set(fingerprint, name);
    return { ts: name, dateFields: rendered.dateFields };
  }

  private objectBody(schema: JsonSchema, name: string): { body: string; dateFields: FieldPath[] } {
    const props = Object.entries(schema.properties ?? {});
    const required = new Set(schema.required ?? []);
    const extensible = schema.additionalProperties !== false;

    if (props.length === 0 && !extensible) {
      return { body: `type ${name} = Record<string, never>;`, dateFields: [] };
    }

    const dateFields: FieldPath[] = [];
    const members = props.map(([prop, propSchema]) => {
      const { ts, dateFields: nested } = this.typeOf(propSchema, name, prop);
      dateFields.push(...nested.map((p) => [prop, ...p]));
      const doc = docComment(propSchema.description, propSchema);
      return `${doc}${prop}${required.has(prop) ? '' : '?'}: ${ts};`;
    });
    if (extensible) members.push('[key: string]: unknown;');
    return { body: `interface ${name} {\n${members.join('\n')}\n}`, dateFields };
  }

  // --- output ---------------------------------------------------------------

  private write() {
    const { config } = this;
    const header = (what: string) =>
      `/* eslint-disable */\n// ${what} for ${config.title}.\n// AUTO-GENERATED by scripts/generate-types.ts from schemas/json/${config.schemaDir} — do not edit.\n\n`;

    const exportDecl = (t: NamedType) => `${t.doc}export ${t.body}`;
    const typesOut = [...this.types.values()].sort((a, b) => a.name.localeCompare(b.name));

    const actionMap = (name: string, actions: string[], who: string) =>
      `/** Actions initiated by the ${who}. */\nexport type ${name} = {\n` +
      actions.map((a) => `  ${a}: { request: ${a}Request; response: ${a}Response };`).join('\n') +
      '\n};';

    const [clientMap, serverMap] = config.mapNames;
    const typesFile =
      header('Payload types') +
      '// ---- Messages ----\n\n' +
      this.messages.map(exportDecl).join('\n\n') +
      '\n\n// ---- Data types ----\n\n' +
      typesOut.map(exportDecl).join('\n\n') +
      '\n\n// ---- Action maps ----\n\n' +
      actionMap(clientMap, config.clientActions, 'charge point (client → server)') +
      '\n\n' +
      actionMap(serverMap, config.serverActions, 'central system (server → client)') +
      '\n';

    const dateFields = Object.fromEntries(
      this.messages.filter((m) => m.dateFields.length).map((m) => [m.name, m.dateFields]),
    );
    const metaFile =
      header('Runtime metadata') +
      `export const clientActions = ${JSON.stringify(config.clientActions)} as const;\n\n` +
      `export const serverActions = ${JSON.stringify(config.serverActions)} as const;\n\n` +
      '/** Paths of `date-time` fields per message (`*` = every array element). */\n' +
      `export const dateFields: Readonly<Record<string, readonly (readonly string[])[]>> = ${JSON.stringify(dateFields)};\n`;

    const out = join(ROOT, 'src', config.dir);
    writeFileSync(join(out, 'types.generated.ts'), typesFile);
    writeFileSync(join(out, 'meta.generated.ts'), metaFile);
    console.log(
      `${config.title}: ${this.messages.length} messages, ${this.types.size} data types → src/${config.dir}/`,
    );
  }
}

// ---------------------------------------------------------------------------

function pascal(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** JSDoc block from a description plus validation constraints worth surfacing in the IDE. */
function docComment(description?: string, schema: JsonSchema = {}) {
  const lines = (description ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim().replace(/\*\//g, '*\\/'))
    .filter((l, i, all) => l || (i > 0 && all[i - 1]));
  while (lines.length && !lines.at(-1)) lines.pop();

  const tags: string[] = [];
  if (schema.maxLength !== undefined) tags.push(`@maxLength ${schema.maxLength}`);
  if (schema.minimum !== undefined) tags.push(`@minimum ${schema.minimum}`);
  if (schema.maximum !== undefined) tags.push(`@maximum ${schema.maximum}`);
  if (schema.minItems !== undefined) tags.push(`@minItems ${schema.minItems}`);
  if (schema.maxItems !== undefined) tags.push(`@maxItems ${schema.maxItems}`);
  if (schema.multipleOf !== undefined) tags.push(`@multipleOf ${schema.multipleOf}`);
  if (schema.default !== undefined) tags.push(`@default ${JSON.stringify(schema.default)}`);
  if (schema.format === 'date-time') tags.push('@format date-time (sent as ISO 8601 string)');

  const all = [...lines, ...(lines.length && tags.length ? [''] : []), ...tags];
  if (!all.length) return '';
  if (all.length === 1) return `/** ${all[0]} */\n`;
  return `/**\n${all.map((l) => (l ? ` * ${l}` : ' *')).join('\n')}\n */\n`;
}

for (const config of [OCPP16, OCPP201]) new Generator(config).run();
