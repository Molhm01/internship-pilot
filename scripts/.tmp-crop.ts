import { chromium } from "playwright";
async function main() {
  const URL = process.argv[2]; const OUT = process.argv[3]; const W = Number(process.argv[4] ?? 1440);
  const H = Number(process.argv[5] ?? 900); const Y = Number(process.argv[6] ?? 0);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
  await page.goto(URL, { waitUntil: "networkidle", timeout: 30000 });
  await page.evaluate(async (y) => {
    const h = document.body.scrollHeight;
    for (let i = 0; i < h; i += 600) { window.scrollTo(0, i); await new Promise(r => setTimeout(r, 50)); }
    window.scrollTo(0, y);
  }, Y);
  await page.waitForTimeout(1400);
  await page.screenshot({ path: OUT });
  await browser.close();
  console.log(`-> ${OUT}`);
}
main();
