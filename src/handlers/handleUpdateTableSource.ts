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

const MAX_SOURCE_BYTES = 512 * 1024;

// Replaces the DDL source ("define table ...") of an existing customer
// database table. Activation (ActivateObject TABL) adjusts the database.
export async function handleUpdateTableSource(args: any) {
    try {
        assertWriteEnabled();
        const tableName = normalizeCustomerName(args?.table_name, 'table_name');
        if (tableName.length > 16) {
            throw new McpError(ErrorCode.InvalidParams, 'table_name must be at most 16 characters');
        }
        const transport = normalizeTransport(args?.transport);
        const source = args?.source;
        if (typeof source !== 'string' || !source.trim()) {
            throw new McpError(ErrorCode.InvalidParams, 'source is required');
        }
        if (!new RegExp(`define\\s+table\\s+${tableName}\\b`, 'i').test(source)) {
            throw new McpError(ErrorCode.InvalidParams, `source must contain "define table ${tableName.toLowerCase()}"`);
        }
        if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
            throw new McpError(ErrorCode.InvalidParams, 'source exceeds 512 KB');
        }
        const normalized = source.replace(/\r?\n/g, '\r\n');

        const objectUrl = `${await getBaseUrl()}/sap/bc/adt/ddic/tables/${encodeURIComponent(tableName.toLowerCase())}`;
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
            updated: tableName,
            transport: transport ?? null,
            status: 'saved (inactive) - run ActivateObject with object_type TABL to activate and adjust the database',
        });
    } catch (error) {
        return return_write_error(error);
    }
}
