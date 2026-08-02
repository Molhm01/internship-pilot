import { afterEach, describe, expect, it } from "vitest";
import { isSingleUserMode, isWebsiteAuthEnabled } from "./singleUser";

const ORIGINAL = process.env.INTERNSHIP_PILOT_SINGLE_USER;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.INTERNSHIP_PILOT_SINGLE_USER;
  else process.env.INTERNSHIP_PILOT_SINGLE_USER = ORIGINAL;
});

describe("local single-user mode", () => {
  it("is on by default, so an unset variable never locks the user out of their profile", () => {
    delete process.env.INTERNSHIP_PILOT_SINGLE_USER;
    expect(isSingleUserMode()).toBe(true);
    expect(isWebsiteAuthEnabled()).toBe(false);
  });

  it("stays on for an empty value rather than failing towards a login", () => {
    process.env.INTERNSHIP_PILOT_SINGLE_USER = "";
    expect(isSingleUserMode()).toBe(true);
  });

  it("is on for every affirmative spelling", () => {
    for (const value of ["true", "TRUE", "1", "yes", "on"]) {
      process.env.INTERNSHIP_PILOT_SINGLE_USER = value;
      expect(isSingleUserMode(), value).toBe(true);
    }
  });

  it("turns off only when explicitly asked to", () => {
    for (const value of ["false", "FALSE", "0", "no", "off"]) {
      process.env.INTERNSHIP_PILOT_SINGLE_USER = value;
      expect(isSingleUserMode(), value).toBe(false);
      expect(isWebsiteAuthEnabled(), value).toBe(true);
    }
  });

  it("treats website auth as the exact inverse, never both or neither", () => {
    for (const value of ["true", "false", "", "nonsense"]) {
      process.env.INTERNSHIP_PILOT_SINGLE_USER = value;
      expect(isSingleUserMode()).toBe(!isWebsiteAuthEnabled());
    }
  });
});
