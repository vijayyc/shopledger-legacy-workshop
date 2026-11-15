const test = require('node:test');
const assert = require('node:assert/strict');
const inventory = require('../lib/inventory');
const orders = require('../lib/orders');

// All fixtures are synthetic and in memory. These modules do not load the store.
function products() {
  return [
    { id: 1, sku: 'DRY-001', name: 'A2 Gir Cow Ghee 500ml', stock: 1, reserved: 0 },
    { id: 2, sku: 'SPC-001', name: 'Byadgi Kashmiri Chilli Powder 500g', stock: 4, reserved: 3 }
  ];
}

for (const index of [0, 1]) {
  test(`allows the last sellable unit of ${index === 0 ? 'DRY-001' : 'SPC-001'}`, () => {
    const catalog = products();
    const before = structuredClone(catalog);
    const product = catalog[index];
    assert.equal(inventory.getSellableStock(product), 1);
    assert.deepEqual(inventory.check(catalog, [{ id: product.id, qty: 1 }]), { ok: true });
    assert.deepEqual(catalog, before);
  });
}

test('permits quantities up to sellable stock but rejects excessive quantities', () => {
  const catalog = [{ id: 1, name: 'Ghee', stock: 8, reserved: 3 }];
  assert.equal(inventory.getSellableStock(catalog[0]), 5);
  assert.deepEqual(inventory.check(catalog, [{ id: 1, qty: 4 }]), { ok: true });
  assert.deepEqual(inventory.check(catalog, [{ id: 1, qty: 5 }]), { ok: true });
  assert.deepEqual(inventory.check(catalog, [{ id: 1, qty: 6 }]), {
    ok: false, msg: 'Ghee is out of stock (5 sellable available)'
  });
});

test('release restores physical stock for normal order lines and preserves reservations', () => {
  const catalog = products();
  const before = structuredClone(catalog);
  inventory.release(catalog, [{ id: 1, qty: 2 }, { id: 2, qty: 2 }]);
  assert.deepEqual(catalog, before.map(p => ({ ...p, stock: p.stock + 2 })));
});

test('release skips unknown product IDs', () => {
  const catalog = products();
  const before = structuredClone(catalog);
  inventory.release(catalog, [{ id: 999, qty: 2 }]);
  assert.deepEqual(catalog, before);
});

test('cancelling pending order #1007 restores committed stock exactly once', () => {
  const db = {
    products: [
      { id: 1, sku: 'DRY-001', name: 'A2 Gir Cow Ghee 500ml', stock: 5, reserved: 1 },
      { id: 3, name: 'Sunflower Oil', stock: 8, reserved: 2 }
    ],
    orders: [], nextOrderId: 1007
  };
  const items = [{ id: 1, qty: 2 }, { id: 3, qty: 2 }];
  assert.deepEqual(inventory.check(db.products, items), { ok: true });
  inventory.reserve(db.products, items);
  assert.deepEqual(db.products.map(p => [p.stock, p.reserved, inventory.getSellableStock(p)]), [
    [3, 1, 2], [6, 2, 4]
  ]);
  const order = orders.add(db, {
    customer: 'Suresh Deshmukh', status: 'pending', paymentMode: 'cash', items, total: 1000
  });
  const before = structuredClone(db.products);
  const result = orders.cancel(db, '1007', 'Customer requested cancellation');
  assert.equal(result.ok, true);
  assert.equal(result.order, order);
  assert.equal(order.status, 'cancelled');
  assert.match(order.cancelledAt, /^\d{2}\/\d{2}\/\d{4}$/);
  assert.equal(order.cancelReason, 'Customer requested cancellation');
  assert.deepEqual(db.products, before.map(p => ({ ...p, stock: p.stock + 2 })));
  assert.deepEqual(db.products.map(inventory.getSellableStock), [4, 6]);

  const afterCancellation = structuredClone(db);
  assert.deepEqual(orders.cancel(db, 1007, 'Again'), {
    ok: false, error: 'Order #1007 is already cancelled'
  });
  assert.deepEqual(db, afterCancellation);
});

test('CURRENT BEHAVIOUR: cancelling a missing order returns an error without mutation', () => {
  const db = { products: products(), orders: [] };
  const before = structuredClone(db);
  assert.deepEqual(orders.cancel(db, 9999), { ok: false, error: 'Order not found' });
  assert.deepEqual(db, before);
});

test('rejects a sale when reservations leave no sellable stock', () => {
  const catalog = [{ id: 1, name: 'Ghee', stock: 3, reserved: 3 }];
  assert.deepEqual(inventory.check(catalog, [{ id: 1, qty: 1 }]), {
    ok: false, msg: 'Ghee is out of stock (0 sellable available)'
  });
});

test('reserve and release round trip numeric strings without changing reservations', () => {
  const catalog = [{ id: 1, stock: '5', reserved: 2 }];
  const items = [{ id: '1', qty: '2' }];
  inventory.reserve(catalog, items);
  assert.equal(catalog[0].stock, 3);
  inventory.release(catalog, items);
  assert.deepEqual(catalog, [{ id: 1, stock: 5, reserved: 2 }]);
});
