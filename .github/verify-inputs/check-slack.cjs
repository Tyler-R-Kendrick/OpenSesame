const { chromium } = require('@playwright/test');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 600 } });
    await page.goto('http://127.0.0.1:4178/__slack-fixture.html', { waitUntil: 'networkidle' });
    for (const theme of ['light', 'dark']) for (const size of [24, 36, 48]) {
      const label = page.locator(`[data-theme-proof="${theme}"] [data-size="${size}"] .conn-mark--wordmark`);
      await label.waitFor();
      assert.equal(await label.textContent(), 'Slack');
      assert.equal(await label.getAttribute('aria-hidden'), 'true');
      const actual = await label.evaluate((el) => {
        const range = document.createRange(); range.selectNodeContents(el);
        const text = range.getBoundingClientRect(); const box = el.getBoundingClientRect();
        return { box: box.width, text: text.width, color: getComputedStyle(el).color };
      });
      assert.equal(actual.box, size);
      assert.ok(actual.text <= actual.box + 1, `${theme} ${size}: text ${actual.text}px exceeds ${actual.box}px`);
      assert.equal(actual.color, theme === 'light' ? 'rgb(17, 17, 17)' : 'rgb(255, 255, 255)');
    }
    await page.screenshot({ path: '/tmp/opensesame-slack-proof.png' });
    console.log('Slack text is visible, fits, and inherits color in both themes at all sizes.');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
