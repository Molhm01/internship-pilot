import { describe, expect, it } from "vitest";
import {
  extractVerificationCodeFromEmail,
  extractVerificationLinksFromEmail,
} from "./verificationCode";

describe("extractVerificationCodeFromEmail", () => {
  it("extracts Greenhouse 8-character alphanumeric security codes", () => {
    const code = extractVerificationCodeFromEmail({
      subject: "Security code for your application to Anduril Industries",
      bodyText: "Copy and paste this security code into the security code field on your application: k9Lm4Pq2",
    });
    expect(code).toBe("k9Lm4Pq2");
  });

  it("extracts 6-digit numeric OTP verification codes", () => {
    const code = extractVerificationCodeFromEmail({
      subject: "Verify your email address",
      bodyText: "Your verification code is 482913. It expires in 15 minutes.",
    });
    expect(code).toBe("482913");
  });

  it("extracts standalone security code on its own line", () => {
    const code = extractVerificationCodeFromEmail({
      subject: "Security code for your application to Scout Space",
      bodyText: "Please enter the security code below to finish submitting your application:\n\nA7b9C2d4\n\nThanks!",
    });
    expect(code).toBe("A7b9C2d4");
  });

  it("returns null for unrelated marketing or confirmation emails", () => {
    const code = extractVerificationCodeFromEmail({
      subject: "Thank you for applying to Acme Robotics",
      bodyText: "We have received your application for Software Engineering Intern.",
    });
    expect(code).toBeNull();
  });
});

describe("extractVerificationLinksFromEmail", () => {
  it("extracts and decodes Workday HTML verification links while skipping unsubscribe/privacy links", () => {
    const links = extractVerificationLinksFromEmail({
      subject: "Verify your candidate account at Lockheed Martin",
      bodyText: "Please verify your email address to activate your account.",
      bodyHtml: `
        <p>Welcome! Click below to confirm your account:</p>
        <a href="https://lmco.wd5.myworkdayjobs.com/en-US/External/verify?token=xyz987&amp;email=mjalasri1%40gmail.com">Verify Email Address</a>
        <a href="https://lmco.wd5.myworkdayjobs.com/unsubscribe?id=123">Unsubscribe</a>
        <a href="https://www.lockheedmartin.com/privacy">Privacy Policy</a>
      `,
    });
    expect(links).toEqual([
      "https://lmco.wd5.myworkdayjobs.com/en-US/External/verify?token=xyz987&email=mjalasri1%40gmail.com",
    ]);
  });

  it("extracts plain-text ATS activation links", () => {
    const links = extractVerificationLinksFromEmail({
      subject: "Confirm your email to complete registration",
      bodyText:
        "To activate your candidate account, open: https://careers-acme.icims.com/jobs/activate?code=998877abc.",
    });
    expect(links).toEqual(["https://careers-acme.icims.com/jobs/activate?code=998877abc"]);
  });

  it("returns empty array for non-verification emails", () => {
    const links = extractVerificationLinksFromEmail({
      subject: "Weekly engineering job digest",
      bodyText: "Check out new roles at https://example.com/careers/jobs",
    });
    expect(links).toEqual([]);
  });
});
