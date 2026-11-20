import { McpError, ErrorCode, makeAdtRequest, getBaseUrl } from '../lib/utils';
import {
    assertWriteEnabled,
    normalizeProgramName,
    normalizeTransport,
    withLock,
    STATEFUL,
    return_write_error,
    return_write_result,
} from '../lib/adtWrite';
import { programSourcePath } from './handleUpdateProgramSource';

const MAX_EDITS = 50;
const MAX_EDIT_BYTES = 256 * 1024;

export interface SourceEdit {
    old_text: string;
    new_text: string;
    replace_all?: boolean;
}

export interface AppliedEdit {
    edit: number;
    line: number;
    occurrences: number;
    whitespace_tolerant: boolean;
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Pattern for old_text that ignores trailing blanks on every line, since
 * listings of ABAP sources often drop them. Leading indentation and the
 * text itself must still match exactly.
 */
function tolerantPattern(oldText: string): RegExp {
    const lines = oldText.split('\n').map((line) => escapeRegExp(line.replace(/[ \t]+$/, '')));
    return new RegExp(lines.join('[ \\t]*\\n') + (oldText.endsWith('\n') ? '' : '[ \\t]*(?=\\n|$)'), 'g');
}

function lineOf(text: string, index: number): number {
    let line = 1;
    for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
    return line;
}

/**
 * Apply exact-text replacements to an LF-normalized source. Every edit must
 * match exactly once (or at least once with replace_all), otherwise nothing
 * is applied and the error names the failing edit.
 */
export function applySourceEdits(source: string, edits: SourceEdit[]): { source: string; applied: AppliedEdit[] } {
    let text = source;
    const applied: AppliedEdit[] = [];
    edits.forEach((edit, i) => {
        const n = i + 1;
        const oldText = edit.old_text.replace(/\r\n/g, '\n');
        const newText = edit.new_text.replace(/\r\n/g, '\n');
        if (!oldText.trim()) {
            throw new McpError(ErrorCode.InvalidParams, `edit ${n}: old_text is empty`);
        }
        let tolerant = false;
        let starts: number[] = [];
        let lengths: number[] = [];
        for (let pos = text.indexOf(oldText); pos >= 0; pos = text.indexOf(oldText, pos + oldText.length)) {
            starts.push(pos);
            lengths.push(oldText.length);
        }
        if (starts.length === 0) {
            tolerant = true;
            for (const match of text.matchAll(tolerantPattern(oldText))) {
                starts.push(match.index ?? 0);
                lengths.push(match[0].length);
            }
        }
        if (starts.length === 0) {
            throw new McpError(ErrorCode.InvalidParams, `edit ${n}: old_text not found in the source (nothing was written)`);
        }
        if (starts.length > 1 && !edit.replace_all) {
            const lines = starts.map((s) => lineOf(text, s)).join(', ');
            throw new McpError(
                ErrorCode.InvalidParams,
                `edit ${n}: old_text occurs ${starts.length} times (lines ${lines}); add surrounding lines to make it unique or set replace_all (nothing was written)`
            );
        }
        const firstLine = lineOf(text, starts[0]);
        for (let k = starts.length - 1; k >= 0; k--) {
            text = text.slice(0, starts[k]) + newText + text.slice(starts[k] + lengths[k]);
        }
        applied.push({ edit: n, line: firstLine, occurrences: starts.length, whitespace_tolerant: tolerant });
    });
    return { source: text, applied };
}

function parseEdits(value: unknown): SourceEdit[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw new McpError(ErrorCode.InvalidParams, 'edits must be a non-empty array');
    }
    if (value.length > MAX_EDITS) {
        throw new McpError(ErrorCode.InvalidParams, `at most ${MAX_EDITS} edits per call`);
    }
    return value.map((raw, i) => {
        const e = raw as Record<string, unknown>;
        if (typeof e?.old_text !== 'string' || typeof e?.new_text !== 'string') {
            throw new McpError(ErrorCode.InvalidParams, `edit ${i + 1}: old_text and new_text must be strings`);
        }
        if (Buffer.byteLength(e.old_text) + Buffer.byteLength(e.new_text) > MAX_EDIT_BYTES) {
            throw new McpError(ErrorCode.InvalidParams, `edit ${i + 1} exceeds 256 KB`);
        }
        return { old_text: e.old_text, new_text: e.new_text, replace_all: e.replace_all === true };
    });
}

export async function handlePatchProgramSource(args: any) {
    try {
        assertWriteEnabled();
        const programName = normalizeProgramName(args?.program_name, args?.object_type, 'program_name');
        const objectPath = programSourcePath(args?.object_type, programName);
        const transport = normalizeTransport(args?.transport);
        const edits = parseEdits(args?.edits);
        const dryRun = args?.dry_run === true;

        const objectUrl = `${await getBaseUrl()}${objectPath}`;
        const readSource = async () => {
            const response = await makeAdtRequest(`${objectUrl}/source/main`, 'GET', 30000, undefined, undefined, {
                ...STATEFUL,
                Accept: 'text/plain',
            });
            return String(response.data ?? '').replace(/\r\n/g, '\n');
        };

        if (dryRun) {
            const original = await readSource();
            const { source, applied } = applySourceEdits(original, edits);
            return return_write_result({
                program: programName,
                dry_run: true,
                applied,
                lines_before: original.split('\n').length,
                lines_after: source.split('\n').length,
                status: 'nothing written',
            });
        }

        const result = await withLock(objectUrl, async (lockHandle) => {
            const original = await readSource();
            const patched = applySourceEdits(original, edits);
            await makeAdtRequest(
                `${objectUrl}/source/main`,
                'PUT',
                30000,
                patched.source.replace(/\n/g, '\r\n'),
                { lockHandle, ...(transport ? { corrNr: transport } : {}) },
                { ...STATEFUL, 'Content-Type': 'text/plain; charset=utf-8', Accept: 'text/plain' }
            );
            return { original, ...patched };
        });

        return return_write_result({
            updated: programName,
            applied: result.applied,
            lines_before: result.original.split('\n').length,
            lines_after: result.source.split('\n').length,
            transport: transport ?? null,
            status: 'saved (inactive) - run ActivateObject to activate',
        });
    } catch (error) {
        return return_write_error(error);
    }
}
