import { McpError, ErrorCode, makeAdtRequest, getBaseUrl } from '../lib/utils';
import {
    assertWriteEnabled,
    functionGroupOfInclude,
    normalizeProgramName,
    normalizeTransport,
    withLock,
    STATEFUL,
    return_write_error,
    return_write_result,
} from '../lib/adtWrite';

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

const SOURCE_PATHS: Record<string, string> = {
    PROG: '/sap/bc/adt/programs/programs/',
    INCL: '/sap/bc/adt/programs/includes/',
};

/**
 * ADT URI of an executable program (PROG) or include (INCL). Includes of a
 * customer function group (LZ...F01) live under the function group.
 */
export function programSourcePath(objectType: unknown, programName: string): string {
    const type = String(objectType ?? 'PROG').trim().toUpperCase() || 'PROG';
    const basePath = SOURCE_PATHS[type];
    if (!basePath) {
        throw new McpError(
            ErrorCode.InvalidParams,
            `object_type must be one of ${Object.keys(SOURCE_PATHS).join(', ')}`
        );
    }
    const name = programName.toUpperCase();
    const group = type === 'INCL' ? functionGroupOfInclude(name) : undefined;
    if (group) {
        return `/sap/bc/adt/functions/groups/${encodeURIComponent(group.toLowerCase())}/includes/${encodeURIComponent(name.toLowerCase())}`;
    }
    return `${basePath}${encodeURIComponent(programName.toLowerCase())}`;
}

export async function handleUpdateProgramSource(args: any) {
    try {
        assertWriteEnabled();
        const programName = normalizeProgramName(args?.program_name, args?.object_type, 'program_name');
        const objectPath = programSourcePath(args?.object_type, programName);
        const transport = normalizeTransport(args?.transport);
        const source = args?.source;
        if (typeof source !== 'string' || !source.trim()) {
            throw new McpError(ErrorCode.InvalidParams, 'source is required');
        }
        if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
            throw new McpError(ErrorCode.InvalidParams, 'source exceeds 2 MB');
        }
        // ADT stores ABAP sources with CRLF line endings
        const normalized = source.replace(/\r?\n/g, '\r\n');

        const objectUrl = `${await getBaseUrl()}${objectPath}`;
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
            updated: programName,
            lines: normalized.split('\r\n').length,
            transport: transport ?? null,
            status: 'saved (inactive) - run ActivateObject to activate',
        });
    } catch (error) {
        return return_write_error(error);
    }
}
