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
  
  console.log('🔐 Filling password with correct format: Workday2026!');
  const passwordInputs = await page.$$('input[type="password"]');
  if (passwordInputs.length >= 2) {
    await passwordInputs[0].fill('Workday2026!');
    await passwordInputs[1].fill('Workday2026!');
  }
  
  await page.waitForTimeout(1000);
  
  // Click Create Account button
  console.log('✅ Clicking Create Account...');
  const createBtn = await page.$('text=Create Account');
  if (createBtn) {
    await createBtn.click();
    await page.waitForTimeout(4000);
  }
  
  console.log('📸 Taking screenshot of next step...');
  await page.screenshot({ path: '/tmp/caresource-step2.png' });
  
  // Get page content
  const text = await page.evaluate(() => document.body.innerText);
  console.log('\n--- PAGE CONTENT ---');
  console.log(text.substring(0, 1500));
})();
