const test = require('node:test');
const assert = require('node:assert/strict');

const { shapeOverview } = require('../revenuecat');

test('shapeOverview: the overview metrics by id, money as RevenueCat sends it (labelled "$" whatever the currency)', () => {
  const figures = shapeOverview({
    object: 'overview_metrics',
    metrics: [
      { id: 'active_trials', value: 120, unit: '#' },
      { id: 'active_subscriptions', value: 2140, unit: '#' },
      { id: 'mrr', value: 15400.5, unit: '$' },
      { id: 'revenue', value: 16800, unit: '$', period: 'P28D' },
      { id: 'new_customers', value: 900, unit: '#', period: 'P28D' },
    ],
  });
  assert.deepEqual(figures, { subscriptions: 2140, mrr: 15400.5, trials: 120, revenue: 16800, newCustomers: 900 });
  assert.deepEqual(shapeOverview({ metrics: [] }), { subscriptions: null, mrr: null, trials: null, revenue: null, newCustomers: null });
});
