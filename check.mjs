import { chromium } from 'playwright';
import fs from 'node:fs';

const CITY = process.env.DTEK_CITY || '';
const STREET = process.env.DTEK_STREET || '';
const HOUSE = process.env.DTEK_HOUSE || '';

if (!CITY || !STREET || !HOUSE) {
  console.error('Missing DTEK_CITY, DTEK_STREET, or DTEK_HOUSE secrets');
  process.exit(1);
}

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
});

const context = await browser.newContext({
  locale: 'uk-UA',
  timezoneId: 'Europe/Kyiv',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
});

const page = await context.newPage();
await page.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});

let ajaxRes = null;

try {
  for (let attempt = 1; attempt <= 2; attempt++) {
    await page.goto('https://www.dtek-krem.com.ua/ua/shutdowns', {
      waitUntil: 'domcontentloaded',
      timeout: 45000
    });
    try {
      await page.waitForSelector('meta[name="csrf-token"]', { state: 'attached', timeout: 25000 });
      break;
    } catch {
      if (attempt === 2) throw new Error('WAF challenge did not resolve (no csrf-token)');
      await page.waitForTimeout(3000);
    }
  }

  ajaxRes = await page.evaluate(async ({ city, street }) => {
    const csrf = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';
    const updateFact = window.DisconSchedule?.fact?.update || '';
    const params = new URLSearchParams();
    params.append('method', 'getHomeNum');
    params.append('data[0][name]', 'city');
    params.append('data[0][value]', city);
    params.append('data[1][name]', 'street');
    params.append('data[1][value]', street);
    if (updateFact) {
      params.append('data[2][name]', 'updateFact');
      params.append('data[2][value]', updateFact);
    }

    const res = await fetch('/ua/ajax', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRF-Token': csrf
      },
      body: params.toString()
    });
    const text = await res.text();
    return { status: res.status, text };
  }, { city: CITY, street: STREET });
} finally {
  await browser.close();
}

if (!ajaxRes || ajaxRes.status !== 200) {
  console.error('AJAX failed, HTTP:', ajaxRes?.status);
  process.exit(1);
}

const json = JSON.parse(ajaxRes.text);
const houseData = json?.data?.[HOUSE];

if (!houseData) {
  console.error('House key not found in response. Available keys count:', Object.keys(json?.data || {}).length);
  process.exit(1);
}

const subType = String(houseData.sub_type || '').trim();
const startDate = String(houseData.start_date || '').trim();
const endDate = String(houseData.end_date || '').trim();
const typeCode = String(houseData.type || '').trim();
const updated = String(json.updateTimestamp || '').trim();

const low = subType.toLowerCase();
const isEmerg =
  typeCode === '2' ||
  low.includes('екстре') ||
  low.includes('аварій') ||
  low.includes('без застосування графіку');

const nextState = {
  ok: 1,
  emerg: isEmerg ? 1 : 0,
  type: typeCode,
  reason: subType,
  start: startDate,
  end: endDate,
  updated
};

let prevState = null;
if (fs.existsSync('status.json')) {
  try { prevState = JSON.parse(fs.readFileSync('status.json', 'utf8')); } catch {}
}

const changed =
  !prevState ||
  prevState.emerg !== nextState.emerg ||
  prevState.reason !== nextState.reason ||
  prevState.start !== nextState.start ||
  prevState.end !== nextState.end;

if (changed) {
  fs.writeFileSync('status.json', JSON.stringify(nextState, null, 2) + '\n', 'utf8');
  console.log('Status changed and saved:', JSON.stringify(nextState));
} else {
  console.log('No status change. Current:', JSON.stringify({ emerg: nextState.emerg, start: nextState.start, end: nextState.end }));
}
