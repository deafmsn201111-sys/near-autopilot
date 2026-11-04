/**
 * SYNTHETIC fixtures. They are hand-written to conform to the TypeScript interfaces in
 * ref-finance/ref-ui (`PoolInfo`, `UserLiquidityInfo`, `ILiquidityInfoPool`, `IOrderInfoPool`,
 * `UserStorageDetail`) and ref-finance/ref-sdk (`UserOrderInfo`). They are NOT recorded chain
 * responses and prove nothing about what a live node returns - test/live.integration.test.ts does that.
 */
export const POOL_ID = 'usdc.fakes.testnet|wrap.testnet|2000';

export const poolFixture = {
  pool_id: POOL_ID,
  token_x: 'usdc.fakes.testnet',
  token_y: 'wrap.testnet',
  fee: 2000,
  point_delta: 40,
  current_point: 288000,
  state: 'Running',
  liquidity: '5842542192',
  liquidity_x: '0',
  max_liquidity_per_point: '170141183460469231731687303715884105727',
  total_x: '1000000',
  total_y: '0',
  total_fee_x_charged: '0',
  total_fee_y_charged: '0',
};

export const positionFixture = {
  lpt_id: `${POOL_ID}#12`,
  owner_id: 'alice.testnet',
  pool_id: POOL_ID,
  left_point: 288680,
  right_point: 289000,
  amount: '5842542192',
  unclaimed_fee_x: '0',
  unclaimed_fee_y: '0',
};

export const orderFixture = {
  order_id: `${POOL_ID}#3`,
  owner_id: 'alice.testnet',
  pool_id: POOL_ID,
  point: 288000,
  sell_token: 'wrap.testnet',
  buy_token: 'usdc.fakes.testnet',
  created_at: '1700000000000000000',
  original_deposit_amount: '1000',
  swap_earn_amount: '0',
  original_amount: '1000',
  cancel_amount: '0',
  remain_amount: '1000',
  bought_amount: '0',
  unclaimed_amount: null,
};
