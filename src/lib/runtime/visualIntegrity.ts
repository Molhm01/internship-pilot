/**
 * Catastrophic visual-regression detection.
 *
 * A local Windows run produced a page that passed every check the browser
 * smoke had: the routes were not 404, not 500, and threw no page exception.
 * The page was still unusable — the stylesheet never loaded, so the sidebar
 * rendered as a bulleted list of default-blue underlined links and the product
 * mark, unconstrained by CSS, filled the viewport.
 *
 * These assertions describe the difference between "styled" and "raw HTML" in
 * terms the browser can measure, and deliberately stop there. They are not a
 * pixel baseline: the point is to catch a stylesheet or chunk that did not
 * load, not to fail a pull request that moved a button by three pixels.
 */

export type ElementBox = { width: number; height: number };

export type VisualSnapshot = {
  route: string;
  viewport: { width: number; height: number };
  body: {
    fontFamily: string;
    backgroundColor: string;
    color: string;
    /** Browser default is 8px on every side; a styled app resets it. */
    marginTop: number;
    marginLeft: number;
  };
  /** Present on authenticated app routes; null on marketing/auth pages. */
  sidebar: { display: string; box: ElementBox } | null;
  /** The nav's list container, if there is one. */
  navList: { listStyleType: string } | null;
  /** A representative in-app navigation link. */
  navLink: { color: string; textDecorationLine: string; display: string } | null;
  /** The product mark, wherever it appears on this route. */
  logo: ElementBox | null;
  main: { present: boolean; visible: boolean; box: ElementBox } | null;
  /** Route-specific landmarks that must be on screen. */
  landmarks: { name: string; visible: boolean; text?: string }[];
};

export type VisualViolation = { route: string; check: string; detail: string };

export type Rgba = { r: number; g: number; b: number; a: number };

export function parseCssColor(value: string): Rgba | null {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "transparent") return { r: 0, g: 0, b: 0, a: 0 };

  const rgb = trimmed.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.%]+))?\s*\)$/);
  if (rgb) {
    const alphaRaw = rgb[4];
    const alpha = alphaRaw === undefined ? 1 : alphaRaw.endsWith("%") ? Number.parseFloat(alphaRaw) / 100 : Number.parseFloat(alphaRaw);
    return {
      r: Number.parseFloat(rgb[1]!),
      g: Number.parseFloat(rgb[2]!),
      b: Number.parseFloat(rgb[3]!),
      a: Number.isFinite(alpha) ? alpha : 1,
    };
  }

  const hex = trimmed.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (hex) {
    const digits = hex[1]!;
    const full = digits.length === 3 ? digits.split("").map((digit) => digit + digit).join("") : digits;
    return {
      r: Number.parseInt(full.slice(0, 2), 16),
      g: Number.parseInt(full.slice(2, 4), 16),
      b: Number.parseInt(full.slice(4, 6), 16),
      a: 1,
    };
  }
  return null;
}

/** The colour Chrome paints an unstyled `<a href>`: #0000EE. */
export function isBrowserDefaultLinkColor(value: string): boolean {
  const color = parseCssColor(value);
  if (!color) return false;
  // Also covers the visited default (#551A8B) — either one means no stylesheet.
  const isDefaultBlue = color.r < 40 && color.g < 40 && color.b > 180;
  const isDefaultVisited = Math.abs(color.r - 85) < 20 && Math.abs(color.g - 26) < 20 && Math.abs(color.b - 139) < 25;
  return isDefaultBlue || isDefaultVisited;
}

/**
 * A serif computed family means the app font never loaded. Geist ships as a
 * CSS variable, so an unstyled document falls back to the browser default,
 * which is Times on every platform this runs on.
 */
export function looksLikeUnstyledFont(fontFamily: string): boolean {
  const first = fontFamily.split(",")[0]?.trim().replace(/^["']|["']$/g, "").toLowerCase() ?? "";
  if (!first) return true;
  return /^(times|times new roman|serif|georgia|garamond|ui-serif)$/.test(first);
}

const SIDEBAR_MIN_WIDTH = 40;
const SIDEBAR_MAX_WIDTH = 420;
const LOGO_MAX_WIDTH = 420;
const LOGO_MAX_HEIGHT = 220;
/** A mark that covers this much of the viewport is the unstyled-SVG failure. */
const LOGO_MAX_VIEWPORT_SHARE = 0.12;
const MAIN_MIN_WIDTH = 320;

export function assertVisualIntegrity(snapshot: VisualSnapshot): VisualViolation[] {
  const violations: VisualViolation[] = [];
  const fail = (check: string, detail: string) => violations.push({ route: snapshot.route, check, detail });

  // --- body ---------------------------------------------------------------
  if (looksLikeUnstyledFont(snapshot.body.fontFamily)) {
    fail("body font", `computed font-family is "${snapshot.body.fontFamily}" — the app sans stack never applied.`);
  }

  const background = parseCssColor(snapshot.body.backgroundColor);
  if (!background || background.a === 0) {
    fail(
      "body background",
      `computed background-color is "${snapshot.body.backgroundColor}" — an unpainted body means the design-system tokens did not load.`,
    );
  }

  const text = parseCssColor(snapshot.body.color);
  if (background && text && background.a > 0) {
    // Not a contrast audit — just proof the two are not the same paint.
    const distance = Math.abs(background.r - text.r) + Math.abs(background.g - text.g) + Math.abs(background.b - text.b);
    if (distance < 60) fail("body contrast", `text colour ${snapshot.body.color} is indistinguishable from the background ${snapshot.body.backgroundColor}.`);
  }

  if (snapshot.body.marginTop >= 8 && snapshot.body.marginLeft >= 8) {
    fail(
      "body layout",
      `body kept the browser default margin (${snapshot.body.marginLeft}px/${snapshot.body.marginTop}px) — no CSS reset applied.`,
    );
  }

  // --- sidebar ------------------------------------------------------------
  if (snapshot.sidebar) {
    const { display, box } = snapshot.sidebar;
    if (display === "inline" || display === "block") {
      fail("sidebar layout", `sidebar computed display is "${display}" — expected a flex column from the app shell.`);
    }
    if (box.width < SIDEBAR_MIN_WIDTH || box.width > SIDEBAR_MAX_WIDTH) {
      fail("sidebar width", `sidebar rendered ${Math.round(box.width)}px wide, outside the expected ${SIDEBAR_MIN_WIDTH}–${SIDEBAR_MAX_WIDTH}px range.`);
    }
    if (box.width >= snapshot.viewport.width * 0.6) {
      fail("sidebar width", `sidebar occupies ${Math.round((box.width / snapshot.viewport.width) * 100)}% of the viewport — the layout collapsed.`);
    }
  }

  if (snapshot.navList && /^(disc|circle|square|decimal)$/.test(snapshot.navList.listStyleType)) {
    fail(
      "sidebar list",
      `navigation list renders with browser-default bullets (list-style-type: ${snapshot.navList.listStyleType}).`,
    );
  }

  // --- navigation links ---------------------------------------------------
  if (snapshot.navLink) {
    if (isBrowserDefaultLinkColor(snapshot.navLink.color)) {
      fail("nav link colour", `navigation links render in the browser default link colour (${snapshot.navLink.color}).`);
    }
    if (snapshot.navLink.textDecorationLine.includes("underline")) {
      fail("nav link decoration", "navigation links render underlined, which the design system never does.");
    }
    if (snapshot.navLink.display === "inline") {
      fail("nav link layout", 'navigation links compute display:inline — the app styles them as flex rows.');
    }
  }

  // --- logo ---------------------------------------------------------------
  if (snapshot.logo) {
    const viewportArea = snapshot.viewport.width * snapshot.viewport.height;
    const logoArea = snapshot.logo.width * snapshot.logo.height;
    if (snapshot.logo.width > LOGO_MAX_WIDTH || snapshot.logo.height > LOGO_MAX_HEIGHT) {
      fail(
        "logo size",
        `product mark rendered ${Math.round(snapshot.logo.width)}×${Math.round(snapshot.logo.height)}px, far beyond its styled size — the SVG is unconstrained.`,
      );
    } else if (viewportArea > 0 && logoArea / viewportArea > LOGO_MAX_VIEWPORT_SHARE) {
      fail("logo size", `product mark covers ${Math.round((logoArea / viewportArea) * 100)}% of the viewport.`);
    }
  }

  // --- main content -------------------------------------------------------
  if (snapshot.main) {
    if (!snapshot.main.present) fail("main content", "no #main landmark was rendered.");
    else if (!snapshot.main.visible) fail("main content", "#main exists but is not visible.");
    else if (snapshot.main.box.width < MAIN_MIN_WIDTH) {
      fail("main content", `#main rendered only ${Math.round(snapshot.main.box.width)}px wide.`);
    }
  }

  // --- route landmarks ----------------------------------------------------
  for (const landmark of snapshot.landmarks) {
    if (!landmark.visible) fail(`landmark ${landmark.name}`, `${landmark.name} is missing or not visible on this route.`);
  }

  return violations;
}
