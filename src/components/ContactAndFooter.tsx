import { useState, type FormEvent } from 'react';
import {
  CheckCircle2,
  Instagram,
  Loader2,
  Mail,
  MapPin,
  MessageCircle,
  Send,
} from 'lucide-react';
import {
  formatWhatsAppDisplay,
  isAddressConfigured,
  isInstagramConfigured,
  resolveBoutiqueEmail,
  resolveWhatsAppDigits,
} from '../config/site';
import { useAuth } from '../context/AuthContext';
import { useStorefront } from '../context/StorefrontContext';
import { RevealSection } from './RevealSection';

interface ContactAndFooterProps {
  onNavigateAuth?: () => void;
  accountLabel?: string;
  onOpenStylist?: () => void;
}

export function ContactAndFooter({
  onNavigateAuth,
  accountLabel = 'Account / Login',
  onOpenStylist,
}: ContactAndFooterProps) {
  const { apiRequest } = useAuth();
  const { settings } = useStorefront();
  const { contact, socialLinks, brandName, tagline, logoUrl } = settings;

  const hasInstagram = isInstagramConfigured(contact);
  const hasAddress = isAddressConfigured(contact);
  const currentYear = new Date().getFullYear();

  const cleanInstagramHandle = contact.instagramHandle.replace(/^@/, '').trim();
  const cleanWhatsApp = resolveWhatsAppDigits(contact);
  const displayWhatsApp = formatWhatsAppDisplay(cleanWhatsApp);
  const boutiqueEmail = resolveBoutiqueEmail(contact);
  const instagramLink =
    socialLinks.instagramUrl ||
    (hasInstagram ? `https://instagram.com/${cleanInstagramHandle}` : '');

  const [senderName, setSenderName] = useState('');
  const [senderEmail, setSenderEmail] = useState('');
  const [senderPhone, setSenderPhone] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState<string | null>(null);

  const handleEnquirySubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitError(null);
    setSubmitSuccess(null);
    setSubmitting(true);
    try {
      const res = await apiRequest<{ id: string; message: string }>('/api/contact', {
        method: 'POST',
        body: JSON.stringify({
          senderName,
          senderEmail,
          senderPhone,
          subject,
          message,
        }),
      });
      if (!res.ok) {
        setSubmitError(res.error);
        return;
      }
      setSenderName('');
      setSenderEmail('');
      setSenderPhone('');
      setSubject('');
      setMessage('');
      setSubmitSuccess(res.data.message);
    } finally {
      setSubmitting(false);
    }
  };

  const activeSocials = [
    { label: 'Instagram', url: instagramLink },
    { label: 'Facebook', url: socialLinks.facebookUrl },
    { label: 'Pinterest', url: socialLinks.pinterestUrl },
    { label: 'YouTube', url: socialLinks.youtubeUrl },
  ].filter((item) => item.url.trim().length > 0);

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
                  Connect With {brandName}
                </h2>
              </div>
              <p className="max-w-md text-sm leading-relaxed text-[#242124]/75">
                Reach out for sizing guidance, custom outfit styling, or bridal and festive enquiries with our boutique team.
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
                  <p className="mt-2 text-sm text-[#242124]/80 tabular-nums">
                    {displayWhatsApp}
                  </p>
                  <p className="mt-1 text-xs text-[#242124]/65">
                    24/7 automated AI styling recommendations &amp; direct WhatsApp concierge.
                  </p>
                </div>

                <div className="mt-5 flex flex-col gap-2">
                  {onOpenStylist && (
                    <button
                      type="button"
                      onClick={onOpenStylist}
                      className="inline-flex min-h-[42px] items-center justify-center rounded-xl bg-[#49243E] px-4 py-2 text-xs font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31]"
                    >
                      Ask AI Stylist
                    </button>
                  )}
                  <a
                    href={`https://wa.me/${cleanWhatsApp}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`inline-flex min-h-[42px] items-center justify-center rounded-xl px-4 py-2 text-xs font-medium transition-colors ${
                      onOpenStylist
                        ? 'border border-[#49243E]/25 text-[#49243E] hover:bg-[#F3D5DF]/35'
                        : 'bg-[#49243E] text-[#FFF9F5] hover:bg-[#3A1B31]'
                    }`}
                  >
                    Message on WhatsApp
                  </a>
                </div>
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
                      Explore seasonal lookbooks, festive edits, and daily atelier styling inspiration.
                    </p>
                  )}
                </div>

                {instagramLink ? (
                  <a
                    href={instagramLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-5 inline-flex min-h-[42px] items-center justify-center rounded-xl border border-[#49243E]/25 px-4 py-2 text-xs font-medium text-[#49243E] transition-colors hover:bg-[#49243E] hover:text-[#FFF9F5]"
                  >
                    Follow Our Style
                  </a>
                ) : (
                  <a
                    href="#lookbook"
                    className="mt-5 inline-flex min-h-[42px] items-center justify-center rounded-xl border border-[#49243E]/20 px-4 py-2 text-xs font-medium text-[#49243E] transition-colors hover:bg-[#F3D5DF]/35"
                  >
                    Browse Lookbook
                  </a>
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
                  <p className="mt-2 break-all text-sm text-[#242124]/80">{boutiqueEmail}</p>
                </div>

                <a
                  href={`mailto:${boutiqueEmail}`}
                  className="mt-5 inline-flex min-h-[42px] items-center justify-center rounded-xl border border-[#49243E]/25 px-4 py-2 text-xs font-medium text-[#49243E] transition-colors hover:bg-[#49243E] hover:text-[#FFF9F5]"
                >
                  Send an Email
                </a>
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
                    Atelier Showroom
                  </h3>
                  {hasAddress ? (
                    <p className="mt-2 text-sm leading-relaxed text-[#242124]/80">
                      {contact.storeAddress}
                    </p>
                  ) : (
                    <p className="mt-2 text-sm text-[#242124]/65">
                      Private appointments and curated collections crafted for your special occasions.
                    </p>
                  )}
                </div>

                <span className="mt-5 inline-block text-xs font-medium text-[#49243E]/75">
                  {contact.hoursNote || 'Mon – Sat · 10:30 AM – 8:00 PM IST'}
                </span>
              </div>
            </RevealSection>
          </div>

          {/* Direct Boutique Enquiry Form */}
          <RevealSection delay={0.18}>
            <div
              id="boutique-enquiry-form"
              className="mt-8 rounded-3xl border border-[#49243E]/12 bg-white p-6 sm:p-8"
            >
              <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
                <div className="lg:col-span-5">
                  <p className="text-xs font-medium tracking-[0.2em] uppercase text-[#B76E79]">
                    Direct Message
                  </p>
                  <h3 className="mt-2 font-serif text-2xl font-semibold text-[#49243E] sm:text-3xl">
                    Send a Boutique Enquiry
                  </h3>
                  <p className="mt-2.5 text-sm leading-relaxed text-[#242124]/75">
                    Have a question about fabric details, custom sizing, or availability? Leave us a note and our team will respond promptly.
                  </p>
                  {activeSocials.length > 0 && (
                    <div className="mt-5 flex flex-wrap gap-2">
                      {activeSocials.map((soc) => (
                        <a
                          key={soc.label}
                          href={soc.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex min-h-[38px] items-center rounded-xl border border-[#49243E]/18 px-3.5 text-xs font-medium text-[#49243E] transition-colors hover:bg-[#F3D5DF]/40"
                        >
                          {soc.label}
                        </a>
                      ))}
                    </div>
                  )}
                </div>

                <form onSubmit={handleEnquirySubmit} className="space-y-4 lg:col-span-7">
                  {submitError && (
                    <div
                      role="alert"
                      className="rounded-xl border border-[#B76E79]/50 bg-[#F3D5DF]/35 px-4 py-3 text-xs font-medium text-[#49243E]"
                    >
                      {submitError}
                    </div>
                  )}
                  {submitSuccess && (
                    <div
                      role="status"
                      className="flex items-center gap-2 rounded-xl border border-[#166534]/25 bg-[#F0FDF4] px-4 py-3 text-xs font-medium text-[#166534]"
                    >
                      <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                      <span>{submitSuccess}</span>
                    </div>
                  )}

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <label htmlFor="enquiry-name" className="block text-xs font-medium text-[#49243E]">
                        Your Name
                      </label>
                      <input
                        id="enquiry-name"
                        type="text"
                        required
                        minLength={2}
                        maxLength={100}
                        value={senderName}
                        onChange={(e) => setSenderName(e.target.value)}
                        placeholder="Ananya Rao"
                        className="mt-1 h-11 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/60 px-3.5 text-sm focus:border-[#49243E] focus:bg-white focus:outline-none"
                      />
                    </div>
                    <div>
                      <label htmlFor="enquiry-email" className="block text-xs font-medium text-[#49243E]">
                        Email Address
                      </label>
                      <input
                        id="enquiry-email"
                        type="email"
                        required
                        value={senderEmail}
                        onChange={(e) => setSenderEmail(e.target.value)}
                        placeholder="you@example.com"
                        className="mt-1 h-11 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/60 px-3.5 text-sm focus:border-[#49243E] focus:bg-white focus:outline-none"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <label htmlFor="enquiry-phone" className="block text-xs font-medium text-[#49243E]">
                        Phone / WhatsApp (optional)
                      </label>
                      <input
                        id="enquiry-phone"
                        type="tel"
                        maxLength={24}
                        value={senderPhone}
                        onChange={(e) => setSenderPhone(e.target.value)}
                        placeholder="+91 98765 43210"
                        className="mt-1 h-11 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/60 px-3.5 text-sm focus:border-[#49243E] focus:bg-white focus:outline-none"
                      />
                    </div>
                    <div>
                      <label htmlFor="enquiry-subject" className="block text-xs font-medium text-[#49243E]">
                        Subject
                      </label>
                      <input
                        id="enquiry-subject"
                        type="text"
                        required
                        minLength={2}
                        maxLength={140}
                        value={subject}
                        onChange={(e) => setSubject(e.target.value)}
                        placeholder="Custom sizing or order enquiry"
                        className="mt-1 h-11 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/60 px-3.5 text-sm focus:border-[#49243E] focus:bg-white focus:outline-none"
                      />
                    </div>
                  </div>

                  <div>
                    <label htmlFor="enquiry-message" className="block text-xs font-medium text-[#49243E]">
                      Message
                    </label>
                    <textarea
                      id="enquiry-message"
                      rows={3}
                      required
                      minLength={5}
                      maxLength={2000}
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      placeholder="Share the design name, size preference, or occasion date..."
                      className="mt-1 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/60 p-3.5 text-sm focus:border-[#49243E] focus:bg-white focus:outline-none"
                    />
                  </div>

                  <div className="flex justify-end">
                    <button
                      type="submit"
                      disabled={submitting}
                      className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-[#49243E] px-6 text-sm font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31] disabled:opacity-60"
                    >
                      {submitting ? (
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      ) : (
                        <Send className="h-4 w-4" aria-hidden="true" />
                      )}
                      <span>{submitting ? 'Sending enquiry...' : 'Send Enquiry'}</span>
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </RevealSection>
        </div>
      </section>

      <footer className="bg-[#49243E] py-12 text-[#FFF9F5]">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-8 border-b border-[#FFF9F5]/15 pb-8 md:flex-row md:items-center md:justify-between">
            <div className="flex items-center gap-3">
              {logoUrl && (
                <img
                  src={logoUrl}
                  alt=""
                  className="h-10 w-10 rounded-full border border-[#FFF9F5]/25 object-cover"
                />
              )}
              <div>
                <a
                  href="#home"
                  className="font-serif text-2xl font-semibold tracking-tight text-[#FFF9F5]"
                >
                  {brandName}
                </a>
                <p className="mt-1 text-sm italic font-serif text-[#F3D5DF]">
                  {tagline}
                </p>
              </div>
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
              {onNavigateAuth && (
                <button
                  type="button"
                  onClick={onNavigateAuth}
                  className="transition-colors hover:text-[#F3D5DF]"
                >
                  {accountLabel}
                </button>
              )}
              {activeSocials.map((soc) => (
                <a
                  key={soc.label}
                  href={soc.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-[#F3D5DF] transition-colors hover:text-[#FFF9F5]"
                >
                  {soc.label}
                </a>
              ))}
            </nav>
          </div>

          <div className="mt-6 flex flex-col gap-2 text-xs text-[#FFF9F5]/70 sm:flex-row sm:items-center sm:justify-between">
            <p>
              &copy; {currentYear} {brandName}. All rights reserved.
            </p>
            <p className="tabular-nums">
              WhatsApp: <a href={`https://wa.me/${cleanWhatsApp}`} target="_blank" rel="noopener noreferrer" className="text-[#F3D5DF] hover:underline">{displayWhatsApp}</a> · <a href={`mailto:${boutiqueEmail}`} className="text-[#F3D5DF] hover:underline">{boutiqueEmail}</a>
            </p>
          </div>
        </div>
      </footer>
    </>
  );
}
