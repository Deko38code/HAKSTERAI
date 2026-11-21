// §18 check for the new pricing UI (packs + per-seat).
// Renders the built /plans page against a simulated /api/stripe/plans payload
// built from the real PRICING_CATALOG, at the five required viewports, and
// measures real boxes — no CSS reading.
const puppeteer = require('/home/ghost/haksterAi/node_modules/puppeteer')
const fs = require('fs')
const payload = fs.readFileSync('/home/ghost/haksterAi/.harness2/plans.json', 'utf8')
// Default: the static preview with a stubbed catalog. Pass a URL to measure a
// running server against its real /api/stripe/plans answer.
const LIVE = process.argv[2] || 'http://127.0.0.1:3997/plans/'

const SIZES = [[360, 640], [390, 844], [414, 896], [1440, 900], [1920, 1080]]

;(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
  })
  const page = await browser.newPage()
  // Stub only when measuring the static preview; a real URL answers for itself.
  if (!process.argv[2]) {
    await page.setRequestInterception(true)
    page.on('request', (req) => {
      const u = req.url()
      if (u.includes('/api/stripe/plans')) {
        return req.respond({ status: 200, contentType: 'application/json', body: payload })
      }
      if (u.includes('/api/pricing')) {
        return req.respond({ status: 200, contentType: 'application/json', body: payload })
      }
      return req.continue()
    })
  }

  const fails = []
  for (const [w, h] of SIZES) {
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 })
    // A live page polls its applet every 2 s, so the network never goes idle;
    // wait for the rendered plan cards instead of for silence on the wire.
    await page.goto(LIVE, { waitUntil: 'domcontentloaded', timeout: 45000 })
    if (process.argv[2]) await page.waitForFunction(() => document.querySelectorAll('#plan-grid > div').length > 1, { timeout: 20000 }).catch(() => {})
    await new Promise(r => setTimeout(r, 300))
    const rep = await page.evaluate(() => {
      const vw = window.innerWidth
      const doc = document.documentElement
      const cards = Array.from(document.querySelectorAll('#plan-grid > div'))
      const out = {
        vw,
        hOverflow: doc.scrollWidth - vw,
        cards: cards.length,
        titles: cards.map(c => (c.querySelector('h2') || {}).textContent || ''),
        rows: [],
        minBtn: 999,
        tinyTargets: [],
      }
      const gutter = vw < 480 ? 20 : 16
      for (const c of cards) {
        const r = c.getBoundingClientRect()
        if (r.left < 0 || r.right > vw + 0.5) out.rows.push({ bad: 'card outside viewport', card: (c.querySelector('h2') || {}).textContent, l: r.left, r: r.right })
        if (c.querySelector('input[type=number]')) {
          const i = c.querySelector('input[type=number]').getBoundingClientRect()
          if (i.height < 44) out.tinyTargets.push('seat input ' + Math.round(i.height) + 'px')
        }
      }
      for (const b of document.querySelectorAll('#plan-grid button')) {
        const r = b.getBoundingClientRect()
        out.minBtn = Math.min(out.minBtn, Math.round(r.height))
        if (r.height < 44) out.tinyTargets.push((b.textContent || '').trim() + ' ' + Math.round(r.height) + 'px')
      }
      // every price row must stay inside its card
      for (const row of document.querySelectorAll('#plan-grid > div > div')) {
        const r = row.getBoundingClientRect()
        if (r.width && Math.abs(r.right - r.left) > vw) out.rows.push({ bad: 'price row wider than viewport', l: r.left, r: r.right })
      }
      out.gutter = (() => {
        const g = document.getElementById('plan-grid')
        if (!g) return null
        const r = g.getBoundingClientRect()
        return Math.round(Math.min(r.left, vw - r.right))
      })()
      out.gutterNeed = gutter
      // text of the seat + pack lines, to prove the labels rendered
      out.labels = Array.from(document.querySelectorAll('#plan-grid > div')).map(c => c.textContent.replace(/\s+/g, ' ').trim().slice(0, 160))
      return out
    })
    const ok = rep.hOverflow <= 0 && rep.rows.length === 0 && rep.tinyTargets.length === 0
      && rep.gutter !== null && rep.gutter >= rep.gutterNeed - 1
    console.log(`${w}x${h} | cards ${rep.cards} | hOver ${rep.hOverflow} | gutter ${rep.gutter} (need ${rep.gutterNeed}) | minBtn ${rep.minBtn} | ${ok ? 'PASS' : 'FAIL'}`)
    if (!ok) {
      fails.push(`${w}x${h}: ` + JSON.stringify({ rows: rep.rows, tiny: rep.tinyTargets, hOverflow: rep.hOverflow, gutter: rep.gutter }))
    }
    console.log('   ' + rep.titles.join(' / '))
  }
  console.log(fails.length ? '\nFAILURES:\n' + fails.join('\n') : '\nALL PASS')
  await browser.close()
})().catch(e => { console.error('HARNESS FAIL', e.message); process.exit(1) })
