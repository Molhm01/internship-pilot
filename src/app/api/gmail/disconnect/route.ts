import { NextResponse } from "next/server";
import { disconnectGmail } from "@/lib/gmail/account";
import { withUser } from "@/lib/auth/session";

/** Disconnects the caller's own mailbox. Scoped, so it cannot end anybody else's. */
export const POST = withUser(async (_request, user) => {
  await disconnectGmail(user.id);
  return NextResponse.json({ disconnected: true });
});
