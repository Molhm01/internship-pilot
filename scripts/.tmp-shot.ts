import { chromium } from "playwright";
async function main() {
  const URL = process.argv[2]; const OUT = process.argv[3]; const W = Number(process.argv[4] ?? 1440);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: 1000 }, deviceScaleFactor: 1.5 });
  const errs: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  page.on("pageerror", (e) => errs.push(e.message));
  const res = await page.goto(URL, { waitUntil: "networkidle", timeout: 30000 });
  // scroll through so in-view reveals fire, then return to top
  await page.evaluate(async () => {
    const h = document.body.scrollHeight;
    for (let y = 0; y < h; y += 600) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 60)); }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: OUT, fullPage: true });
  await browser.close();
  console.log(`status=${res?.status()} -> ${OUT}`);
  console.log(errs.length ? "ERRORS:\n" + errs.join("\n") : "no console errors");
}
main();
