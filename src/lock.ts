import {addComment, fetchClosedOldIssuesAndPRs, hasCommentsSince, lockIssue} from './github.ts';

const MILLISECONDS_IN_A_DAY = 1000 * 60 * 60 * 24;

// adds a comment and locks old issues and PRs
export async function lockOldIssues() {
  const twoWeeksAgo = new Date(Date.now() - MILLISECONDS_IN_A_DAY * 14);
  const threeMonthsAgo = new Date(Date.now() - MILLISECONDS_IN_A_DAY * 90);
  const issues = await fetchClosedOldIssuesAndPRs(threeMonthsAgo);
  return Promise.all(issues.items.map(async (issue) => {
    // if the issue was commented on in the last two weeks, we add a comment
    if (await lockIssue(issue.number, 'resolved') && await hasCommentsSince(issue.number, twoWeeksAgo)) {
      await addComment(
        issue.number,
        `We lock ${issue.pull_request ? 'pull request' : 'issue'}s 3 months after they were closed. If there's any need for further discussion, please open a new issue. :tea:`,
      );
    }
  }));
}
