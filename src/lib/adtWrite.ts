import { AxiosError } from "axios";
import { getConfig } from "../config";
import { McpError, ErrorCode, makeAdtRequest, return_error } from "./utils";

/**
 * Write tools are disabled unless SAP_ALLOW_WRITE=1 is set explicitly.
 * They are never registered on a server started without the opt-in.
 */
export function isWriteEnabled(): boolean {
  return process.env.SAP_ALLOW_WRITE === "1";
}

export function assertWriteEnabled(): void {
  if (!isWriteEnabled()) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      "Write tools are disabled. Set SAP_ALLOW_WRITE=1 to enable them.",
    );
  }
}

/** Only customer objects (Y*, Z* or a /NAMESPACE/) may be changed. */
export function normalizeCustomerName(value: unknown, label: string): string {
  const name = String(value ?? "")
    .trim()
    .toUpperCase();
  if (!/^([YZ][A-Z0-9_]{0,39}|\/[A-Z0-9_]{1,10}\/[A-Z0-9_]{1,30})$/.test(name)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${label} must be a customer object name (Y*, Z* or /NAMESPACE/...): ${String(value)}`,
    );
  }
  return name;
}

/**
 * Function group of a customer function group include, named
 * L + group + 3-character suffix (LZFGTOP, LZFGF01, LZFGUXX ...).
 */
export function functionGroupOfInclude(name: string): string | undefined {
  const match = /^L([YZ][A-Z0-9_]{0,25})([A-Z0-9_]{3})$/.exec(name);
  return match ? match[1] : undefined;
}

/**
 * Name of a program or include that may be changed: a customer object, or
 * (for includes only) an include of a customer function group.
 */
export function normalizeProgramName(
  value: unknown,
  objectType: unknown,
  label: string,
): string {
  const name = String(value ?? "")
    .trim()
    .toUpperCase();
  const type = String(objectType ?? "PROG").trim().toUpperCase();
  if (type === "INCL" && functionGroupOfInclude(name)) return name;
  return normalizeCustomerName(value, label);
}

export function normalizeTransport(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const transport = String(value).trim().toUpperCase();
  if (!/^[A-Z0-9]{3}K\d{6}$/.test(transport)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid transport request number: ${String(value)}`,
    );
  }
  return transport;
}

export function normalizePackage(value: unknown): string {
  const pkg = String(value ?? "")
    .trim()
    .toUpperCase();
  if (pkg === "$TMP") return pkg;
  return normalizeCustomerName(pkg, "package_name");
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function currentUser(): string {
  return getConfig().username.toUpperCase();
}

export function masterLanguage(value?: unknown): string {
  const language = String(value ?? process.env.SAP_LANGUAGE ?? "EN")
    .trim()
    .toUpperCase();
  if (!/^[A-Z]{2}$/.test(language)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "language must be a two-letter code",
    );
  }
  return language;
}

export const STATEFUL = { "X-sap-adt-sessiontype": "stateful" };

/** Lock an ADT object for modification and return the lock handle. */
export async function lockObject(objectUrl: string): Promise<string> {
  const response = await makeAdtRequest(
    objectUrl,
    "POST",
    30000,
    undefined,
    { _action: "LOCK", accessMode: "MODIFY" },
    {
      ...STATEFUL,
      Accept:
        "application/*,application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result",
    },
  );
  const match = /<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/.exec(
    String(response.data),
  );
  if (!match) {
    throw new Error("SAP did not return a lock handle");
  }
  return match[1];
}

export async function unlockObject(
  objectUrl: string,
  lockHandle: string,
): Promise<void> {
  await makeAdtRequest(
    objectUrl,
    "POST",
    30000,
    undefined,
    { _action: "UNLOCK", lockHandle },
    STATEFUL,
  );
}

/** Run fn while holding the lock, always releasing it afterwards. */
export async function withLock<T>(
  objectUrl: string,
  fn: (lockHandle: string) => Promise<T>,
): Promise<T> {
  const lockHandle = await lockObject(objectUrl);
  try {
    return await fn(lockHandle);
  } finally {
    try {
      await unlockObject(objectUrl, lockHandle);
    } catch {
      // The lock expires with the SAP session; the original result or
      // error is more useful to the caller than an unlock failure.
    }
  }
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * ADT reports failures as <exc:exception> XML. Only the human-readable
 * message is surfaced: never raw bodies, which could contain cookies,
 * login pages or other sensitive data.
 */
export function adtErrorMessage(error: unknown): string | undefined {
  if (!(error instanceof AxiosError) || !error.response) return undefined;
  const body = String(error.response.data ?? "");
  const match =
    /<localizedMessage[^>]*>([\s\S]*?)<\/localizedMessage>/.exec(body) ??
    /<message[^>]*>([\s\S]*?)<\/message>/.exec(body);
  if (!match) return undefined;
  const text = decodeXml(match[1]).replace(/\s+/g, " ").trim();
  return text
    ? `SAP request failed (HTTP ${error.response.status}): ${text.slice(0, 800)}`
    : undefined;
}

export function return_write_error(error: unknown) {
  const message = adtErrorMessage(error);
  if (message) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error: ${message}` }],
    };
  }
  return return_error(error);
}

export function return_write_result(result: unknown) {
  return {
    isError: false,
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}
