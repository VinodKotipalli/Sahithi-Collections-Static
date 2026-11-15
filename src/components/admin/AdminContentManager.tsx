import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Plus,
  Save,
  Trash2,
  Upload,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import type { LookbookEntry, StorefrontCategory, StorefrontContent } from '../../types/boutique';
import { BoutiqueImage } from '../BoutiqueImage';

interface AdminContentManagerProps {
  categories: StorefrontCategory[];
  onNotify: (kind: 'ok' | 'err', text: string) => void;
  onMutated: () => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}

type ContentSectionTab = 'hero' | 'banners' | 'lookbook' | 'about';

function subTabForField(fieldKey: string): ContentSectionTab {
  if (fieldKey.startsWith('hero.')) return 'hero';
  if (fieldKey.startsWith('collectionsHeader.') || fieldKey.startsWith('showcaseHeader.') || fieldKey.startsWith('spotlightEdit.')) {
    return 'banners';
  }
  if (fieldKey.startsWith('lookbookHeader.') || fieldKey.startsWith('lookbookEntries.')) {
    return 'lookbook';
  }
  return 'about';
}

function validateContentClient(c: StorefrontContent): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!c.hero.headline.trim()) {
    errors['hero.headline'] = 'Hero headline is required.';
  } else if (c.hero.headline.trim().length > 160) {
    errors['hero.headline'] = 'Hero headline must be 160 characters or fewer.';
  }
  if (!c.hero.supportingText.trim()) {
    errors['hero.supportingText'] = 'Supporting description is required.';
  } else if (c.hero.supportingText.trim().length > 500) {
    errors['hero.supportingText'] = 'Supporting description must be 500 characters or fewer.';
  }
  if (!c.hero.primaryCta.trim()) {
    errors['hero.primaryCta'] = 'Primary CTA button label is required.';
  } else if (c.hero.primaryCta.trim().length > 60) {
    errors['hero.primaryCta'] = 'Primary CTA label must be 60 characters or fewer.';
  }
  if (!c.hero.mainImage.src.trim()) {
    errors['hero.mainImage.src'] = 'Main hero photo is required.';
  }

  if (!c.collectionsHeader.heading.trim()) {
    errors['collectionsHeader.heading'] = 'Collections section heading is required.';
  }
  if (!c.showcaseHeader.heading.trim()) {
    errors['showcaseHeader.heading'] = 'Showcase section heading is required.';
  }
  if (!c.spotlightEdit.title.trim()) {
    errors['spotlightEdit.title'] = 'Spotlight Edit title is required.';
  }
  if (!c.spotlightEdit.description.trim()) {
    errors['spotlightEdit.description'] = 'Spotlight Edit description is required.';
  }
  if (!c.spotlightEdit.ctaLabel.trim()) {
    errors['spotlightEdit.ctaLabel'] = 'Spotlight CTA button label is required.';
  }
  if (!c.spotlightEdit.image.src.trim()) {
    errors['spotlightEdit.image.src'] = 'Spotlight Edit image is required.';
  }

  if (!c.lookbookHeader.heading.trim()) {
    errors['lookbookHeader.heading'] = 'Lookbook section heading is required.';
  }
  c.lookbookEntries.forEach((entry, idx) => {
    if (!entry.title.trim()) {
      errors[`lookbookEntries.${idx}.title`] = `Lookbook frame #${idx + 1} requires a title.`;
    }
    if (!entry.image.trim()) {
      errors[`lookbookEntries.${idx}.image`] = `Lookbook frame #${idx + 1} requires an image.`;
    }
  });

  if (!c.about.heading.trim()) {
    errors['about.heading'] = 'Brand story heading is required.';
  }
  if (c.about.paragraphs.filter((p) => p.trim().length > 0).length === 0) {
    errors['about.paragraphs'] = 'Please include at least one non-empty brand story paragraph.';
  }
  if (!c.about.image.src.trim()) {
    errors['about.image.src'] = 'About portrait image is required.';
  }

  return errors;
}

export function AdminContentManager({
  categories,
  onNotify,
  onMutated,
  onDirtyChange,
}: AdminContentManagerProps) {
  const { apiRequest } = useAuth();
  const topRef = useRef<HTMLDivElement>(null);
  const onNotifyRef = useRef(onNotify);
  onNotifyRef.current = onNotify;
  const hasLoadedRef = useRef(false);

  const [content, setContent] = useState<StorefrontContent | null>(null);
  const [baselineSnapshot, setBaselineSnapshot] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingKey, setUploadingKey] = useState<string | null>(null);
  const [subTab, setSubTab] = useState<ContentSectionTab>('hero');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saveBanner, setSaveBanner] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!hasLoadedRef.current) setLoading(true);
      const res = await apiRequest<{ content: StorefrontContent }>('/api/admin/content');
      if (!active) return;
      setLoading(false);
      if (res.ok) {
        hasLoadedRef.current = true;
        setContent(res.data.content);
        setBaselineSnapshot(JSON.stringify(res.data.content));
      } else {
        onNotifyRef.current('err', res.error);
      }
    })();
    return () => {
      active = false;
    };
  }, [apiRequest]);

  const isDirty = useMemo(
    () => Boolean(content && baselineSnapshot && JSON.stringify(content) !== baselineSnapshot),
    [content, baselineSnapshot]
  );

  useEffect(() => {
    onDirtyChange?.(isDirty);
    return () => {
      onDirtyChange?.(false);
    };
  }, [isDirty, onDirtyChange]);

  useEffect(() => {
    if (!isDirty) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);

  const clearFieldError = (key: string) => {
    setSaveBanner(null);
    setFieldErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const uploadSinglePhoto = async (
    key: string,
    fieldKey: string,
    file: File | undefined,
    onUrl: (url: string) => void
  ) => {
    if (!file) return;
    clearFieldError(fieldKey);
    if (file.size > 5 * 1024 * 1024) {
      const msg = 'Image file must be 5 MB or smaller.';
      setFieldErrors((prev) => ({ ...prev, [fieldKey]: msg }));
      setSaveBanner({ kind: 'err', text: msg });
      onNotify('err', msg);
      return;
    }
    setUploadingKey(key);
    try {
      const fd = new FormData();
      fd.append('files', file);
      const res = await apiRequest<{ files: Array<{ url: string }> }>('/api/admin/uploads', {
        method: 'POST',
        body: fd,
      });
      if (!res.ok) {
        setFieldErrors((prev) => ({ ...prev, [fieldKey]: res.error }));
        setSaveBanner({ kind: 'err', text: res.error });
        onNotify('err', res.error);
        return;
      }
      const url = res.data.files[0]?.url;
      if (url) {
        onUrl(url);
        onNotify('ok', 'Photo uploaded. Click Save & Publish Content to apply it live.');
      }
    } finally {
      setUploadingKey(null);
    }
  };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    if (!content || saving || uploadingKey !== null) return;
    setSaveBanner(null);

    const clientErrors = validateContentClient(content);
    if (Object.keys(clientErrors).length > 0) {
      setFieldErrors(clientErrors);
      const firstKey = Object.keys(clientErrors)[0];
      const firstMsg = clientErrors[firstKey];
      setSubTab(subTabForField(firstKey));
      setSaveBanner({ kind: 'err', text: firstMsg });
      onNotify('err', firstMsg);
      topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }

    setFieldErrors({});
    setSaving(true);
    try {
      const res = await apiRequest<{ content: StorefrontContent }>('/api/admin/content', {
        method: 'PUT',
        body: JSON.stringify(content),
      });
      if (!res.ok) {
        if (res.fieldErrors && Object.keys(res.fieldErrors).length > 0) {
          setFieldErrors(res.fieldErrors);
          const firstKey = Object.keys(res.fieldErrors)[0];
          setSubTab(subTabForField(firstKey));
        }
        setSaveBanner({ kind: 'err', text: res.error });
        onNotify('err', res.error);
        topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return;
      }
      setContent(res.data.content);
      setBaselineSnapshot(JSON.stringify(res.data.content));
      setSaveBanner({ kind: 'ok', text: 'Storefront content updated live.' });
      onNotify('ok', 'Storefront content updated live.');
      await onMutated();
    } finally {
      setSaving(false);
    }
  };

  const subTabHasError = useMemo(() => {
    const map: Record<ContentSectionTab, boolean> = {
      hero: false,
      banners: false,
      lookbook: false,
      about: false,
    };
    for (const key of Object.keys(fieldErrors)) {
      map[subTabForField(key)] = true;
    }
    return map;
  }, [fieldErrors]);

  if (loading || !content) {
    return (
      <div className="space-y-4 rounded-3xl border border-[#49243E]/12 bg-white p-6">
        {Array.from({ length: 4 }).map((_, idx) => (
          <div key={idx} className="h-20 animate-pulse rounded-2xl bg-[#FFF9F5]" />
        ))}
      </div>
    );
  }

  const categoryNames = categories.length > 0 ? categories.map((c) => c.name) : ['Festive Collection'];

  const subTabs: Array<{ id: ContentSectionTab; label: string }> = [
    { id: 'hero', label: 'Hero Banner' },
    { id: 'banners', label: 'Headers & Spotlight' },
    { id: 'lookbook', label: 'Lookbook' },
    { id: 'about', label: 'About Section' },
  ];

  return (
    <form onSubmit={handleSave} noValidate className="space-y-6">
      {/* Header & Section Tabs */}
      <div
        ref={topRef}
        className="flex flex-wrap items-center justify-between gap-4 rounded-3xl border border-[#49243E]/12 bg-white p-5 sm:p-6"
      >
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="font-serif text-2xl font-semibold text-[#49243E]">
              Content Management
            </h2>
            {isDirty ? (
              <span className="rounded-md bg-[#F3D5DF]/65 px-2 py-0.5 text-[11px] font-semibold text-[#49243E]">
                Unsaved changes
              </span>
            ) : (
              <span className="rounded-md bg-[#F0FDF4] px-2 py-0.5 text-[11px] font-medium text-[#166534]">
                All changes saved
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-[#242124]/65">
            Edit homepage banners, featured spotlight copy, editorial lookbook frames, and story imagery.
          </p>
        </div>

        <button
          type="submit"
          disabled={saving || uploadingKey !== null}
          className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-[#49243E] px-5 text-xs font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31] disabled:opacity-55"
        >
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Save className="h-4 w-4" aria-hidden="true" />
          )}
          <span>{saving ? 'Saving Content...' : 'Save & Publish Content'}</span>
        </button>

        {saveBanner && (
          <div
            role={saveBanner.kind === 'err' ? 'alert' : 'status'}
            className={`flex w-full items-center gap-2 rounded-2xl border px-4 py-2.5 text-xs font-medium ${
              saveBanner.kind === 'ok'
                ? 'border-[#166534]/25 bg-[#F0FDF4] text-[#166534]'
                : 'border-[#B76E79]/55 bg-[#F3D5DF]/35 text-[#49243E]'
            }`}
          >
            {saveBanner.kind === 'ok' ? (
              <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
            ) : (
              <AlertTriangle className="h-4 w-4 shrink-0 text-[#B76E79]" aria-hidden="true" />
            )}
            <span>{saveBanner.text}</span>
          </div>
        )}

        <div
          role="tablist"
          aria-label="Storefront content sections"
          className="flex w-full flex-wrap gap-1.5 border-t border-[#49243E]/10 pt-4"
        >
          {subTabs.map((item) => {
            const active = subTab === item.id;
            const hasErr = subTabHasError[item.id];
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setSubTab(item.id)}
                className={`inline-flex min-h-[40px] items-center gap-1.5 rounded-xl px-4 text-xs font-medium transition-colors ${
                  active
                    ? 'bg-[#49243E] text-[#FFF9F5]'
                    : 'bg-[#FFF9F5] text-[#49243E] hover:bg-[#F3D5DF]/40'
                }`}
              >
                <span>{item.label}</span>
                {hasErr && (
                  <span
                    className={`h-2 w-2 rounded-full ${active ? 'bg-[#F3D5DF]' : 'bg-[#9F1239]'}`}
                    aria-label="Contains validation errors"
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* HERO TAB */}
      {subTab === 'hero' && (
        <section className="space-y-5 rounded-3xl border border-[#49243E]/12 bg-white p-5 sm:p-6">
          <h3 className="font-serif text-xl font-semibold text-[#49243E]">Hero Showcase</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="cms-hero-eyebrow" className="block text-xs font-medium text-[#49243E]">
                Eyebrow Label
              </label>
              <input
                id="cms-hero-eyebrow"
                type="text"
                value={content.hero.eyebrow}
                onChange={(e) => {
                  clearFieldError('hero.eyebrow');
                  setContent((p) => (p ? { ...p, hero: { ...p.hero, eyebrow: e.target.value } } : p));
                }}
                className="mt-1 h-11 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/60 px-3.5 text-sm focus:border-[#49243E] focus:bg-white focus:outline-none"
              />
              {fieldErrors['hero.eyebrow'] && (
                <p className="mt-1 text-xs font-medium text-[#9F1239]">{fieldErrors['hero.eyebrow']}</p>
              )}
            </div>

            <div>
              <label htmlFor="cms-hero-headline" className="block text-xs font-medium text-[#49243E]">
                Hero Headline
              </label>
              <input
                id="cms-hero-headline"
                type="text"
                value={content.hero.headline}
                onChange={(e) => {
                  clearFieldError('hero.headline');
                  setContent((p) => (p ? { ...p, hero: { ...p.hero, headline: e.target.value } } : p));
                }}
                aria-invalid={Boolean(fieldErrors['hero.headline'])}
                className={`mt-1 h-11 w-full rounded-xl border bg-[#FFF9F5]/60 px-3.5 text-sm focus:bg-white focus:outline-none ${
                  fieldErrors['hero.headline']
                    ? 'border-[#9F1239] focus:border-[#9F1239]'
                    : 'border-[#49243E]/18 focus:border-[#49243E]'
                }`}
              />
              {fieldErrors['hero.headline'] && (
                <p className="mt-1 text-xs font-medium text-[#9F1239]">{fieldErrors['hero.headline']}</p>
              )}
            </div>

            <div className="sm:col-span-2">
              <label htmlFor="cms-hero-support" className="block text-xs font-medium text-[#49243E]">
                Supporting Text
              </label>
              <textarea
                id="cms-hero-support"
                rows={2}
                value={content.hero.supportingText}
                onChange={(e) => {
                  clearFieldError('hero.supportingText');
                  setContent((p) =>
                    p ? { ...p, hero: { ...p.hero, supportingText: e.target.value } } : p
                  );
                }}
                aria-invalid={Boolean(fieldErrors['hero.supportingText'])}
                className={`mt-1 w-full rounded-xl border bg-[#FFF9F5]/60 p-3.5 text-sm focus:bg-white focus:outline-none ${
                  fieldErrors['hero.supportingText']
                    ? 'border-[#9F1239] focus:border-[#9F1239]'
                    : 'border-[#49243E]/18 focus:border-[#49243E]'
                }`}
              />
              {fieldErrors['hero.supportingText'] && (
                <p className="mt-1 text-xs font-medium text-[#9F1239]">
                  {fieldErrors['hero.supportingText']}
                </p>
              )}
            </div>

            <div>
              <label htmlFor="cms-hero-primary-cta" className="block text-xs font-medium text-[#49243E]">
                Primary CTA Label
              </label>
              <input
                id="cms-hero-primary-cta"
                type="text"
                value={content.hero.primaryCta}
                onChange={(e) => {
                  clearFieldError('hero.primaryCta');
                  setContent((p) =>
                    p ? { ...p, hero: { ...p.hero, primaryCta: e.target.value } } : p
                  );
                }}
                aria-invalid={Boolean(fieldErrors['hero.primaryCta'])}
                className={`mt-1 h-11 w-full rounded-xl border bg-[#FFF9F5]/60 px-3.5 text-sm focus:bg-white focus:outline-none ${
                  fieldErrors['hero.primaryCta']
                    ? 'border-[#9F1239] focus:border-[#9F1239]'
                    : 'border-[#49243E]/18 focus:border-[#49243E]'
                }`}
              />
              {fieldErrors['hero.primaryCta'] && (
                <p className="mt-1 text-xs font-medium text-[#9F1239]">{fieldErrors['hero.primaryCta']}</p>
              )}
            </div>

            <div>
              <label htmlFor="cms-hero-secondary-cta" className="block text-xs font-medium text-[#49243E]">
                Secondary CTA Label
              </label>
              <input
                id="cms-hero-secondary-cta"
                type="text"
                value={content.hero.secondaryCta}
                onChange={(e) => {
                  clearFieldError('hero.secondaryCta');
                  setContent((p) =>
                    p ? { ...p, hero: { ...p.hero, secondaryCta: e.target.value } } : p
                  );
                }}
                className="mt-1 h-11 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/60 px-3.5 text-sm focus:border-[#49243E] focus:bg-white focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="cms-hero-float1" className="block text-xs font-medium text-[#49243E]">
                Floating Note 1
              </label>
              <input
                id="cms-hero-float1"
                type="text"
                value={content.hero.floatingLabels[0]}
                onChange={(e) => {
                  clearFieldError('hero.floatingLabels');
                  setContent((p) =>
                    p
                      ? {
                          ...p,
                          hero: {
                            ...p.hero,
                            floatingLabels: [e.target.value, p.hero.floatingLabels[1]],
                          },
                        }
                      : p
                  );
                }}
                className="mt-1 h-11 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/60 px-3.5 text-sm focus:border-[#49243E] focus:bg-white focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="cms-hero-float2" className="block text-xs font-medium text-[#49243E]">
                Floating Note 2
              </label>
              <input
                id="cms-hero-float2"
                type="text"
                value={content.hero.floatingLabels[1]}
                onChange={(e) => {
                  clearFieldError('hero.floatingLabels');
                  setContent((p) =>
                    p
                      ? {
                          ...p,
                          hero: {
                            ...p.hero,
                            floatingLabels: [p.hero.floatingLabels[0], e.target.value],
                          },
                        }
                      : p
                  );
                }}
                className="mt-1 h-11 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/60 px-3.5 text-sm focus:border-[#49243E] focus:bg-white focus:outline-none"
              />
            </div>
          </div>

          {/* Hero Primary Image */}
          <div className="space-y-2 border-t border-[#49243E]/10 pt-5">
            <div className="flex flex-wrap items-center gap-4">
              <div className="h-28 w-20 shrink-0 overflow-hidden rounded-xl border border-[#49243E]/12 bg-[#F8F1ED]">
                <BoutiqueImage
                  src={content.hero.mainImage.src}
                  alt={content.hero.mainImage.alt}
                  loading="eager"
                  className="h-full w-full object-cover object-top"
                />
              </div>
              <div className="min-w-0 flex-1 space-y-2">
                <label className="block text-xs font-medium text-[#49243E]">
                  Main Hero Portrait Alt Text
                </label>
                <input
                  type="text"
                  value={content.hero.mainImage.alt}
                  onChange={(e) =>
                    setContent((p) =>
                      p
                        ? {
                            ...p,
                            hero: {
                              ...p.hero,
                              mainImage: { ...p.hero.mainImage, alt: e.target.value },
                            },
                          }
                        : p
                    )
                  }
                  className="h-10 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/60 px-3 text-xs focus:border-[#49243E] focus:bg-white focus:outline-none"
                />
                <label className="inline-flex min-h-[40px] cursor-pointer items-center gap-2 rounded-xl border border-[#49243E]/20 bg-[#FFF9F5] px-3.5 text-xs font-medium text-[#49243E] hover:bg-[#F3D5DF]/40">
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="sr-only"
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      void uploadSinglePhoto('hero-main', 'hero.mainImage.src', e.target.files?.[0], (url) =>
                        setContent((p) =>
                          p
                            ? { ...p, hero: { ...p.hero, mainImage: { ...p.hero.mainImage, src: url } } }
                            : p
                        )
                      )
                    }
                  />
                  {uploadingKey === 'hero-main' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  <span>Upload Hero Image</span>
                </label>
              </div>
            </div>
            {fieldErrors['hero.mainImage.src'] && (
              <p className="text-xs font-medium text-[#9F1239]">{fieldErrors['hero.mainImage.src']}</p>
            )}
          </div>
        </section>
      )}

      {/* BANNERS & SPOTLIGHT TAB */}
      {subTab === 'banners' && (
        <div className="space-y-6">
          <section className="space-y-4 rounded-3xl border border-[#49243E]/12 bg-white p-5 sm:p-6">
            <h3 className="font-serif text-xl font-semibold text-[#49243E]">
              Collections &amp; Showcase Section Headings
            </h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-[#49243E]">Collections Kicker</label>
                <input
                  type="text"
                  value={content.collectionsHeader.kicker}
                  onChange={(e) =>
                    setContent((p) =>
                      p
                        ? {
                            ...p,
                            collectionsHeader: { ...p.collectionsHeader, kicker: e.target.value },
                          }
                        : p
                    )
                  }
                  className="mt-1 h-11 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/60 px-3.5 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[#49243E]">Collections Heading</label>
                <input
                  type="text"
                  value={content.collectionsHeader.heading}
                  onChange={(e) => {
                    clearFieldError('collectionsHeader.heading');
                    setContent((p) =>
                      p
                        ? {
                            ...p,
                            collectionsHeader: { ...p.collectionsHeader, heading: e.target.value },
                          }
                        : p
                    );
                  }}
                  aria-invalid={Boolean(fieldErrors['collectionsHeader.heading'])}
                  className={`mt-1 h-11 w-full rounded-xl border bg-[#FFF9F5]/60 px-3.5 text-sm ${
                    fieldErrors['collectionsHeader.heading']
                      ? 'border-[#9F1239]'
                      : 'border-[#49243E]/18'
                  }`}
                />
                {fieldErrors['collectionsHeader.heading'] && (
                  <p className="mt-1 text-xs font-medium text-[#9F1239]">
                    {fieldErrors['collectionsHeader.heading']}
                  </p>
                )}
              </div>
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-[#49243E]">Collections Subtitle</label>
                <input
                  type="text"
                  value={content.collectionsHeader.subtitle}
                  onChange={(e) =>
                    setContent((p) =>
                      p
                        ? {
                            ...p,
                            collectionsHeader: { ...p.collectionsHeader, subtitle: e.target.value },
                          }
                        : p
                    )
                  }
                  className="mt-1 h-11 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/60 px-3.5 text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-[#49243E]">Showcase Kicker</label>
                <input
                  type="text"
                  value={content.showcaseHeader.kicker}
                  onChange={(e) =>
                    setContent((p) =>
                      p ? { ...p, showcaseHeader: { ...p.showcaseHeader, kicker: e.target.value } } : p
                    )
                  }
                  className="mt-1 h-11 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/60 px-3.5 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[#49243E]">Showcase Heading</label>
                <input
                  type="text"
                  value={content.showcaseHeader.heading}
                  onChange={(e) => {
                    clearFieldError('showcaseHeader.heading');
                    setContent((p) =>
                      p
                        ? { ...p, showcaseHeader: { ...p.showcaseHeader, heading: e.target.value } }
                        : p
                    );
                  }}
                  aria-invalid={Boolean(fieldErrors['showcaseHeader.heading'])}
                  className={`mt-1 h-11 w-full rounded-xl border bg-[#FFF9F5]/60 px-3.5 text-sm ${
                    fieldErrors['showcaseHeader.heading']
                      ? 'border-[#9F1239]'
                      : 'border-[#49243E]/18'
                  }`}
                />
                {fieldErrors['showcaseHeader.heading'] && (
                  <p className="mt-1 text-xs font-medium text-[#9F1239]">
                    {fieldErrors['showcaseHeader.heading']}
                  </p>
                )}
              </div>
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-[#49243E]">Showcase Subtitle</label>
                <input
                  type="text"
                  value={content.showcaseHeader.subtitle}
                  onChange={(e) =>
                    setContent((p) =>
                      p
                        ? { ...p, showcaseHeader: { ...p.showcaseHeader, subtitle: e.target.value } }
                        : p
                    )
                  }
                  className="mt-1 h-11 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/60 px-3.5 text-sm"
                />
              </div>
            </div>
          </section>

          <section className="space-y-4 rounded-3xl border border-[#49243E]/12 bg-white p-5 sm:p-6">
            <h3 className="font-serif text-xl font-semibold text-[#49243E]">
              Featured Spotlight Edit Banner
            </h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-[#49243E]">Kicker</label>
                <input
                  type="text"
                  value={content.spotlightEdit.kicker}
                  onChange={(e) =>
                    setContent((p) =>
                      p ? { ...p, spotlightEdit: { ...p.spotlightEdit, kicker: e.target.value } } : p
                    )
                  }
                  className="mt-1 h-11 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/60 px-3.5 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[#49243E]">Spotlight Title</label>
                <input
                  type="text"
                  value={content.spotlightEdit.title}
                  onChange={(e) => {
                    clearFieldError('spotlightEdit.title');
                    setContent((p) =>
                      p ? { ...p, spotlightEdit: { ...p.spotlightEdit, title: e.target.value } } : p
                    );
                  }}
                  aria-invalid={Boolean(fieldErrors['spotlightEdit.title'])}
                  className={`mt-1 h-11 w-full rounded-xl border bg-[#FFF9F5]/60 px-3.5 text-sm ${
                    fieldErrors['spotlightEdit.title'] ? 'border-[#9F1239]' : 'border-[#49243E]/18'
                  }`}
                />
                {fieldErrors['spotlightEdit.title'] && (
                  <p className="mt-1 text-xs font-medium text-[#9F1239]">
                    {fieldErrors['spotlightEdit.title']}
                  </p>
                )}
              </div>
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-[#49243E]">Italic Subtitle</label>
                <input
                  type="text"
                  value={content.spotlightEdit.subtitle}
                  onChange={(e) =>
                    setContent((p) =>
                      p
                        ? { ...p, spotlightEdit: { ...p.spotlightEdit, subtitle: e.target.value } }
                        : p
                    )
                  }
                  className="mt-1 h-11 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/60 px-3.5 text-sm"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-[#49243E]">Description</label>
                <textarea
                  rows={3}
                  value={content.spotlightEdit.description}
                  onChange={(e) => {
                    clearFieldError('spotlightEdit.description');
                    setContent((p) =>
                      p
                        ? { ...p, spotlightEdit: { ...p.spotlightEdit, description: e.target.value } }
                        : p
                    );
                  }}
                  aria-invalid={Boolean(fieldErrors['spotlightEdit.description'])}
                  className={`mt-1 w-full rounded-xl border bg-[#FFF9F5]/60 p-3.5 text-sm ${
                    fieldErrors['spotlightEdit.description']
                      ? 'border-[#9F1239]'
                      : 'border-[#49243E]/18'
                  }`}
                />
                {fieldErrors['spotlightEdit.description'] && (
                  <p className="mt-1 text-xs font-medium text-[#9F1239]">
                    {fieldErrors['spotlightEdit.description']}
                  </p>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-[#49243E]">Button Label</label>
                <input
                  type="text"
                  value={content.spotlightEdit.ctaLabel}
                  onChange={(e) => {
                    clearFieldError('spotlightEdit.ctaLabel');
                    setContent((p) =>
                      p
                        ? { ...p, spotlightEdit: { ...p.spotlightEdit, ctaLabel: e.target.value } }
                        : p
                    );
                  }}
                  aria-invalid={Boolean(fieldErrors['spotlightEdit.ctaLabel'])}
                  className={`mt-1 h-11 w-full rounded-xl border bg-[#FFF9F5]/60 px-3.5 text-sm ${
                    fieldErrors['spotlightEdit.ctaLabel']
                      ? 'border-[#9F1239]'
                      : 'border-[#49243E]/18'
                  }`}
                />
                {fieldErrors['spotlightEdit.ctaLabel'] && (
                  <p className="mt-1 text-xs font-medium text-[#9F1239]">
                    {fieldErrors['spotlightEdit.ctaLabel']}
                  </p>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-[#49243E]">Target Collection</label>
                <select
                  value={content.spotlightEdit.targetCategory}
                  onChange={(e) =>
                    setContent((p) =>
                      p
                        ? {
                            ...p,
                            spotlightEdit: { ...p.spotlightEdit, targetCategory: e.target.value },
                          }
                        : p
                    )
                  }
                  className="mt-1 h-11 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/60 px-3 text-sm text-[#49243E]"
                >
                  {categoryNames.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="space-y-2 border-t border-[#49243E]/10 pt-4">
              <div className="flex flex-wrap items-center gap-4">
                <div className="h-24 w-20 shrink-0 overflow-hidden rounded-xl border border-[#49243E]/12 bg-[#F8F1ED]">
                  <BoutiqueImage
                    src={content.spotlightEdit.image.src}
                    alt={content.spotlightEdit.image.alt}
                    loading="eager"
                    className="h-full w-full object-cover object-top"
                  />
                </div>
                <div className="min-w-0 flex-1 space-y-2">
                  <label className="block text-xs font-medium text-[#49243E]">Spotlight Image Alt Text</label>
                  <input
                    type="text"
                    value={content.spotlightEdit.image.alt}
                    onChange={(e) =>
                      setContent((p) =>
                        p
                          ? {
                              ...p,
                              spotlightEdit: {
                                ...p.spotlightEdit,
                                image: { ...p.spotlightEdit.image, alt: e.target.value },
                              },
                            }
                          : p
                      )
                    }
                    className="h-10 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/60 px-3 text-xs"
                  />
                  <label className="inline-flex min-h-[40px] cursor-pointer items-center gap-2 rounded-xl border border-[#49243E]/20 bg-[#FFF9F5] px-3.5 text-xs font-medium text-[#49243E] hover:bg-[#F3D5DF]/40">
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      className="sr-only"
                      onChange={(e: ChangeEvent<HTMLInputElement>) =>
                        void uploadSinglePhoto(
                          'spotlight',
                          'spotlightEdit.image.src',
                          e.target.files?.[0],
                          (url) =>
                            setContent((p) =>
                              p
                                ? {
                                    ...p,
                                    spotlightEdit: {
                                      ...p.spotlightEdit,
                                      image: { ...p.spotlightEdit.image, src: url },
                                    },
                                  }
                                : p
                            )
                        )
                      }
                    />
                    {uploadingKey === 'spotlight' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    <span>Upload Spotlight Image</span>
                  </label>
                </div>
              </div>
              {fieldErrors['spotlightEdit.image.src'] && (
                <p className="text-xs font-medium text-[#9F1239]">
                  {fieldErrors['spotlightEdit.image.src']}
                </p>
              )}
            </div>
          </section>
        </div>
      )}

      {/* LOOKBOOK TAB */}
      {subTab === 'lookbook' && (
        <section className="space-y-5 rounded-3xl border border-[#49243E]/12 bg-white p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-serif text-xl font-semibold text-[#49243E]">
              Lookbook Editorial Frames
            </h3>
            <button
              type="button"
              onClick={() =>
                setContent((p) => {
                  if (!p) return p;
                  const nextEntry: LookbookEntry = {
                    id: `lb-${Date.now()}`,
                    title: 'New Lookbook Frame',
                    caption: 'Editorial styling story crafted at Sahithi Collections.',
                    category: categoryNames[0] || 'Festive Collection',
                    image: p.spotlightEdit.image.src,
                    alt: 'Editorial lookbook silhouette',
                    layout: 'square',
                  };
                  return { ...p, lookbookEntries: [...p.lookbookEntries, nextEntry] };
                })
              }
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-[#49243E]/20 px-3.5 text-xs font-medium text-[#49243E] hover:bg-[#F3D5DF]/40"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Add Lookbook Frame</span>
            </button>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-[#49243E]">Lookbook Kicker</label>
              <input
                type="text"
                value={content.lookbookHeader.kicker}
                onChange={(e) =>
                  setContent((p) =>
                    p ? { ...p, lookbookHeader: { ...p.lookbookHeader, kicker: e.target.value } } : p
                  )
                }
                className="mt-1 h-11 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/60 px-3.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#49243E]">Lookbook Heading</label>
              <input
                type="text"
                value={content.lookbookHeader.heading}
                onChange={(e) => {
                  clearFieldError('lookbookHeader.heading');
                  setContent((p) =>
                    p ? { ...p, lookbookHeader: { ...p.lookbookHeader, heading: e.target.value } } : p
                  );
                }}
                aria-invalid={Boolean(fieldErrors['lookbookHeader.heading'])}
                className={`mt-1 h-11 w-full rounded-xl border bg-[#FFF9F5]/60 px-3.5 text-sm ${
                  fieldErrors['lookbookHeader.heading'] ? 'border-[#9F1239]' : 'border-[#49243E]/18'
                }`}
              />
              {fieldErrors['lookbookHeader.heading'] && (
                <p className="mt-1 text-xs font-medium text-[#9F1239]">
                  {fieldErrors['lookbookHeader.heading']}
                </p>
              )}
            </div>
          </div>

          <div className="space-y-4">
            {content.lookbookEntries.map((entry, idx) => {
              const titleErr = fieldErrors[`lookbookEntries.${idx}.title`];
              const imgErr = fieldErrors[`lookbookEntries.${idx}.image`];
              return (
                <div
                  key={entry.id}
                  className="flex flex-col gap-4 rounded-2xl border border-[#49243E]/12 bg-[#FFF9F5]/55 p-4 sm:flex-row"
                >
                  <div className="h-28 w-24 shrink-0 overflow-hidden rounded-xl border border-[#49243E]/12 bg-[#F8F1ED]">
                    <BoutiqueImage
                      src={entry.image}
                      alt={entry.alt || entry.title}
                      loading="lazy"
                      className="h-full w-full object-cover object-top"
                    />
                  </div>

                  <div className="min-w-0 flex-1 space-y-3">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                      <div>
                        <input
                          type="text"
                          value={entry.title}
                          onChange={(e) => {
                            const val = e.target.value;
                            clearFieldError(`lookbookEntries.${idx}.title`);
                            setContent((p) =>
                              p
                                ? {
                                    ...p,
                                    lookbookEntries: p.lookbookEntries.map((item, i) =>
                                      i === idx ? { ...item, title: val } : item
                                    ),
                                  }
                                : p
                            );
                          }}
                          placeholder="Frame Title"
                          aria-invalid={Boolean(titleErr)}
                          className={`h-10 w-full rounded-xl border bg-white px-3 text-xs font-medium ${
                            titleErr ? 'border-[#9F1239]' : 'border-[#49243E]/15'
                          }`}
                        />
                        {titleErr && (
                          <p className="mt-1 text-[11px] font-medium text-[#9F1239]">{titleErr}</p>
                        )}
                      </div>

                      <select
                        value={entry.category}
                        onChange={(e) => {
                          const val = e.target.value;
                          setContent((p) =>
                            p
                              ? {
                                  ...p,
                                  lookbookEntries: p.lookbookEntries.map((item, i) =>
                                    i === idx ? { ...item, category: val } : item
                                  ),
                                }
                              : p
                          );
                        }}
                        className="h-10 rounded-xl border border-[#49243E]/15 bg-white px-2.5 text-xs text-[#49243E]"
                      >
                        {categoryNames.map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </select>

                      <select
                        value={entry.layout}
                        onChange={(e) => {
                          const val = e.target.value as LookbookEntry['layout'];
                          setContent((p) =>
                            p
                              ? {
                                  ...p,
                                  lookbookEntries: p.lookbookEntries.map((item, i) =>
                                    i === idx ? { ...item, layout: val } : item
                                  ),
                                }
                              : p
                          );
                        }}
                        className="h-10 rounded-xl border border-[#49243E]/15 bg-white px-2.5 text-xs text-[#49243E]"
                      >
                        <option value="tall">Tall Grid Card</option>
                        <option value="wide">Wide Grid Card</option>
                        <option value="square">Square Grid Card</option>
                      </select>
                    </div>

                    <input
                      type="text"
                      value={entry.caption}
                      onChange={(e) => {
                        const val = e.target.value;
                        setContent((p) =>
                          p
                            ? {
                                ...p,
                                lookbookEntries: p.lookbookEntries.map((item, i) =>
                                  i === idx ? { ...item, caption: val } : item
                                ),
                              }
                            : p
                        );
                      }}
                      placeholder="Lookbook styling note caption"
                      className="h-10 w-full rounded-xl border border-[#49243E]/15 bg-white px-3 text-xs"
                    />

                    {imgErr && <p className="text-xs font-medium text-[#9F1239]">{imgErr}</p>}

                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <label className="inline-flex min-h-[36px] cursor-pointer items-center gap-1.5 rounded-xl border border-[#49243E]/18 bg-white px-3 text-xs font-medium text-[#49243E] hover:bg-[#F3D5DF]/40">
                        <input
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          className="sr-only"
                          onChange={(e: ChangeEvent<HTMLInputElement>) =>
                            void uploadSinglePhoto(
                              `lb-${entry.id}`,
                              `lookbookEntries.${idx}.image`,
                              e.target.files?.[0],
                              (url) =>
                                setContent((p) =>
                                  p
                                    ? {
                                        ...p,
                                        lookbookEntries: p.lookbookEntries.map((item, i) =>
                                          i === idx ? { ...item, image: url } : item
                                        ),
                                      }
                                    : p
                                )
                            )
                          }
                        />
                        {uploadingKey === `lb-${entry.id}` ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                        ) : (
                          <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                        )}
                        <span>Replace Photo</span>
                      </label>

                      <button
                        type="button"
                        disabled={content.lookbookEntries.length <= 1}
                        onClick={() => {
                          setFieldErrors({});
                          setContent((p) =>
                            p
                              ? {
                                  ...p,
                                  lookbookEntries: p.lookbookEntries.filter((_, i) => i !== idx),
                                }
                              : p
                          );
                        }}
                        aria-label={`Remove lookbook frame ${entry.title}`}
                        className="inline-flex min-h-[36px] items-center gap-1 rounded-xl border border-[#B76E79]/30 px-3 text-xs font-medium text-[#B76E79] hover:bg-[#F3D5DF]/35 disabled:opacity-40"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Remove</span>
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* ABOUT SECTION TAB */}
      {subTab === 'about' && (
        <section className="space-y-5 rounded-3xl border border-[#49243E]/12 bg-white p-5 sm:p-6">
          <h3 className="font-serif text-xl font-semibold text-[#49243E]">About Section Story</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-[#49243E]">Kicker</label>
              <input
                type="text"
                value={content.about.kicker}
                onChange={(e) =>
                  setContent((p) =>
                    p ? { ...p, about: { ...p.about, kicker: e.target.value } } : p
                  )
                }
                className="mt-1 h-11 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/60 px-3.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#49243E]">Heading</label>
              <input
                type="text"
                value={content.about.heading}
                onChange={(e) => {
                  clearFieldError('about.heading');
                  setContent((p) =>
                    p ? { ...p, about: { ...p.about, heading: e.target.value } } : p
                  );
                }}
                aria-invalid={Boolean(fieldErrors['about.heading'])}
                className={`mt-1 h-11 w-full rounded-xl border bg-[#FFF9F5]/60 px-3.5 text-sm ${
                  fieldErrors['about.heading'] ? 'border-[#9F1239]' : 'border-[#49243E]/18'
                }`}
              />
              {fieldErrors['about.heading'] && (
                <p className="mt-1 text-xs font-medium text-[#9F1239]">{fieldErrors['about.heading']}</p>
              )}
            </div>
            {content.about.paragraphs.map((para, idx) => (
              <div key={idx} className="sm:col-span-2">
                <label className="block text-xs font-medium text-[#49243E]">
                  Story Paragraph {idx + 1}
                </label>
                <textarea
                  rows={3}
                  value={para}
                  onChange={(e) => {
                    const val = e.target.value;
                    clearFieldError('about.paragraphs');
                    setContent((p) =>
                      p
                        ? {
                            ...p,
                            about: {
                              ...p.about,
                              paragraphs: p.about.paragraphs.map((item, i) =>
                                i === idx ? val : item
                              ),
                            },
                          }
                        : p
                    );
                  }}
                  className="mt-1 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/60 p-3.5 text-sm"
                />
              </div>
            ))}
            {fieldErrors['about.paragraphs'] && (
              <p className="text-xs font-medium text-[#9F1239] sm:col-span-2">
                {fieldErrors['about.paragraphs']}
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 border-t border-[#49243E]/10 pt-5 md:grid-cols-3">
            {content.about.pillars.map((pillar, idx) => (
              <div key={idx} className="space-y-2 rounded-2xl border border-[#49243E]/10 bg-[#FFF9F5]/60 p-3.5">
                <input
                  type="text"
                  value={pillar.title}
                  onChange={(e) => {
                    const val = e.target.value;
                    setContent((p) =>
                      p
                        ? {
                            ...p,
                            about: {
                              ...p.about,
                              pillars: p.about.pillars.map((item, i) =>
                                i === idx ? { ...item, title: val } : item
                              ),
                            },
                          }
                        : p
                    );
                  }}
                  className="h-9 w-full rounded-lg border border-[#49243E]/15 bg-white px-2.5 text-xs font-semibold text-[#49243E]"
                />
                <textarea
                  rows={2}
                  value={pillar.detail}
                  onChange={(e) => {
                    const val = e.target.value;
                    setContent((p) =>
                      p
                        ? {
                            ...p,
                            about: {
                              ...p.about,
                              pillars: p.about.pillars.map((item, i) =>
                                i === idx ? { ...item, detail: val } : item
                              ),
                            },
                          }
                        : p
                    );
                  }}
                  className="w-full rounded-lg border border-[#49243E]/15 bg-white p-2.5 text-xs"
                />
              </div>
            ))}
          </div>

          <div className="space-y-2 border-t border-[#49243E]/10 pt-5">
            <div className="flex flex-wrap items-center gap-4">
              <div className="h-24 w-32 shrink-0 overflow-hidden rounded-xl border border-[#49243E]/12 bg-[#F8F1ED]">
                <BoutiqueImage
                  src={content.about.image.src}
                  alt={content.about.image.alt}
                  loading="eager"
                  className="h-full w-full object-cover"
                />
              </div>
              <div className="min-w-0 flex-1 space-y-2">
                <label className="block text-xs font-medium text-[#49243E]">About Atelier Alt Text</label>
                <input
                  type="text"
                  value={content.about.image.alt}
                  onChange={(e) =>
                    setContent((p) =>
                      p
                        ? {
                            ...p,
                            about: { ...p.about, image: { ...p.about.image, alt: e.target.value } },
                          }
                        : p
                    )
                  }
                  className="h-10 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/60 px-3 text-xs"
                />
                <label className="inline-flex min-h-[40px] cursor-pointer items-center gap-2 rounded-xl border border-[#49243E]/20 bg-[#FFF9F5] px-3.5 text-xs font-medium text-[#49243E] hover:bg-[#F3D5DF]/40">
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="sr-only"
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      void uploadSinglePhoto('about', 'about.image.src', e.target.files?.[0], (url) =>
                        setContent((p) =>
                          p
                            ? { ...p, about: { ...p.about, image: { ...p.about.image, src: url } } }
                            : p
                        )
                      )
                    }
                  />
                  {uploadingKey === 'about' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  <span>Upload Atelier Image</span>
                </label>
              </div>
            </div>
            {fieldErrors['about.image.src'] && (
              <p className="text-xs font-medium text-[#9F1239]">{fieldErrors['about.image.src']}</p>
            )}
          </div>
        </section>
      )}
    </form>
  );
}
