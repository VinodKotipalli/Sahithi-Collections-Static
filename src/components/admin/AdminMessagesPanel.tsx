import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Mail,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import type { ContactMessage, ContactMessageStatus } from '../../types/boutique';
import { formatTimestamp } from '../../utils/format';

interface AdminMessagesPanelProps {
  onNotify: (kind: 'ok' | 'err', text: string) => void;
  onUnreadCountChanged: (count: number) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

const STATUS_TABS: Array<{ value: 'all' | ContactMessageStatus; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'unread', label: 'Unread' },
  { value: 'read', label: 'Read' },
  { value: 'replied', label: 'Replied' },
  { value: 'archived', label: 'Archived' },
];

export function AdminMessagesPanel({
  onNotify,
  onUnreadCountChanged,
  onDirtyChange,
}: AdminMessagesPanelProps) {
  const { apiRequest } = useAuth();
  const onNotifyRef = useRef(onNotify);
  onNotifyRef.current = onNotify;
  const onUnreadRef = useRef(onUnreadCountChanged);
  onUnreadRef.current = onUnreadCountChanged;

  const [messages, setMessages] = useState<ContactMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<'all' | ContactMessageStatus>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

  const baselineNotesRef = useRef<Record<string, string>>({});
  const [notesDraft, setNotesDraft] = useState<Record<string, string>>({});
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [pendingViewSwitch, setPendingViewSwitch] = useState<(() => void) | null>(null);

  const loadMessages = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({
      status: statusFilter,
      page: String(page),
      pageSize: '12',
    });
    if (search.trim()) params.set('q', search.trim());

    const res = await apiRequest<{
      items: ContactMessage[];
      total: number;
      unreadCount: number;
      totalPages: number;
    }>(`/api/admin/messages?${params.toString()}`);
    setLoading(false);
    if (!res.ok) {
      onNotifyRef.current('err', res.error);
      return;
    }
    setMessages(res.data.items);
    setTotal(res.data.total);
    setTotalPages(res.data.totalPages);
    onUnreadRef.current(res.data.unreadCount);

    const freshServerNotes: Record<string, string> = {};
    for (const m of res.data.items) {
      freshServerNotes[m.id] = m.adminNote || '';
    }

    setNotesDraft((prev) => {
      const merged: Record<string, string> = { ...prev };
      for (const m of res.data.items) {
        const prevBaseline = baselineNotesRef.current[m.id];
        const prevDraft = prev[m.id];
        const hasUnsavedLocalDraft =
          prevDraft !== undefined &&
          prevBaseline !== undefined &&
          prevDraft !== prevBaseline;
        if (!hasUnsavedLocalDraft) {
          merged[m.id] = m.adminNote || '';
        }
      }
      return merged;
    });
    baselineNotesRef.current = {
      ...baselineNotesRef.current,
      ...freshServerNotes,
    };
  }, [apiRequest, statusFilter, page, search]);

  useEffect(() => {
    void loadMessages();
  }, [loadMessages]);

  const dirtyIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [id, val] of Object.entries(notesDraft)) {
      const base = baselineNotesRef.current[id] ?? '';
      if (val !== base) {
        ids.add(id);
      }
    }
    return ids;
  }, [notesDraft]);

  const isDirty = dirtyIds.size > 0;

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

  const guardViewSwitch = (action: () => void) => {
    if (isDirty) {
      setPendingViewSwitch(() => action);
      return;
    }
    action();
  };

  const handleUpdateMessage = async (
    id: string,
    patch: { status?: ContactMessageStatus; adminNote?: string }
  ) => {
    if (busyId) return;
    setCardErrors((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });

    if (typeof patch.adminNote === 'string' && patch.adminNote.trim().length > 1000) {
      const msg = 'Internal studio note must be 1000 characters or fewer.';
      setCardErrors((prev) => ({ ...prev, [id]: msg }));
      onNotify('err', msg);
      return;
    }

    setBusyId(id);
    try {
      const res = await apiRequest<{ message: ContactMessage }>(`/api/admin/messages/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const errMsg = res.fieldErrors?.adminNote || res.error;
        setCardErrors((prev) => ({ ...prev, [id]: errMsg }));
        onNotify('err', errMsg);
        return;
      }

      if (patch.adminNote !== undefined) {
        const savedNote = res.data.message.adminNote || '';
        baselineNotesRef.current[id] = savedNote;
        setNotesDraft((prev) => ({ ...prev, [id]: savedNote }));
      }
      onNotify('ok', patch.adminNote !== undefined ? 'Studio note saved.' : 'Message status updated.');
      await loadMessages();
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteMessage = async (id: string) => {
    if (busyId) return;
    setBusyId(id);
    try {
      const res = await apiRequest<{ deletedId: string }>(`/api/admin/messages/${id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        setCardErrors((prev) => ({ ...prev, [id]: res.error }));
        onNotify('err', res.error);
        return;
      }
      delete baselineNotesRef.current[id];
      setNotesDraft((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setConfirmDeleteId(null);
      onNotify('ok', 'Message removed.');
      await loadMessages();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section aria-label="Customer contact enquiries" className="space-y-5">
      <div className="space-y-4 rounded-3xl border border-[#49243E]/12 bg-white p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="font-serif text-2xl font-semibold text-[#49243E]">
                Customer Messages
              </h2>
              {isDirty && (
                <span className="rounded-md bg-[#F3D5DF]/65 px-2 py-0.5 text-[11px] font-semibold text-[#49243E]">
                  {dirtyIds.size} unsaved note{dirtyIds.size === 1 ? '' : 's'}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-[#242124]/65 tabular-nums">
              {total} enquiry message{total === 1 ? '' : 's'} received via the storefront concierge form
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-3 border-t border-[#49243E]/10 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div
            role="tablist"
            aria-label="Filter messages by status"
            className="inline-flex flex-wrap gap-1 rounded-xl border border-[#49243E]/10 bg-[#FFF9F5] p-1"
          >
            {STATUS_TABS.map((tab) => {
              const active = statusFilter === tab.value;
              return (
                <button
                  key={tab.value}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => {
                    if (statusFilter === tab.value) return;
                    guardViewSwitch(() => {
                      setPage(1);
                      setStatusFilter(tab.value);
                    });
                  }}
                  className={`min-h-[38px] rounded-lg px-3.5 text-xs font-medium transition-colors ${
                    active
                      ? 'bg-[#49243E] text-[#FFF9F5]'
                      : 'text-[#49243E]/80 hover:bg-[#F3D5DF]/40'
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          <div className="relative w-full sm:max-w-xs">
            <Search
              className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-[#49243E]/55"
              aria-hidden="true"
            />
            <input
              type="search"
              value={search}
              onChange={(e) => {
                setPage(1);
                setSearch(e.target.value);
              }}
              placeholder="Search sender, subject, or text..."
              className="h-10 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 pl-10 pr-8 text-xs focus:border-[#49243E] focus:bg-white focus:outline-none"
            />
            {search && (
              <button
                type="button"
                onClick={() => {
                  setPage(1);
                  setSearch('');
                }}
                aria-label="Clear message search"
                className="absolute top-1/2 right-2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-[#49243E]/70"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>

        {pendingViewSwitch && (
          <div
            role="alertdialog"
            aria-label="Unsaved note confirmation"
            className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#B76E79]/45 bg-[#F3D5DF]/40 px-4 py-3 text-xs text-[#49243E]"
          >
            <span className="font-medium">
              You have {dirtyIds.size} unsaved studio note{dirtyIds.size === 1 ? '' : 's'}. Discard edits and switch view?
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPendingViewSwitch(null)}
                className="min-h-[34px] rounded-lg border border-[#49243E]/25 bg-white px-3 font-medium text-[#49243E]"
              >
                Stay Here
              </button>
              <button
                type="button"
                onClick={() => {
                  setNotesDraft({ ...baselineNotesRef.current });
                  const action = pendingViewSwitch;
                  setPendingViewSwitch(null);
                  action();
                }}
                className="min-h-[34px] rounded-lg bg-[#49243E] px-3 font-medium text-[#FFF9F5]"
              >
                Discard &amp; Switch
              </button>
            </div>
          </div>
        )}
      </div>

      {loading ? (
        <div className="space-y-3 rounded-3xl border border-[#49243E]/12 bg-white p-6">
          {Array.from({ length: 3 }).map((_, idx) => (
            <div key={idx} className="h-28 animate-pulse rounded-2xl bg-[#FFF9F5]" />
          ))}
        </div>
      ) : messages.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-3xl border border-[#49243E]/12 bg-white px-6 py-16 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#F3D5DF]/45 text-[#49243E]">
            <Mail className="h-5 w-5" aria-hidden="true" />
          </div>
          <h3 className="mt-4 font-serif text-2xl font-semibold text-[#49243E]">
            No messages matching this view
          </h3>
          <p className="mt-1.5 max-w-md text-sm text-[#242124]/70">
            Enquiries sent through the Contact Us section on the public storefront will appear here.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {messages.map((msg) => {
            const isBusy = busyId === msg.id;
            const draftNote = notesDraft[msg.id] ?? '';
            const isCardDirty = dirtyIds.has(msg.id);
            const cardErr = cardErrors[msg.id];
            return (
              <article
                key={msg.id}
                className={`rounded-3xl border bg-white p-5 sm:p-6 ${
                  msg.status === 'unread' ? 'border-[#B76E79]' : 'border-[#49243E]/12'
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#49243E]/10 pb-3.5">
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-[#B76E79] tabular-nums">
                      {msg.status} · {formatTimestamp(msg.createdAt)}
                    </p>
                    <h3 className="mt-0.5 font-serif text-xl font-semibold text-[#49243E]">
                      {msg.subject}
                    </h3>
                    <p className="mt-0.5 text-xs text-[#242124]/70">
                      {msg.senderName} · {msg.senderEmail}
                      {msg.senderPhone ? ` · ${msg.senderPhone}` : ''}
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <select
                      aria-label={`Status for enquiry from ${msg.senderName}`}
                      disabled={isBusy}
                      value={msg.status}
                      onChange={(e) =>
                        void handleUpdateMessage(msg.id, {
                          status: e.target.value as ContactMessageStatus,
                        })
                      }
                      className="h-10 rounded-xl border border-[#49243E]/20 bg-[#FFF9F5] px-3 text-xs font-medium capitalize text-[#49243E] disabled:opacity-55"
                    >
                      <option value="unread">Unread</option>
                      <option value="read">Read</option>
                      <option value="replied">Replied</option>
                      <option value="archived">Archived</option>
                    </select>

                    {confirmDeleteId === msg.id ? (
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void handleDeleteMessage(msg.id)}
                          className="min-h-[40px] rounded-xl bg-[#49243E] px-3 text-xs font-medium text-[#FFF9F5]"
                        >
                          {isBusy ? 'Deleting...' : 'Confirm'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          className="min-h-[40px] rounded-xl border border-[#49243E]/20 px-2.5 text-xs text-[#49243E]"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => setConfirmDeleteId(msg.id)}
                        aria-label={`Delete enquiry from ${msg.senderName}`}
                        className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#B76E79]/30 text-[#B76E79] hover:bg-[#F3D5DF]/40 hover:text-[#49243E]"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </div>

                <p className="mt-3.5 whitespace-pre-line text-sm leading-relaxed text-[#242124]/85">
                  {msg.message}
                </p>

                <div className="mt-4 space-y-2 border-t border-[#49243E]/10 pt-3.5">
                  <div className="flex flex-col gap-2.5 sm:flex-row sm:items-end">
                    <div className="flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <label className="block text-[11px] font-medium text-[#49243E]/75">
                          Internal Staff / Owner Note
                          {isCardDirty && (
                            <span className="ml-2 rounded bg-[#F3D5DF]/65 px-1.5 py-0.5 text-[10px] font-semibold text-[#49243E]">
                              Unsaved
                            </span>
                          )}
                        </label>
                        <span
                          className={`text-[10px] tabular-nums ${
                            draftNote.trim().length > 1000 ? 'font-semibold text-[#9F1239]' : 'text-[#242124]/50'
                          }`}
                        >
                          {draftNote.length} / 1000
                        </span>
                      </div>
                      <input
                        type="text"
                        value={draftNote}
                        onChange={(e) => {
                          setCardErrors((prev) => {
                            if (!prev[msg.id]) return prev;
                            const next = { ...prev };
                            delete next[msg.id];
                            return next;
                          });
                          setNotesDraft((prev) => ({ ...prev, [msg.id]: e.target.value }));
                        }}
                        placeholder="Add follow-up reminder or measurement note..."
                        aria-invalid={Boolean(cardErr)}
                        className={`mt-1 h-10 w-full rounded-xl border bg-[#FFF9F5]/65 px-3 text-xs focus:bg-white focus:outline-none ${
                          cardErr
                            ? 'border-[#9F1239] focus:border-[#9F1239]'
                            : 'border-[#49243E]/15 focus:border-[#49243E]'
                        }`}
                      />
                    </div>

                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() =>
                        void handleUpdateMessage(msg.id, {
                          adminNote: draftNote,
                        })
                      }
                      className="inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-xl border border-[#49243E]/20 bg-white px-4 text-xs font-medium text-[#49243E] hover:bg-[#F3D5DF]/35 disabled:opacity-55"
                    >
                      {isBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                      <span>{isBusy ? 'Saving...' : 'Save Note'}</span>
                    </button>
                  </div>

                  {cardErr && (
                    <p role="alert" className="flex items-center gap-1.5 text-xs font-medium text-[#9F1239]">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span>{cardErr}</span>
                    </p>
                  )}
                </div>
              </article>
            );
          })}

          {totalPages > 1 && (
            <div className="flex items-center justify-between rounded-2xl border border-[#49243E]/12 bg-white px-5 py-3">
              <span className="text-xs text-[#242124]/65 tabular-nums">
                Page {page} of {totalPages}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => guardViewSwitch(() => setPage((p) => p - 1))}
                  className="inline-flex min-h-[38px] items-center gap-1 rounded-xl border border-[#49243E]/18 px-3 text-xs font-medium text-[#49243E] disabled:opacity-45"
                >
                  <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                  <span>Previous</span>
                </button>
                <button
                  type="button"
                  disabled={page >= totalPages}
                  onClick={() => guardViewSwitch(() => setPage((p) => p + 1))}
                  className="inline-flex min-h-[38px] items-center gap-1 rounded-xl border border-[#49243E]/18 px-3 text-xs font-medium text-[#49243E] disabled:opacity-45"
                >
                  <span>Next</span>
                  <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
