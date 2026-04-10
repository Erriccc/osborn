import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  
  console.log('🌐 Navigating to CareSource form...');
  await page.goto('https://caresource.wd1.myworkdayjobs.com/CareSource/job/Remote/AI-Developer_R10487/apply', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);
  
  // Fill step 2 form fields
  console.log('📝 Filling step 2: My Information...\n');
  
  // How Did You Hear About Us? - select "Job Board"
  console.log('• Setting: How Did You Hear About Us?');
  const hearAboutDropdown = await page.$('[aria-label*="How Did You Hear"]');
  if (hearAboutDropdown) {
    await hearAboutDropdown.click();
    await page.waitForTimeout(500);
    const jobBoardOption = await page.$('text=Job Board');
    if (jobBoardOption) await jobBoardOption.click();
  }
  
  // Legal Name
  console.log('• Setting: First Name = Osborn');
  const firstNameInput = await page.$('input[aria-label*="First Name"]');
  if (firstNameInput) await firstNameInput.fill('Osborn');
  
  console.log('• Setting: Last Name = Ojure');
  const lastNameInput = await page.$('input[aria-label*="Last Name"]');
  if (lastNameInput) await lastNameInput.fill('Ojure');
  
  // Address
  console.log('• Setting: Address Line 1');
  const addressInput = await page.$('input[aria-label*="Address Line 1"]');
  if (addressInput) await addressInput.fill('Chicago, IL');
  
  console.log('• Setting: City = Chicago');
  const cityInput = await page.$('input[aria-label*="City"]');
  if (cityInput) await cityInput.fill('Chicago');
  
  console.log('• Setting: State = Illinois');
  const stateDropdown = await page.$('[aria-label*="State"]');
  if (stateDropdown) {
    await stateDropdown.click();
    await page.waitForTimeout(300);
    const ilOption = await page.$('text=Illinois');
    if (ilOption) await ilOption.click();
  }
  
  console.log('• Setting: Postal Code = 60601');
  const postalInput = await page.$('input[aria-label*="Postal Code"]');
  if (postalInput) await postalInput.fill('60601');
  
  console.log('• Phone Number = 312-718-5561');
  const phoneInput = await page.$('input[aria-label*="Phone Number"]');
  if (phoneInput) await phoneInput.fill('3127185561');
  
  await page.waitForTimeout(2000);
  
  // Take screenshot
  console.log('\n✅ Step 2 form filled. Taking screenshot...\n');
  await page.screenshot({ path: '/tmp/caresource-step2-filled.png' });
  
  const text = await page.evaluate(() => document.body.innerText);
  console.log('--- FORM STATE ---');
  console.log(text.substring(0, 800));
})();
