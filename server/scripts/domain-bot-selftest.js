#!/usr/bin/env node
'use strict';

// Domain desk self-test — exercises the real command router with no Telegram
// token, so the bot can be verified before the owner creates it in BotFather.
//
//   node server/scripts/domain-bot-selftest.js            # live registry checks
//   node server/scripts/domain-bot-selftest.js --offline  # router only, no network
//
// Exit code 0 means every case answered as expected.

const { handleDomainCommand, checkDomain, shortForms } = require('../src/telegramDomainBot');

const OFFLINE = process.argv.includes('--offline');
const results = [];

function record(label, ok, detail) {
  results.push({ label, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

(async () => {
  // Router coverage: every command the bot advertises must answer, not fall through.
  const routerCases = [
    ['/start', /Domain desk|marketplace/i],
    ['/help', /\/check/],
    ['/tlds', /\.com/],
    ['/market', /marketplace/i],
    ['/waitlist not-an-email', /does not look like an email|Waitlist/i],
  ];
  for (const [input, expect] of routerCases) {
    const reply = await handleDomainCommand(input, { chatId: 'selftest' });
    record(`router ${input}`, Boolean(reply && expect.test(reply)), reply ? reply.split('\n')[0].slice(0, 60) : 'no reply');
  }

  // Commands that belong to other bots must not be swallowed by the desk.
  for (const foreign of ['/ports', '/security', '/recon 1.2.3.4']) {
    const reply = await handleDomainCommand(foreign, { chatId: 'selftest' });
    record(`ignores ${foreign}`, reply === null, reply === null ? '' : 'unexpected reply');
  }

  record('name ideas for "trailer"', shortForms('trailer').length >= 4, shortForms('trailer').slice(0, 4).join(', '));

  if (OFFLINE) {
    const r = await handleDomainCommand('/check', { chatId: 'selftest' });
    record('missing argument is explained', /Send the name/i.test(r || ''), '');
    return finish();
  }

  // Live registry checks: a known-registered name, a name nothing can own, and a fake suffix.
  const registered = await checkDomain('example.com');
  record('example.com reads as registered', registered.status === 'registered', `${registered.registrar || 'no registrar field'}`);

  const fake = `selftest-${Date.now().toString(36)}.com`;
  const free = await checkDomain(fake);
  record(`${fake} reads as unregistered`, free.status === 'available', free.status);

  const badTld = await checkDomain('selftest.zzz');
  record('fake suffix is rejected', badTld.status === 'invalid-tld', badTld.status);

  const findReply = await handleDomainCommand('/find trailer', { chatId: 'selftest' });
  record('/find returns a report', Boolean(findReply && /Name ideas/.test(findReply)), (findReply || '').split('\n')[0]);
  record('/find never claims a reservation', Boolean(findReply && /nothing here is reserved/i.test(findReply)), '');

  finish();
})().catch((e) => { console.error('SELFTEST ERROR', e.message); process.exit(1); });

function finish() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}
