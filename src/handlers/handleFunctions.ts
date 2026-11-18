import { McpError, ErrorCode, makeAdtRequest, getBaseUrl } from '../lib/utils';
import {
    assertWriteEnabled,
    normalizeCustomerName,
    normalizePackage,
    normalizeTransport,
    escapeXml,
    currentUser,
    masterLanguage,
    withLock,
    STATEFUL,
    return_write_error,
    return_write_result,
} from '../lib/adtWrite';

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

export function functionGroupPath(group: string) {
    return `/sap/bc/adt/functions/groups/${encodeURIComponent(group.toLowerCase())}`;
}

export function functionModulePath(group: string, name: string) {
    return `${functionGroupPath(group)}/fmodules/${encodeURIComponent(name.toLowerCase())}`;
}

function requireDescription(value: unknown) {
    const description = String(value ?? '').trim();
    if (!description || description.length > 74) {
        throw new McpError(ErrorCode.InvalidParams, 'description is required (max 74 characters)');
    }
    return description;
}

export async function handleCreateFunctionGroup(args: any) {
    try {
        assertWriteEnabled();
        const group = normalizeCustomerName(args?.function_group, 'function_group');
        if (group.length > 26) {
            throw new McpError(ErrorCode.InvalidParams, 'function_group must be at most 26 characters');
        }
        const packageName = normalizePackage(args?.package_name);
        const transport = normalizeTransport(args?.transport);
        const description = requireDescription(args?.description);
        if (packageName !== '$TMP' && !transport) {
            throw new McpError(ErrorCode.InvalidParams, 'transport is required for a transportable package');
        }
        const language = masterLanguage(args?.language);

        const body =
            '<?xml version="1.0" encoding="UTF-8"?>' +
            '<group:abapFunctionGroup xmlns:group="http://www.sap.com/adt/functions/groups" ' +
            'xmlns:adtcore="http://www.sap.com/adt/core" ' +
            `adtcore:description="${escapeXml(description)}" ` +
            `adtcore:language="${language}" adtcore:masterLanguage="${language}" ` +
            `adtcore:name="${group}" adtcore:type="FUGR/F" ` +
            `adtcore:responsible="${escapeXml(currentUser())}">` +
            `<adtcore:packageRef adtcore:name="${escapeXml(packageName)}"/>` +
            '</group:abapFunctionGroup>';

        await makeAdtRequest(
            `${await getBaseUrl()}/sap/bc/adt/functions/groups`,
            'POST',
            30000,
            body,
            transport ? { corrNr: transport } : undefined,
            { 'Content-Type': 'application/*', Accept: 'application/*' }
        );
        return return_write_result({
            created: group,
            package: packageName,
            transport: transport ?? null,
            uri: functionGroupPath(group),
            next: 'Create function modules with CreateFunctionModule, then ActivateObject (FUGR).',
        });
    } catch (error) {
        return return_write_error(error);
    }
}

export async function handleCreateFunctionModule(args: any) {
    try {
        assertWriteEnabled();
        const group = normalizeCustomerName(args?.function_group, 'function_group');
        const name = normalizeCustomerName(args?.function_name, 'function_name');
        if (name.length > 30) {
            throw new McpError(ErrorCode.InvalidParams, 'function_name must be at most 30 characters');
        }
        const transport = normalizeTransport(args?.transport);
        const description = requireDescription(args?.description);

        const body =
            '<?xml version="1.0" encoding="UTF-8"?>' +
            '<fmodule:abapFunctionModule xmlns:fmodule="http://www.sap.com/adt/functions/fmodules" ' +
            'xmlns:adtcore="http://www.sap.com/adt/core" ' +
            `adtcore:description="${escapeXml(description)}" ` +
            `adtcore:name="${name}" adtcore:type="FUGR/FF">` +
            `<adtcore:containerRef adtcore:name="${group}" adtcore:type="FUGR/F" ` +
            `adtcore:uri="${functionGroupPath(group)}"/>` +
            '</fmodule:abapFunctionModule>';

        await makeAdtRequest(
            `${await getBaseUrl()}${functionGroupPath(group)}/fmodules`,
            'POST',
            30000,
            body,
            transport ? { corrNr: transport } : undefined,
            { 'Content-Type': 'application/*', Accept: 'application/*' }
        );
        return return_write_result({
            created: name,
            function_group: group,
            transport: transport ?? null,
            uri: functionModulePath(group, name),
            next: 'Write the source (with signature) using UpdateFunctionModuleSource, then ActivateObject (FUNC).',
        });
    } catch (error) {
        return return_write_error(error);
    }
}

// The ADT source of a function module carries its signature:
// FUNCTION z_name IMPORTING ... EXPORTING ... TABLES ... EXCEPTIONS ... .
export async function handleUpdateFunctionModuleSource(args: any) {
    try {
        assertWriteEnabled();
        const group = normalizeCustomerName(args?.function_group, 'function_group');
        const name = normalizeCustomerName(args?.function_name, 'function_name');
        const transport = normalizeTransport(args?.transport);
        const source = args?.source;
        if (typeof source !== 'string' || !source.trim()) {
            throw new McpError(ErrorCode.InvalidParams, 'source is required');
        }
        if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
            throw new McpError(ErrorCode.InvalidParams, 'source exceeds 2 MB');
        }
        const normalized = source.replace(/\r?\n/g, '\r\n');

        const objectUrl = `${await getBaseUrl()}${functionModulePath(group, name)}`;
        await withLock(objectUrl, async (lockHandle) => {
            await makeAdtRequest(
                `${objectUrl}/source/main`,
                'PUT',
                30000,
                normalized,
                { lockHandle, ...(transport ? { corrNr: transport } : {}) },
                { ...STATEFUL, 'Content-Type': 'text/plain; charset=utf-8', Accept: 'text/plain' }
            );
        });
        return return_write_result({
            updated: name,
            function_group: group,
            lines: normalized.split('\r\n').length,
            transport: transport ?? null,
            status: 'saved (inactive) - run ActivateObject to activate',
        });
    } catch (error) {
        return return_write_error(error);
    }
}
