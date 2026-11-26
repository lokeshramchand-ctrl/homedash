import type { ConnConfig, Driver, Kind } from './types.js';

/** Connection-form fields a plugin can ask for. The "Add connection" dialog is generated from this list. */
export type FieldName = 'host' | 'port' | 'database' | 'username' | 'password' | 'uri' | 'tls' | 'file' | 'token';

/**
 * Everything the dashboard needs to know about one engine. To add a service: write one file that exports a
 * `DriverPlugin` and add it to PLUGINS in index.ts. No other server or UI code needs to change.
 */
export interface DriverPlugin {
  kind: Kind;
  label: string;
  defaultPort: number | null;
  fields: FieldName[];
  /** Which target the user must supply: a host, a host or a URI, or a local file path. */
  connect: 'host' | 'uri-or-host' | 'file';
  /** Accepted URI scheme(s) when `uri` is a field, e.g. /^rediss?:\/\// */
  uriScheme?: { re: RegExp; message: string };
  uriExample?: string;
  databaseHint?: string;
  /** UI wording for the database field and namespaces, when it differs from "database". */
  databaseLabel?: string;
  create(cfg: ConnConfig, writable: boolean): Driver;
}

/** The part of a plugin that is safe and useful to send to the browser. */
export type KindInfo = Omit<DriverPlugin, 'create' | 'uriScheme'>;
