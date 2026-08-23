import { NextResponse } from "next/server";

import { localInstanceIdentity } from "@/lib/runtime/localInstance";
import { isCloudRuntime } from "@/lib/runtime/deployment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Who this local server actually is.
 *
 * `npm run local` calls this before deciding whether an existing process on
 * port 3000 may be reused. It answers with the checkout, the commit and the
 * build the running process came from, which is the only way to distinguish a
 * correct instance from one still serving a `.next` directory that has since
 * been deleted and rebuilt.
 *
 * It is refused outright in a cloud runtime. The repository path and commit of
 * a deployment are not a public fact, and no hosted caller has any use for
 * them: the launcher this serves runs on the same machine as the server.
 */
export async function GET() {
  if (isCloudRuntime()) {
    return NextResponse.json(
      { error: "The local instance identity endpoint only answers in a local runtime." },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }

  return NextResponse.json(localInstanceIdentity(), {
    headers: { "cache-control": "no-store" },
  });
}
