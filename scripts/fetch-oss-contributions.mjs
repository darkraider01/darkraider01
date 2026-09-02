// Rewrites the OSS-CONTRIBUTIONS block in README.md from live GitHub search.
// Run daily by .github/workflows/oss-contributions.yml — never called from the browser.
import { readFileSync, writeFileSync } from 'fs';

const USERNAME = 'darkraider01';
const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) throw new Error('GH_TOKEN env var is required');

// Global search queries auto-discover every public repo the user has touched —
// no hardcoded repo list, so new repos show up automatically.
// -user:USERNAME excludes their own repos: this tracks OSS contributions, not personal projects.
const CATEGORIES = [
  ['mergedPRs', 'Merged PRs', `is:pr is:merged author:${USERNAME} -user:${USERNAME}`],
  ['issuesCreated', 'Issues Raised', `is:issue author:${USERNAME} -user:${USERNAME}`],
  ['issuesAssigned', 'Issues Taken', `is:issue assignee:${USERNAME} -user:${USERNAME}`],
  ['reviewsGiven', 'Reviews Given', `is:pr reviewed-by:${USERNAME} -author:${USERNAME} -user:${USERNAME}`]
];

const QUERY = /* GraphQL */ `
  query ($q: String!) {
    search(query: $q, type: ISSUE, first: 5) {
      issueCount
      nodes {
        ... on PullRequest { title url createdAt mergedAt repository { nameWithOwner } }
        ... on Issue { title url createdAt repository { nameWithOwner } }
      }
    }
  }
`;

async function graphql(query, variables, attempt = 1) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });

  if (res.status === 403 || res.status === 429) {
    if (attempt > 3) throw new Error(`GitHub API rate-limited after ${attempt} attempts`);
    await new Promise(r => setTimeout(r, 2 ** attempt * 1000));
    return graphql(query, variables, attempt + 1);
  }

  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

const results = await Promise.all(
  CATEGORIES.map(([key, , q]) => graphql(QUERY, { q }).then(d => [key, d.search]))
);
const byKey = Object.fromEntries(results);

const statsRow = CATEGORIES.map(([key, label]) => `**${byKey[key].issueCount}** ${label}`).join(' &nbsp;·&nbsp; ');

const recentPRs = byKey.mergedPRs.nodes
  .sort((a, b) => new Date(b.mergedAt) - new Date(a.mergedAt))
  .map(pr => `- [\`${pr.repository.nameWithOwner}\`](${pr.url}) — ${pr.title}`)
  .join('\n');

const block = `<!-- OSS-CONTRIBUTIONS:START -->
### Live Open Source Activity

${statsRow}

**Recent merged PRs**
${recentPRs || '_none yet_'}

<sub>Updated ${new Date().toISOString().slice(0, 10)} · auto-refreshed daily from live GitHub search</sub>
<!-- OSS-CONTRIBUTIONS:END -->`;

const readme = readFileSync('README.md', 'utf8');
const updated = readme.replace(
  /<!-- OSS-CONTRIBUTIONS:START -->[\s\S]*<!-- OSS-CONTRIBUTIONS:END -->/,
  block
);

if (updated === readme && !readme.includes('OSS-CONTRIBUTIONS:START')) {
  throw new Error('OSS-CONTRIBUTIONS markers not found in README.md');
}

writeFileSync('README.md', updated);
console.log('README.md updated');
