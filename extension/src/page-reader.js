(() => {
  "use strict";

  const RESULT_ID = "internship-pilot-description-result";
  const REQUEST_EVENT = "internship-pilot-read-job-description";
  const RESULT_EVENT = "internship-pilot-job-description-ready";
  const SECTION_HEADING = /responsibilit|qualification|requirement|what you(?:'|’)?ll do|what you(?:'|’)?ll bring|about the role|the role|your impact|who you are|preferred/i;
  const RESPONSIBILITIES = /responsibilit|what you(?:'|’)?ll do|what you(?:'|’)?ll work on|about the role|^\s*role\s*:?\s*$|your impact|duties/i;
  const QUALIFICATIONS = /qualification|requirement|what you(?:'|’)?ll bring|what we look for|who you are|about you|preferred/i;
  const DANGEROUS_ACTION = /apply|submit|continue|next|sign in|log in|create account|upload|send/i;

  function clean(value) {
    return String(value || "").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }

  function visible(element) {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    return element.getClientRects().length > 0 && style.display !== "none" && style.visibility !== "hidden";
  }

  function buttonText(element) {
    return clean([
      element.textContent,
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
    ].filter(Boolean).join(" "));
  }

  async function expandSafeDescriptionSections() {
    const candidates = Array.from(document.querySelectorAll(
      "button[aria-expanded='false'], [role='button'][aria-expanded='false'], details:not([open]) > summary",
    )).filter(visible);
    let expanded = 0;
    for (const control of candidates) {
      const label = buttonText(control);
      if (!SECTION_HEADING.test(label) || DANGEROUS_ACTION.test(label)) continue;
      control.click();
      expanded += 1;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return expanded;
  }

  function listItemsWithinSection(heading) {
    const items = [];
    let node = heading.nextElementSibling;
    while (node && !/^H[1-6]$/.test(node.tagName)) {
      if (visible(node)) {
        const listItems = Array.from(node.querySelectorAll("li")).filter(visible);
        if (listItems.length) {
          for (const item of listItems) {
            const text = clean(item.innerText || item.textContent);
            if (text) items.push(text);
          }
        } else {
          const text = clean(node.innerText || node.textContent);
          if (text && text.length <= 1_000) items.push(text);
        }
      }
      node = node.nextElementSibling;
    }
    return items;
  }

  function unique(items) {
    return Array.from(new Set(items.map(clean).filter(Boolean))).slice(0, 200);
  }

  async function readJobDescription() {
    const expandedSections = await expandSafeDescriptionSections();
    const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6, [role='heading']"))
      .filter(visible);
    const responsibilities = [];
    const qualifications = [];
    for (const heading of headings) {
      const label = clean(heading.innerText || heading.textContent);
      if (RESPONSIBILITIES.test(label)) responsibilities.push(...listItemsWithinSection(heading));
      if (QUALIFICATIONS.test(label)) qualifications.push(...listItemsWithinSection(heading));
    }

    const preferredRoot = [
      "[data-qa='job-description']",
      "[data-testid*='job-description' i]",
      "[class*='job-description' i]",
      "[class*='job__description' i]",
      "[class*='posting-page' i]",
      "main",
      "article",
      "[role='main']",
    ].map((selector) => document.querySelector(selector)).find((element) => element && visible(element));
    const description = clean((preferredRoot || document.body)?.innerText || "");
    const title = clean(
      document.querySelector("h1")?.textContent
      || document.querySelector("meta[property='og:title']")?.getAttribute("content")
      || document.title,
    );

    return {
      sourceUrl: location.href,
      title,
      description,
      responsibilities: unique(responsibilities),
      qualifications: unique(qualifications),
      expandedSections,
      capturedAt: new Date().toISOString(),
    };
  }

  async function publishResult() {
    let element = document.getElementById(RESULT_ID);
    if (!element) {
      element = document.createElement("script");
      element.id = RESULT_ID;
      element.type = "application/json";
      element.hidden = true;
      document.documentElement.appendChild(element);
    }
    try {
      element.textContent = JSON.stringify(await readJobDescription());
      element.setAttribute("data-status", "ready");
    } catch (error) {
      element.textContent = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
      element.setAttribute("data-status", "error");
    }
    document.dispatchEvent(new CustomEvent(RESULT_EVENT));
  }

  globalThis.InternshipPilotPageReader = { readJobDescription, publishResult };
  document.documentElement.setAttribute("data-internship-pilot-description-reader", "ready");
  document.addEventListener(REQUEST_EVENT, () => void publishResult());
})();
