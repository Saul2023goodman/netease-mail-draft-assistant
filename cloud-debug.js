const { chromium } = require('playwright');

const state = {
  phase: 'idle',
  url: '',
  title: '',
  lastAction: '',
  lastError: '',
  updatedAt: new Date().toISOString(),
  browserReady: false,
  verificationRequired: false
};

let browser = null;
let context = null;
let page = null;

function touch(patch = {}) {
  Object.assign(state, patch, { updatedAt: new Date().toISOString() });
  return getState();
}

function getState() {
  return { ...state };
}

async function refreshMeta() {
  if (!page) return getState();
  try { state.url = page.url(); } catch (_) {}
  try { state.title = await page.title(); } catch (_) {}
  state.updatedAt = new Date().toISOString();
  return getState();
}

async function ensureBrowser() {
  if (page && !page.isClosed()) return page;

  touch({ phase: 'starting_browser', lastAction: 'launch Chromium', lastError: '', verificationRequired: false });
  browser = await chromium.launch({
    headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai'
  });

  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    } catch (_) {}
  });

  page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.setDefaultNavigationTimeout(20000);

  page.on('console', msg => console.log(`[browser:${msg.type()}] ${msg.text()}`));
  page.on('pageerror', err => console.error('[browser:pageerror]', err.message));
  page.on('requestfailed', req => console.warn('[browser:requestfailed]', req.url(), req.failure()?.errorText || ''));

  touch({ phase: 'browser_ready', browserReady: true, lastAction: 'Chromium ready' });
  return page;
}

async function visibleLocator(frame, selectors) {
  for (const selector of selectors) {
    try {
      const locator = frame.locator(selector).first();
      if (await locator.count() && await locator.isVisible()) return locator;
    } catch (_) {}
  }
  return null;
}

async function clickPasswordLoginMode() {
  const candidates = [
    'text=密码登录',
    'text=账号密码登录',
    'text=使用密码登录',
    '[data-logintype="password"]',
    '[class*="password"]'
  ];
  for (const frame of page.frames()) {
    const locator = await visibleLocator(frame, candidates);
    if (locator) {
      try { await locator.click({ timeout: 2500 }); return true; } catch (_) {}
    }
  }
  return false;
}

async function locateCredentialsFrame() {
  const emailSelectors = [
    'input[name="email"]',
    'input[name="username"]',
    'input[type="email"]',
    'input[id*="account"]',
    'input[placeholder*="邮箱"]',
    'input[placeholder*="帐号"]',
    'input[placeholder*="账号"]'
  ];
  const passwordSelectors = [
    'input[name="password"]',
    'input[type="password"]',
    'input[id*="password"]',
    'input[placeholder*="密码"]'
  ];

  for (const frame of page.frames()) {
    const email = await visibleLocator(frame, emailSelectors);
    const password = await visibleLocator(frame, passwordSelectors);
    if (email && password) return { frame, email, password };
  }
  return null;
}

async function clickLoginButton(frame) {
  const selectors = [
    '#dologin',
    '.u-loginbtn',
    'button[type="submit"]',
    'input[type="submit"]',
    'a[id*="login"]',
    'button:has-text("登录")',
    'a:has-text("登录")'
  ];
  const locator = await visibleLocator(frame, selectors);
  if (!locator) return false;
  await locator.click();
  return true;
}

function isMailboxLoggedInUrl(url = '') {
  return /mail\.163\.com\/(js\d|main|entry|webmail)/i.test(url) || /main\.jsp/i.test(url);
}

async function detectMailboxState() {
  await refreshMeta();
  const frames = page ? page.frames() : [];
  const urls = [
    state.url || '',
    ...frames.map(frame => {
      try { return frame.url() || ''; } catch (_) { return ''; }
    })
  ];
  if (urls.some(isMailboxLoggedInUrl)) return 'logged_in';

  let verificationRequired = false;
  for (const frame of frames) {
    let body = '';
    try { body = await frame.locator('body').innerText({ timeout: 1500 }); } catch (_) {}
    if (/收件箱/.test(body) && /写信/.test(body)) return 'logged_in';
    if (/验证码|安全验证|滑块|人机验证|完成验证|请验证/i.test(body)) verificationRequired = true;
  }
  return verificationRequired ? 'verification_required' : 'unknown';
}

async function waitForMailboxState(timeoutMs = 30000) {
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs || 0));
  let detected = 'unknown';
  while (Date.now() < deadline) {
    detected = await detectMailboxState();
    if (detected !== 'unknown') return detected;
    touch({ phase: 'awaiting_login_result', lastAction: 'wait for login result' });
    await page.waitForTimeout(1000);
  }
  return detected;
}

async function startLogin() {
  const email = process.env.NETEASE_DEBUG_EMAIL || '';
  const password = process.env.NETEASE_DEBUG_PASSWORD || '';
  if (!email || !password) throw new Error('NETEASE_DEBUG_EMAIL / NETEASE_DEBUG_PASSWORD are not configured');

  await ensureBrowser();
  touch({ phase: 'opening_login', lastAction: 'open mail.163.com', lastError: '', verificationRequired: false });

  await page.goto('https://mail.163.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  let detected = await detectMailboxState();
  if (detected === 'logged_in') {
    touch({ phase: 'logged_in', lastAction: 'existing session detected' });
    return refreshMeta();
  }

  await clickPasswordLoginMode();
  await page.waitForTimeout(1200);

  const credentials = await locateCredentialsFrame();
  if (!credentials) {
    detected = await detectMailboxState();
    if (detected === 'verification_required') {
      touch({ phase: 'verification_required', verificationRequired: true, lastAction: 'verification detected' });
      return refreshMeta();
    }
    throw new Error('Could not find NetEase account/password fields');
  }

  touch({ phase: 'filling_credentials', lastAction: 'fill development account' });
  await credentials.email.fill(email);
  await credentials.password.fill(password);

  touch({ phase: 'submitting_login', lastAction: 'submit login' });
  const clicked = await clickLoginButton(credentials.frame);
  if (!clicked) throw new Error('Could not find NetEase login button');

  touch({ phase: 'awaiting_login_result', lastAction: 'wait for login result' });
  detected = await waitForMailboxState(30000);

  if (detected === 'logged_in') {
    touch({ phase: 'logged_in', verificationRequired: false, lastAction: 'login successful' });
  } else if (detected === 'verification_required') {
    touch({ phase: 'verification_required', verificationRequired: true, lastAction: 'manual verification required' });
  } else {
    touch({ phase: 'login_submitted', lastAction: 'login submitted; result needs inspection' });
  }
  return refreshMeta();
}

async function navigate(url) {
  await ensureBrowser();
  if (!/^https?:\/\//i.test(url || '')) throw new Error('Only public HTTP(S) URLs are allowed');
  touch({ phase: 'navigating', lastAction: `navigate ${url}`, lastError: '' });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  touch({ phase: 'browser_ready', lastAction: `navigated ${url}` });
  return refreshMeta();
}

async function click(x, y) {
  await ensureBrowser();
  const px = Number(x), py = Number(y);
  if (!Number.isFinite(px) || !Number.isFinite(py)) throw new Error('Invalid coordinates');
  await page.mouse.click(px, py);
  await page.waitForTimeout(500);
  touch({ lastAction: `click ${Math.round(px)},${Math.round(py)}` });
  return refreshMeta();
}

async function drag(startX, startY, endX, endY, duration = 600) {
  await ensureBrowser();
  const points = [startX, startY, endX, endY].map(Number);
  if (points.some(value => !Number.isFinite(value))) throw new Error('Invalid drag coordinates');

  const totalDuration = Math.min(2500, Math.max(250, Number(duration) || 600));
  const steps = Math.max(8, Math.ceil(totalDuration / 25));
  await page.mouse.move(points[0], points[1]);
  await page.mouse.down();
  try {
    for (let index = 1; index <= steps; index++) {
      const progress = index / steps;
      await page.mouse.move(
        points[0] + (points[2] - points[0]) * progress,
        points[1] + (points[3] - points[1]) * progress
      );
      await page.waitForTimeout(Math.max(4, Math.round(totalDuration / steps)));
    }
  } finally {
    await page.mouse.up();
  }
  await page.waitForTimeout(700);
  touch({ lastAction: 'manual drag' });
  return refreshMeta();
}

async function type(text) {
  await ensureBrowser();
  await page.keyboard.type(String(text || ''), { delay: 25 });
  touch({ lastAction: 'type text' });
  return refreshMeta();
}

async function press(key) {
  await ensureBrowser();
  await page.keyboard.press(String(key || ''));
  await page.waitForTimeout(250);
  touch({ lastAction: `press ${key}` });
  return refreshMeta();
}

async function screenshot() {
  await ensureBrowser();
  return page.screenshot({ type: 'png', fullPage: false });
}

async function reset() {
  if (browser) {
    try { await browser.close(); } catch (_) {}
  }
  browser = null;
  context = null;
  page = null;
  touch({
    phase: 'idle', url: '', title: '', lastAction: 'browser reset', lastError: '',
    browserReady: false, verificationRequired: false
  });
  return getState();
}

async function close() {
  if (browser) {
    try { await browser.close(); } catch (_) {}
  }
}

function captureError(error) {
  console.error('[cloud-debug]', error);
  touch({ phase: 'error', lastError: error?.message || String(error), lastAction: 'error' });
  return getState();
}

module.exports = {
  getState,
  ensureBrowser,
  startLogin,
  navigate,
  click,
  type,
  press,
  drag,
  screenshot,
  reset,
  close,
  captureError
};
