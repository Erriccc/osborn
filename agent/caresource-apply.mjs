import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  
  console.log('🌐 Navigating to CareSource...');
  await page.goto('https://caresource.wd1.myworkdayjobs.com/CareSource/job/Remote/AI-Developer_R10487/apply', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  
  console.log('📋 Clicking Apply Manually...');
  await page.click('text=Apply Manually');
  await page.waitForTimeout(3000);
  
  console.log('📧 Filling email...');
  const emailInput = await page.$('input[type="email"]');
  if (emailInput) {
    await emailInput.fill('osbornojure@gmail.com');
  }
  
  console.log('🔐 Filling passwords...');
  const passwordInputs = await page.$$('input[type="password"]');
  if (passwordInputs.length >= 2) {
    await passwordInputs[0].fill('workday2026!');
    await passwordInputs[1].fill('workday2026!');
  }
  
  await page.waitForTimeout(1000);
  await page.screenshot({ path: '/tmp/caresource-step1.png' });
  
  console.log('✅ Account form filled. Screenshot saved.');
  console.log('\n📝 Browser is now open. You can review before submitting.');
  console.log('Keep this window open and ready to proceed.\n');
})();
