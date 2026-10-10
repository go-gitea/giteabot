import {execFile} from 'node:child_process';

export type CommandOptions = {
  args?: string[];
  cwd?: string;
};

// run a command
export const run = (command: string, options: CommandOptions = {}) =>
  new Promise<{success: boolean; stdout: string; stderr: string}>(
    (resolve, reject) => {
      execFile(
        command,
        options.args ?? [],
        {cwd: options.cwd, maxBuffer: 64 * 1024 * 1024},
        (error, stdout, stderr) => {
          // a non-numeric code means the command could not be spawned
          if (error && typeof error.code !== 'number') {
            reject(new Error(error.message, {cause: error}));
            return;
          }
          resolve({success: !error, stdout, stderr});
        },
      );
    },
  );
