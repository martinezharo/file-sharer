import {
  ArrowRight,
  EyeOff,
  FileUp,
  Link2,
  Lock,
  MonitorSmartphone,
  Plus,
  QrCode,
  Send,
  ShieldCheck,
  WifiOff,
  X,
} from "lucide-preact";
import { createPortal } from "preact/compat";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { JSX, RefObject } from "preact";
import { cx, IconButton, Logo, Toasts } from "./components";
import { OnboardingCard } from "./Onboarding";

interface Feature {
  icon: typeof Lock;
  title: string;
  body: string;
}

const FEATURES: Feature[] = [
  {
    icon: Lock,
    title: "End-to-end encrypted",
    body: "Every message and file is encrypted with AES-256 on your device before it is ever sent over the network.",
  },
  {
    icon: EyeOff,
    title: "Zero-knowledge server",
    body: "The server stores only ciphertext, public keys and hashes. Your plaintext and keys never leave your devices.",
  },
  {
    icon: MonitorSmartphone,
    title: "All of your devices",
    body: "Keep your phone, laptop and tablet in sync through one shared, private space that only you control.",
  },
  {
    icon: QrCode,
    title: "Pair with a QR code",
    body: "Add a device by scanning a code. Keys are exchanged out-of-band, so there is no man-in-the-middle.",
  },
  {
    icon: FileUp,
    title: "Files up to 50 MB",
    body: "Send documents, images or archives. They are encrypted, delivered, then deleted from the server automatically.",
  },
  {
    icon: WifiOff,
    title: "Installable & offline",
    body: "Install it as a progressive web app. Your history lives locally and stays available, even without a connection.",
  },
];

const STEPS: Feature[] = [
  {
    icon: Plus,
    title: "Create a space",
    body: "Spin up an encrypted space on your first device in a single tap. No sign-up, no email.",
  },
  {
    icon: Link2,
    title: "Link your devices",
    body: "Scan a QR code to securely add your phone, laptop or tablet to the same private space.",
  },
  {
    icon: Send,
    title: "Share instantly",
    body: "Send text and files that sync end-to-end encrypted across every device you have linked.",
  },
];

interface Faq {
  q: string;
  a: string;
}

const FAQS: Faq[] = [
  {
    q: "Is file-sharer really end-to-end encrypted?",
    a: "Yes. A symmetric AES-256 group key is created on your first device and shared only with devices you link. Messages and files are encrypted before they leave your device, and the server only ever handles ciphertext.",
  },
  {
    q: "Do I need an account or email?",
    a: "No. There are no accounts, no email and no passwords. You create a space on one device and link your other devices to it with a QR code.",
  },
  {
    q: "Can you read my messages or files?",
    a: "No. The server is zero-knowledge by design: it stores only ciphertext, public keys and SHA-256 hashes. Without the keys that live on your devices, the data is unreadable.",
  },
  {
    q: "What is the maximum file size?",
    a: "You can share files up to 50 MB. Files are encrypted on your device, delivered to your other devices, then removed from the server automatically.",
  },
  {
    q: "Does it work offline?",
    a: "Yes. file-sharer is a progressive web app you can install. Your message history is stored locally, so it remains available even when you are offline.",
  },
  {
    q: "How do I add another device?",
    a: "On the new device choose to link to an existing space to get a QR code, then scan it from a device already in the space. The encryption keys are exchanged securely during pairing.",
  },
];

const OPEN_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const CLOSE_EASE = "cubic-bezier(0.4, 0, 0.2, 1)";

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function Landing(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  const slotRef = useRef<HTMLDivElement>(null);
  const modalCardRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const firstRect = useRef<DOMRect | null>(null);
  const closing = useRef(false);

  // Header appearance follows scroll position.
  useEffect(() => {
    const onScroll = (): void => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  function openModal(): void {
    if (open) return;
    // Lock scroll first (the gutter is reserved, so this won't shift layout),
    // then capture where the card sits in the hero before it leaves the flow.
    document.documentElement.style.overflow = "hidden";
    firstRect.current = slotRef.current?.getBoundingClientRect() ?? null;
    if (slotRef.current && firstRect.current) {
      // Reserve the hero space so the page behind the backdrop doesn't reflow.
      slotRef.current.style.minHeight = `${firstRect.current.height}px`;
    }
    setOpen(true);
  }

  function finishClose(): void {
    setOpen(false);
    closing.current = false;
    document.documentElement.style.overflow = "";
    if (slotRef.current) slotRef.current.style.minHeight = "";
  }

  function closeModal(): void {
    if (closing.current) return;
    const card = modalCardRef.current;
    const slot = slotRef.current;
    if (!card || !slot || prefersReducedMotion()) {
      finishClose();
      return;
    }
    closing.current = true;
    const first = card.getBoundingClientRect();
    const last = slot.getBoundingClientRect();
    backdropRef.current?.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: 280,
      easing: CLOSE_EASE,
      fill: "forwards",
    });
    const dx = last.left - first.left;
    const dy = last.top - first.top;
    const sx = last.width / first.width;
    const sy = last.height / first.height;
    card.style.transformOrigin = "top left";
    const anim = card.animate(
      [{ transform: "none" }, { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 0.4 }],
      { duration: 320, easing: CLOSE_EASE },
    );
    anim.onfinish = finishClose;
  }

  // The shared-element FLIP: morph the card from its hero rect to the centre.
  useLayoutEffect(() => {
    if (!open) return;
    const card = modalCardRef.current;
    const first = firstRect.current;
    if (!card || !first || prefersReducedMotion()) return;
    const last = card.getBoundingClientRect();
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    const sx = first.width / last.width;
    const sy = first.height / last.height;
    card.style.transformOrigin = "top left";
    card.style.willChange = "transform";
    const anim = card.animate(
      [{ transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` }, { transform: "none" }],
      { duration: 460, easing: OPEN_EASE },
    );
    anim.onfinish = () => {
      card.style.willChange = "";
    };
  }, [open]);

  // Escape to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") closeModal();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Never leave the document scroll-locked if we unmount mid-transition
  // (e.g. the user creates a space from inside the modal).
  useEffect(
    () => () => {
      document.documentElement.style.overflow = "";
    },
    [],
  );

  return (
    <div class="bg-grad min-h-full">
      <SiteHeader scrolled={scrolled} onCreate={openModal} />
      <main>
        <Hero slotRef={slotRef} showCard={!open} onCreate={openModal} />
        <Features />
        <HowItWorks />
        <Security onCreate={openModal} />
        <Faq />
      </main>
      <SiteFooter />

      {open &&
        createPortal(
          <div class="fixed inset-0 z-50 overflow-y-auto">
            <div
              ref={backdropRef}
              class="animate-fade-in fixed inset-0 bg-[color-mix(in_srgb,#0a0a0c_60%,transparent)] backdrop-blur-[3px]"
              onClick={closeModal}
            />
            <div class="pointer-events-none relative flex min-h-full items-center justify-center p-4">
              <div
                role="dialog"
                aria-modal="true"
                aria-label="Get started"
                class="pointer-events-auto relative w-full max-w-[420px]"
                ref={modalCardRef}
              >
                <div class="absolute -top-1 right-0 z-10 -translate-y-full pb-2">
                  <IconButton
                    label="Close"
                    class="bg-surface/80 text-ink backdrop-blur hover:bg-surface"
                    onClick={closeModal}
                  >
                    <X />
                  </IconButton>
                </div>
                <OnboardingCard />
              </div>
            </div>
          </div>,
          document.body,
        )}

      <Toasts />
    </div>
  );
}

function SiteHeader({ scrolled, onCreate }: { scrolled: boolean; onCreate: () => void }): JSX.Element {
  return (
    <header
      class={cx(
        "sticky top-0 z-30 transition-[background-color,border-color,box-shadow] duration-300",
        scrolled
          ? "border-b border-line bg-[color-mix(in_srgb,var(--c-surface)_72%,transparent)] backdrop-blur-xl"
          : "border-b border-transparent bg-transparent",
      )}
    >
      <div class="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-6 max-md:px-4">
        <a href="#top" class="flex items-center" aria-label="file-sharer home">
          <Logo />
        </a>
        <nav class="flex items-center gap-1 text-[13.5px] font-medium text-subtle max-md:hidden">
          <a class="rounded-lg px-3 py-2 transition hover:bg-surface-3 hover:text-ink" href="#features">
            Features
          </a>
          <a class="rounded-lg px-3 py-2 transition hover:bg-surface-3 hover:text-ink" href="#how">
            How it works
          </a>
          <a class="rounded-lg px-3 py-2 transition hover:bg-surface-3 hover:text-ink" href="#security">
            Security
          </a>
          <a class="rounded-lg px-3 py-2 transition hover:bg-surface-3 hover:text-ink" href="#faq">
            FAQ
          </a>
        </nav>
        <button
          type="button"
          onClick={onCreate}
          class={cx(
            "inline-flex h-10 items-center gap-2 rounded-card bg-accent px-4 text-[14px] font-semibold text-on-accent shadow-accent transition-[opacity,transform] duration-300 hover:bg-accent-hover active:scale-[0.98] [&_svg]:size-[17px]",
            scrolled ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-1 opacity-0",
          )}
        >
          Create a space
          <ArrowRight />
        </button>
      </div>
    </header>
  );
}

function Hero({
  slotRef,
  showCard,
  onCreate,
}: {
  slotRef: RefObject<HTMLDivElement>;
  showCard: boolean;
  onCreate: () => void;
}): JSX.Element {
  return (
    <section id="top" class="relative scroll-mt-20">
      <div class="mx-auto grid max-w-6xl items-center gap-12 px-6 py-16 max-md:px-4 max-md:py-10 md:grid-cols-[1.05fr_0.95fr] md:py-24">
        <div class="max-md:text-center">
          <span class="inline-flex items-center gap-2 rounded-full bg-accent-soft px-3 py-1.5 font-mono text-[10.5px] font-medium uppercase tracking-[0.16em] text-accent [&_svg]:size-3.5">
            <ShieldCheck />
            End-to-end encrypted
          </span>
          <h1 class="mt-5 text-[clamp(2.25rem,5vw,3.5rem)] font-semibold leading-[1.04] tracking-[-0.035em]">
            Share files and text<br class="max-md:hidden" /> between your own devices,{" "}
            <span class="text-accent">privately</span>.
          </h1>
          <p class="mt-5 max-w-xl text-[16.5px] leading-relaxed text-subtle max-md:mx-auto">
            file-sharer is an end-to-end encrypted space for your phone, laptop and tablet. The
            server only ever sees ciphertext — your messages and files never leave your devices
            unencrypted.
          </p>
          <div class="mt-8 flex flex-wrap items-center gap-3 max-md:justify-center">
            <button
              type="button"
              onClick={onCreate}
              class="inline-flex h-12 items-center gap-2 rounded-card bg-accent px-5 text-[15px] font-semibold text-on-accent shadow-accent transition hover:bg-accent-hover active:scale-[0.98] [&_svg]:size-[18px]"
            >
              Create a space
              <ArrowRight />
            </button>
            <a
              href="#how"
              class="inline-flex h-12 items-center rounded-card bg-surface px-5 text-[15px] font-semibold text-ink shadow-soft transition hover:bg-surface-3 dark:bg-surface-2"
            >
              See how it works
            </a>
          </div>
          <ul class="mt-8 flex flex-wrap gap-x-6 gap-y-2 font-mono text-[11px] uppercase tracking-[0.1em] text-muted max-md:justify-center">
            <li class="flex items-center gap-1.5">
              <span class="size-1.5 rounded-full bg-success" /> No account
            </li>
            <li class="flex items-center gap-1.5">
              <span class="size-1.5 rounded-full bg-success" /> Files up to 50 MB
            </li>
            <li class="flex items-center gap-1.5">
              <span class="size-1.5 rounded-full bg-success" /> Works offline
            </li>
          </ul>
        </div>

        <div ref={slotRef} class="mx-auto w-full max-w-[420px]">
          {showCard && <OnboardingCard />}
        </div>
      </div>
    </section>
  );
}

function SectionHeading({
  kicker,
  title,
  subtitle,
}: {
  kicker: string;
  title: string;
  subtitle?: string;
}): JSX.Element {
  return (
    <div class="mx-auto max-w-2xl text-center">
      <div class="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-accent">
        {kicker}
      </div>
      <h2 class="mt-3 text-[clamp(1.6rem,3.5vw,2.25rem)] font-semibold tracking-[-0.03em]">
        {title}
      </h2>
      {subtitle && <p class="mt-3 text-[15.5px] leading-relaxed text-muted">{subtitle}</p>}
    </div>
  );
}

function Features(): JSX.Element {
  return (
    <section id="features" class="scroll-mt-20 px-6 py-16 max-md:px-4 md:py-24">
      <div class="mx-auto max-w-6xl">
        <SectionHeading
          kicker="Why file-sharer"
          title="Private by design, not by promise"
          subtitle="Encryption happens on your devices. There is nothing for us — or anyone else — to read on the server."
        />
        <div class="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <article
              key={title}
              class="rounded-xl2 bg-surface p-6 shadow-soft transition hover:shadow-pop dark:bg-surface-2"
            >
              <div class="grid size-11 place-items-center rounded-[12px] bg-accent-soft text-accent [&_svg]:size-[22px]">
                <Icon />
              </div>
              <h3 class="mt-4 text-[16.5px] font-semibold tracking-[-0.01em]">{title}</h3>
              <p class="mt-2 text-[14px] leading-relaxed text-muted">{body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function HowItWorks(): JSX.Element {
  return (
    <section id="how" class="scroll-mt-20 px-6 py-16 max-md:px-4 md:py-24">
      <div class="mx-auto max-w-6xl">
        <SectionHeading kicker="How it works" title="Up and running in three steps" />
        <ol class="mt-12 grid gap-4 md:grid-cols-3">
          {STEPS.map(({ icon: Icon, title, body }, i) => (
            <li key={title} class="relative rounded-xl2 bg-surface p-6 shadow-soft dark:bg-surface-2">
              <div class="flex items-center gap-3">
                <span class="grid size-10 place-items-center rounded-[12px] bg-accent text-on-accent [&_svg]:size-[20px]">
                  <Icon />
                </span>
                <span class="font-mono text-[12px] font-medium text-muted">
                  Step {String(i + 1).padStart(2, "0")}
                </span>
              </div>
              <h3 class="mt-4 text-[17px] font-semibold tracking-[-0.01em]">{title}</h3>
              <p class="mt-2 text-[14px] leading-relaxed text-muted">{body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Security({ onCreate }: { onCreate: () => void }): JSX.Element {
  const points = [
    {
      term: "Group key (AES-GCM 256)",
      desc: "A single symmetric key encrypts every message, file and file-metadata blob. It is created once and shared only with devices you link.",
    },
    {
      term: "Device keys (ECDH P-256)",
      desc: "Each device holds a non-extractable private key. It never leaves the device and cannot be exported, even by the app.",
    },
    {
      term: "Secure pairing (ECIES)",
      desc: "Linking wraps the keys with an ephemeral key tied to a scanned QR code, so there is no man-in-the-middle during pairing.",
    },
    {
      term: "Ephemeral by default",
      desc: "Once a message is delivered to your devices it is deleted from the server, and anything left over is reaped within 24 hours.",
    },
  ];

  return (
    <section id="security" class="scroll-mt-20 px-6 py-16 max-md:px-4 md:py-24">
      <div class="mx-auto max-w-5xl overflow-hidden rounded-xl3 bg-surface p-8 shadow-float dark:bg-surface-2 md:p-12">
        <div class="grid gap-10 md:grid-cols-[0.9fr_1.1fr] md:items-center">
          <div>
            <div class="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-accent">
              Security model
            </div>
            <h2 class="mt-3 text-[clamp(1.6rem,3.5vw,2.25rem)] font-semibold tracking-[-0.03em]">
              Built so we can never see your data
            </h2>
            <p class="mt-4 text-[15px] leading-relaxed text-muted">
              The architecture is zero-knowledge from the ground up. Plaintext, the group key and
              the raw auth token are never sent to the server — only ciphertext, public keys and
              hashes ever cross the wire.
            </p>
            <button
              type="button"
              onClick={onCreate}
              class="mt-6 inline-flex items-center gap-2 text-[14.5px] font-semibold text-accent transition-[gap] hover:gap-3 [&_svg]:size-[17px]"
            >
              Start an encrypted space
              <ArrowRight />
            </button>
          </div>
          <dl class="grid gap-3 sm:grid-cols-2">
            {points.map(({ term, desc }) => (
              <div key={term} class="rounded-xl2 bg-surface-3 p-5">
                <dt class="flex items-center gap-2 text-[14px] font-semibold [&_svg]:size-4 [&_svg]:text-accent">
                  <Lock />
                  {term}
                </dt>
                <dd class="mt-2 text-[13px] leading-relaxed text-muted">{desc}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}

function Faq(): JSX.Element {
  return (
    <section id="faq" class="scroll-mt-20 px-6 py-16 max-md:px-4 md:py-24">
      <div class="mx-auto max-w-3xl">
        <SectionHeading kicker="FAQ" title="Questions, answered" />
        <div class="mt-10 flex flex-col gap-3">
          {FAQS.map(({ q, a }) => (
            <details
              key={q}
              class="group rounded-xl2 bg-surface px-5 shadow-soft transition open:shadow-pop dark:bg-surface-2"
            >
              <summary class="flex cursor-pointer list-none items-center justify-between gap-4 py-4 text-[15.5px] font-semibold [&::-webkit-details-marker]:hidden">
                {q}
                <span class="grid size-7 flex-none place-items-center rounded-full bg-surface-3 text-muted transition group-open:rotate-45 group-open:bg-accent-soft group-open:text-accent">
                  <Plus class="size-4" />
                </span>
              </summary>
              <p class="pb-5 text-[14px] leading-relaxed text-muted">{a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function SiteFooter(): JSX.Element {
  return (
    <footer class="border-t border-line px-6 py-12 max-md:px-4">
      <div class="mx-auto flex max-w-6xl flex-col items-center gap-6 text-center">
        <Logo />
        <p class="max-w-md text-[14px] leading-relaxed text-muted">
          A tiny, end-to-end encrypted progressive web app to share text and files between your own
          devices.
        </p>
        <div class="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted [&_svg]:size-3.5">
          <ShieldCheck class="text-accent" />
          Zero-knowledge encryption
        </div>
        <p class="text-[12.5px] text-muted">© {new Date().getFullYear()} file-sharer</p>
      </div>
    </footer>
  );
}
