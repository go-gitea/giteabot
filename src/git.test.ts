import {once} from 'node:events';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runCommand} from './cmd.ts';
import {initializeGitRepo, isBackportConflictFree} from './git.ts';

test('isBackportConflictFree() accepts only clean, non-empty cherry-picks onto the release branch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'giteabot-test-'));
  onTestFinished(() => rm(dir, {recursive: true}));
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  const git = (...args: string[]) => runCommand('git', {cwd: dir, args: ['-c', 'user.name=x', '-c', 'user.email=x', ...args]});
  const commit = async (file: string, content: string) => {
    await writeFile(join(dir, file), content);
    await git('add', file);
    await git('commit', '-qm', file);
  };
  await git('init', '-qb', 'main');
  await commit('a', '1\n2\n3\n');
  await git('branch', 'release/v1');
  for (const [branch, file, content] of [['clean', 'b', '1\n'], ['conflict', 'a', '1\n2\ny\n'], ['applied', 'a', '1\n2\nx\n']]) {
    await git('switch', '-qc', branch, 'main');
    await commit(file, content);
  }
  await git('switch', '-q', 'release/v1');
  await commit('a', '1\n2\nx\n');
  const repo = {dir, release: 'release/v1', releaseTree: (await git('rev-parse', 'release/v1^{tree}')).stdout.trim()};
  expect(await isBackportConflictFree(repo, 'clean')).toBe(true);
  expect(await isBackportConflictFree(repo, 'conflict')).toBe(false);
  expect(await isBackportConflictFree(repo, 'applied')).toBe(false);
});

test('initializeGitRepo() authenticates through a credential helper instead of the clone URL', async () => {
  const authorizations: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    authorizations.push(req.headers.authorization);
    res.writeHead(401, {'WWW-Authenticate': 'Basic'}).end();
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const dir = await mkdtemp(join(tmpdir(), 'giteabot-test-'));
  onTestFinished(async () => {
    server.close();
    await rm(dir, {recursive: true});
  });
  vi.stubEnv('TMPDIR', dir);
  vi.stubEnv('INPUT_GITHUB_TOKEN', 'secret');
  vi.stubEnv('GIT_TERMINAL_PROMPT', '0');
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('GIT_CONFIG_COUNT', '1');
  vi.stubEnv('GIT_CONFIG_KEY_0', `url.http://127.0.0.1:${(server.address() as AddressInfo).port}/.insteadOf`);
  vi.stubEnv('GIT_CONFIG_VALUE_0', 'https://github.com/');
  await expect(initializeGitRepo('GiteaBot', null)).rejects.toThrow();
  expect(authorizations).toContain(`Basic ${btoa('x-access-token:secret')}`);
});
