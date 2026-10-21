import {once} from 'node:events';
import {mkdtemp, rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializeGitRepo} from './git.ts';

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
