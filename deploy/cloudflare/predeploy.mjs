// Runs before `npm run deploy`. The site is made of whatever is in this checkout (the Worker, the
// scanner's image and all of web/), and nothing on the site says which commit that was: it once went
// out from a branch 41 commits behind main with edits that were never committed, and nobody noticed
// for a week. So it's only deployed from a clean checkout of what origin's main is right now.
// To deploy something else on purpose: DEPLOY_ANYWAY=1 npm run deploy
import { execFileSync } from 'node:child_process';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const wrong = [];
let at = '';
try {
  const head = git('rev-parse', 'HEAD');
  at = git('log', '-1', '--format=%h %s');
  // (untracked files count: anything in web/ is uploaded with the rest)
  const changed = git('status', '--porcelain').split('\n').filter(Boolean);
  if (changed.length) wrong.push(`${count(changed.length, 'file')} changed or not in git:\n${changed.slice(0, 8).map(l => `      ${l}`).join('\n')}${changed.length > 8 ? '\n      …' : ''}`);
  let main = null;
  try { git('fetch', '--quiet', 'origin', 'main'); main = git('rev-parse', 'FETCH_HEAD'); }
  catch { wrong.push("origin's main couldn't be fetched to compare with"); }
  if (main && main !== head) {
    // ahead: commits here that main doesn't have; behind: main's that aren't here
    const [ahead, behind] = git('rev-list', '--left-right', '--count', `${head}...${main}`).split(/\s+/).map(Number);
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
    wrong.push(`this checkout (${branch === 'HEAD' ? at : branch}) isn't origin's main: ${[behind && `${count(behind, 'commit')} behind it`, ahead && `${count(ahead, 'commit')} of its own`].filter(Boolean).join(', ')}`);
  }
} catch (err) {
  wrong.push(`git couldn't say what this checkout is: ${String(err.stderr || err.message).trim().split('\n')[0]}`);
}

if (!wrong.length) console.log(`  deploying origin's main, ${at}`);
else {
  const anyway = !!process.env.DEPLOY_ANYWAY;
  console.error(`\n  gitropolis: ${anyway ? 'deploying anyway (DEPLOY_ANYWAY), though' : 'not deploying:'} the site would not be origin's main\n${wrong.map(w => `    · ${w}`).join('\n')}`);
  if (!anyway) {
    console.error('\n  Commit or stash, switch to main and pull. Or, to deploy this on purpose:\n    DEPLOY_ANYWAY=1 npm run deploy\n');
    process.exit(1);
  }
}
