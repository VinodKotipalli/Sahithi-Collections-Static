import { getApp, getApps, initializeApp } from 'firebase/app';
import {
  collection,
  doc,
  getDocFromServer,
  getFirestore,
  onSnapshot,
  query,
  where,
  type Firestore,
  type Unsubscribe,
} from 'firebase/firestore';
import firebaseAppletConfig from '../../firebase-applet-config.json';
import { getFirebaseWebAuth } from './firebaseWebAuth';
import { serializeClientOrderDoc } from './firebaseClientApi';
import type { AdminOrder, PlacedOrderReceipt } from '../types/boutique';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

let cachedDb: Firestore | null = null;
let connectionChecked = false;

function resolveRealtimeEnvKey(): 'development' | 'production' {
  if (typeof window === 'undefined') return 'development';
  const host = window.location.hostname.toLowerCase();
  if (host.startsWith('ais-pre-')) return 'production';
  if (
    host !== 'localhost' &&
    host !== '127.0.0.1' &&
    !host.startsWith('ais-dev-')
  ) {
    return 'production';
  }
  return 'development';
}

export function getRealtimeFirestoreDb(): Firestore {
  if (cachedDb) return cachedDb;
  const auth = getFirebaseWebAuth();
  const app =
    auth.app ||
    (getApps().length > 0
      ? getApp()
      : initializeApp({
          apiKey: firebaseAppletConfig.apiKey,
          authDomain:
            firebaseAppletConfig.authDomain ||
            `${firebaseAppletConfig.projectId}.firebaseapp.com`,
          projectId: firebaseAppletConfig.projectId,
          appId: firebaseAppletConfig.appId,
        }));
  const databaseId = firebaseAppletConfig.firestoreDatabaseId || '(default)';
  cachedDb = getFirestore(app, databaseId);
  if (!connectionChecked) {
    connectionChecked = true;
    void testFirestoreConnection(cachedDb);
  }
  return cachedDb;
}

export async function testFirestoreConnection(dbInstance?: Firestore): Promise<void> {
  try {
    const db = dbInstance || getRealtimeFirestoreDb();
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}

export function formatFirestoreErrorInfo(
  error: unknown,
  operationType: OperationType,
  path: string | null
): FirestoreErrorInfo {
  const auth = getFirebaseWebAuth();
  const user = auth.currentUser;
  return {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: user?.uid ?? null,
      email: user?.email ?? null,
      emailVerified: user?.emailVerified ?? null,
      isAnonymous: user?.isAnonymous ?? null,
      tenantId: user?.tenantId ?? null,
      providerInfo:
        user?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo = formatFirestoreErrorInfo(error, operationType, path);
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export type RealtimeListenerState = 'connecting' | 'connected' | 'reconnecting' | 'error';

export function subscribeAdminOrdersRealtime(callbacks: {
  onOrders: (orders: AdminOrder[]) => void;
  onError?: (message: string, info: FirestoreErrorInfo) => void;
  onStatusChange?: (state: RealtimeListenerState) => void;
}): Unsubscribe {
  const auth = getFirebaseWebAuth();
  if (!auth.currentUser) {
    callbacks.onStatusChange?.('connecting');
    return () => {};
  }

  const envKey = resolveRealtimeEnvKey();
  const ordersPath = `environments/${envKey}/orders`;
  const db = getRealtimeFirestoreDb();
  callbacks.onStatusChange?.('connecting');

  return onSnapshot(
    collection(db, ordersPath),
    (snapshot) => {
      callbacks.onStatusChange?.('connected');
      const items = snapshot.docs
        .map((d) => {
          const data = { id: d.id, ...(d.data() as Record<string, unknown>) };
          return serializeClientOrderDoc(data) as unknown as AdminOrder;
        })
        .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
      callbacks.onOrders(items);
    },
    (error) => {
      const info = formatFirestoreErrorInfo(error, OperationType.LIST, ordersPath);
      console.error('Firestore Error: ', JSON.stringify(info));
      callbacks.onStatusChange?.('error');
      callbacks.onError?.(
        'Live order updates disconnected. Using periodic refresh — click Reconnect to restore instant sync.',
        info
      );
    }
  );
}

export function subscribeCustomerOrdersRealtime(
  customerUid: string,
  callbacks: {
    onOrders: (orders: PlacedOrderReceipt[]) => void;
    onError?: (message: string, info: FirestoreErrorInfo) => void;
    onStatusChange?: (state: RealtimeListenerState) => void;
  }
): Unsubscribe {
  const auth = getFirebaseWebAuth();
  if (!auth.currentUser || !customerUid || auth.currentUser.uid !== customerUid) {
    return () => {};
  }

  const envKey = resolveRealtimeEnvKey();
  const ordersPath = `environments/${envKey}/orders`;
  const db = getRealtimeFirestoreDb();
  callbacks.onStatusChange?.('connecting');

  const ordersQuery = query(
    collection(db, ordersPath),
    where('customer_user_id', '==', customerUid)
  );

  return onSnapshot(
    ordersQuery,
    (snapshot) => {
      callbacks.onStatusChange?.('connected');
      const items = snapshot.docs
        .map((d) => {
          const data = { id: d.id, ...(d.data() as Record<string, unknown>) };
          return serializeClientOrderDoc(data) as unknown as PlacedOrderReceipt;
        })
        .filter((o) => !o.hiddenByCustomer)
        .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
      callbacks.onOrders(items);
    },
    (error) => {
      const info = formatFirestoreErrorInfo(error, OperationType.LIST, ordersPath);
      console.error('Firestore Error: ', JSON.stringify(info));
      callbacks.onStatusChange?.('error');
      callbacks.onError?.(
        'Live order updates paused. Refreshing automatically.',
        info
      );
    }
  );
}
