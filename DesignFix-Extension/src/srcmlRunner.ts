import { execFile, ExecFileException } from 'child_process';
import { Constants } from './Constants';

const SRCML_MAX_ATTEMPTS = 3;
const SRCML_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const WINDOWS_ACCESS_VIOLATION = 0xC0000005;
const WINDOWS_HEAP_CORRUPTION = 0xC0000374;
const STABLE_EXECUTION_ARGUMENTS = ['--max-threads', '1', '--in-order'] as const;

export type SrcmlExecutor = (
    binary: string,
    args: readonly string[],
    callback: (error: ExecFileException | null, stdout: string, stderr: string) => void
) => void;

const defaultExecutor: SrcmlExecutor = (binary, args, callback) => {
    execFile(binary, [...args], {
        encoding: 'utf8',
        maxBuffer: SRCML_MAX_BUFFER_BYTES,
        windowsHide: true
    }, callback);
};

function srcmlBinary(): string {
    if (process.platform === 'win32') {
        return Constants.SRCML_PATH_WINDOWS;
    }
    if (process.platform === 'darwin') {
        return Constants.SRCML_PATH_MAC;
    }
    return Constants.SRCML_PATH_LINUX;
}

function unsignedExitCode(code: number): number {
    return code >>> 0;
}

/** True only for the two transient native failures observed in bundled srcML 0.9.5. */
export function isRetryableSrcmlCrash(error: ExecFileException): boolean {
    if (typeof error.code !== 'number') {
        return false;
    }

    const code = unsignedExitCode(error.code);
    return code === WINDOWS_ACCESS_VIOLATION || code === WINDOWS_HEAP_CORRUPTION;
}

export function buildJavaToXmlArguments(inputFilePath: string): readonly string[] {
    return [
        ...STABLE_EXECUTION_ARGUMENTS,
        '--language',
        'Java',
        inputFilePath
    ];
}

function buildExtractUnitArguments(xmlFilePath: string): readonly string[] {
    return [
        ...STABLE_EXECUTION_ARGUMENTS,
        '--unit',
        '1',
        xmlFilePath
    ];
}

function executeOnce(
    binary: string,
    args: readonly string[],
    executor: SrcmlExecutor
): Promise<{ error: ExecFileException | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        try {
            executor(binary, args, (error, stdout, stderr) => {
                resolve({ error, stdout, stderr });
            });
        } catch (error) {
            reject(error);
        }
    });
}

async function runSrcml(
    args: readonly string[],
    inputPath: string,
    executor: SrcmlExecutor
): Promise<string> {
    const binary = srcmlBinary();

    for (let attempt = 1; attempt <= SRCML_MAX_ATTEMPTS; attempt += 1) {
        const { error, stdout } = await executeOnce(binary, args, executor);
        if (!error) {
            // srcML may emit diagnostics on stderr even after a successful run.
            // Its exit status is authoritative; stdout contains the requested data.
            return stdout;
        }

        if (!isRetryableSrcmlCrash(error) || attempt === SRCML_MAX_ATTEMPTS) {
            throw error;
        }

        const code = unsignedExitCode(error.code as number).toString(16).toUpperCase();
        console.warn(
            `srcML native crash 0x${code} while processing ${inputPath}; ` +
            `retrying (${attempt + 1}/${SRCML_MAX_ATTEMPTS}).`
        );
    }

    throw new Error(`srcML exhausted its retry limit for ${inputPath}.`);
}

/** Convert a Java file with the stable single-threaded bundled-srcML configuration. */
export function convertJavaToXml(
    inputFilePath: string,
    executor: SrcmlExecutor = defaultExecutor
): Promise<string> {
    return runSrcml(buildJavaToXmlArguments(inputFilePath), inputFilePath, executor);
}

/** Extract the first source unit from an existing srcML document. */
export function extractFirstSourceUnit(
    xmlFilePath: string,
    executor: SrcmlExecutor = defaultExecutor
): Promise<string> {
    return runSrcml(buildExtractUnitArguments(xmlFilePath), xmlFilePath, executor);
}
