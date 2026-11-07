import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Constants } from '../../Constants';

const execFileAsync = promisify(execFile);

// SPMF takes only numeric thresholds, for example a minimum support of 0.005
// or a minimum utility of 1000 (optionally written as a percentage).
const NUMERIC_PARAMETER = /^-?\d+(\.\d+)?(e[-+]?\d+)?%?$/i;

export class LearnDesignRules {
    private static filePrefix: { [key: string]: string } = {
        "FPMax": "AttributeEncoding",
        "FPClose": "AttributeEncoding",
        "CHUI-Miner": "Weighted_AttributeEncoding",
        "CHUI-MinerMax": "Weighted_AttributeEncoding",
    };
    private static timeoutInSeconds = 5;

    /** True when `algorithm` names one of the SPMF algorithms DesignFix uses. */
    public static isSupportedAlgorithm(algorithm: unknown): algorithm is string {
        return typeof algorithm === 'string'
            && Object.prototype.hasOwnProperty.call(this.filePrefix, algorithm);
    }

    /** True when every mining parameter is a plain number SPMF accepts. */
    public static areValidParameters(params: unknown): params is Array<string | number> {
        return Array.isArray(params)
            && params.every((param) => NUMERIC_PARAMETER.test(String(param).trim()));
    }

    public static async analyzeDatabases(projectPath: string, params: Array<string | number>, algorithm: string): Promise<any> {
        // Both values arrive from the dashboard. Only the known algorithms and
        // numeric thresholds are accepted, and SPMF is started without a shell,
        // so no value can ever be interpreted as an additional command.
        if (!this.isSupportedAlgorithm(algorithm)) {
            throw new Error(`Unsupported mining algorithm: ${JSON.stringify(algorithm)}`);
        }
        if (!this.areValidParameters(params)) {
            throw new Error('Mining parameters must be numbers.');
        }
        const parameters = params.map((param) => String(param).trim());

        const fullPath = path.join(projectPath, Constants.LEARNING_DR_DIRECTORY);
        if (!fs.existsSync(fullPath)) {
            fs.mkdirSync(fullPath);
        }

        const fileList: string[] = [];
        const outputFileList: string[] = [];
        const files = fs.readdirSync(fullPath);

        files.forEach(file => {
            if (file.startsWith(this.filePrefix[algorithm])) {
                fileList.push(file);
            } else if (file.startsWith("output_")) {
                outputFileList.push(file);
            }
        });

        // Delete output files
        outputFileList.forEach(file => {
            fs.unlinkSync(path.join(fullPath, file));
        });

        for (const file of fileList) {
            // Arguments are passed as an array, so paths with spaces need no quoting.
            const args = [
                '-jar', path.join(projectPath, 'spmf.jar'),
                'run', algorithm,
                path.join(fullPath, file),
                path.join(fullPath, `output_${file}`),
                ...parameters,
            ];
            console.log(`Running SPMF: java ${args.join(' ')}`);

            try {
                await execFileAsync('java', args, { timeout: this.timeoutInSeconds * 1000, windowsHide: true });
            } catch (error) {
                console.error(`Error running SPMF on ${file}`, error);
            }
        }

        const results: { [key: string]: string } = {};
        for (const file of fileList) {
            const outputFile = path.join(fullPath, `output_${file}`);
            try {
                const data = fs.readFileSync(outputFile, { encoding: 'utf8' });
                results[file] = data;
            } catch (error) {
                console.error(`Error reading output file: ${outputFile}`, error);
            }
        }

        return results;
    }
}
