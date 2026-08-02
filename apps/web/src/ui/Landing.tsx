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
import type { JSX, RefObject } from "preact";
import { createPortal } from "preact/compat";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { OnboardingCard } from "./Onboarding";
import { IconButton, Logo, Toasts, cx } from "./components";

interface Feature {
  icon: typeof Lock;
  title: string;
  body: string;
}

const FEATURES: Feature[] = [
  {
    icon: Lock,
    title: "Encrypted before upload",
    body: "Messages and files are encrypted on your device before they leave it. The server can deliver the ciphertext, but cannot decrypt your content.",
  },
  {
    icon: EyeOff,
    title: "No account required",
    body: "No email or server password. Optionally protect this device with a passphrase, PIN, or passkey.",
  },
  {
    icon: MonitorSmartphone,
    title: "One private space, every device",
    body: "Keep your phone, laptop, and tablet connected through one private space you control.",
  },
  {
    icon: QrCode,
    title: "Pair with a QR code",
    body: "Link a new device through an out-of-band QR flow that securely transfers access to it.",
  },
  {
    icon: FileUp,
    title: "Files up to 50 MB",
    body: "Send documents, images, or archives. Delivered content is removed from the server automatically.",
  },
  {
    icon: WifiOff,
    title: "Local history & offline queue",
    body: "Your history stays on your devices. Messages and selected files can wait locally, but uploading and delivery require a connection.",
  },
];

const STEPS: Feature[] = [
  {
    icon: Plus,
    title: "Create a private space",
    body: "Start on any device without an account, email, or server password.",
  },
  {
    icon: Link2,
    title: "Link your devices",
    body: "Scan a QR code to add your phone, laptop, or tablet to the same private space.",
  },
  {
    icon: Send,
    title: "Send without waiting",
    body: "Send text and files when connected; if a recipient is offline, encrypted content waits for it.",
  },
];

interface Faq {
  q: string;
  a: string;
}

const FAQS: Faq[] = [
  {
    q: "Is file-sharer end-to-end encrypted?",
    a: "Yes. Messages, files, and file metadata are encrypted on your device with AES-GCM before upload. The server receives ciphertext and cannot decrypt the content.",
  },
  {
    q: "Do I need an account?",
    a: "No account, email, or server password is required. You can optionally protect this device with a passphrase, PIN, or passkey.",
  },
  {
    q: "Can the server read my messages or files?",
    a: "It cannot decrypt your content. It does receive ciphertext and the protocol metadata needed to authenticate requests and deliver messages.",
  },
  {
    q: "What is the maximum file size?",
    a: "You can share files up to 50 MB. Delivered content is purged when active recipients acknowledge it; anything left over is cleaned up within 24 hours.",
  },
  {
    q: "Does it work offline?",
    a: "Partly. The installed PWA keeps local history available and can save outgoing messages or selected files locally, but nothing is uploaded or delivered until you reconnect.",
  },
  {
    q: "How do I add another device?",
    a: "On the new device, choose to link an existing space and show its QR code. Scan it from a linked device; the shared group key is transferred in an encrypted pairing package.",
  },
  {
    q: "Where are the encryption keys kept?",
    a: "Private device keys are generated locally and never sent to the server. The shared group key is transferred only to linked devices through encrypted pairing and key-rotation packages. An optional encrypted recovery file can carry a copy for restoring a device.",
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
      [
        { transform: "none" },
        { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 0.4 },
      ],
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

function SiteHeader({
  scrolled,
  onCreate,
}: { scrolled: boolean; onCreate: () => void }): JSX.Element {
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
        <a href="#top" class="flex items-center">
          <Logo />
        </a>
        <nav class="flex items-center gap-1 text-[13.5px] font-medium text-subtle max-md:hidden">
          <a
            class="rounded-lg px-3 py-2 transition hover:bg-surface-3 hover:text-ink"
            href="#features"
          >
            Features
          </a>
          <a class="rounded-lg px-3 py-2 transition hover:bg-surface-3 hover:text-ink" href="#how">
            How it works
          </a>
          <a
            class="rounded-lg px-3 py-2 transition hover:bg-surface-3 hover:text-ink"
            href="#security"
          >
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
          Create space
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
            Send files and text
            <br class="max-md:hidden" /> between your own devices —{" "}
            <span class="text-accent">privately</span>.
          </h1>
          <p class="mt-5 max-w-xl text-[16.5px] leading-relaxed text-subtle max-md:mx-auto">
            file-sharer is a private, end-to-end encrypted space for your phone, laptop, and tablet.
            No account required: your content is encrypted on your device before upload, and the
            server never receives it in readable form.
          </p>
          <div class="mt-8 flex flex-wrap items-center gap-3 max-md:justify-center">
            <button
              type="button"
              onClick={onCreate}
              class="inline-flex h-12 items-center gap-2 rounded-card bg-accent px-5 text-[15px] font-semibold text-on-accent shadow-accent transition hover:bg-accent-hover active:scale-[0.98] [&_svg]:size-[18px]"
            >
              Create your private space
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
              <span class="size-1.5 rounded-full bg-success" /> Up to 50 MB per file
            </li>
            <li class="flex items-center gap-1.5">
              <span class="size-1.5 rounded-full bg-success" /> Offline-ready
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
          title="Your content stays yours"
          subtitle="Messages and files are encrypted on your devices before they leave them. The server can deliver ciphertext, but cannot decrypt it."
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
            <li
              key={title}
              class="relative rounded-xl2 bg-surface p-6 shadow-soft dark:bg-surface-2"
            >
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
      term: "Content encryption (AES-GCM 256)",
      desc: "A local group key encrypts messages, files, and file metadata. Keys rotate when membership changes.",
    },
    {
      term: "Device identity (ECDH P-256)",
      desc: "Each device creates its own P-256 key pair. Private keys are never sent to the server; an optional encrypted recovery file can restore a device.",
    },
    {
      term: "Encrypted device pairing",
      desc: "A QR code binds the new device's public key to the pairing. The shared group key is sent only inside an encrypted package.",
    },
    {
      term: "Temporary server storage",
      desc: "Delivered messages and files are purged when active recipients acknowledge them; a scheduled cleanup removes anything older than 24 hours.",
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
              Built so the server cannot decrypt your content
            </h2>
            <p class="mt-4 text-[15px] leading-relaxed text-muted">
              Messages, files, and file metadata are encrypted on your devices. The service receives
              ciphertext, public keys, authentication data, and delivery metadata — but not readable
              content or private device keys.
            </p>
            <button
              type="button"
              onClick={onCreate}
              class="mt-6 inline-flex items-center gap-2 text-[14.5px] font-semibold text-accent transition-[gap] hover:gap-3 [&_svg]:size-[17px]"
            >
              Create your private space
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
          A private, end-to-end encrypted space for text and files across your devices.
        </p>
        <div class="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted [&_svg]:size-3.5">
          <ShieldCheck class="text-accent" />
          End-to-end encryption
        </div>
        <nav
          aria-label="Resources"
          class="flex flex-wrap justify-center gap-x-5 gap-y-2 text-[13px] text-muted"
        >
          <a class="transition hover:text-ink" href="/how-it-works/">
            How it works
          </a>
          <a class="transition hover:text-ink" href="/security/">
            Security
          </a>
          <a class="transition hover:text-ink" href="/privacy/">
            Privacy
          </a>
          <a class="transition hover:text-ink" href="/install/">
            Install
          </a>
        </nav>
        <p class="text-[12.5px] text-muted">© {new Date().getFullYear()} file-sharer</p>
      </div>
    </footer>
  );
}
