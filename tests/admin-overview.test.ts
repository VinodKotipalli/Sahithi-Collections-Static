import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { normalizeAdminOverview } from '../src/services/adminOverview.ts';
import { AdminOverviewSection } from '../src/components/admin/AdminOverviewSection.tsx';

const props = { loading: false, onNavigateTab: () => {}, onQuickFilterCatalog: () => {}, onEditProduct: () => {}, onCreateProduct: () => {} };

test('regression: legacy Firebase overview renders without undefined.length', () => {
  const overview = { metrics: { totalProducts: 0, activeProducts: 0 }, recentAudit: [] };
  const html = renderToStaticMarkup(React.createElement(AdminOverviewSection, { ...props, overview } as any));
  assert.match(html, /No storefront orders placed yet/);
  assert.match(html, /No customer messages received yet/);
  assert.match(html, /No recent catalog activity recorded/);
  assert.doesNotMatch(html, /undefined|NaN/);
});

test('missing and malformed overview collections normalize to safe empty lists', () => {
  for (const input of [undefined, null, {}, {metrics: null, recentOrders: null, recentMessages: {}, lowStockItems: 'bad', recentAuditLogs: 2}]) {
    const result = normalizeAdminOverview(input);
    for (const key of ['recentOrders','recentMessages','lowStockItems','recentAuditLogs'] as const) assert.deepEqual(result[key], []);
    assert.ok(Object.values(result.metrics).every(n => n === 0));
  }
});

test('Firestore rows preserve recent records and map dashboard names', () => {
  const result = normalizeAdminOverview({ metrics: { activeProducts: 3, totalAuditEvents: 1 },
    recentOrders: [{id:'o1', order_number:'SC1',customer_name:'Customer',total_paise:129900,created_at:100}],
    recentMessages: [{id:'m1',full_name:'Customer',email:'test@example.com',status:'new',message:'Hello',created_at:100}],
    recentAudit: [{id:'a1',entity_id:'p1',action:'update',summary:'Changed stock',created_at:100}] });
  assert.equal(result.metrics.publishedProducts, 3);
  assert.equal(result.recentOrders[0].totalPaise, 129900);
  assert.equal(result.recentOrders[0].customerName, 'Customer');
  assert.equal(result.recentMessages[0].senderName, 'Customer');
  assert.equal(result.recentMessages[0].status, 'unread');
  assert.equal(result.recentAuditLogs[0].productId, 'p1');
  assert.equal(result.metrics.totalAuditEvents, 1);
});

test('actual Firebase overview endpoint supplies all arrays and renders merged catalog with empty Firestore activity', async () => {
  const { handleClientlessApiRequest, clearClientFirebaseSession, AUTHORIZED_OWNER_EMAIL } = await import('../src/services/firebaseClientApi.ts');
  const { PRODUCTS } = await import('../src/config/products.ts');
  const originalFetch = globalThis.fetch;
  clearClientFirebaseSession();
  globalThis.fetch = async (input, options) => {
    const url = String(input);
    if (url.includes('accounts:signInWithPassword')) return Response.json({idToken:'test-token',refreshToken:'test-refresh'});
    if (url.includes('accounts:lookup')) return Response.json({users:[{localId:'test-owner',email:AUTHORIZED_OWNER_EMAIL,emailVerified:true}]});
    if (url.startsWith('https://firestore.googleapis.com/')) {
      if (options?.method === 'PATCH') return Response.json({fields:{}});
      if (url.includes('?pageSize=')) return Response.json({documents:[]});
      return Response.json({}, {status:404});
    }
    throw new Error('Unexpected test request');
  };
  try {
    const login = await handleClientlessApiRequest('/api/admin/login','POST',JSON.stringify({email:AUTHORIZED_OWNER_EMAIL,password:'test-only-password'}));
    assert.equal(login.ok,true);
    const response = await handleClientlessApiRequest<any>('/api/admin/overview','GET');
    assert.equal(response.ok,true);
    if (!response.ok) return;
    for (const key of ['recentOrders','recentMessages','lowStockItems','recentAuditLogs']) assert.deepEqual(response.data[key],[]);
    assert.equal(response.data.metrics.publishedProducts,PRODUCTS.length);
    assert.equal(response.data.metrics.totalAuditEvents,0);
    assert.doesNotThrow(() => renderToStaticMarkup(React.createElement(AdminOverviewSection,{...props,overview:response.data})));

    // Verify clientless POST /api/admin/products/sc-101/unpublish and publish succeed
    const unpubRes = await handleClientlessApiRequest<any>(
      '/api/admin/products/sc-101/unpublish',
      'POST',
      JSON.stringify({ expectedVersion: 1 })
    );
    assert.equal(unpubRes.ok, true);
    if (unpubRes.ok) {
      assert.equal(unpubRes.data.product.id, 'sc-101');
      assert.equal(unpubRes.data.product.status, 'draft');
    }

    const pubRes = await handleClientlessApiRequest<any>(
      '/api/admin/products/sc-101/publish',
      'POST',
      JSON.stringify({ expectedVersion: 2 })
    );
    assert.equal(pubRes.ok, true);
    if (pubRes.ok) {
      assert.equal(pubRes.data.product.id, 'sc-101');
      assert.equal(pubRes.data.product.status, 'published');
    }
  } finally { globalThis.fetch = originalFetch; clearClientFirebaseSession(); }
});
