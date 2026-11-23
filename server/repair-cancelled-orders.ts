import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  normalizePaymentAndRefundStatus,
  normalizeRawOrderStatusValue,
  type OrderRefundStatus,
  type OrderRequestRecordData as OrderReturnRequest,
  type OrderHistoryEntryData as OrderStatusHistoryEntry,
} from './order-utils.ts';

function parseJsonSafe<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export interface RepairableOrderRecord {
  id: string;
  orderNumber: string;
  rawStatus: string;
  rawFulfillmentStatus: string;
  paymentStatus: string;
  paymentMethod: string;
  refundStatus: string;
  cancelledAt: number | null;
  cancelledBy: string | null;
  cancelReason: string | null;
  cancelRequest: OrderReturnRequest | null;
  statusHistory: OrderStatusHistoryEntry[];
  createdAt: number;
  updatedAt: number;
  rawRecord: Record<string, unknown>;
}

export interface CancellationRepairCandidate {
  id: string;
  orderNumber: string;
  evidence: string[];
  before: {
    status: string;
    fulfillmentStatus: string;
    paymentStatus: string;
    refundStatus: string;
    cancelledAt: number | null;
    cancelledBy: string | null;
  };
  after: {
    status: 'cancelled';
    fulfillmentStatus: 'cancelled';
    refundStatus: OrderRefundStatus;
    cancelledAt: number;
    cancelledBy: string;
    cancelReason: string | null;
  };
  rawRecord: Record<string, unknown>;
  nextStatusHistory: OrderStatusHistoryEntry[];
}

export interface CancellationRepairSummary {
  mode: 'dry-run' | 'apply';
  source: 'sqlite' | 'firestore';
  scannedCount: number;
  candidateCount: number;
  repairedCount: number;
  skippedCount: number;
  backupPath: string | null;
  candidates: Array<{
    id: string;
    orderNumber: string;
    evidence: string[];
    before: CancellationRepairCandidate['before'];
    after: CancellationRepairCandidate['after'];
  }>;
}

function parseHistory(raw: unknown): OrderStatusHistoryEntry[] {
  if (Array.isArray(raw)) {
    return raw.filter((entry): entry is OrderStatusHistoryEntry =>
      Boolean(entry && typeof entry === 'object' && typeof (entry as { status?: unknown }).status === 'string')
    );
  }
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = parseJsonSafe<unknown>(raw, []);
    if (Array.isArray(parsed)) {
      return parsed.filter((entry): entry is OrderStatusHistoryEntry =>
        Boolean(entry && typeof entry === 'object' && typeof (entry as { status?: unknown }).status === 'string')
      );
    }
  }
  return [];
}

function parseCancelRequest(raw: unknown): OrderReturnRequest | null {
  if (!raw) return null;
  const obj = typeof raw === 'string' ? parseJsonSafe<OrderReturnRequest | null>(raw, null) : (raw as OrderReturnRequest);
  if (!obj || typeof obj !== 'object') return null;
  if (obj.type !== 'cancel' && obj.type !== 'return') return null;
  return obj;
}

/**
 * Inspects a single order record and returns a repair candidate ONLY when there is
 * verified cancellation evidence and the stored record is inconsistent or incomplete.
 *
 * Explicitly does NOT repair:
 * - Genuine pending / placed / confirmed / packed / shipped / delivered orders
 * - Pending (unapproved) cancellation requests without cancellation confirmation
 * - Failed payments or abandoned checkouts without cancellation evidence
 */
export function inspectOrderForCancellationRepair(
  record: RepairableOrderRecord,
  now = Date.now()
): CancellationRepairCandidate | null {
  const normStatus = normalizeRawOrderStatusValue(record.rawStatus);
  const normFulfillment = normalizeRawOrderStatusValue(record.rawFulfillmentStatus);

  const evidence: string[] = [];

  if (normStatus === 'cancelled' || normFulfillment === 'cancelled') {
    evidence.push('cancelled_status_field');
  }
  if (record.cancelRequest?.type === 'cancel' && record.cancelRequest.status === 'approved') {
    evidence.push('approved_cancel_request');
  }
  if (typeof record.cancelledAt === 'number' && Number.isFinite(record.cancelledAt) && record.cancelledAt > 0) {
    evidence.push('cancelled_at_timestamp');
  }

  const cancelHistoryEntries = record.statusHistory.filter((entry) => {
    const st = String(entry.status || '').trim().toLowerCase();
    return st === 'cancelled' || st === 'canceled' || st === 'cancel_approved';
  });
  if (cancelHistoryEntries.length > 0) {
    evidence.push('status_history_cancelled');
  }

  // No verified cancellation evidence -> leave untouched
  if (evidence.length === 0) {
    return null;
  }

  const normalizedPay = normalizePaymentAndRefundStatus({
    rawPaymentStatus: record.paymentStatus,
    rawRefundStatus: record.refundStatus,
    paymentMethod: record.paymentMethod,
    orderStatus: 'cancelled',
  });

  const lastCancelHistory = cancelHistoryEntries[cancelHistoryEntries.length - 1];
  const resolvedCancelledAt =
    record.cancelledAt && record.cancelledAt > 0
      ? record.cancelledAt
      : lastCancelHistory?.at && Number.isFinite(lastCancelHistory.at) && lastCancelHistory.at > 0
        ? Number(lastCancelHistory.at)
        : record.cancelRequest?.resolvedAt && record.cancelRequest.resolvedAt > 0
          ? record.cancelRequest.resolvedAt
          : record.updatedAt || now;

  const resolvedCancelledBy =
    record.cancelledBy?.trim() ||
    (lastCancelHistory?.actor ? String(lastCancelHistory.actor) : '') ||
    (record.cancelRequest?.status === 'approved' ? 'customer' : 'system');

  const resolvedCancelReason =
    record.cancelReason?.trim() ||
    record.cancelRequest?.reason?.trim() ||
    null;

  const alreadyConsistent =
    record.rawStatus === 'cancelled' &&
    record.rawFulfillmentStatus === 'cancelled' &&
    typeof record.cancelledAt === 'number' &&
    record.cancelledAt > 0 &&
    Boolean(record.cancelledBy?.trim()) &&
    record.refundStatus === normalizedPay.refundStatus;

  if (alreadyConsistent) {
    return null;
  }

  const nextStatusHistory: OrderStatusHistoryEntry[] = [
    ...record.statusHistory,
    {
      status: 'cancelled',
      actor: 'system',
      note: `Repaired cancelled order state (${evidence.join(', ')}).`,
      at: now,
    },
  ];

  return {
    id: record.id,
    orderNumber: record.orderNumber,
    evidence,
    before: {
      status: record.rawStatus || '',
      fulfillmentStatus: record.rawFulfillmentStatus || '',
      paymentStatus: record.paymentStatus || '',
      refundStatus: record.refundStatus || '',
      cancelledAt: record.cancelledAt ?? null,
      cancelledBy: record.cancelledBy ?? null,
    },
    after: {
      status: 'cancelled',
      fulfillmentStatus: 'cancelled',
      refundStatus: normalizedPay.refundStatus,
      cancelledAt: resolvedCancelledAt,
      cancelledBy: resolvedCancelledBy,
      cancelReason: resolvedCancelReason,
    },
    rawRecord: record.rawRecord,
    nextStatusHistory,
  };
}

export function findOrdersNeedingCancellationRepair(
  records: RepairableOrderRecord[],
  now = Date.now()
): CancellationRepairCandidate[] {
  const candidates: CancellationRepairCandidate[] = [];
  for (const record of records) {
    const candidate = inspectOrderForCancellationRepair(record, now);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

function writeBackupFile(
  backupDir: string,
  source: 'sqlite' | 'firestore',
  candidates: CancellationRepairCandidate[],
  now: number
): string {
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(backupDir, `repair-cancelled-orders-backup-${source}-${stamp}.json`);
  const payload = {
    createdAt: new Date(now).toISOString(),
    source,
    affectedOrderCount: candidates.length,
    records: candidates.map((c) => ({
      id: c.id,
      orderNumber: c.orderNumber,
      evidence: c.evidence,
      before: c.before,
      plannedAfter: c.after,
      rawRecord: c.rawRecord,
    })),
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return filePath;
}

export function runSqliteCancellationRepair(options: {
  dbPath: string;
  apply: boolean;
  backupDir?: string;
  now?: number;
}): CancellationRepairSummary {
  const now = options.now ?? Date.now();
  const backupDir = options.backupDir || path.resolve(process.cwd(), 'data', 'backups');
  const db = new DatabaseSync(options.dbPath);

  try {
    // Ensure new cancellation columns exist before reading/writing
    const cols = db.prepare(`PRAGMA table_info(orders)`).all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    if (!colNames.has('refund_status')) {
      db.exec(`ALTER TABLE orders ADD COLUMN refund_status TEXT NOT NULL DEFAULT 'none'`);
    }
    if (!colNames.has('cancelled_at')) {
      db.exec(`ALTER TABLE orders ADD COLUMN cancelled_at INTEGER`);
    }
    if (!colNames.has('cancelled_by')) {
      db.exec(`ALTER TABLE orders ADD COLUMN cancelled_by TEXT`);
    }
    if (!colNames.has('cancel_reason')) {
      db.exec(`ALTER TABLE orders ADD COLUMN cancel_reason TEXT`);
    }

    const rows = db.prepare(`SELECT * FROM orders ORDER BY created_at DESC`).all() as Array<
      Record<string, unknown>
    >;

    const records: RepairableOrderRecord[] = rows.map((row) => ({
      id: String(row.id || ''),
      orderNumber: String(row.order_number || ''),
      rawStatus: String(row.status || ''),
      rawFulfillmentStatus: String(row.fulfillment_status || ''),
      paymentStatus: String(row.payment_status || ''),
      paymentMethod: String(row.payment_method || 'razorpay'),
      refundStatus: String(row.refund_status || 'none'),
      cancelledAt: typeof row.cancelled_at === 'number' ? row.cancelled_at : null,
      cancelledBy: typeof row.cancelled_by === 'string' ? row.cancelled_by : null,
      cancelReason: typeof row.cancel_reason === 'string' ? row.cancel_reason : null,
      cancelRequest: parseCancelRequest(row.cancel_request_json),
      statusHistory: parseHistory(row.status_history_json),
      createdAt: Number(row.created_at || 0),
      updatedAt: Number(row.updated_at || 0),
      rawRecord: row,
    }));

    const candidates = findOrdersNeedingCancellationRepair(records, now);
    let backupPath: string | null = null;
    let repairedCount = 0;

    if (options.apply && candidates.length > 0) {
      backupPath = writeBackupFile(backupDir, 'sqlite', candidates, now);
      const updateStmt = db.prepare(`
        UPDATE orders
        SET status = 'cancelled',
            fulfillment_status = 'cancelled',
            refund_status = ?,
            cancelled_at = ?,
            cancelled_by = ?,
            cancel_reason = ?,
            status_history_json = ?,
            updated_at = ?
        WHERE id = ?
      `);

      db.exec('BEGIN IMMEDIATE;');
      try {
        for (const item of candidates) {
          updateStmt.run(
            item.after.refundStatus,
            item.after.cancelledAt,
            item.after.cancelledBy,
            item.after.cancelReason,
            JSON.stringify(item.nextStatusHistory),
            now,
            item.id
          );
          repairedCount += 1;
        }
        db.exec('COMMIT;');
      } catch (err) {
        try {
          db.exec('ROLLBACK;');
        } catch {
          // ignore rollback errors
        }
        throw err;
      }
    }

    return {
      mode: options.apply ? 'apply' : 'dry-run',
      source: 'sqlite',
      scannedCount: records.length,
      candidateCount: candidates.length,
      repairedCount,
      skippedCount: records.length - candidates.length,
      backupPath,
      candidates: candidates.map((c) => ({
        id: c.id,
        orderNumber: c.orderNumber,
        evidence: c.evidence,
        before: c.before,
        after: c.after,
      })),
    };
  } finally {
    db.close();
  }
}

export async function runFirestoreCancellationRepair(options: {
  apply: boolean;
  envKey?: 'development' | 'production';
  backupDir?: string;
  now?: number;
}): Promise<CancellationRepairSummary> {
  const now = options.now ?? Date.now();
  const backupDir = options.backupDir || path.resolve(process.cwd(), 'data', 'backups');
  const envKey = options.envKey || (process.env.NODE_ENV === 'production' ? 'production' : 'development');

  const { initializeApp, getApps, applicationDefault } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
    projectId: string;
    firestoreDatabaseId?: string;
  };

  if (getApps().length === 0) {
    initializeApp({
      credential: applicationDefault(),
      projectId: config.projectId,
    });
  }

  const db = config.firestoreDatabaseId
    ? getFirestore(config.firestoreDatabaseId)
    : getFirestore();

  const ordersCol = db.collection('environments').doc(envKey).collection('orders');
  const snap = await ordersCol.get();

  const records: RepairableOrderRecord[] = snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    return {
      id: d.id,
      orderNumber: String(data.order_number || ''),
      rawStatus: String(data.status || ''),
      rawFulfillmentStatus: String(data.fulfillment_status || ''),
      paymentStatus: String(data.payment_status || ''),
      paymentMethod: String(data.payment_method || 'razorpay'),
      refundStatus: String(data.refund_status || 'none'),
      cancelledAt: typeof data.cancelled_at === 'number' ? data.cancelled_at : null,
      cancelledBy: typeof data.cancelled_by === 'string' ? data.cancelled_by : null,
      cancelReason: typeof data.cancel_reason === 'string' ? data.cancel_reason : null,
      cancelRequest: parseCancelRequest(data.cancel_request ?? data.cancel_request_json),
      statusHistory: parseHistory(data.status_history ?? data.status_history_json),
      createdAt: Number(data.created_at || 0),
      updatedAt: Number(data.updated_at || 0),
      rawRecord: { id: d.id, ...data },
    };
  });

  const candidates = findOrdersNeedingCancellationRepair(records, now);
  let backupPath: string | null = null;
  let repairedCount = 0;

  if (options.apply && candidates.length > 0) {
    backupPath = writeBackupFile(backupDir, 'firestore', candidates, now);
    for (const item of candidates) {
      await ordersCol.doc(item.id).update({
        status: 'cancelled',
        fulfillment_status: 'cancelled',
        refund_status: item.after.refundStatus,
        cancelled_at: item.after.cancelledAt,
        cancelled_by: item.after.cancelledBy,
        cancel_reason: item.after.cancelReason,
        status_history: item.nextStatusHistory,
        status_history_json: JSON.stringify(item.nextStatusHistory),
        updated_at: now,
      });
      repairedCount += 1;
    }
  }

  return {
    mode: options.apply ? 'apply' : 'dry-run',
    source: 'firestore',
    scannedCount: records.length,
    candidateCount: candidates.length,
    repairedCount,
    skippedCount: records.length - candidates.length,
    backupPath,
    candidates: candidates.map((c) => ({
      id: c.id,
      orderNumber: c.orderNumber,
      evidence: c.evidence,
      before: c.before,
      after: c.after,
    })),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const sourceArg = args.find((a) => a.startsWith('--source='))?.split('=')[1] || 'sqlite';
  const dbPathArg =
    args.find((a) => a.startsWith('--db-path='))?.split('=')[1] ||
    process.env.DB_PATH ||
    path.resolve(process.cwd(), 'data', 'boutique.db');
  const envArg = (args.find((a) => a.startsWith('--env='))?.split('=')[1] || 'production') as
    | 'development'
    | 'production';
  const backupDirArg = args.find((a) => a.startsWith('--backup-dir='))?.split('=')[1];

  if (sourceArg === 'firestore') {
    const summary = await runFirestoreCancellationRepair({
      apply,
      envKey: envArg,
      backupDir: backupDirArg,
    });
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (!fs.existsSync(dbPathArg)) {
    console.log(
      JSON.stringify(
        {
          mode: apply ? 'apply' : 'dry-run',
          source: 'sqlite',
          scannedCount: 0,
          candidateCount: 0,
          repairedCount: 0,
          skippedCount: 0,
          backupPath: null,
          note: `No SQLite database found at ${dbPathArg}. Pass --source=firestore or --db-path=<file>.`,
        },
        null,
        2
      )
    );
    return;
  }

  const summary = runSqliteCancellationRepair({
    dbPath: dbPathArg,
    apply,
    backupDir: backupDirArg,
  });
  console.log(JSON.stringify(summary, null, 2));
}

const isEntrypoint =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntrypoint) {
  main().catch((err) => {
    console.error('[repair-cancelled-orders] Fatal error:', err);
    process.exit(1);
  });
}
