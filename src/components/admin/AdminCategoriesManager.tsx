import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  AlertTriangle,
  Edit3,
  FolderPlus,
  Loader2,
  Plus,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import type { StorefrontCategory } from '../../types/boutique';
import { BoutiqueImage } from '../BoutiqueImage';

interface AdminCategoriesManagerProps {
  categories: StorefrontCategory[];
  loading: boolean;
  onNotify: (kind: 'ok' | 'err', text: string) => void;
  onMutated: () => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}

const DEFAULT_CATEGORY_IMAGE = '/boutique-media/col_dresses_1794557657118.jpg';

export function AdminCategoriesManager({
  categories,
  loading,
  onNotify,
  onMutated,
  onDirtyChange,
}: AdminCategoriesManagerProps) {
  const { apiRequest } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [editing, setEditing] = useState<StorefrontCategory | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [altText, setAltText] = useState('');
  const [imageUrl, setImageUrl] = useState(DEFAULT_CATEGORY_IMAGE);
  const [position, setPosition] = useState('0');
  const [baselineSnapshot, setBaselineSnapshot] = useState('');

  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<StorefrontCategory | null>(null);
  const [deleting, setDeleting] = useState(false);

  const currentSnapshot = useMemo(
    () =>
      JSON.stringify({
        editingId: editing?.id || null,
        name,
        subtitle,
        altText,
        imageUrl,
        position,
      }),
    [editing?.id, name, subtitle, altText, imageUrl, position]
  );

  const isDirty = formOpen && currentSnapshot !== baselineSnapshot;

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

  const applyOpenCreate = () => {
    const nextPos = String(categories.length);
    setEditing(null);
    setName('');
    setSubtitle('');
    setAltText('');
    setImageUrl(DEFAULT_CATEGORY_IMAGE);
    setPosition(nextPos);
    setFieldErrors({});
    setFormError(null);
    setPendingAction(null);
    setBaselineSnapshot(
      JSON.stringify({
        editingId: null,
        name: '',
        subtitle: '',
        altText: '',
        imageUrl: DEFAULT_CATEGORY_IMAGE,
        position: nextPos,
      })
    );
    setFormOpen(true);
  };

  const applyOpenEdit = (cat: StorefrontCategory) => {
    const nextImg = cat.imageUrl || DEFAULT_CATEGORY_IMAGE;
    const nextPos = String(cat.position);
    setEditing(cat);
    setName(cat.name);
    setSubtitle(cat.subtitle);
    setAltText(cat.altText);
    setImageUrl(nextImg);
    setPosition(nextPos);
    setFieldErrors({});
    setFormError(null);
    setPendingAction(null);
    setBaselineSnapshot(
      JSON.stringify({
        editingId: cat.id,
        name: cat.name,
        subtitle: cat.subtitle,
        altText: cat.altText,
        imageUrl: nextImg,
        position: nextPos,
      })
    );
    setFormOpen(true);
  };

  const applyCloseForm = () => {
    setFormOpen(false);
    setEditing(null);
    setFieldErrors({});
    setFormError(null);
    setPendingAction(null);
  };

  const guardFormTransition = (action: () => void) => {
    if (saving || uploading) return;
    if (isDirty) {
      setPendingAction(() => action);
      return;
    }
    action();
  };

  const clearFieldError = (key: string) => {
    setFormError(null);
    setFieldErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const handleUploadImage = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    clearFieldError('imageUrl');
    if (file.size > 5 * 1024 * 1024) {
      const msg = 'Category photo must be 5 MB or smaller.';
      setFieldErrors((prev) => ({ ...prev, imageUrl: msg }));
      setFormError(msg);
      onNotify('err', msg);
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('files', file);
      const res = await apiRequest<{
        files: Array<{ url: string }>;
      }>('/api/admin/uploads', {
        method: 'POST',
        body: fd,
      });
      if (!res.ok) {
        setFieldErrors((prev) => ({ ...prev, imageUrl: res.error }));
        setFormError(res.error);
        onNotify('err', res.error);
        return;
      }
      if (res.data.files[0]?.url) {
        setImageUrl(res.data.files[0].url);
        onNotify('ok', 'Category cover image uploaded. Save category to apply.');
      }
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    if (saving || uploading) return;
    setFormError(null);

    const errors: Record<string, string> = {};
    const trimmedName = name.trim();
    const trimmedSubtitle = subtitle.trim();
    const trimmedAlt = altText.trim();
    const parsedPos = Number(position.trim() === '' ? '0' : position);

    if (trimmedName.length < 2 || trimmedName.length > 64) {
      errors.name = 'Category name must be between 2 and 64 characters.';
    }
    if (trimmedSubtitle.length > 240) {
      errors.subtitle = 'Subtitle must be 240 characters or fewer.';
    }
    if (trimmedAlt.length > 200) {
      errors.altText = 'Image alt description must be 200 characters or fewer.';
    }
    if (!Number.isInteger(parsedPos) || parsedPos < 0 || parsedPos > 999) {
      errors.position = 'Display order must be a whole number between 0 and 999.';
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      const firstMsg = Object.values(errors)[0];
      setFormError(firstMsg);
      onNotify('err', firstMsg);
      return;
    }

    setFieldErrors({});
    setSaving(true);
    try {
      const payload = {
        name: trimmedName,
        subtitle: trimmedSubtitle,
        altText: trimmedAlt || trimmedName,
        imageUrl: imageUrl.trim() || DEFAULT_CATEGORY_IMAGE,
        position: parsedPos,
      };
      const res = editing
        ? await apiRequest<{ category: StorefrontCategory }>(
            `/api/admin/categories/${editing.id}`,
            { method: 'PATCH', body: JSON.stringify(payload) }
          )
        : await apiRequest<{ category: StorefrontCategory }>('/api/admin/categories', {
            method: 'POST',
            body: JSON.stringify(payload),
          });

      if (!res.ok) {
        if (res.fieldErrors) {
          setFieldErrors(res.fieldErrors);
        }
        setFormError(res.error);
        onNotify('err', res.error);
        return;
      }

      setFormOpen(false);
      setEditing(null);
      setPendingAction(null);
      onNotify(
        'ok',
        editing
          ? `Updated collection "${res.data.category.name}".`
          : `Created collection "${res.data.category.name}".`
      );
      await onMutated();
    } finally {
      setSaving(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      const res = await apiRequest<{ message: string }>(
        `/api/admin/categories/${deleteTarget.id}`,
        { method: 'DELETE' }
      );
      if (!res.ok) {
        onNotify('err', res.error);
        return;
      }
      if (editing?.id === deleteTarget.id) {
        applyCloseForm();
      }
      onNotify('ok', `Deleted collection "${deleteTarget.name}".`);
      setDeleteTarget(null);
      await onMutated();
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4 rounded-3xl border border-[#49243E]/12 bg-white p-6">
        {Array.from({ length: 4 }).map((_, idx) => (
          <div key={idx} className="h-20 animate-pulse rounded-2xl bg-[#FFF9F5]" />
        ))}
      </div>
    );
  }

  return (
    <section aria-label="Collection categories" className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-3xl border border-[#49243E]/12 bg-white p-5 sm:p-6">
        <div>
          <h2 className="font-serif text-2xl font-semibold text-[#49243E]">
            Collections &amp; Categories
          </h2>
          <p className="mt-1 text-xs text-[#242124]/65">
            Create, rename, and arrange storefront collections. Renaming automatically updates assigned products.
          </p>
        </div>

        <button
          type="button"
          onClick={() => guardFormTransition(applyOpenCreate)}
          className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-[#49243E] px-4 text-xs font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31]"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          <span>Add Category</span>
        </button>
      </div>

      {formOpen && (
        <form
          onSubmit={handleSave}
          noValidate
          className="space-y-4 rounded-3xl border border-[#49243E]/18 bg-white p-5 sm:p-6"
        >
          <div className="flex items-center justify-between border-b border-[#49243E]/10 pb-3">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-serif text-xl font-semibold text-[#49243E]">
                {editing ? `Edit Collection: ${editing.name}` : 'New Collection Category'}
              </h3>
              {isDirty && (
                <span className="rounded-md bg-[#F3D5DF]/65 px-2 py-0.5 text-[11px] font-semibold text-[#49243E]">
                  Unsaved changes
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => guardFormTransition(applyCloseForm)}
              aria-label="Close category form"
              className="flex h-9 w-9 items-center justify-center rounded-full text-[#49243E] hover:bg-[#F3D5DF]/40"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          {pendingAction && (
            <div
              role="alertdialog"
              aria-label="Discard category changes"
              className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#B76E79]/45 bg-[#F3D5DF]/40 px-4 py-3 text-xs text-[#49243E]"
            >
              <span className="font-medium">
                You have unsaved category edits. Discard them without saving?
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPendingAction(null)}
                  className="min-h-[34px] rounded-lg border border-[#49243E]/25 bg-white px-3 font-medium text-[#49243E]"
                >
                  Keep Editing
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const next = pendingAction;
                    setPendingAction(null);
                    next();
                  }}
                  className="min-h-[34px] rounded-lg bg-[#49243E] px-3 font-medium text-[#FFF9F5]"
                >
                  Discard Changes
                </button>
              </div>
            </div>
          )}

          {formError && (
            <div
              role="alert"
              className="flex items-center gap-2 rounded-2xl border border-[#B76E79]/55 bg-[#F3D5DF]/35 px-4 py-2.5 text-xs font-medium text-[#49243E]"
            >
              <AlertTriangle className="h-4 w-4 shrink-0 text-[#B76E79]" aria-hidden="true" />
              <span>{formError}</span>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 md:grid-cols-12">
            <div className="md:col-span-5">
              <label htmlFor="cat-name-input" className="block text-xs font-medium text-[#49243E]">
                Category Name
              </label>
              <input
                id="cat-name-input"
                type="text"
                maxLength={64}
                value={name}
                onChange={(e) => {
                  clearFieldError('name');
                  setName(e.target.value);
                }}
                placeholder="Bridal Trousseau"
                aria-invalid={Boolean(fieldErrors.name)}
                className={`mt-1 h-11 w-full rounded-xl border bg-[#FFF9F5]/60 px-3.5 text-sm focus:bg-white focus:outline-none ${
                  fieldErrors.name
                    ? 'border-[#9F1239] focus:border-[#9F1239]'
                    : 'border-[#49243E]/18 focus:border-[#49243E]'
                }`}
              />
              {fieldErrors.name && (
                <p className="mt-1 text-xs font-medium text-[#9F1239]">{fieldErrors.name}</p>
              )}
            </div>

            <div className="md:col-span-5">
              <label htmlFor="cat-subtitle-input" className="block text-xs font-medium text-[#49243E]">
                Subtitle
              </label>
              <input
                id="cat-subtitle-input"
                type="text"
                maxLength={240}
                value={subtitle}
                onChange={(e) => {
                  clearFieldError('subtitle');
                  setSubtitle(e.target.value);
                }}
                placeholder="Handcrafted silk & zari drapes for cherished celebrations"
                aria-invalid={Boolean(fieldErrors.subtitle)}
                className={`mt-1 h-11 w-full rounded-xl border bg-[#FFF9F5]/60 px-3.5 text-sm focus:bg-white focus:outline-none ${
                  fieldErrors.subtitle
                    ? 'border-[#9F1239] focus:border-[#9F1239]'
                    : 'border-[#49243E]/18 focus:border-[#49243E]'
                }`}
              />
              {fieldErrors.subtitle && (
                <p className="mt-1 text-xs font-medium text-[#9F1239]">{fieldErrors.subtitle}</p>
              )}
            </div>

            <div className="md:col-span-2">
              <label htmlFor="cat-order-input" className="block text-xs font-medium text-[#49243E]">
                Display Order
              </label>
              <input
                id="cat-order-input"
                type="number"
                min={0}
                max={999}
                value={position}
                onChange={(e) => {
                  clearFieldError('position');
                  setPosition(e.target.value);
                }}
                aria-invalid={Boolean(fieldErrors.position)}
                className={`mt-1 h-11 w-full rounded-xl border bg-[#FFF9F5]/60 px-3 text-sm tabular-nums focus:bg-white focus:outline-none ${
                  fieldErrors.position
                    ? 'border-[#9F1239] focus:border-[#9F1239]'
                    : 'border-[#49243E]/18 focus:border-[#49243E]'
                }`}
              />
              {fieldErrors.position && (
                <p className="mt-1 text-xs font-medium text-[#9F1239]">{fieldErrors.position}</p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-12 md:items-start">
            <div className="space-y-1.5 md:col-span-6">
              <div className="flex items-center gap-3">
                <div className="h-20 w-16 shrink-0 overflow-hidden rounded-xl border border-[#49243E]/12 bg-[#F8F1ED]">
                  <BoutiqueImage
                    src={imageUrl}
                    alt={altText || name}
                    loading="eager"
                    className="h-full w-full object-cover object-top"
                  />
                </div>
                <div className="min-w-0 flex-1 space-y-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={(e) => void handleUploadImage(e)}
                    className="sr-only"
                    id="admin-category-upload"
                  />
                  <label
                    htmlFor="admin-category-upload"
                    className="inline-flex min-h-[40px] cursor-pointer items-center gap-2 rounded-xl border border-[#49243E]/20 bg-[#FFF9F5] px-3.5 text-xs font-medium text-[#49243E] hover:bg-[#F3D5DF]/40"
                  >
                    {uploading ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    <span>{uploading ? 'Uploading...' : 'Upload Cover Photo'}</span>
                  </label>
                  <p className="truncate font-mono text-[11px] text-[#242124]/60">{imageUrl}</p>
                </div>
              </div>
              {fieldErrors.imageUrl && (
                <p className="text-xs font-medium text-[#9F1239]">{fieldErrors.imageUrl}</p>
              )}
            </div>

            <div className="md:col-span-6">
              <label htmlFor="cat-alt-input" className="block text-xs font-medium text-[#49243E]">
                Image Alt Description
              </label>
              <input
                id="cat-alt-input"
                type="text"
                maxLength={200}
                value={altText}
                onChange={(e) => {
                  clearFieldError('altText');
                  setAltText(e.target.value);
                }}
                placeholder="Describe the collection photograph for accessibility"
                aria-invalid={Boolean(fieldErrors.altText)}
                className={`mt-1 h-11 w-full rounded-xl border bg-[#FFF9F5]/60 px-3.5 text-sm focus:bg-white focus:outline-none ${
                  fieldErrors.altText
                    ? 'border-[#9F1239] focus:border-[#9F1239]'
                    : 'border-[#49243E]/18 focus:border-[#49243E]'
                }`}
              />
              {fieldErrors.altText && (
                <p className="mt-1 text-xs font-medium text-[#9F1239]">{fieldErrors.altText}</p>
              )}
            </div>
          </div>

          <div className="flex justify-end gap-2.5 border-t border-[#49243E]/10 pt-4">
            <button
              type="button"
              disabled={saving}
              onClick={() => guardFormTransition(applyCloseForm)}
              className="min-h-[44px] rounded-xl border border-[#49243E]/20 px-4 text-xs font-medium text-[#49243E]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || uploading}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-[#49243E] px-5 text-xs font-medium text-[#FFF9F5] hover:bg-[#3A1B31] disabled:opacity-55"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              <span>
                {saving
                  ? editing
                    ? 'Saving...'
                    : 'Creating...'
                  : editing
                    ? 'Save Category'
                    : 'Create Category'}
              </span>
            </button>
          </div>
        </form>
      )}

      {categories.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-3xl border border-[#49243E]/12 bg-white px-6 py-14 text-center">
          <FolderPlus className="h-7 w-7 text-[#B76E79]" aria-hidden="true" />
          <h3 className="mt-3 font-serif text-2xl font-semibold text-[#49243E]">
            No categories configured
          </h3>
          <p className="mt-1 max-w-md text-sm text-[#242124]/70">
            Add your first boutique collection to organize your storefront showcase.
          </p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {categories.map((cat) => (
            <li
              key={cat.id}
              className="flex items-center justify-between gap-4 rounded-2xl border border-[#49243E]/12 bg-white p-4"
            >
              <div className="flex min-w-0 items-center gap-3.5">
                <div className="h-20 w-16 shrink-0 overflow-hidden rounded-xl border border-[#49243E]/10 bg-[#F8F1ED]">
                  <BoutiqueImage
                    src={cat.imageUrl}
                    alt={cat.altText || cat.name}
                    loading="lazy"
                    fallbackTitle={cat.name}
                    className="h-full w-full object-cover object-top"
                  />
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] font-medium uppercase tracking-wider text-[#B76E79] tabular-nums">
                    Order #{cat.position} · /{cat.slug}
                  </p>
                  <h3 className="mt-0.5 truncate font-serif text-xl font-semibold text-[#49243E]">
                    {cat.name}
                  </h3>
                  <p className="mt-0.5 line-clamp-2 text-xs text-[#242124]/70">
                    {cat.subtitle || 'No subtitle'}
                  </p>
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => guardFormTransition(() => applyOpenEdit(cat))}
                  aria-label={`Edit ${cat.name}`}
                  className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#49243E]/15 text-[#49243E] hover:bg-[#F3D5DF]/40"
                >
                  <Edit3 className="h-4 w-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => setDeleteTarget(cat)}
                  aria-label={`Delete ${cat.name}`}
                  className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#B76E79]/30 text-[#B76E79] hover:bg-[#F3D5DF]/40 hover:text-[#49243E]"
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {deleteTarget && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="cat-delete-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#242124]/55 p-4"
        >
          <div className="w-full max-w-md rounded-3xl border border-[#49243E]/15 bg-[#FFF9F5] p-6 shadow-2xl">
            <h2 id="cat-delete-title" className="font-serif text-2xl font-semibold text-[#49243E]">
              Delete Collection Category?
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-[#242124]/75">
              Delete "{deleteTarget.name}"? Categories currently assigned to existing products cannot be deleted until those products are reassigned.
            </p>
            <div className="mt-6 flex justify-end gap-2.5">
              <button
                type="button"
                disabled={deleting}
                onClick={() => setDeleteTarget(null)}
                className="min-h-[42px] rounded-xl border border-[#49243E]/20 bg-white px-4 text-sm font-medium text-[#49243E]"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={() => void handleConfirmDelete()}
                className="inline-flex min-h-[42px] items-center gap-2 rounded-xl bg-[#49243E] px-4 text-sm font-medium text-[#FFF9F5] hover:bg-[#3A1B31]"
              >
                {deleting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                <span>Confirm Delete</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
