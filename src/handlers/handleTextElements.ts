import { McpError, ErrorCode, makeAdtRequest, getBaseUrl, return_response } from '../lib/utils';
import {
    assertWriteEnabled,
    normalizeCustomerName,
    normalizeTransport,
    withLock,
    STATEFUL,
    return_write_error,
    return_write_result,
} from '../lib/adtWrite';

const KINDS = ['symbols', 'selections', 'headings'];

function kindOf(value: unknown): string {
    const kind = String(value ?? '').trim().toLowerCase();
    if (!KINDS.includes(kind)) {
        throw new McpError(ErrorCode.InvalidParams, `kind must be one of ${KINDS.join(', ')}`);
    }
    return kind;
}

// ADT only accepts its own media types for text elements; with a generic
// Accept header it serves an HTML preview instead of the plain source.
export function mediaType(kind: string) {
    return `application/vnd.sap.adt.textelements.${kind}.v1`;
}

async function textElementsUrl(programName: string) {
    return `${await getBaseUrl()}/sap/bc/adt/textelements/programs/${encodeURIComponent(programName.toLowerCase())}`;
}

// Read-only: text symbols, selection texts or list headings of a program.
export async function handleGetTextElements(args: any) {
    try {
        if (!args?.program_name) {
            throw new McpError(ErrorCode.InvalidParams, 'program_name is required');
        }
        const programName = String(args.program_name).trim().toUpperCase();
        const kind = kindOf(args?.kind);
        const response = await makeAdtRequest(
            `${await textElementsUrl(programName)}/source/${kind}`,
            'GET',
            30000,
            undefined,
            undefined,
            { Accept: mediaType(kind) }
        );
        return return_response(response, args);
    } catch (error) {
        return return_write_error(error);
    }
}

export async function handleUpdateTextElements(args: any) {
    try {
        assertWriteEnabled();
        const programName = normalizeCustomerName(args?.program_name, 'program_name');
        const kind = kindOf(args?.kind);
        const transport = normalizeTransport(args?.transport);
        const source = args?.source;
        if (typeof source !== 'string' || !source.trim()) {
            throw new McpError(ErrorCode.InvalidParams, 'source is required');
        }
        const objectUrl = await textElementsUrl(programName);
        await withLock(objectUrl, async (lockHandle) => {
            await makeAdtRequest(
                `${objectUrl}/source/${kind}`,
                'PUT',
                30000,
                source.replace(/\r?\n/g, '\r\n'),
                { lockHandle, ...(transport ? { corrNr: transport } : {}) },
                {
                    ...STATEFUL,
                    'Content-Type': `${mediaType(kind)}; charset=utf-8`,
                    Accept: `${mediaType(kind)}, text/plain`,
                }
            );
        });
        return return_write_result({
            updated: `${programName} text elements (${kind})`,
            transport: transport ?? null,
            status: 'saved (inactive) - run ActivateObject with object_type TEXT to activate the text elements',
        });
    } catch (error) {
        return return_write_error(error);
    }
}
