import { describe, it, expect } from "vitest";
import { authErrorMessage, validateAuthInput } from "./errorMessages";
import { MINIMUM_PASSWORD_LENGTH } from "./password";

describe("authErrorMessage — maps server errors to clear, safe messages", () => {
  it("duplicate email → log in instead", () => {
    expect(authErrorMessage({ code: "USER_ALREADY_EXISTS", status: 422 }, "signup")).toMatch(/already has an Internship Pilot account/i);
    expect(authErrorMessage({ code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" }, "signup")).toMatch(/log in instead/i);
  });

  it("invalid email", () => {
    expect(authErrorMessage({ code: "INVALID_EMAIL" })).toMatch(/valid email/i);
  });

  it("password too short quotes the minimum", () => {
    expect(authErrorMessage({ code: "PASSWORD_TOO_SHORT" })).toContain(String(MINIMUM_PASSWORD_LENGTH));
  });

  it("wrong credentials → generic 'incorrect' (no user enumeration)", () => {
    expect(authErrorMessage({ code: "INVALID_EMAIL_OR_PASSWORD", status: 401 }, "login")).toMatch(/incorrect email or password/i);
    expect(authErrorMessage({ code: "INVALID_PASSWORD" }, "login")).toMatch(/incorrect email or password/i);
  });

  it("invalid origin → temporary unavailable, reload", () => {
    expect(authErrorMessage({ code: "INVALID_ORIGIN", status: 403 })).toMatch(/temporarily unavailable/i);
  });

  it("5xx → account service temporarily unavailable", () => {
    expect(authErrorMessage({ status: 500 })).toMatch(/temporarily unavailable/i);
  });

  it("429 → too many attempts", () => {
    expect(authErrorMessage({ status: 429 })).toMatch(/too many attempts/i);
  });

  it("network failure (no status, no message) → service unavailable, not generic", () => {
    expect(authErrorMessage({ status: 0 })).toMatch(/temporarily unavailable/i);
  });

  it("NEVER leaks SQL / stack / connection strings even if present in message", () => {
    const leaky = [
      "select * from \"User\" where email = $1",
      "PrismaClientKnownRequestError: relation \"account\" does not exist",
      "connect ECONNREFUSED 127.0.0.1:5432",
      "postgres://user:pw@host:5432/db timed out",
      "at /var/task/node_modules/better-auth/dist/index.js:1:1",
    ];
    for (const message of leaky) {
      const shown = authErrorMessage({ message });
      expect(shown).toBe("That did not work. Check your details and try again.");
      expect(shown).not.toMatch(/select|prisma|postgres|econn|node_modules|\$1|5432/i);
    }
  });

  it("uses a clean human message when Better Auth provides one", () => {
    expect(authErrorMessage({ message: "This email already has an account." })).toBe("This email already has an account.");
  });

  it("falls back to the generic message only as a last resort", () => {
    expect(authErrorMessage({})).toBe("That did not work. Check your details and try again.");
  });
});

describe("validateAuthInput — client-side pre-checks", () => {
  const strong = "Correct-Horse-9";

  it("passes a valid signup", () => {
    expect(validateAuthInput({ email: "a@b.com", password: strong, name: "A", confirmPassword: strong }, "signup")).toBeNull();
  });

  it("rejects missing/invalid email", () => {
    expect(validateAuthInput({ email: "", password: strong }, "login")).toMatch(/email/i);
    expect(validateAuthInput({ email: "not-an-email", password: strong }, "login")).toMatch(/valid email/i);
  });

  it("rejects short signup password with the minimum length", () => {
    expect(validateAuthInput({ email: "a@b.com", password: "short", confirmPassword: "short" }, "signup")).toContain(String(MINIMUM_PASSWORD_LENGTH));
  });

  it("rejects mismatched confirmation", () => {
    expect(validateAuthInput({ email: "a@b.com", password: strong, confirmPassword: "different" }, "signup")).toMatch(/do not match/i);
  });

  it("login does not enforce signup password rules", () => {
    expect(validateAuthInput({ email: "a@b.com", password: "x" }, "login")).toBeNull();
  });
});
