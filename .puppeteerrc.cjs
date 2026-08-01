// Chrome is installed separately at runtime into ~/.cache/puppeteer-ghost
// (see server/src/agent/index.js) so `npm install` must not try to download
// its own copy — that download was breaking the CLI install (curl/npm) for
// every user whenever the postinstall Chrome fetch failed for any reason.
module.exports = {
  skipDownload: true,
};
