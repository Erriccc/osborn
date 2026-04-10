const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  
  await page.goto('https://caresource.wd1.myworkdayjobs.com/CareSource/job/Remote/AI-Developer_R10487/apply', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  
  // Click Apply Manually
  console.log('Clicking Apply Manually...');
  await page.click('text=Apply Manually');
  await page.waitForTimeout(3000);
  
  // Fill in email
  console.log('Filling email field...');
  const emailInput = await page.$('input[type="email"]');
  if (emailInput) {
    await emailInput.fill('osbornojure@gmail.com');
    console.log('Email filled: osbornojure@gmail.com');
  }
  
  // Fill in password
  console.log('Filling password fields...');
  const passwordInputs = await page.$$('input[type="password"]');
  if (passwordInputs.length >= 2) {
    await passwordInputs[0].fill('workday2026!');
    await passwordInputs[1].fill('workday2026!');
    console.log('Passwords filled');
  }
  
  await page.waitForTimeout(1000);
  
  // Click Create Account
  const createBtn = await page.$('text=Create Account');
  if (createBtn) {
    console.log('Clicking Create Account...');
    await createBtn.click();
    await page.waitForTimeout(3000);
  }
  
  // Take screenshot
  await page.screenshot({ path: '/tmp/caresource-step1.png' });
  console.log('Screenshot saved to /tmp/caresource-step1.png');
  
  // Get current page text
  const text = await page.evaluate(() => document.body.innerText);
  console.log('\n--- PAGE CONTENT ---');
  console.log(text);
})();
