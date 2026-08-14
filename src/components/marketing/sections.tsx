"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/components/ui/cn";

/**
 * Shared marketing layout pieces.
 *
 * Editorial content is held to a narrow measure; product visuals are allowed
 * the full grid. Keeping that rule in one place is what stops marketing
 * sections from drifting into the full-width-everything look.
 */

export function Shell({
  children,
  className,
  wide,
}: {
  children: React.ReactNode;
  className?: string;
  wide?: boolean;
}) {
  return (
    <div className={cn("mx-auto px-5 lg:px-8", wide ? "max-w-6xl" : "max-w-3xl", className)}>
      {children}
    </div>
  );
}

export function SectionTag({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-3 flex items-center gap-2 text-micro font-medium uppercase tracking-[0.075em] text-faint">
      <span className="h-px w-6 bg-line" aria-hidden />
      {children}
    </p>
  );
}

export function SectionTitle({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <h2 className={cn("text-title text-primary text-balance", className)}>{children}</h2>
  );
}

export function Lede({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 max-w-xl text-body text-secondary text-pretty">{children}</p>;
}

/**
 * Reveals a block once when it first enters the viewport.
 *
 * Deliberately small: an 8px rise and a fade. Anything larger becomes the thing
 * the reader notices instead of the content, and reduced-motion users get the
 * final state immediately.
 */
export function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  const reduceMotion = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShown(true);
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.1 },
    );
    observer.observe(element);

    // Safety net. Content that is invisible until an observer fires is content
    // that can be permanently invisible if the observer never does — during a
    // print, inside a screenshot tool, or in any environment where layout never
    // settles. After a beat, show it regardless.
    const failsafe = window.setTimeout(() => setShown(true), 1200);

    return () => {
      observer.disconnect();
      window.clearTimeout(failsafe);
    };
  }, []);

  if (reduceMotion) return <div className={className}>{children}</div>;

  return (
    <motion.div
      ref={ref}
      className={className}
      initial={{ opacity: 0, y: 8 }}
      animate={shown ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
      transition={{ duration: 0.5, delay, ease: [0.2, 0, 0, 1] }}
    >
      {children}
    </motion.div>
  );
}
