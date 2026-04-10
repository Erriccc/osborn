import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  
  console.log('🌐 Navigating to CareSource application form...');
  await page.goto('https://caresource.wd1.myworkdayjobs.com/CareSource/job/Remote/AI-Developer_R10487/apply', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  
  console.log('📋 Clicking Apply Manually...');
  await page.click('text=Apply Manually');
  await page.waitForTimeout(3000);
  
  console.log('📧 Filling email: osbornojure@gmail.com');
  const emailInput = await page.$('input[type="email"]');
  if (emailInput) {
    await emailInput.fill('osbornojure@gmail.com');
  }
  
  console.log('🔐 Filling password: workday2026!');
  const passwordInputs = await page.$$('input[type="password"]');
  if (passwordInputs.length >= 2) {
    await passwordInputs[0].fill('workday2026!');
    await passwordInputs[1].fill('workday2026!');
  }
  
  console.log('✅ Form filled. Taking screenshot...');
  await page.screenshot({ path: '/tmp/caresource-filled-form.png' });
  
  console.log('\n📸 Screenshot saved to /tmp/caresource-filled-form.png');
  console.log('Ready to proceed. The browser window is open.\n');
  
  // Keep browser open
  await page.waitForTimeout(2000);
})();
