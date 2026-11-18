import { McpError, ErrorCode, makeAdtRequest, getBaseUrl } from '../lib/utils';
import {
    assertWriteEnabled,
    normalizeTransport,
    withLock,
    STATEFUL,
    return_write_error,
    return_write_result,
} from '../lib/adtWrite';
import { resolveObject } from './handleActivateObject';

// Deletes a customer object. The caller must repeat the object name in
// `confirm`, so a wrong or guessed name never deletes anything.
export async function handleDeleteObject(args: any) {
    try {
        assertWriteEnabled();
        const { objectType, objectName, uri } = resolveObject(args);
        const confirm = String(args?.confirm ?? '').trim().toUpperCase();
        if (confirm !== objectName) {
            throw new McpError(ErrorCode.InvalidParams, `confirm must repeat the object name (${objectName})`);
        }
        const transport = normalizeTransport(args?.transport);

        const objectUrl = `${await getBaseUrl()}${uri}`;
        await withLock(objectUrl, async (lockHandle) => {
            await makeAdtRequest(
                objectUrl,
                'DELETE',
                30000,
                undefined,
                { lockHandle, ...(transport ? { corrNr: transport } : {}) },
                STATEFUL
            );
        });
        return return_write_result({
            deleted: objectName,
            object_type: objectType,
            transport: transport ?? null,
        });
    } catch (error) {
        return return_write_error(error);
    }
}
