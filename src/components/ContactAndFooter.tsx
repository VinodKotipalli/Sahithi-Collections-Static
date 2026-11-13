import { Instagram, Mail, MapPin, MessageCircle } from 'lucide-react';
import {
  isAddressConfigured,
  isEmailConfigured,
  isInstagramConfigured,
  isWhatsAppConfigured,
  SITE_CONFIG,
} from '../config/site';
import { RevealSection } from './RevealSection';

export function ContactAndFooter({ onOpenLogin }: { onOpenLogin?: () => void }) {
  const { contact } = SITE_CONFIG;
  const hasWhatsApp = isWhatsAppConfigured(contact);
  const hasInstagram = isInstagramConfigured(contact);
  const hasEmail = isEmailConfigured(contact);
  const hasAddress = isAddressConfigured(contact);
  const currentYear = new Date().getFullYear();

  const cleanInstagramHandle = contact.instagramHandle.replace(/^@/, '').trim();
  const cleanWhatsApp = contact.whatsappNumber.replace(/\D/g, '');

  return (
    <>
      <section id="contact" className="border-t border-[#49243E]/10 bg-[#FFF9F5] py-16 sm:py-24">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <RevealSection>
            <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
              <div>
                <p className="text-xs font-medium tracking-[0.2em] uppercase text-[#B76E79]">
                  Boutique Concierge
                </p>
                <h2 className="mt-2 font-serif text-3xl font-semibold tracking-tight text-[#49243E] sm:text-4xl">
                  Connect With Sahithi Collections
                </h2>
              </div>
              <p className="max-w-md text-sm leading-relaxed text-[#242124]/75">
                Reach out directly through your preferred channel once boutique details are configured in{' '}
                <code className="rounded bg-[#F3D5DF]/40 px-1.5 py-0.5 font-mono text-xs text-[#49243E]">
                  src/config/site.ts
                </code>
                .
              </p>
            </div>
          </RevealSection>

          <div className="mt-10 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {/* WhatsApp Card */}
            <RevealSection delay={0.04}>
              <div className="flex h-full flex-col justify-between rounded-2xl border border-[#49243E]/12 bg-white p-6">
                <div>
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#F3D5DF]/45 text-[#49243E]">
                    <MessageCircle className="h-5 w-5" aria-hidden="true" />
                  </div>
                  <h3 className="mt-4 font-serif text-xl font-semibold text-[#49243E]">
                    WhatsApp Styling
                  </h3>
                  {hasWhatsApp ? (
                    <p className="mt-2 text-sm text-[#242124]/80 tabular-nums">
                      +{cleanWhatsApp}
                    </p>
                  ) : (
                    <p className="mt-2 text-sm text-[#242124]/65">
                      Placeholder — add your boutique WhatsApp number in{' '}
                      <code className="font-mono text-xs">site.ts</code> to enable product enquiries.
                    </p>
                  )}
                </div>

                {hasWhatsApp ? (
                  <a
                    href={`https://wa.me/${cleanWhatsApp}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-5 inline-flex min-h-[42px] items-center justify-center rounded-xl bg-[#49243E] px-4 py-2 text-xs font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31]"
                  >
                    Message on WhatsApp
                  </a>
                ) : (
                  <span className="mt-5 inline-block text-xs font-medium text-[#B76E79]">
                    Status: Pending setup
                  </span>
                )}
              </div>
            </RevealSection>

            {/* Instagram Card */}
            <RevealSection delay={0.08}>
              <div className="flex h-full flex-col justify-between rounded-2xl border border-[#49243E]/12 bg-white p-6">
                <div>
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#F3D5DF]/45 text-[#49243E]">
                    <Instagram className="h-5 w-5" aria-hidden="true" />
                  </div>
                  <h3 className="mt-4 font-serif text-xl font-semibold text-[#49243E]">
                    Instagram
                  </h3>
                  {hasInstagram ? (
                    <p className="mt-2 text-sm text-[#242124]/80">@{cleanInstagramHandle}</p>
                  ) : (
                    <p className="mt-2 text-sm text-[#242124]/65">
                      Placeholder — add your Instagram handle in{' '}
                      <code className="font-mono text-xs">site.ts</code> to activate Follow Our Style.
                    </p>
                  )}
                </div>

                {hasInstagram ? (
                  <a
                    href={`https://instagram.com/${cleanInstagramHandle}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-5 inline-flex min-h-[42px] items-center justify-center rounded-xl border border-[#49243E]/25 px-4 py-2 text-xs font-medium text-[#49243E] transition-colors hover:bg-[#49243E] hover:text-[#FFF9F5]"
                  >
                    Follow Our Style
                  </a>
                ) : (
                  <span className="mt-5 inline-block text-xs font-medium text-[#B76E79]">
                    Status: Pending setup
                  </span>
                )}
              </div>
            </RevealSection>

            {/* Email Card */}
            <RevealSection delay={0.12}>
              <div className="flex h-full flex-col justify-between rounded-2xl border border-[#49243E]/12 bg-white p-6">
                <div>
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#F3D5DF]/45 text-[#49243E]">
                    <Mail className="h-5 w-5" aria-hidden="true" />
                  </div>
                  <h3 className="mt-4 font-serif text-xl font-semibold text-[#49243E]">
                    Boutique Email
                  </h3>
                  {hasEmail ? (
                    <p className="mt-2 break-all text-sm text-[#242124]/80">{contact.email}</p>
                  ) : (
                    <p className="mt-2 text-sm text-[#242124]/65">
                      Placeholder — configure your boutique email address in{' '}
                      <code className="font-mono text-xs">site.ts</code>.
                    </p>
                  )}
                </div>

                {hasEmail ? (
                  <a
                    href={`mailto:${contact.email}`}
                    className="mt-5 inline-flex min-h-[42px] items-center justify-center rounded-xl border border-[#49243E]/25 px-4 py-2 text-xs font-medium text-[#49243E] transition-colors hover:bg-[#49243E] hover:text-[#FFF9F5]"
                  >
                    Send an Email
                  </a>
                ) : (
                  <span className="mt-5 inline-block text-xs font-medium text-[#B76E79]">
                    Status: Pending setup
                  </span>
                )}
              </div>
            </RevealSection>

            {/* Store Address Card */}
            <RevealSection delay={0.16}>
              <div className="flex h-full flex-col justify-between rounded-2xl border border-[#49243E]/12 bg-white p-6">
                <div>
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#F3D5DF]/45 text-[#49243E]">
                    <MapPin className="h-5 w-5" aria-hidden="true" />
                  </div>
                  <h3 className="mt-4 font-serif text-xl font-semibold text-[#49243E]">
                    Store Address
                  </h3>
                  {hasAddress ? (
                    <p className="mt-2 text-sm leading-relaxed text-[#242124]/80">
                      {contact.storeAddress}
                    </p>
                  ) : (
                    <p className="mt-2 text-sm text-[#242124]/65">
                      Placeholder — add your showroom or studio street address in{' '}
                      <code className="font-mono text-xs">site.ts</code>.
                    </p>
                  )}
                </div>

                <span className="mt-5 inline-block text-xs font-medium text-[#49243E]/70">
                  {hasAddress ? contact.hoursNote : 'Status: Pending setup'}
                </span>
              </div>
            </RevealSection>
          </div>
        </div>
      </section>

      <footer className="bg-[#49243E] py-12 text-[#FFF9F5]">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-8 border-b border-[#FFF9F5]/15 pb-8 md:flex-row md:items-center md:justify-between">
            <div>
              <a
                href="#home"
                className="font-serif text-2xl font-semibold tracking-tight text-[#FFF9F5]"
              >
                {SITE_CONFIG.brandName}
              </a>
              <p className="mt-1.5 text-sm italic font-serif text-[#F3D5DF]">
                {SITE_CONFIG.tagline}
              </p>
            </div>

            <nav aria-label="Footer navigation" className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-[#FFF9F5]/85">
              <a href="#home" className="transition-colors hover:text-[#F3D5DF]">
                Home
              </a>
              <a href="#collections" className="transition-colors hover:text-[#F3D5DF]">
                Collections
              </a>
              <a href="#new-arrivals" className="transition-colors hover:text-[#F3D5DF]">
                New Arrivals
              </a>
              <a href="#lookbook" className="transition-colors hover:text-[#F3D5DF]">
                Lookbook
              </a>
              <a href="#about" className="transition-colors hover:text-[#F3D5DF]">
                About
              </a>
              <a href="#contact" className="transition-colors hover:text-[#F3D5DF]">
                Contact
              </a>
              {onOpenLogin && (
                <button
                  type="button"
                  onClick={onOpenLogin}
                  className="transition-colors hover:text-[#F3D5DF]"
                >
                  Login
                </button>
              )}
              {hasInstagram && (
                <a
                  href={`https://instagram.com/${cleanInstagramHandle}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-[#F3D5DF] transition-colors hover:text-[#FFF9F5]"
                >
                  Follow Our Style
                </a>
              )}
            </nav>
          </div>

          <div className="mt-6 flex flex-col gap-2 text-xs text-[#FFF9F5]/70 sm:flex-row sm:items-center sm:justify-between">
            <p>
              &copy; {currentYear} {SITE_CONFIG.brandName}. All rights reserved.
            </p>
            <p>
              Showcase product listings and INR prices are editable demo catalog entries.
            </p>
          </div>
        </div>
      </footer>
    </>
  );
}
