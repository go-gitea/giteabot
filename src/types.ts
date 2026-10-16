import type {Endpoints} from '@octokit/types';

export type Issue = Endpoints['GET /repos/{owner}/{repo}/issues/{issue_number}']['response']['data'];
export type PullRequest = Endpoints['GET /repos/{owner}/{repo}/pulls/{pull_number}']['response']['data'];
export type Branch = Endpoints['GET /repos/{owner}/{repo}/branches/{branch}']['response']['data'];
export type User = Endpoints['GET /user']['response']['data'];
