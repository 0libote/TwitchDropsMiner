// Optional browser regression checks. See docs/dashboard-design.md for setup.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
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
    let historyMode = "success";
    await page.route('**/api/**', route => {
      requests.push({url: route.request().url(), body: route.request().postDataJSON(), csrf: route.request().headers()["x-csrf-token"]});
      if (route.request().url().includes('/api/csrf')) return route.fulfill({json: {token: 'test-token'}});
      if (route.request().url().includes('/api/history') && historyMode === 'error') return route.fulfill({status: 503, body: 'History temporarily unavailable'});
      if (route.request().url().includes('/api/history') && historyMode === 'empty') return route.fulfill({json: {items: [], total: 0, summary: {games: []}}});
      if (route.request().url().includes('/api/history')) return route.fulfill({json: {items: [{name: 'Saved reward', gameName: 'Sample game', benefitId: 'saved-1', source: 'inventory'}, {name: 'Locally recorded reward', benefitId: 'saved-2', source: 'local', observedAt: '2026-09-04T12:00:00Z'}], total: 2, summary: {rewardCount: 2, gameCount: 1, games: []}}});
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
    await emit({...fixture, paused: false, miningPlan: [{game: 'Automatic game', reason: 'Ending soonest', priority: false, watching: false}]});
    assert.match(await page.locator('#queue-preview').textContent(), /Automatic game/);
    assert.match(await page.locator('#queue-preview').textContent(), /Ending soonest/);
    // A progress tick must preserve the focused campaign link and action button.
    await page.locator('.now-status a').focus();
    await emit({...fixture, activeDrop: {...fixture.activeDrop, progress: .7}});
    assert.equal(await page.locator('.now-status a').evaluate(el => el === document.activeElement), true);
    await page.locator('[data-action="pause"]').focus();
    await emit({...fixture, revision: 43});
    assert.equal(await page.locator('[data-action="pause"]').evaluate(el => el === document.activeElement), true);
    await page.locator('[data-action="pause"]').click();
    await page.waitForFunction(() => !document.querySelector('[data-action="pause"]').disabled);
    assert.ok(requests.some(request => request.url.endsWith('/api/actions/pause') && request.csrf === 'test-token'));
    await emit({...fixture, activity: 'idle', paused: true});
    assert.equal(await page.locator('#now-heading').textContent(), 'Mining is paused');
    assert.equal(await page.locator('[data-action="resume"]').first().textContent(), 'Resume mining');
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
    await page.locator('.campaign-name a').focus();
    await emit({...fixture, revision: 101});
    assert.equal(await page.locator('.campaign-name a').evaluate(el => el === document.activeElement), true);
    await page.locator('.campaign-name a').click();
    assert.match(page.url(), /campaigns\/campaign-2$/);

    await page.locator('[data-preference="exclude"]').focus();
    await emit({...fixture, revision: 102});
    assert.equal(await page.locator('[data-preference="exclude"]').evaluate(el => el === document.activeElement), true);
    await goto('/history');
    await page.waitForSelector('.history-row');
    assert.match(await page.locator('#history-results').textContent(), /Claim date unavailable/);
    assert.match(await page.locator('#history-results').textContent(), /Recorded /);
    const historyCalls = requests.filter(item => item.url.includes('/api/history')).length;
    await emit({...fixture, revision: 103});
    assert.equal(requests.filter(item => item.url.includes('/api/history')).length, historyCalls);
    await page.locator('#history-query').fill('reward');
    await page.locator('#history-filters button').click();
    await page.waitForSelector('.history-row');
    assert.ok(requests.some(item => item.url.includes('q=reward')));
    historyMode = 'error';
    await page.locator('#history-filters button').click();
    await page.waitForSelector('[data-history-retry]');
    assert.match(await page.locator('#history-results').textContent(), /History temporarily unavailable/);
    historyMode = 'empty';
    await page.locator('[data-history-retry]').click();
    await page.waitForFunction(() => document.querySelector('#history-results').textContent.includes('No saved rewards found'));
    historyMode = 'success';

    await emit({...fixture, login: {userId: 2002}, revision: 104});
    await page.waitForSelector('.history-row');
    assert.equal(await page.locator('#history-query').inputValue(), '', 'Account changes clear history filters');
    assert.equal(await page.locator('#history-game').inputValue(), '');
    await emit({...fixture, canLogout: false, login: {}, revision: 105});
    assert.equal(await page.locator('#history-results').count(), 0, 'Sign-out removes previous account history');
    await emit(fixture);
    await page.waitForSelector('.history-row');

    for (const width of [1440, 1024, 920, 768, 390, 320]) {
      await page.setViewportSize({width, height: 900});
      for (const route of ['/', '/campaigns', '/campaigns/campaign-1', '/mining', '/settings', '/diagnostics', '/history']) {
        await goto(route);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `Overflow on ${route} at ${width}px`);
      }
    }
    for (const width of [1440, 390]) {
      await page.setViewportSize({width, height: 900});
      for (const route of ['settings', 'history']) {
        await goto('/' + route);
        if (route === 'history') await page.waitForSelector('.history-row');
        await page.screenshot({path: path.join(os.tmpdir(), `tdm-review-${route}-${width}.png`), fullPage: true});
      }
    }
    await emit({...fixture, login: {activationCode: 'ABCD1234', activationUrl: 'https://www.twitch.tv/activate'}, canLogout: false});
    assert.equal(await page.locator('#auth-view').isVisible(), true);
    assert.equal(await page.locator('#activation-code').textContent(), 'ABCD1234');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    console.log('Passed: themes, queue states, pause, reconnect, empty state, failed artwork, live-update focus, settings save, game picker, search, detail navigation, authorization, and 42 responsive route checks, history filters and CSRF headers.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
