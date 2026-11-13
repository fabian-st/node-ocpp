import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WSDL } from 'soap';
import { extractSchema, parseXml, XsdValidator } from './xml.js';

export type SoapProtocol = 'ocpp1.2' | 'ocpp1.5' | 'ocpp1.6';
export type ServiceRole = 'CentralSystem' | 'ChargePoint';

/** Official service namespaces → protocol version and role. */
const NAMESPACES: Record<string, { protocol: SoapProtocol; role: ServiceRole }> = {
  'urn://Ocpp/Cs/2010/08/': { protocol: 'ocpp1.2', role: 'CentralSystem' },
  'urn://Ocpp/Cp/2010/08/': { protocol: 'ocpp1.2', role: 'ChargePoint' },
  'urn://Ocpp/Cs/2012/06/': { protocol: 'ocpp1.5', role: 'CentralSystem' },
  'urn://Ocpp/Cp/2012/06/': { protocol: 'ocpp1.5', role: 'ChargePoint' },
  'urn://Ocpp/Cs/2015/10/': { protocol: 'ocpp1.6', role: 'CentralSystem' },
  'urn://Ocpp/Cp/2015/10/': { protocol: 'ocpp1.6', role: 'ChargePoint' },
};

export const DEFAULT_WSDL_DIR = new URL('../../schemas/wsdl/', import.meta.url);

export interface Operation {
  action: string;
  requestElement: string;
  responseElement: string;
  /** Namespace prefix node-soap uses for the response element. */
  responseAlias: string | undefined;
}

/** One parsed OCPP SOAP service description (e.g. the 1.6 CentralSystemService). */
export interface OcppService {
  readonly protocol: SoapProtocol;
  readonly role: ServiceRole;
  readonly namespace: string;
  readonly file: string;
  /** node-soap's parsed WSDL: schema-aware XML ⇄ object mapping. */
  readonly wsdl: WSDL;
  readonly soap12: boolean;
  readonly xsd: XsdValidator;
  readonly operations: ReadonlyMap<string, Operation>;
  /** Request element local name → action. */
  readonly actionByElement: ReadonlyMap<string, string>;
}

/**
 * Discovers the OCPP WSDLs in a directory (recursively) by their target namespace,
 * so file names and layout don't matter. Loaded once per directory.
 */
export class WsdlRegistry {
  static readonly #cache = new Map<string, Promise<WsdlRegistry>>();

  static load(dir: string | URL = DEFAULT_WSDL_DIR): Promise<WsdlRegistry> {
    const path = dir instanceof URL ? fileURLToPath(dir) : dir;
    let registry = this.#cache.get(path);
    if (!registry) {
      registry = this.#discover(path);
      this.#cache.set(path, registry);
      registry.catch(() => this.#cache.delete(path));
    }
    return registry;
  }

  static async #discover(dir: string): Promise<WsdlRegistry> {
    const files = (await readdir(dir, { recursive: true })).filter((f) =>
      f.toLowerCase().endsWith('.wsdl'),
    );
    const services = await Promise.all(files.map((f) => loadService(join(dir, f))));
    return new WsdlRegistry(services.filter((s): s is OcppService => s !== undefined));
  }

  readonly #services: OcppService[];

  private constructor(services: OcppService[]) {
    this.#services = services;
  }

  service(protocol: SoapProtocol, role: ServiceRole): OcppService | undefined {
    return this.#services.find((s) => s.protocol === protocol && s.role === role);
  }

  byNamespace(namespace: string | null | undefined): OcppService | undefined {
    return this.#services.find((s) => s.namespace === namespace);
  }

  protocols(role: ServiceRole): SoapProtocol[] {
    return this.#services.filter((s) => s.role === role).map((s) => s.protocol);
  }
}

async function loadService(file: string): Promise<OcppService | undefined> {
  const xml = await readFile(file, 'utf8');
  const root = parseXml(xml).documentElement;
  const namespace = root?.getAttribute('targetNamespace') ?? '';
  const known = NAMESPACES[namespace];
  if (!known) return undefined;

  const wsdl = new WSDL(xml, pathToFileURL(file).href, {});
  await new Promise<void>((resolve, reject) =>
    wsdl.onReady((err) => (err ? reject(err) : resolve())),
  );
  // Not taken from the constructor options; node-soap's own Server/Client set it like this.
  wsdl.options.attributesKey = 'attributes';

  const operations = new Map<string, Operation>();
  for (const service of Object.values(wsdl.definitions.services)) {
    for (const port of Object.values(service.ports)) {
      for (const [action, method] of Object.entries(port.binding.methods)) {
        const { input, output } = method;
        if (!input?.$name || !output?.$name) continue; // one-way operations don't exist in OCPP
        operations.set(action, {
          action,
          requestElement: input.$name,
          responseElement: output.$name,
          responseAlias: (output as { targetNSAlias?: string }).targetNSAlias,
        });
      }
    }
  }

  return {
    ...known,
    namespace,
    file,
    wsdl,
    soap12: xml.includes('http://schemas.xmlsoap.org/wsdl/soap12/'),
    xsd: new XsdValidator(extractSchema(xml)),
    operations,
    actionByElement: new Map([...operations.values()].map((o) => [o.requestElement, o.action])),
  };
}
