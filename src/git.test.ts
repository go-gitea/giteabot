import {execFileSync} from 'node:child_process';
import {rm} from 'node:fs/promises';
import {runCommand} from './cmd.ts';
import {initializeGitRepo} from './git.ts';

vi.mock('./cmd.ts', () => ({runCommand: vi.fn().mockResolvedValue({success: true, stdout: '', stderr: ''})}));

test('initializeGitRepo() passes the token through a credential helper instead of the clone URL', async () => {
  vi.stubEnv('INPUT_GITHUB_TOKEN', 'secret');
  vi.stubEnv('GIT_TERMINAL_PROMPT', '0');
  await initializeGitRepo('GiteaBot', null);
  const {args, cwd} = vi.mocked(runCommand).mock.calls[0][1]!;
  await rm(cwd!, {recursive: true});
  expect(args!.join(' ')).not.toContain('secret');
  const helper = args![args!.indexOf('-c') + 1];
  const credential = execFileSync('git', ['-c', 'credential.helper=', '-c', helper, 'credential', 'fill'], {input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8'});
  expect(credential).toContain('username=x-access-token\npassword=secret\n');
});
