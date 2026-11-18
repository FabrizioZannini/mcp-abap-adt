import { McpError, ErrorCode, makeAdtRequest, getBaseUrl } from '../lib/utils';
import {
    assertWriteEnabled,
    normalizeCustomerName,
    normalizePackage,
    normalizeTransport,
    escapeXml,
    currentUser,
    masterLanguage,
    return_write_error,
    return_write_result,
} from '../lib/adtWrite';

export async function handleCreateProgram(args: any) {
    try {
        assertWriteEnabled();
        const programName = normalizeCustomerName(args?.program_name, 'program_name');
        const packageName = normalizePackage(args?.package_name);
        const transport = normalizeTransport(args?.transport);
        const description = String(args?.description ?? '').trim();
        if (!description || description.length > 70) {
            throw new McpError(ErrorCode.InvalidParams, 'description is required (max 70 characters)');
        }
        if (packageName !== '$TMP' && !transport) {
            throw new McpError(ErrorCode.InvalidParams, 'transport is required for a transportable package');
        }
        const language = masterLanguage(args?.language);

        const body =
            '<?xml version="1.0" encoding="UTF-8"?>' +
            '<program:abapProgram xmlns:program="http://www.sap.com/adt/programs/programs" ' +
            'xmlns:adtcore="http://www.sap.com/adt/core" ' +
            `adtcore:description="${escapeXml(description)}" ` +
            `adtcore:language="${language}" adtcore:masterLanguage="${language}" ` +
            `adtcore:name="${programName}" adtcore:type="PROG/P" ` +
            `adtcore:responsible="${escapeXml(currentUser())}">` +
            `<adtcore:packageRef adtcore:name="${escapeXml(packageName)}"/>` +
            '</program:abapProgram>';

        const url = `${await getBaseUrl()}/sap/bc/adt/programs/programs`;
        await makeAdtRequest(
            url,
            'POST',
            30000,
            body,
            transport ? { corrNr: transport } : undefined,
            { 'Content-Type': 'application/*', Accept: 'application/*' }
        );
        return return_write_result({
            created: programName,
            package: packageName,
            transport: transport ?? null,
            uri: `/sap/bc/adt/programs/programs/${programName.toLowerCase()}`,
            next: 'Write the source with UpdateProgramSource, then ActivateObject.',
        });
    } catch (error) {
        return return_write_error(error);
    }
}
