// Optional browser regression checks. See docs/dashboard-design.md for setup.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseURL = process.env.TDM_PREVIEW_URL || 'http://127.0.0.1:8095';
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/web_state.json')));
(async () => {
  const browser = await chromium.launch({headless: true, ...(process.env.CHROMIUM_PATH ? {executablePath: process.env.CHROMIUM_PATH} : {})});
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 1000}, colorScheme: 'dark'});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    // All actions are intercepted: this suite must never control a real miner.
    const requests = [];
    await page.route('**/api/**', route => {
      requests.push({url: route.request().url(), body: route.request().postDataJSON()});
      return route.fulfill({json: {ok: true}});
    });
    await page.addInitScript(state => {
      window.EventSource = class {
        constructor() {
          window.previewEvents = this;
          setTimeout(() => this.onmessage?.({data: JSON.stringify(state)}), 0);
        }
      };
    }, fixture);
    const emit = state => page.evaluate(state => window.previewEvents.onmessage({data: JSON.stringify(state)}), state);
    const goto = async route => { await page.goto(baseURL + route); await page.waitForSelector('#app-shell:not(.hidden)'); };
    await goto('/');
    assert.equal(await page.locator('#now-heading').textContent(), fixture.activeDrop.rewards);
    assert.equal(await page.locator('.reward-track li').count(), 3);
    assert.match(await page.locator('#queue-preview').textContent(), /Account connection required/);
    // A progress tick must preserve the focused campaign link and action button.
    await page.locator('.now-status a').focus();
    await emit({...fixture, activeDrop: {...fixture.activeDrop, progress: .7}});
    assert.equal(await page.locator('.now-status a').evaluate(el => el === document.activeElement), true);
    await page.locator('[data-action="pause"]').focus();
    await emit({...fixture, revision: 43});
    assert.equal(await page.locator('[data-action="pause"]').evaluate(el => el === document.activeElement), true);
    await page.locator('[data-action="pause"]').click();
    await page.waitForFunction(() => !document.querySelector('[data-action="pause"]').disabled);
    assert.ok(requests.some(request => request.url.endsWith('/api/actions/pause')));
    await emit({...fixture, activity: 'idle'});
    assert.equal(await page.locator('#now-heading').textContent(), 'Mining is paused');
    assert.equal(await page.locator('[data-action="reload"]').first().textContent(), 'Resume mining');
    await page.evaluate(() => window.previewEvents.onerror());
    assert.equal(await page.locator('#connection-banner').isVisible(), true);
    assert.match(await page.locator('.now-status').textContent(), /Connection interrupted/);
    assert.equal(await page.locator('.queue-state .live').count(), 0);
    await emit(fixture);
    assert.equal(await page.locator('#connection-banner').isVisible(), false);
    await emit({...fixture, activeDrop: null, campaigns: [], channels: [], messages: [], notifications: [], settings: {...fixture.settings, priority: []}});
    assert.equal(await page.locator('#now-heading').textContent(), 'Ready for the next drop');
    assert.equal(await page.locator('#reward-track li').count(), 0);
    await emit({...fixture, activeDrop: {...fixture.activeDrop, benefits: [{image: baseURL + '/missing-artwork'}]}});
    await page.waitForFunction(() => !document.querySelector('.reward-art img'));
    assert.equal(await page.locator('.reward-art svg').isVisible(), true);

    for (const theme of ['graphite', 'paper', 'midnight', 'evergreen', 'system']) {
      await goto('/settings');
      await page.locator(`[data-theme-choice="${theme}"]`).click();
      assert.equal(await page.locator('#quick-theme').inputValue(), theme);
      await page.reload();
      await page.waitForSelector('.theme-options');
      assert.equal(await page.locator(`[data-theme-choice="${theme}"]`).getAttribute('aria-pressed'), 'true');
      assert.equal(await page.evaluate(() => localStorage.getItem('tdm-theme')), theme);
    }
    await page.locator('#quick-theme').selectOption('evergreen');
    assert.equal(await page.locator('[data-theme-choice="evergreen"]').getAttribute('aria-pressed'), 'true');
    await page.locator('[data-setting="trayNotifications"]').uncheck();
    await page.locator('[data-theme-choice="paper"]').click();
    await emit(fixture);
    assert.equal(await page.locator('[data-setting="trayNotifications"]').isChecked(), false, 'Theme/live update must preserve unsaved settings');
    await page.locator('[data-save-settings]').click();
    await page.waitForFunction(() => document.querySelector('#save-bar').classList.contains('hidden'));
    assert.ok(requests.some(request => request.url.endsWith('/api/settings') && request.body.trayNotifications === false));

    await goto('/mining');
    const input = page.locator('#priority-game');
    await input.fill('ARC');
    await emit(fixture);
    assert.equal(await input.inputValue(), 'ARC', 'Live updates preserve game search');
    await input.press('Enter');
    assert.match(await page.locator('#priority-rows').textContent(), /ARC Raiders/);
    await page.locator('[data-discard-settings]').click();
    await goto('/campaigns');
    await page.locator('#campaign-search').fill('VALORANT');
    assert.equal(await page.locator('.campaign-row').count(), 1);
    await page.locator('.campaign-name a').click();
    assert.match(page.url(), /campaigns\/campaign-2$/);

    for (const width of [1440, 1024, 920, 768, 390, 320]) {
      await page.setViewportSize({width, height: 900});
      for (const route of ['/', '/campaigns', '/campaigns/campaign-1', '/mining', '/settings', '/diagnostics']) {
        await goto(route);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `Overflow on ${route} at ${width}px`);
      }
    }
    await emit({...fixture, login: {activationCode: 'ABCD1234', activationUrl: 'https://www.twitch.tv/activate'}, canLogout: false});
    assert.equal(await page.locator('#auth-view').isVisible(), true);
    assert.equal(await page.locator('#activation-code').textContent(), 'ABCD1234');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    console.log('Passed: themes, queue states, pause, reconnect, empty state, failed artwork, live-update focus, settings save, game picker, search, detail navigation, authorization, and 36 responsive route checks.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
