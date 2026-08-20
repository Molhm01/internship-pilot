import { describe, expect, it } from "vitest";
import { detectJobAlertProvider } from "./jobAlertRadar";

describe("job alert radar provider detection", () => {
  it.each([
    ["LinkedIn Jobs <jobs-noreply@linkedin.com>", "New jobs for you", "linkedin"],
    ["Handshake <notifications@joinhandshake.com>", "New job matches", "handshake"],
    ["Indeed <alert@indeed.com>", "Electrical engineering job alert", "indeed"],
    ["Glassdoor Jobs <jobs@glassdoor.com>", "Jobs you may like", "glassdoor"],
    ["ZipRecruiter <jobs@ziprecruiter.com>", "New jobs matching your search", "ziprecruiter"],
  ])("detects %s", (fromAddress, subject, expected) => {
    expect(detectJobAlertProvider({ fromAddress, subject, bodyText: "Recommended internships for you" }))
      .toBe(expected);
  });

  it("does not turn an ordinary LinkedIn message into a job radar event", () => {
    expect(detectJobAlertProvider({
      fromAddress: "messages-noreply@linkedin.com",
      subject: "Someone sent you a message",
      bodyText: "You have a new message.",
    })).toBeNull();
  });
});
