'use strict';

// Inspect the official page only. Never interact with a challenge or its answer.
async function needsVerification(page, profile) {
  for (const selector of profile.verification_selectors || []) {
    if (await page.locator(selector).first().isVisible().catch(() => false)) return true;
  }
  return false;
}

module.exports = { needsVerification };
