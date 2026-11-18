import { makeAdtRequest, getBaseUrl, return_response } from '../lib/utils';
import { normalizeCustomerName, normalizePackage, escapeXml, return_write_error } from '../lib/adtWrite';

// Read-only: asks the Transport Organizer which requests can record a
// (new or existing) program in the given package. Nothing is changed.
export async function handleGetTransportInfo(args: any) {
    try {
        const packageName = normalizePackage(args?.package_name);
        const programName = normalizeCustomerName(args?.program_name, 'program_name');
        const body =
            '<?xml version="1.0" encoding="UTF-8"?>' +
            '<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA>' +
            '<PGMID/><OBJECT/><OBJECTNAME/>' +
            `<DEVCLASS>${escapeXml(packageName)}</DEVCLASS>` +
            '<SUPER_PACKAGE/><OPERATION>I</OPERATION>' +
            `<URI>/sap/bc/adt/programs/programs/${programName.toLowerCase()}</URI>` +
            '</DATA></asx:values></asx:abap>';
        const response = await makeAdtRequest(
            `${await getBaseUrl()}/sap/bc/adt/cts/transportchecks`,
            'POST',
            30000,
            body,
            undefined,
            {
                'Content-Type':
                    'application/vnd.sap.as+xml; charset=UTF-8; dataname=com.sap.adt.transport.service.checkData',
                Accept: 'application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.transport.service.checkData',
            }
        );
        return return_response(response, args);
    } catch (error) {
        return return_write_error(error);
    }
}
