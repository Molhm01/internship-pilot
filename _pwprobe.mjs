import { chromium } from "playwright";

const target = process.argv[2] ?? "https://careers.gf.com/careers?query=intern";
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  const seen = [];
  page.on("response", async (res) => {
    const url = res.url();
    const type = res.request().resourceType();
    if (type !== "xhr" && type !== "fetch") return;
    let len = 0;
    let sample = "";
    try {
      const body = await res.text();
      len = body.length;
      sample = body.slice(0, 300).replace(/\s+/g, " ");
    } catch {
      /* stream */
    }
    seen.push({ status: res.status(), url, len, sample });
  });
  await page.goto(target, { waitUntil: "networkidle", timeout: 45000 });
  await page.waitForTimeout(3000);

  for (const r of seen) {
    console.log(`${r.status} len=${r.len} ${r.url.slice(0, 220)}`);
    if (r.len > 0 && r.len < 100000 && /json/.test(r.sample.slice(0, 5) + "{")) {
      console.log("    ", r.sample.slice(0, 260));
    }
  }
  console.log("\n--- rendered anchors ---");
  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a[href]"))
      .map((a) => a.getAttribute("href"))
      .filter((h) => h && /pid=|\/job\//i.test(h))
      .slice(0, 15),
  );
  console.log(links.join("\n"));
} finally {
  await browser.close();
}
