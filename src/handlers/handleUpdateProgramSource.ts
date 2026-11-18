import { McpError, ErrorCode, makeAdtRequest, getBaseUrl } from '../lib/utils';
import {
    assertWriteEnabled,
    normalizeCustomerName,
    normalizeTransport,
    withLock,
    STATEFUL,
    return_write_error,
    return_write_result,
} from '../lib/adtWrite';

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

export async function handleUpdateProgramSource(args: any) {
    try {
        assertWriteEnabled();
        const programName = normalizeCustomerName(args?.program_name, 'program_name');
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

        const objectUrl = `${await getBaseUrl()}/sap/bc/adt/programs/programs/${encodeURIComponent(programName.toLowerCase())}`;
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
