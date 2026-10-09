// Rewrites the OSS-CONTRIBUTIONS block in README.md from live GitHub + GitLab APIs.
// Run daily by .github/workflows/oss-contributions.yml — never called from the browser.
import { readFileSync, writeFileSync } from 'fs';

const USERNAME = 'darkraider01';
const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) throw new Error('GH_TOKEN env var is required');

// Global search queries auto-discover every public repo the user has touched —
// no hardcoded repo list, so new repos show up automatically.
// -user:USERNAME excludes their own repos: this tracks OSS contributions, not personal projects.
const CATEGORIES = [
  ['mergedPRs', `is:pr is:merged author:${USERNAME} -user:${USERNAME}`],
  ['openPRs', `is:pr is:open author:${USERNAME} -user:${USERNAME}`],
  ['issuesCreated', `is:issue author:${USERNAME} -user:${USERNAME}`],
  ['issuesAssigned', `is:issue assignee:${USERNAME} -user:${USERNAME}`],
  ['reviewsGiven', `is:pr reviewed-by:${USERNAME} -author:${USERNAME} -user:${USERNAME}`]
];

// first:100 fetches every result so the "recent" lists can sort by actual
// date client-side — a first:5 window misses PRs created long ago but merged recently.
const QUERY = /* GraphQL */ `
  query ($q: String!) {
    search(query: $q, type: ISSUE, first: 100) {
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

// Language mix: primary language of every OSS PR (open or merged), newest 100.
const LANG_QUERY = /* GraphQL */ `
  query ($q: String!) {
    search(query: $q, type: ISSUE, first: 100) {
      nodes {
        ... on PullRequest {
          state
          repository { primaryLanguage { name } }
        }
      }
    }
  }
`;

const [results, langData] = await Promise.all([
  Promise.all(CATEGORIES.map(([key, q]) => graphql(QUERY, { q }).then(d => [key, d.search]))),
  graphql(LANG_QUERY, { q: `is:pr author:${USERNAME} -user:${USERNAME}` })
]);
const byKey = Object.fromEntries(results);

// --- GitLab (skipped gracefully if the API is unreachable) ------------------

const GITLAB_TOKEN = process.env.GITLAB_TOKEN; // optional, raises rate limits

async function gitlab(path, attempt = 1) {
  const headers = { 'User-Agent': 'oss-readme-stats' };
  if (GITLAB_TOKEN) headers['PRIVATE-TOKEN'] = GITLAB_TOKEN;
  const res = await fetch(`https://gitlab.com/api/v4${path}`, { headers });
  if (res.status === 429 || res.status >= 500) {
    if (attempt > 3) throw new Error(`GitLab API failed after ${attempt} attempts: ${path} -> ${res.status}`);
    await new Promise(r => setTimeout(r, 2 ** attempt * 1000));
    return gitlab(path, attempt + 1);
  }
  if (!res.ok) throw new Error(`GitLab ${path} -> ${res.status}`);
  return res.json();
}

async function fetchGitlabStats() {
  const [mrs, issues, assignedIssues, reviewedMrs] = await Promise.all([
    gitlab(`/merge_requests?author_username=${USERNAME}&scope=all&state=all&per_page=100&order_by=created_at`),
    gitlab(`/issues?author_username=${USERNAME}&scope=all&state=all&per_page=100`),
    gitlab(`/issues?assignee_username=${USERNAME}&scope=all&state=all&per_page=100`),
    gitlab(`/merge_requests?reviewer_username=${USERNAME}&scope=all&state=all&per_page=100`)
  ]);

  // Exclude personal projects (anything under the user's own namespace), matching -user: on GitHub.
  const projectOf = ref => ref.split(/[!#]/)[0];
  const isOwn = ref => projectOf(ref) === USERNAME || projectOf(ref).startsWith(`${USERNAME}/`);
  const ossMrs = mrs.filter(m => !isOwn(m.references.full));
  const ossIssues = issues.filter(i => !isOwn(i.references.full));

  // Attribute each MR to the dominant language of its target project.
  const projectIds = [...new Set(ossMrs.map(m => m.target_project_id))].slice(0, 10);
  const projectLangs = await Promise.all(
    projectIds.map(id => gitlab(`/projects/${id}/languages`).catch(() => null))
  );
  const langsByProject = new Map(projectIds.map((id, i) => [id, projectLangs[i]]));

  return {
    mergedMRs: ossMrs.filter(m => m.state === 'merged').length,
    issues: ossIssues.length,
    taken: assignedIssues.filter(i => !isOwn(i.references.full)).length,
    reviews: reviewedMrs.filter(m => !isOwn(m.references.full) && m.author?.username !== USERNAME).length,
    openMrs: ossMrs.filter(m => m.state === 'opened'),
    mergedMrs: ossMrs.filter(m => m.state === 'merged'),
    countLanguages(add) {
      for (const m of ossMrs) {
        const langs = langsByProject.get(m.target_project_id);
        const top = langs && Object.entries(langs).sort((a, b) => b[1] - a[1])[0];
        if (top) add(top[0]);
      }
    }
  };
}

let gitlabStats = null;
try {
  gitlabStats = await fetchGitlabStats();
} catch (err) {
  console.warn(`GitLab stats skipped: ${err.message}`);
}

// --- Language chart ---------------------------------------------------------

// Canonical display names where GitHub and GitLab disagree on casing/spelling.
const LANG_NAMES = {
  'c++': 'C++',
  'c#': 'C#',
  'javascript': 'JavaScript',
  'typescript': 'TypeScript',
  'objective-c': 'Objective-C',
  'jupyter notebook': 'Jupyter Notebook'
};

const langs = new Map(); // lowercased name -> { name, count }
const addLang = raw => {
  const name = LANG_NAMES[raw.toLowerCase()] ?? raw;
  const key = name.toLowerCase();
  const entry = langs.get(key);
  if (entry) entry.count++;
  else langs.set(key, { name, count: 1 });
};

for (const node of langData.search?.nodes ?? []) {
  if (node.state === 'CLOSED') continue; // abandoned PRs don't count as contributions
  if (node.repository?.primaryLanguage) addLang(node.repository.primaryLanguage.name);
}
gitlabStats?.countLanguages(addLang);

const allRows = [...langs.values()].sort((a, b) => b.count - a.count);
const langTotal = allRows.reduce((sum, r) => sum + r.count, 0);
const langRows = allRows.slice(0, 8);
const nameWidth = Math.max(...langRows.map(r => r.name.length), 0);

const langChart = langRows.length
  ? [
      '**Languages** (OSS contributions)',
      '',
      '```text',
      ...langRows.map(r => {
        const pct = Math.round((r.count / langTotal) * 100);
        const bar = '█'.repeat(Math.max(1, Math.round(pct * 0.35)));
        return `${r.name.padEnd(nameWidth)}  ${bar} ${String(pct).padStart(3)}%`;
      }),
      '```'
    ].join('\n')
  : '';

// --- Recent lists (GitHub PRs + GitLab MRs, newest first) -------------------

const ghEntry = (n, dateKey) => ({
  repo: n.repository.nameWithOwner,
  url: n.url,
  title: n.title,
  date: n[dateKey]
});
const glEntry = (m, dateKey) => ({
  repo: m.references.full.split(/[!#]/)[0],
  url: m.web_url,
  title: m.title,
  date: m[dateKey]
});

const list = entries =>
  entries
    .slice()
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 5)
    .map(e => `- [\`${e.repo}\`](${e.url}) — ${e.title}`)
    .join('\n') || '_none yet_';

const openEntries = [
  ...byKey.openPRs.nodes.map(n => ghEntry(n, 'createdAt')),
  ...(gitlabStats?.openMrs ?? []).map(m => glEntry(m, 'created_at'))
];
const mergedEntries = [
  ...byKey.mergedPRs.nodes.map(n => ghEntry(n, 'mergedAt')),
  ...(gitlabStats?.mergedMrs ?? []).map(m => glEntry(m, 'merged_at'))
];

// --- Assemble the block -----------------------------------------------------

// One combined row: GitHub + GitLab totals in the same buckets.
const statsRow = [
  ['Merged PRs', byKey.mergedPRs.issueCount + (gitlabStats?.mergedMRs ?? 0)],
  ['Issues Raised', byKey.issuesCreated.issueCount + (gitlabStats?.issues ?? 0)],
  ['Issues Taken', byKey.issuesAssigned.issueCount + (gitlabStats?.taken ?? 0)],
  ['Reviews Given', byKey.reviewsGiven.issueCount + (gitlabStats?.reviews ?? 0)]
]
  .map(([label, count]) => `**${count}** ${label}`)
  .join(' &nbsp;·&nbsp; ');

const out = [
  '<!-- OSS-CONTRIBUTIONS:START -->',
  '### Live Open Source Activity',
  '',
  statsRow,
  ''
];
if (langChart) out.push(langChart, '');
out.push(
  '**Recent open PRs**',
  list(openEntries),
  '',
  '**Recent merged PRs**',
  list(mergedEntries),
  '',
  `<sub>Updated ${new Date().toISOString().slice(0, 10)} · auto-refreshed daily from live GitHub + GitLab search</sub>`,
  '<!-- OSS-CONTRIBUTIONS:END -->'
);
const block = out.join('\n');

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
