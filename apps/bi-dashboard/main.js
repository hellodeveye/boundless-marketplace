const http = require('http');
const { URL } = require('url');
const mysql = require('mysql2/promise');

const HOST = '127.0.0.1';
const PORT = Number(process.env.BOUNDLESS_APP_PORT || 43120);

let pool = null;
let dbInitError = null;

// ecp_order.status values used in metric filters
const ORDER_STATUS_PENDING_PAY = 10;
const ORDER_STATUS_CANCELLED   = 60;
// ecp_order_after_sale.status value for completed refunds
const AFTER_SALE_STATUS_COMPLETED = 40;

async function initDb() {
  const dbHost = process.env.LING_BO_DB_HOST;
  const dbPort = process.env.LING_BO_DB_PORT || 3306;
  const dbUser = process.env.LING_BO_DB_USER;
  const dbPassword = process.env.LING_BO_DB_PASSWORD;
  const dbName = process.env.LING_BO_DB_NAME;

  if (!dbHost || !dbUser || !dbName) {
    const missing = [
      !dbHost ? 'LING_BO_DB_HOST' : null,
      !dbUser ? 'LING_BO_DB_USER' : null,
      !dbName ? 'LING_BO_DB_NAME' : null
    ].filter(Boolean);
    throw new Error(`Missing DB env vars: ${missing.join(', ')}`);
  }

  pool = mysql.createPool({
    host: dbHost,
    port: Number(dbPort),
    user: dbUser,
    password: dbPassword,
    database: dbName,
    waitForConnections: true,
    connectionLimit: 5
  });

  await pool.query('SELECT 1');
  console.log('[bi-dashboard] MySQL pool initialized');
}

function getDateFilter(range, alias) {
  if (range === 'today') return `AND DATE(${alias}.created_at) = CURDATE()`;
  if (range === 'month') return `AND DATE(${alias}.created_at) >= DATE_FORMAT(CURDATE(), '%Y-%m-01')`;
  return '';
}

async function queryOverview(range) {
  const [[orderRows], [refundRows]] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(*) AS order_count,
        COALESCE(SUM(o.pay_amount), 0) AS pay_amount
      FROM lingbo_base.ecp_order o
      WHERE o.deleted = 0
        AND o.status NOT IN (${ORDER_STATUS_PENDING_PAY}, ${ORDER_STATUS_CANCELLED})
        ${getDateFilter(range, 'o')}
    `),
    pool.query(`
      SELECT
        COUNT(*) AS refund_count,
        COALESCE(SUM(a.refund_amount), 0) AS refund_amount
      FROM lingbo_base.ecp_order_after_sale a
      WHERE a.deleted = 0
        AND a.status = ${AFTER_SALE_STATUS_COMPLETED}
        ${getDateFilter(range, 'a')}
    `)
  ]);

  return {
    order_count: Number(orderRows[0].order_count),
    pay_amount: Number(orderRows[0].pay_amount),
    refund_count: Number(refundRows[0].refund_count),
    refund_amount: Number(refundRows[0].refund_amount)
  };
}

async function queryAccountSummary() {
  const [rows] = await pool.query(`
    SELECT
      COALESCE(SUM(total_in_amount), 0)  AS total_in,
      COALESCE(SUM(total_out_amount), 0) AS total_out,
      COALESCE(SUM(settling_amount), 0)  AS settling,
      COALESCE(SUM(available_amount), 0) AS available
    FROM lingbo_funds.ecp_account
    WHERE deleted = 0
  `);
  const r = rows[0];
  return {
    total_in:  Number(r.total_in),
    total_out: Number(r.total_out),
    settling:  Number(r.settling),
    available: Number(r.available)
  };
}

async function queryOrderTrend(days) {
  const [rows] = await pool.query(`
    SELECT
      DATE(created_at)       AS dt,
      COUNT(*)               AS order_count,
      COALESCE(SUM(pay_amount), 0) AS pay_amount
    FROM lingbo_base.ecp_order
    WHERE deleted = 0
      AND status NOT IN (${ORDER_STATUS_PENDING_PAY}, ${ORDER_STATUS_CANCELLED})
      AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
    GROUP BY DATE(created_at)
    ORDER BY dt ASC
  `, [days]);
  return rows.map(r => ({
    dt: r.dt instanceof Date ? r.dt.toISOString().slice(0, 10) : String(r.dt),
    order_count: Number(r.order_count),
    pay_amount: Number(r.pay_amount)
  }));
}

async function queryProductTop(limit) {
  const [rows] = await pool.query(`
    SELECT
      spu.name,
      COALESCE(SUM(oi.qty), 0)           AS total_qty,
      COALESCE(SUM(oi.total_amount), 0)  AS total_amount
    FROM lingbo_base.ecp_order_item oi
    JOIN lingbo_base.ecp_product_spu spu ON oi.spu_id = spu.id
    JOIN lingbo_base.ecp_order o ON oi.order_id = o.id
    WHERE oi.deleted = 0
      AND o.deleted = 0
      AND o.status NOT IN (${ORDER_STATUS_PENDING_PAY}, ${ORDER_STATUS_CANCELLED})
    GROUP BY spu.id, spu.name
    ORDER BY total_amount DESC
    LIMIT ?
  `, [limit]);
  return rows.map(r => ({
    name: r.name,
    total_qty: Number(r.total_qty),
    total_amount: Number(r.total_amount)
  }));
}

async function queryStoreTop(limit) {
  const [rows] = await pool.query(`
    SELECT
      org_name,
      COUNT(*)                     AS order_count,
      COALESCE(SUM(pay_amount), 0) AS total_amount
    FROM lingbo_base.ecp_order
    WHERE deleted = 0
      AND status NOT IN (${ORDER_STATUS_PENDING_PAY}, ${ORDER_STATUS_CANCELLED})
      AND org_name IS NOT NULL
      AND org_name != ''
    GROUP BY org_name
    ORDER BY total_amount DESC
    LIMIT ?
  `, [limit]);
  return rows.map(r => ({
    org_name: r.org_name,
    order_count: Number(r.order_count),
    total_amount: Number(r.total_amount)
  }));
}

async function queryOrderStatus() {
  const STATUS_LABELS = {
    10: '待付款',
    20: '待发货',
    30: '发货中',
    40: '待收货',
    50: '已完成',
    60: '已取消',
    70: '已退款'
  };
  const [rows] = await pool.query(`
    SELECT status, COUNT(*) AS cnt
    FROM lingbo_base.ecp_order
    WHERE deleted = 0
    GROUP BY status
    ORDER BY status
  `);
  return rows.map(r => ({
    status: Number(r.status),
    label: STATUS_LABELS[Number(r.status)] || `状态${r.status}`,
    count: Number(r.cnt)
  }));
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req, res) => {
  if (!req.url || !req.method) {
    sendJson(res, 400, { error: 'Invalid request' });
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, {
      status: pool ? 'ok' : 'degraded',
      service: 'bi-dashboard',
      port: PORT,
      dbConnected: Boolean(pool),
      dbInitError,
      uptimeSeconds: Math.floor(process.uptime())
    });
    return;
  }

  if (!pool) {
    sendJson(res, 503, { error: dbInitError || 'Database is not initialized' });
    return;
  }

  try {
    if (req.method === 'GET' && url.pathname === '/api/overview') {
      const range = url.searchParams.get('range') || 'month';
      const data = await queryOverview(range);
      sendJson(res, 200, data);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/account-summary') {
      const data = await queryAccountSummary();
      sendJson(res, 200, data);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/order-trend') {
      const days = Math.min(90, Math.max(7, Number(url.searchParams.get('days') || 30)));
      const data = await queryOrderTrend(days);
      sendJson(res, 200, data);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/product-top') {
      const limit = Math.min(20, Math.max(5, Number(url.searchParams.get('limit') || 10)));
      const data = await queryProductTop(limit);
      sendJson(res, 200, data);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/store-top') {
      const limit = Math.min(20, Math.max(5, Number(url.searchParams.get('limit') || 10)));
      const data = await queryStoreTop(limit);
      sendJson(res, 200, data);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/order-status') {
      const data = await queryOrderStatus();
      sendJson(res, 200, data);
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('[bi-dashboard] Query failed:', err.message);
    sendJson(res, 503, { error: err.message || 'Database error' });
  }
});

initDb().catch((err) => {
  dbInitError = err.message;
  console.error('[bi-dashboard] DB init failed:', err.message);
}).finally(() => {
  server.listen(PORT, HOST, () => {
    console.log(`[bi-dashboard] API listening on http://${HOST}:${PORT}`);
  });
});

function shutdown() {
  if (pool) pool.end();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
