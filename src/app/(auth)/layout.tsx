import Link from "next/link";
import { Wordmark } from "@/components/shell/Wordmark";

/**
 * Auth pages get no shell. There is nothing to navigate to yet, and a sidebar
 * behind a sign-in form implies the app is already reachable.
 */
export default function AuthGroupLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex h-14 items-center px-5">
        <Link href="/" className="rounded-md">
          <Wordmark />
        </Link>
      </header>
      <main id="main" className="flex flex-1 items-center justify-center px-5 pb-20">
        {children}
      </main>
    </div>
  );
}
