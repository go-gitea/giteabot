import {execFile} from 'node:child_process';

type CommandOptions = {
  args?: string[];
  cwd?: string;
};

// run a command
export const runCommand = (command: string, options: CommandOptions = {}) =>
  new Promise<{success: boolean; stdout: string; stderr: string}>((resolve, reject) => {
    execFile(command, options.args ?? [], {cwd: options.cwd, maxBuffer: 64 * 1024 * 1024}, (error, stdout, stderr) => {
      // a string code means the command could not be spawned, as opposed to a non-zero exit or a signal
      if (typeof error?.code === 'string') {
        reject(new Error(error.message));
        return;
      }
      resolve({success: !error, stdout, stderr});
    });
  });
