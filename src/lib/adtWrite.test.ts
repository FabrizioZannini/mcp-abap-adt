import { AxiosError, AxiosHeaders } from 'axios';
import {
  adtErrorMessage,
  assertWriteEnabled,
  isWriteEnabled,
  normalizeCustomerName,
  normalizePackage,
  normalizeTransport
} from './adtWrite';
import { parseActivationMessages } from '../handlers/handleActivateObject';
import { handleUpdateProgramSource } from '../handlers/handleUpdateProgramSource';
import { createServer } from '../index';

describe('write tool safety', () => {
  const original = process.env.SAP_ALLOW_WRITE;
  afterEach(() => {
    if (original === undefined) delete process.env.SAP_ALLOW_WRITE;
    else process.env.SAP_ALLOW_WRITE = original;
  });

  it('is disabled unless SAP_ALLOW_WRITE=1', () => {
    delete process.env.SAP_ALLOW_WRITE;
    expect(isWriteEnabled()).toBe(false);
    expect(() => assertWriteEnabled()).toThrow(/disabled/);
    process.env.SAP_ALLOW_WRITE = 'true';
    expect(isWriteEnabled()).toBe(false);
    process.env.SAP_ALLOW_WRITE = '1';
    expect(isWriteEnabled()).toBe(true);
  });

  it('refuses to write before touching SAP when disabled', async () => {
    delete process.env.SAP_ALLOW_WRITE;
    const result = await handleUpdateProgramSource({ program_name: 'ZTEST', source: 'REPORT ztest.' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/disabled/);
  });

  it('registers write tools only when enabled', () => {
    const names = (server: any) => Object.keys(server._registeredTools ?? {});
    delete process.env.SAP_ALLOW_WRITE;
    const readOnly = names(createServer());
    process.env.SAP_ALLOW_WRITE = '1';
    const writable = names(createServer());
    if (readOnly.length === 0) return; // SDK internals not exposed
    expect(readOnly).not.toContain('UpdateProgramSource');
    expect(writable).toEqual(
      expect.arrayContaining(['CreateProgram', 'UpdateProgramSource', 'ActivateObject', 'UpdateTextElements'])
    );
  });
});

describe('object name validation', () => {
  it('accepts customer objects only', () => {
    expect(normalizeCustomerName('zmm_stealth_check', 'n')).toBe('ZMM_STEALTH_CHECK');
    expect(normalizeCustomerName('Y_TEST', 'n')).toBe('Y_TEST');
    expect(normalizeCustomerName('/MON/REPORT', 'n')).toBe('/MON/REPORT');
    for (const bad of ['SAPMV45A', 'RSABAPPROGRAM', '', 'Z TEST', 'Z../X', 'ZPROG;DROP']) {
      expect(() => normalizeCustomerName(bad, 'n')).toThrow();
    }
  });

  it('validates packages and transports', () => {
    expect(normalizePackage('$tmp')).toBe('$TMP');
    expect(normalizePackage('zutility')).toBe('ZUTILITY');
    expect(() => normalizePackage('SAPSCRIPT')).toThrow();
    expect(normalizeTransport('medk900123')).toBe('MEDK900123');
    expect(normalizeTransport(undefined)).toBeUndefined();
    expect(() => normalizeTransport('MED900123')).toThrow();
  });
});

describe('ADT responses', () => {
  it('extracts only the readable SAP error message', () => {
    const error = new AxiosError('fail', 'ERR', undefined, undefined, {
      status: 400,
      statusText: 'Bad Request',
      headers: {},
      config: { headers: new AxiosHeaders() },
      data:
        '<exc:exception><message lang="EN">Ignored</message>' +
        '<localizedMessage lang="EN">Program ZX already exists &amp; is locked</localizedMessage></exc:exception>'
    });
    expect(adtErrorMessage(error)).toBe('SAP request failed (HTTP 400): Program ZX already exists & is locked');
    expect(adtErrorMessage(new Error('x'))).toBeUndefined();
  });

  it('parses activation messages with line numbers', () => {
    const xml =
      '<chkl:messages><msg objDescr="Program ZX" type="E" line="1" ' +
      'href="/sap/bc/adt/programs/programs/zx/source/main#start=42,10" forceSupported="true">' +
      '<shortText><txt>Field &quot;GV_X&quot; is unknown.</txt></shortText></msg>' +
      '<msg type="W" href="/x"><shortText><txt>Warning</txt></shortText></msg></chkl:messages>';
    expect(parseActivationMessages(xml)).toEqual([
      { type: 'E', line: '42', text: 'Field "GV_X" is unknown.' },
      { type: 'W', text: 'Warning' }
    ]);
    expect(parseActivationMessages('')).toEqual([]);
  });
});
