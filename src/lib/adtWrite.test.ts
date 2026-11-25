import { AxiosError, AxiosHeaders } from 'axios';
import {
  adtErrorMessage,
  assertWriteEnabled,
  functionGroupOfInclude,
  isWriteEnabled,
  normalizeCustomerName,
  normalizeProgramName,
  normalizePackage,
  normalizeTransport
} from './adtWrite';
import { parseActivationMessages, resolveObject } from '../handlers/handleActivateObject';
import { isCsrfFailure, isStaleSessionFailure } from './utils';
import { handleUpdateProgramSource, programSourcePath } from '../handlers/handleUpdateProgramSource';
import { createServer } from '../index';
import { handleDeleteObject } from '../handlers/handleDeleteObject';
import { applySourceEdits, handlePatchProgramSource } from '../handlers/handlePatchProgramSource';
import { handleUpdateTableSource } from '../handlers/handleUpdateTableSource';
import {
  functionGroupPath,
  functionModulePath,
  handleUpdateFunctionModuleSource
} from '../handlers/handleFunctions';

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
      expect.arrayContaining([
        'CreateProgram',
        'UpdateProgramSource',
        'ActivateObject',
        'UpdateTextElements',
        'CreateFunctionGroup',
        'CreateFunctionModule',
        'UpdateFunctionModuleSource'
      ])
    );
    expect(readOnly).not.toContain('CreateFunctionGroup');
  });

  it('refuses function module writes when disabled', async () => {
    delete process.env.SAP_ALLOW_WRITE;
    const result = await handleUpdateFunctionModuleSource({
      function_group: 'ZFG_TEST',
      function_name: 'Z_TEST',
      source: 'FUNCTION z_test. ENDFUNCTION.'
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/disabled/);
  });
});

describe('object deletion', () => {
  const original = process.env.SAP_ALLOW_WRITE;
  afterEach(() => {
    if (original === undefined) delete process.env.SAP_ALLOW_WRITE;
    else process.env.SAP_ALLOW_WRITE = original;
  });

  it('refuses when writes are disabled', async () => {
    delete process.env.SAP_ALLOW_WRITE;
    const result = await handleDeleteObject({ object_name: 'ZTEST', confirm: 'ZTEST' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/disabled/);
  });

  it('requires the object name to be confirmed before touching SAP', async () => {
    process.env.SAP_ALLOW_WRITE = '1';
    const result = await handleDeleteObject({
      object_name: 'ZFG_STK3ORD',
      object_type: 'FUGR',
      confirm: 'ZFG_ST3KORD'
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/confirm/);
  });

  it('refuses SAP standard objects', async () => {
    process.env.SAP_ALLOW_WRITE = '1';
    const result = await handleDeleteObject({ object_name: 'SAPMV45A', confirm: 'SAPMV45A' });
    expect(result.isError).toBe(true);
  });
});

describe('table source', () => {
  it('requires the matching define table statement', async () => {
    const original = process.env.SAP_ALLOW_WRITE;
    process.env.SAP_ALLOW_WRITE = '1';
    const result = await handleUpdateTableSource({ table_name: 'ZTAB', source: 'define table zother { }' });
    if (original === undefined) delete process.env.SAP_ALLOW_WRITE;
    else process.env.SAP_ALLOW_WRITE = original;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/define table ztab/);
  });
});

describe('program source paths', () => {
  const original = process.env.SAP_ALLOW_WRITE;
  afterEach(() => {
    if (original === undefined) delete process.env.SAP_ALLOW_WRITE;
    else process.env.SAP_ALLOW_WRITE = original;
  });

  it('targets programs by default and includes on request', () => {
    expect(programSourcePath(undefined, 'ZTEST')).toBe('/sap/bc/adt/programs/programs/ztest');
    expect(programSourcePath('prog', 'ZTEST')).toBe('/sap/bc/adt/programs/programs/ztest');
    expect(programSourcePath('INCL', 'ZTEST_F01')).toBe('/sap/bc/adt/programs/includes/ztest_f01');
    expect(() => programSourcePath('CLAS', 'ZTEST')).toThrow(/object_type/);
  });

  it('targets customer function group includes under their group', () => {
    expect(functionGroupOfInclude('LZNOTE_RIOF01')).toBe('ZNOTE_RIO');
    expect(functionGroupOfInclude('LZFGTOP')).toBe('ZFG');
    expect(functionGroupOfInclude('LSVIMF01')).toBeUndefined();
    expect(functionGroupOfInclude('ZPROG')).toBeUndefined();
    expect(programSourcePath('INCL', 'LZNOTE_RIOF01')).toBe(
      '/sap/bc/adt/functions/groups/znote_rio/includes/lznote_riof01'
    );
    expect(normalizeProgramName('lznote_riof01', 'INCL', 'n')).toBe('LZNOTE_RIOF01');
    expect(() => normalizeProgramName('LZNOTE_RIOF01', 'PROG', 'n')).toThrow();
    expect(() => normalizeProgramName('LSVIMF01', 'INCL', 'n')).toThrow();
    expect(resolveObject({ object_name: 'LZNOTE_RIOF01', object_type: 'INCL' }).uri).toBe(
      '/sap/bc/adt/functions/groups/znote_rio/includes/lznote_riof01'
    );
  });

  it('rejects an unknown object_type before touching SAP', async () => {
    process.env.SAP_ALLOW_WRITE = '1';
    const result = await handleUpdateProgramSource({
      program_name: 'ZTEST',
      object_type: 'FUGR',
      source: 'REPORT ztest.'
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/object_type/);
  });
});

describe('source patching', () => {
  const src = [
    '**--Soglia3',
    '  IF ( pttot >= soglia3da ) AND',
    '     ( pttot < soglia3a ).',
    '**--Soglia4',
    '  IF ( pttot >= soglia3da ) AND   ',
    '     ( pttot < soglia3a ).',
    ''
  ].join('\n');

  it('replaces a unique block and reports its line', () => {
    const { source, applied } = applySourceEdits(src, [
      { old_text: '**--Soglia4\n  IF ( pttot >= soglia3da ) AND', new_text: '**--Soglia4\n  IF ( pttot >= soglia4da ) AND' }
    ]);
    expect(source).toContain('**--Soglia4\n  IF ( pttot >= soglia4da ) AND');
    expect(source).toContain('**--Soglia3\n  IF ( pttot >= soglia3da ) AND');
    expect(applied[0]).toMatchObject({ edit: 1, line: 4, occurrences: 1 });
  });

  it('ignores trailing blanks on lines of old_text', () => {
    const { source, applied } = applySourceEdits(src, [
      { old_text: '**--Soglia4\n  IF ( pttot >= soglia3da ) AND\n     ( pttot < soglia3a ).', new_text: 'X' }
    ]);
    expect(applied[0].whitespace_tolerant).toBe(true);
    expect(source).toBe('**--Soglia3\n  IF ( pttot >= soglia3da ) AND\n     ( pttot < soglia3a ).\nX\n');
  });

  it('rejects ambiguous or missing text and applies nothing', () => {
    expect(() =>
      applySourceEdits(src, [{ old_text: '( pttot < soglia3a ).', new_text: 'x' }])
    ).toThrow(/occurs 2 times \(lines 3, 6\)/);
    expect(() =>
      applySourceEdits(src, [
        { old_text: '**--Soglia3', new_text: 'A' },
        { old_text: 'not there', new_text: 'B' }
      ])
    ).toThrow(/edit 2: old_text not found/);
  });

  it('replaces every occurrence with replace_all', () => {
    const { source, applied } = applySourceEdits(src, [
      { old_text: 'soglia3a', new_text: 'sogliaXa', replace_all: true }
    ]);
    expect(source).not.toContain('soglia3a');
    expect(applied[0].occurrences).toBe(2);
  });

  it('refuses to patch when writes are disabled', async () => {
    const original = process.env.SAP_ALLOW_WRITE;
    delete process.env.SAP_ALLOW_WRITE;
    const result = await handlePatchProgramSource({
      program_name: 'ZTEST',
      edits: [{ old_text: 'a', new_text: 'b' }]
    });
    if (original !== undefined) process.env.SAP_ALLOW_WRITE = original;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/disabled/);
  });
});

describe('function module paths', () => {
  it('builds ADT URIs for groups and modules', () => {
    expect(functionGroupPath('ZFG_STK3ORD')).toBe('/sap/bc/adt/functions/groups/zfg_stk3ord');
    expect(functionModulePath('ZFG_STK3ORD', 'ZFMD_STK3ORD_UPL')).toBe(
      '/sap/bc/adt/functions/groups/zfg_stk3ord/fmodules/zfmd_stk3ord_upl'
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

  it('recognises an expired CSRF token from the SAP header', () => {
    const make = (status: number, headers: any, data: any) =>
      new AxiosError('fail', 'ERR', undefined, undefined, {
        status,
        statusText: '',
        headers,
        config: { headers: new AxiosHeaders() },
        data
      });
    expect(isCsrfFailure(make(403, { 'x-csrf-token': 'Required' }, ''))).toBe(true);
    expect(isCsrfFailure(make(403, {}, 'CSRF token validation failed'))).toBe(true);
    expect(isCsrfFailure(make(403, {}, '<exc:exception>No authorization</exc:exception>'))).toBe(false);
    expect(isCsrfFailure(make(401, { 'x-csrf-token': 'Required' }, ''))).toBe(false);
  });

  it('recognises a bare 403 from an expired SAP session', () => {
    const make = (status: number, headers: any, data: any) =>
      new AxiosError('fail', 'ERR', undefined, undefined, {
        status,
        statusText: '',
        headers,
        config: { headers: new AxiosHeaders() },
        data
      });
    expect(isStaleSessionFailure(make(403, {}, ''))).toBe(true);
    expect(isStaleSessionFailure(make(403, {}, undefined))).toBe(true);
    expect(isStaleSessionFailure(make(403, { 'x-csrf-token': 'Required' }, ''))).toBe(false);
    expect(isStaleSessionFailure(make(403, {}, '<?xml version="1.0"?><exc:exception>No authorization</exc:exception>'))).toBe(false);
    expect(isStaleSessionFailure(make(401, {}, ''))).toBe(false);
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
