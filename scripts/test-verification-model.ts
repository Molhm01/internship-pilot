import {
  AVAILABILITY,
  REASON_CODES,
  badgeFor,
  canonicalAvailability,
  isActiveAvailability,
} from "@/lib/jobs/verificationModel";

let failures = 0;
function check(condition: boolean, message: string) {
  if (condition) console.log(`  PASS: ${message}`);
  else {
    console.error(`  FAIL: ${message}`);
    failures += 1;
  }
}

console.log("1) Canonical availability mapping");
check(canonicalAvailability("VERIFIED_OFFICIAL_AT_LAST_CHECK") === AVAILABILITY.OFFICIAL_VERIFIED, "verified stays official_verified");
check(canonicalAvailability("ACTIVE_SOURCE_LISTED") === AVAILABILITY.ACTIVE_SOURCE_LISTED, "source-listed stays source-listed");
for (const legacy of ["VERIFICATION_PENDING", "Pending", "NeedsReview"]) {
  check(canonicalAvailability(legacy) === AVAILABILITY.VERIFICATION_PENDING, `${legacy} maps to verification pending`);
}
check(canonicalAvailability("CLOSED_OR_UNVERIFIED") === AVAILABILITY.ACTIVE_SOURCE_LISTED, "legacy false-closure is repaired to source-listed, not closed");
check(canonicalAvailability("Closed") === AVAILABILITY.CLOSED_CONFIRMED, "Closed maps only to confirmed closed");
check(canonicalAvailability("DESTINATION_MISMATCH") === AVAILABILITY.DESTINATION_MISMATCH, "destination mismatch remains mismatch");
check(canonicalAvailability("SecurityQuarantine") === AVAILABILITY.SECURITY_BLOCKED, "security quarantine remains blocked");

console.log("\n2) Active/terminal boundary");
for (const status of [
  "VERIFIED_OFFICIAL_AT_LAST_CHECK",
  "ACTIVE_SOURCE_LISTED",
  "VERIFICATION_PENDING",
  "Pending",
  "NeedsReview",
  "CLOSED_OR_UNVERIFIED",
]) {
  check(isActiveAvailability(status), `${status} is considered applyable/active availability`);
}
for (const status of ["Closed", "DESTINATION_MISMATCH", "SecurityQuarantine"]) {
  check(!isActiveAvailability(status), `${status} is not active`);
}

console.log("\n3) Badge mapping is deterministic");
check(badgeFor("VERIFIED_OFFICIAL_AT_LAST_CHECK") === "official_verified", "verified badge");
check(badgeFor("ACTIVE_SOURCE_LISTED") === "source_listed", "source-listed badge");
check(badgeFor("NeedsReview") === "verification_pending", "pending badge");
check(badgeFor("Closed") === "closed_confirmed", "confirmed-closed badge");
check(badgeFor("DESTINATION_MISMATCH") === "destination_mismatch", "mismatch badge");
check(badgeFor("SecurityQuarantine") === "security_blocked", "security badge");

console.log("\n4) Reason-code registry has no duplicates");
check(new Set(REASON_CODES).size === REASON_CODES.length, "reason codes are unique");
check(REASON_CODES.includes("CLOSED_NOT_FOUND") && REASON_CODES.includes("CLOSED_EXPIRED"), "confirmed closure has explicit reason codes");
check(REASON_CODES.includes("OFFICIAL_MIRROR_NOT_FOUND"), "missing mirror is represented separately from closure");

console.log(failures === 0 ? "\nAll verification-model tests PASSED." : `\n${failures} verification-model test(s) FAILED.`);
if (failures) process.exitCode = 1;
