import { McpError, ErrorCode, makeAdtRequest, getBaseUrl } from '../lib/utils';
import {
    assertWriteEnabled,
    normalizeCustomerName,
    return_write_error,
    return_write_result,
} from '../lib/adtWrite';
import { functionGroupPath, functionModulePath } from './handleFunctions';

const OBJECT_PATHS: Record<string, string> = {
    PROG: '/sap/bc/adt/programs/programs/',
    INCL: '/sap/bc/adt/programs/includes/',
    CLAS: '/sap/bc/adt/oo/classes/',
    INTF: '/sap/bc/adt/oo/interfaces/',
    TABL: '/sap/bc/adt/ddic/tables/',
};

function decode(value: string) {
    return value
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

export function parseActivationMessages(xml: string) {
    const messages: { type: string; line?: string; text: string }[] = [];
    const msgRegex = /<msg\b([^>]*)>([\s\S]*?)<\/msg>/g;
    let match: RegExpExecArray | null;
    while ((match = msgRegex.exec(xml))) {
        const attrs = match[1];
        const type = /\btype="([^"]*)"/.exec(attrs)?.[1] ?? '';
        const href = /\bhref="([^"]*)"/.exec(attrs)?.[1] ?? '';
        const line = /#start=(\d+)/.exec(href)?.[1];
        const texts = [...match[2].matchAll(/<txt>([\s\S]*?)<\/txt>/g)].map((t) => decode(t[1]).trim());
        messages.push({ type, ...(line ? { line } : {}), text: texts.join(' ') });
    }
    return messages;
}

/** ADT URI of a customer object from object_type/object_name(/function_group). */
export function resolveObject(args: any) {
    const objectType = String(args?.object_type ?? 'PROG').trim().toUpperCase();
    const objectName = normalizeCustomerName(args?.object_name, 'object_name');
    if (objectType === 'FUGR') {
        return { objectType, objectName, uri: functionGroupPath(objectName) };
    }
    if (objectType === 'FUNC') {
        if (!args?.function_group) {
            throw new McpError(ErrorCode.InvalidParams, 'function_group is required for FUNC');
        }
        const group = normalizeCustomerName(args.function_group, 'function_group');
        return { objectType, objectName, uri: functionModulePath(group, objectName) };
    }
    const basePath = OBJECT_PATHS[objectType];
    if (!basePath) {
        throw new McpError(
            ErrorCode.InvalidParams,
            `object_type must be one of ${[...Object.keys(OBJECT_PATHS), 'FUGR', 'FUNC'].join(', ')}`
        );
    }
    return { objectType, objectName, uri: `${basePath}${encodeURIComponent(objectName.toLowerCase())}` };
}

export async function handleActivateObject(args: any) {
    try {
        assertWriteEnabled();
        const { objectName, uri } = resolveObject(args);
        const body =
            '<?xml version="1.0" encoding="UTF-8"?>' +
            '<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">' +
            `<adtcore:objectReference adtcore:uri="${uri}" adtcore:name="${objectName}"/>` +
            '</adtcore:objectReferences>';

        const response = await makeAdtRequest(
            `${await getBaseUrl()}/sap/bc/adt/activation`,
            'POST',
            30000,
            body,
            { method: 'activate', preauditRequested: 'true' },
            { 'Content-Type': 'application/xml', Accept: 'application/xml' }
        );
        const messages = parseActivationMessages(String(response.data ?? ''));
        const errors = messages.filter((m) => m.type === 'E' || m.type === 'A');
        return return_write_result({
            object: objectName,
            activated: errors.length === 0,
            messages,
        });
    } catch (error) {
        return return_write_error(error);
    }
}
