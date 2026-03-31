// TC4S CI – QG1 Issue Review (GitHub Actions, no AI)
// Reads rules from rules/qg1-rules.yaml, posts a review comment on the Issue.

const { Octokit } = require('@octokit/rest');
const yaml = require('js-yaml');
const fs   = require('fs');

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const OWNER   = process.env.REPO_OWNER;
const REPO    = process.env.REPO_NAME;
const NUM     = parseInt(process.env.ISSUE_NUMBER, 10);
const TITLE   = process.env.ISSUE_TITLE   || '';
const BODY    = process.env.ISSUE_BODY    || '';
const LABELS  = JSON.parse(process.env.ISSUE_LABELS || '[]');

const LB      = LABELS.map(l => (typeof l === 'string' ? l : l.name || '').toLowerCase());
const FT      = `${TITLE}\n${BODY}`.toLowerCase();

function has(text, ...terms) { return terms.some(t => (text||'').toLowerCase().includes(t.toLowerCase())); }
function wc(t) { return (t||'').split(/\s+/).filter(Boolean).length; }
function extractSection(body, heading) {
  const re = new RegExp(`#+\\s*${heading}[^\\n]*\\n([\\s\\S]*?)(?=\\n#+|$)`, 'i');
  const m  = (body||'').match(re);
  return m ? m[1].trim() : null;
}
function cxIds(t) { return [...new Set((t.match(/CX-0\d{3}/gi)||[]))]; }

function classifyType() {
  if (LB.some(l => l.includes('sr') || l.includes('standard-request'))) return 'SR';
  if (has(FT, 'standard request', '[sr]', 'new standard')) return 'SR';
  const vm = FT.match(/(\d+)\.(\d+)\.(\d+)\s*(?:→|->|to)\s*(\d+)\.(\d+)\.(\d+)/);
  if (vm) {
    const [,ma,,pa,mb,,pb] = vm.map(Number);
    if (mb===ma && pb>pa) return 'Patch';
  }
  return 'CR';
}

// Load rules
let rules = [];
try {
  const raw = fs.readFileSync('rules/qg1-rules.yaml', 'utf8');
  rules = yaml.load(raw).rules || [];
} catch(e) {
  console.error('Could not load rules/qg1-rules.yaml:', e.message);
  process.exit(0); // don't fail CI if rules are missing
}

const enabled = id => rules.find(r => r.id === id)?.enabled !== false;

const PASS  = (id, title, note='') => ({ id, title, result:'PASS',     note, blocking:false });
const FAIL  = (id, title, note='', blocking=true) => ({ id, title, result:'FAIL',     note, blocking });
const WARN  = (id, title, note='') => ({ id, title, result:'ADVISORY', note, blocking:false });
const SKIP  = (id, title, note='') => ({ id, title, result:'SKIP',     note, blocking:false });

const type = classifyType();
const results = [];

if (enabled('QG1-01')) {
  const ms = extractSection(BODY, 'Management Summary');
  if (!ms)           results.push(FAIL('QG1-01', 'Management Summary present', 'No "Management Summary" heading found.'));
  else if (wc(ms)<30) results.push(FAIL('QG1-01', 'Management Summary present', `Too short (${wc(ms)} words).`));
  else if (has(ms,'tbd','todo','placeholder')) results.push(FAIL('QG1-01', 'Management Summary present', 'Contains placeholder text.'));
  else results.push(PASS('QG1-01', 'Management Summary present'));
}

if (enabled('QG1-02')) {
  const dm = LB.some(l => l.includes('domain-manager') || l.includes('dm-approved'));
  const bl = (BODY.match(/^[-*]\s+\S/gm) || []).length;
  if (!dm)      results.push(FAIL('QG1-02', 'Domain Manager label; ≥3 companies', 'Label NOT set — hard blocker.'));
  else if(bl<3) results.push(WARN('QG1-02', 'Domain Manager label; ≥3 companies', `Only ${bl} bullet(s) found.`));
  else          results.push(PASS('QG1-02', 'Domain Manager label; ≥3 companies'));
}

if (enabled('QG1-03')) {
  const hm = has(FT,'sam','semantic model','aspect model','sldt');
  const hc = has(FT,'changelog','changelog.md');
  if (!hm&&!hc) results.push(FAIL('QG1-03', 'Mandatory artifacts referenced', 'No model and no changelog reference.'));
  else if (!hm) results.push(FAIL('QG1-03', 'Mandatory artifacts referenced', 'No aspect model/SAM/SLDT reference.'));
  else if (!hc) results.push(WARN('QG1-03', 'Mandatory artifacts referenced', 'No changelog reference.'));
  else          results.push(PASS('QG1-03', 'Mandatory artifacts referenced'));
}

const blockFails = results.filter(r => r.result === 'FAIL' && r.blocking);
const warns      = results.filter(r => r.result === 'ADVISORY');
const pass       = blockFails.length === 0;
const icon       = r => ({ PASS:'✅', FAIL: r.blocking ? '🚫' : '❌', ADVISORY:'⚠️', SKIP:'–' })[r.result] || '–';

const comment = `## ${pass ? '✅' : '🚫'} TC4S QG1 – Automated Review

> **Issue type:** ${type} · **Reviewed by:** GitHub Actions (rule-based, no AI)

| | Rule | Result | Note |
|---|---|---|---|
${results.map(r => `| ${icon(r)} | \`${r.id}\` ${r.title} | ${r.result} | ${r.note || '—'} |`).join('\n')}

${blockFails.length > 0
  ? `> 🚫 **${blockFails.length} blocking failure(s).** Resolve before requesting QG1 approval.`
  : '> ✅ No blocking failures. Advisory items should be reviewed.'}

<sub>TC4S automated review · [product-standardization-review](https://github.com/janseidel/product-standardization-review) · rule-based only, AI checks available in the browser UI</sub>
`;

async function main() {
  // Delete previous bot comment
  const comments = await octokit.issues.listComments({ owner: OWNER, repo: REPO, issue_number: NUM, per_page: 100 });
  for (const c of comments.data) {
    if (c.user.type === 'Bot' && c.body.includes('TC4S QG1')) {
      await octokit.issues.deleteComment({ owner: OWNER, repo: REPO, comment_id: c.id }).catch(() => {});
    }
  }

  // Post new comment
  await octokit.issues.createComment({ owner: OWNER, repo: REPO, issue_number: NUM, body: comment });

  // Set label
  const passLabel = 'tc4s: qg1-passed', failLabel = 'tc4s: qg1-failed';
  for (const name of [passLabel, failLabel]) {
    try { await octokit.issues.getLabel({ owner: OWNER, repo: REPO, name }); }
    catch { await octokit.issues.createLabel({ owner: OWNER, repo: REPO, name, color: name.includes('pass') ? '1D9E75' : 'E24B4A' }).catch(() => {}); }
  }
  await octokit.issues.addLabels({ owner: OWNER, repo: REPO, issue_number: NUM, labels: [pass ? passLabel : failLabel] }).catch(() => {});
  await octokit.issues.removeLabel({ owner: OWNER, repo: REPO, issue_number: NUM, name: pass ? failLabel : passLabel }).catch(() => {});

  console.log(`QG1 done. Blocking: ${blockFails.length}. Type: ${type}.`);
  if (!pass) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
