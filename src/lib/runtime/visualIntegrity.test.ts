import { describe, expect, it } from "vitest";

import {
  assertVisualIntegrity,
  isBrowserDefaultLinkColor,
  looksLikeUnstyledFont,
  parseCssColor,
  type VisualSnapshot,
} from "@/lib/runtime/visualIntegrity";

/**
 * The reference failure: a Next process whose stylesheet and chunks 500'd, so
 * the browser painted raw HTML. Every assertion below is calibrated so that a
 * correctly styled page passes and that page does not.
 */

function styledPage(overrides: Partial<VisualSnapshot> = {}): VisualSnapshot {
  return {
    route: "/dashboard",
    viewport: { width: 1280, height: 900 },
    body: {
      fontFamily: '"Geist Sans", ui-sans-serif, system-ui, sans-serif',
      backgroundColor: "rgb(10, 12, 15)",
      color: "rgb(237, 238, 240)",
      marginTop: 0,
      marginLeft: 0,
    },
    sidebar: { display: "flex", box: { width: 216, height: 900 } },
    navList: { listStyleType: "none" },
    navLink: { color: "rgb(160, 165, 172)", textDecorationLine: "none", display: "flex" },
    logo: { width: 20, height: 20 },
    main: { present: true, visible: true, box: { width: 1064, height: 900 } },
    landmarks: [],
    ...overrides,
  };
}

/** What the browser actually rendered during the reported Windows failure. */
function unstyledPage(): VisualSnapshot {
  return {
    route: "/dashboard",
    viewport: { width: 1280, height: 900 },
    body: {
      fontFamily: '"Times New Roman"',
      backgroundColor: "rgba(0, 0, 0, 0)",
      color: "rgb(0, 0, 0)",
      marginTop: 8,
      marginLeft: 8,
    },
    sidebar: { display: "block", box: { width: 1280, height: 4200 } },
    navList: { listStyleType: "disc" },
    navLink: { color: "rgb(0, 0, 238)", textDecorationLine: "underline", display: "inline" },
    logo: { width: 1264, height: 1264 },
    main: { present: true, visible: true, box: { width: 1264, height: 4000 } },
    landmarks: [],
  };
}

describe("catastrophic visual regression", () => {
  it("passes a correctly styled application page", () => {
    expect(assertVisualIntegrity(styledPage())).toEqual([]);
  });

  it("catches the raw-HTML failure on every independent signal", () => {
    const checks = assertVisualIntegrity(unstyledPage()).map((violation) => violation.check);
    expect(checks).toContain("body font");
    expect(checks).toContain("body background");
    expect(checks).toContain("body layout");
    expect(checks).toContain("sidebar layout");
    expect(checks).toContain("sidebar width");
    expect(checks).toContain("sidebar list");
    expect(checks).toContain("nav link colour");
    expect(checks).toContain("nav link decoration");
    expect(checks).toContain("logo size");
  });

  it("flags the giant logo specifically, even when everything else is styled", () => {
    const violations = assertVisualIntegrity(styledPage({ logo: { width: 900, height: 700 } }));
    expect(violations).toHaveLength(1);
    expect(violations[0]!.check).toBe("logo size");
  });

  it("flags a mark that is within absolute bounds but still swallows the viewport", () => {
    const violations = assertVisualIntegrity(
      styledPage({ viewport: { width: 800, height: 600 }, logo: { width: 400, height: 220 } }),
    );
    expect(violations.map((violation) => violation.check)).toContain("logo size");
  });

  it("flags a collapsed or absent main region", () => {
    expect(
      assertVisualIntegrity(styledPage({ main: { present: true, visible: false, box: { width: 1064, height: 900 } } }))
        .map((violation) => violation.check),
    ).toContain("main content");
    expect(
      assertVisualIntegrity(styledPage({ main: { present: true, visible: true, box: { width: 120, height: 900 } } }))
        .map((violation) => violation.check),
    ).toContain("main content");
  });

  it("reports a missing route landmark, such as the Discover header on /jobs", () => {
    const violations = assertVisualIntegrity(
      styledPage({
        route: "/jobs",
        landmarks: [
          { name: "Discover heading", visible: false },
          { name: "job feed container", visible: true },
        ],
      }),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]!.check).toBe("landmark Discover heading");
  });

  it("does not require a sidebar on routes that legitimately have none", () => {
    expect(
      assertVisualIntegrity(styledPage({ route: "/login", sidebar: null, navList: null, navLink: null })),
    ).toEqual([]);
  });

  it("accepts a light-theme page as readily as a dark one", () => {
    expect(
      assertVisualIntegrity(
        styledPage({
          body: {
            fontFamily: '"Geist Sans", sans-serif',
            backgroundColor: "rgb(251, 251, 252)",
            color: "rgb(23, 24, 28)",
            marginTop: 0,
            marginLeft: 0,
          },
        }),
      ),
    ).toEqual([]);
  });

  it("catches text painted the same colour as its background", () => {
    const violations = assertVisualIntegrity(
      styledPage({
        body: {
          fontFamily: '"Geist Sans", sans-serif',
          backgroundColor: "rgb(10, 12, 15)",
          color: "rgb(12, 14, 17)",
          marginTop: 0,
          marginLeft: 0,
        },
      }),
    );
    expect(violations.map((violation) => violation.check)).toContain("body contrast");
  });
});

describe("style primitives", () => {
  it("parses the colour forms a browser reports", () => {
    expect(parseCssColor("rgb(10, 12, 15)")).toEqual({ r: 10, g: 12, b: 15, a: 1 });
    expect(parseCssColor("rgba(0, 0, 0, 0)")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(parseCssColor("#0a0c0f")).toEqual({ r: 10, g: 12, b: 15, a: 1 });
    expect(parseCssColor("#abc")).toEqual({ r: 170, g: 187, b: 204, a: 1 });
    expect(parseCssColor("transparent")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(parseCssColor("not a colour")).toBeNull();
  });

  it("recognises the browser default link colours and not the app's own", () => {
    expect(isBrowserDefaultLinkColor("rgb(0, 0, 238)")).toBe(true);
    expect(isBrowserDefaultLinkColor("rgb(85, 26, 139)")).toBe(true);
    expect(isBrowserDefaultLinkColor("rgb(160, 165, 172)")).toBe(false);
    // An app accent that is genuinely blue must not be mistaken for the default.
    expect(isBrowserDefaultLinkColor("rgb(96, 165, 250)")).toBe(false);
  });

  it("recognises a serif fallback as proof the app font never loaded", () => {
    expect(looksLikeUnstyledFont('"Times New Roman"')).toBe(true);
    expect(looksLikeUnstyledFont("serif")).toBe(true);
    expect(looksLikeUnstyledFont("")).toBe(true);
    expect(looksLikeUnstyledFont('"Geist Sans", ui-sans-serif, system-ui')).toBe(false);
    expect(looksLikeUnstyledFont("system-ui, sans-serif")).toBe(false);
  });
});
