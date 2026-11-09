// Browser walk of the demo (login → reports → validation → PDF → about). Needs `pnpm demo` running and Playwright.
//   node tests/e2e/demo-walk.cjs <screenshot-dir> [light|dark] [mobile]
const { chromium, devices } = require('playwright');
const [OUT, scheme, mobile] = process.argv.slice(2);
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext(mobile ? { ...devices['Pixel 7'], colorScheme: scheme } : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: scheme });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(String(e)));
  p.on('console', m => { if (m.type() === 'error' && !m.text().includes('401')) errors.push(m.text()) });
  await p.goto('http://localhost:3000/');
  await p.fill('#email', 'mireille.kabange@kibala.example');
  await p.click('button:has-text("Recevoir un code")');
  await p.waitForSelector('.demo-banner');
  await p.fill('#code', (await p.textContent('.demo-banner .mono')).trim());
  await p.click('button:has-text("Se connecter")');
  await p.waitForSelector('text=Activité du jour'); await p.waitForTimeout(700);
  await p.screenshot({ path: `${OUT}/a-dashboard.png` });
  await p.goto('http://localhost:3000/sessions/nouvelle'); await p.waitForSelector('text=Que doit faire'); await p.waitForTimeout(400);
  await p.click('.chip:has-text("032")'); await p.click('.chip:has-text("022")'); await p.waitForTimeout(400);
  await p.click('button:has-text("Lancer")');
  await p.waitForSelector('.doc-table'); await p.waitForTimeout(3000);
  await p.screenshot({ path: `${OUT}/b-session.png` });
  await p.click('a:has-text("Ouvrir") >> nth=0'); await p.waitForSelector('text=Contrôles de l\'agent'); await p.waitForTimeout(400);
  await p.screenshot({ path: `${OUT}/c-review-injection.png`, fullPage: !!mobile });
  if (!mobile) {
    await p.click('button:has-text("Valider la facture")');
    await p.waitForSelector('text=Télécharger le PDF'); await p.waitForTimeout(400);
    await p.screenshot({ path: `${OUT}/d-validated.png` });
    await p.goto('http://localhost:3000/a-propos'); await p.waitForTimeout(500);
    await p.click('button:has-text("Voir la licence")'); await p.waitForTimeout(500);
    await p.screenshot({ path: `${OUT}/e-about.png` });
  }
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  console.log(scheme, mobile ? 'mobile' : 'desktop', 'horizontal overflow:', overflow, 'errors:', JSON.stringify(errors));
  await b.close();
})().catch(e => { console.error('WALK FAILED', e); process.exit(1) });
