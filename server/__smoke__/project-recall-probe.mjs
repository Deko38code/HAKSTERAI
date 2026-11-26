#!/usr/bin/env node
/* project-recall probe — the agent recalls PAST PROJECTS from its memory bank.
 *
 * Owner, 2026-11-26: "and build where are agent uses are memory bank to recall
 * past projects".
 *
 * What this pins:
 *
 *   1. scoring ranks a project NAME above a directory above a description word —
 *      a task that says "cinevault" is about CineVault, not about whatever
 *      description happens to contain the word;
 *   2. a task that names no known project yields NO block (no decoration, §10);
 *   3. the block carries the bank's MEASURED counts and the project's real path,
 *      and marks a project that lives on another box instead of pretending it is
 *      local;
 *   4. a project declared only as data (the registry) is recallable — a new
 *      project is data, not a code change (§26.5);
 *   5. the index is cached: two builds inside the TTL return the same object;
 *   6. the two wiring bugs are gone: `customerDirective` is declared before the
 *      memory-first block that reads it (it used to throw a TDZ ReferenceError),
 *      and v2 recall is called with the TASK as its query, not the cwd.
 *
 * Run: node server/__smoke__/project-recall-probe.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const recall = require(path.join(root, 'server/src/agent/project-recall.js'));

let pass = 0;
const fail = [];
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`✔ ${name}`); }
  else { fail.push(name); console.log(`✘ ${name}${detail ? ' — ' + detail : ''}`); }
}

/* A synthetic index: no disk, no bank — the scoring and rendering only. */
const index = {
  builtAt: Date.now(),
  projects: [
    {
      key: 'cine-vault-live', name: 'CineVault', dir: '/home/ghost/cine-vault-live',
      description: 'IPTV and movie streaming platform', stack: '', pm2: 'cinevault', port: 8081,
      lastCommit: { at: '2026-11-26T14:00:00Z', subject: 'codex movie agent: return whole franchises' },
      aliases: ['cinevault', 'cine-vault', 'flixchill'], present: true,
      memory: { facts: 6, lessons: 2, mistakes: 1, patterns: 0, conventions: 0,
        samples: ['The paced playlist meters segments by wall clock'],
        mistakesList: ['ERR_HTTP_HEADERS_SENT in serveFile was a double-response'] },
    },
    {
      key: 'junkalot', name: 'Junkalot.co', dir: '/home/ghost694/junkalot',
      description: '', stack: '', pm2: null, port: null, lastCommit: null,
      aliases: ['junkalot', 'junkalot.co'], present: false, host: 'parrot',
      memory: { facts: 26, lessons: 0, mistakes: 0, patterns: 0, conventions: 25, samples: [], mistakesList: [] },
    },
    {
      key: 'miniforge', name: 'Miniforge', dir: '/home/ghost/miniforge',
      description: 'cinevault helper for local encodes', stack: '', pm2: null, port: 5555,
      lastCommit: null, aliases: ['miniforge'], present: true,
      memory: { facts: 5, lessons: 2, mistakes: 0, patterns: 0, conventions: 4, samples: [], mistakesList: [] },
    },
  ],
};

/* 1. scoring order: name > dir > description */
{
  const terms = ['cinevault'];
  const nameHit = recall._scoreProject(index.projects[0], terms);   // alias/name
  const descHit = recall._scoreProject(index.projects[2], terms);   // description only
  ok('a name/alias match outranks a description match', nameHit > descHit, `name=${nameHit} desc=${descHit}`);
  ok('a name match scores >= 3', nameHit >= 3, String(nameHit));
  ok('an unrelated term scores 0', recall._scoreProject(index.projects[0], ['kubernetes']) === 0);
}

/* 2. no project named → no block */
{
  const r = recall.projectPromptBlock('deploy the site and check latency', { index });
  ok('a task naming no project yields no block', r.text === '' && r.count === 0, JSON.stringify(r.projects));
  ok('an empty task yields no block', recall.projectPromptBlock('', { index }).text === '');
}

/* 3. the block carries measured counts and the real path */
{
  const r = recall.projectPromptBlock('fix the cinevault buffering', { index });
  ok('the named project is recalled', r.count === 1 && r.projects[0] === 'CineVault', r.projects.join(','));
  ok('the block names the project path', r.text.includes('/home/ghost/cine-vault-live'));
  ok('it carries the bank s own counts', /6 facts · 2 lessons · 1 mistake/.test(r.text), r.text.split('\n')[4]);
  ok('it carries the recorded mistake verbatim', r.text.includes('ERR_HTTP_HEADERS_SENT'));
  ok('it carries the last commit', r.text.includes('2026-11-26'));

  const remote = recall.projectPromptBlock('add a rule to junkalot footer', { index });
  ok('a project on another box is recalled too', remote.count === 1 && remote.projects[0] === 'Junkalot.co');
  ok('and it says it is not on this machine', /not this machine/.test(remote.text));
  ok('and it never tells the agent to open a local MEMORY.md for it', !/open \/home\/ghost694/.test(remote.text));
}

/* 4. a project that exists only as data is recallable */
{
  const regFile = path.join(root, 'server/src/agent/project-registry.json');
  const reg = JSON.parse(fs.readFileSync(regFile, 'utf8'));
  ok('the registry is data in tracked source, so both boxes carry it', Array.isArray(reg.projects) && reg.projects.length > 0);
  ok('the registry declares junkalot with its Parrot path',
    reg.projects.some((p) => /junkalot/i.test(p.name) && p.dir.includes('/home/ghost694/')));
  ok('every registry row carries a name and a dir',
    reg.projects.every((p) => p.name && p.dir));
  ok('no registry row carries a secret-shaped value',
    !/eyJ|sk_|ghp_|xox|AKIA/.test(fs.readFileSync(regFile, 'utf8')));
}

/* 5. the index is cached inside the TTL */
{
  const a = recall.buildProjectIndex({ force: true });
  const b = recall.buildProjectIndex();
  ok('a second build inside the TTL returns the cached index', a === b);
  ok('the index it built is real work', Array.isArray(a.projects) && a.projects.length > 0);
}

/* 6. the wiring bugs are gone */
{
  const srv = fs.readFileSync(path.join(root, 'server/src/index.js'), 'utf8');
  const decl = srv.indexOf("const customerDirective = customerDirectiveFor(user, sessionId);");
  const use = srv.indexOf('if (!customerDirective && memoryFirst.count > 0)');
  ok('customerDirective is declared before the memory-first block reads it', decl !== -1 && use !== -1 && decl < use,
    `decl@${decl} use@${use}`);
  ok('the duplicate later declaration is gone',
    srv.indexOf("  const customerDirective = customerDirectiveFor(user, sessionId);\n  const dynamicPrompt") === -1);
  ok('the run stream announces a project recall', srv.includes("type: 'project_recall'"));
  ok('the prompt carries the past-projects block', srv.includes('pastProjects.text'));

  const agent = fs.readFileSync(path.join(root, 'server/src/agent/index.js'), 'utf8');
  ok('v2 recall is queried with the task, not the cwd',
    agent.includes('memoryEngine.recallForPrompt(taskText, process.cwd()') &&
    !agent.includes('memoryEngine.recallForPrompt(process.cwd(), { maxChars: 5000 })'));
  ok('the agent loop pushes the past-projects block per task',
    agent.includes('projectRecall.projectPromptBlock(userMessage'));
}

console.log(`\n${pass} passed, ${fail.length} failed`);
if (fail.length) { console.log('FAILED: ' + fail.join(' | ')); process.exit(1); }
