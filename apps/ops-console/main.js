const http = require('http');
const { URL } = require('url');

const HOST = '127.0.0.1';
const PORT = Number(process.env.BOUNDLESS_APP_PORT || 43110);

function makeInitialState() {
  return {
    services: [
      { name: 'router', status: 'healthy', latencyMs: 28, region: 'cn-shanghai' },
      { name: 'classifier', status: 'healthy', latencyMs: 44, region: 'cn-shanghai' },
      { name: 'playbook-runner', status: 'healthy', latencyMs: 61, region: 'ap-singapore' }
    ],
    tickets: [
      { id: 'OPS-2031', customer: 'Northwind', severity: 'high', channel: 'Email', summary: 'Refund flow returns duplicate receipts', waitMinutes: 18, assignee: null, status: 'open' },
      { id: 'OPS-2030', customer: 'Aperture', severity: 'medium', channel: 'Slack', summary: 'Webhook retry queue is growing after 09:10', waitMinutes: 26, assignee: 'Ava', status: 'open' },
      { id: 'OPS-2029', customer: 'Fabrikam', severity: 'low', channel: 'Email', summary: 'Need export CSV for finance reconciliation', waitMinutes: 34, assignee: null, status: 'open' }
    ],
    automations: {
      routingAccuracy: 94,
      runsToday: 182,
      avgHandleMinutes: 7.4
    },
    activity: [
      { id: 1, time: '09:42', message: 'Classifier promoted fraud-related tickets to urgent path.' },
      { id: 2, time: '09:38', message: 'Ava acknowledged queue spike for webhook retries.' },
      { id: 3, time: '09:31', message: 'Northwind refund issue matched existing incident signature.' }
    ]
  };
}

const state = makeInitialState();

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(payload));
}

function pushActivity(message) {
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  state.activity.unshift({
    id: Date.now(),
    time,
    message
  });
  state.activity = state.activity.slice(0, 8);
}

function getDashboard() {
  const openTickets = state.tickets.filter((ticket) => ticket.status === 'open');
  const urgentCount = openTickets.filter((ticket) => ticket.severity === 'high').length;
  const assignedCount = openTickets.filter((ticket) => ticket.assignee).length;
  const avgWaitMinutes = openTickets.length > 0
    ? Math.round(openTickets.reduce((sum, ticket) => sum + ticket.waitMinutes, 0) / openTickets.length)
    : 0;

  return {
    runtime: {
      port: PORT,
      uptimeSeconds: Math.floor(process.uptime())
    },
    metrics: {
      openTickets: openTickets.length,
      urgentCount,
      assignedCount,
      avgWaitMinutes,
      routingAccuracy: state.automations.routingAccuracy,
      runsToday: state.automations.runsToday,
      avgHandleMinutes: state.automations.avgHandleMinutes
    },
    services: state.services,
    tickets: openTickets,
    activity: state.activity
  };
}

function assignNextTicket() {
  const nextTicket = state.tickets.find((ticket) => ticket.status === 'open' && !ticket.assignee);
  if (!nextTicket) {
    pushActivity('No unassigned tickets were available for pickup.');
    return;
  }

  nextTicket.assignee = 'Ava';
  nextTicket.waitMinutes = Math.max(4, nextTicket.waitMinutes - 5);
  pushActivity(`Assigned ${nextTicket.id} to Ava for manual follow-up.`);
}

function runPlaybook() {
  state.automations.runsToday += 4;
  state.automations.routingAccuracy = Math.min(99, state.automations.routingAccuracy + 1);
  state.automations.avgHandleMinutes = Math.max(5.2, Number((state.automations.avgHandleMinutes - 0.2).toFixed(1)));

  const targetService = state.services.find((service) => service.name === 'playbook-runner');
  if (targetService) {
    targetService.latencyMs = Math.max(38, targetService.latencyMs - 6);
  }

  pushActivity('Executed retry playbook and refreshed automation thresholds.');
}

function resolveOldestTicket() {
  const oldestTicket = state.tickets
    .filter((ticket) => ticket.status === 'open')
    .sort((left, right) => right.waitMinutes - left.waitMinutes)[0];

  if (!oldestTicket) {
    pushActivity('No open tickets were available to resolve.');
    return;
  }

  oldestTicket.status = 'resolved';
  oldestTicket.assignee = oldestTicket.assignee || 'Ava';
  pushActivity(`Resolved ${oldestTicket.id} and closed the customer loop.`);
}

function resetDemo() {
  const fresh = makeInitialState();
  state.services = fresh.services;
  state.tickets = fresh.tickets;
  state.automations = fresh.automations;
  state.activity = fresh.activity;
  pushActivity('Reset the demo data to the initial operating state.');
}

function driftState() {
  for (const ticket of state.tickets) {
    if (ticket.status === 'open') {
      ticket.waitMinutes += ticket.assignee ? 1 : 2;
    }
  }

  for (const service of state.services) {
    const drift = Math.floor(Math.random() * 7) - 3;
    service.latencyMs = Math.max(22, service.latencyMs + drift);
  }

  if (Math.random() > 0.7) {
    const nextId = 2032 + state.activity.length;
    state.tickets.unshift({
      id: `OPS-${nextId}`,
      customer: ['Contoso', 'Litware', 'Tailspin'][Math.floor(Math.random() * 3)],
      severity: ['low', 'medium', 'high'][Math.floor(Math.random() * 3)],
      channel: ['Slack', 'Email', 'API'][Math.floor(Math.random() * 3)],
      summary: 'New operational signal detected and queued for triage.',
      waitMinutes: 3,
      assignee: null,
      status: 'open'
    });
    state.tickets = state.tickets.slice(0, 7);
    pushActivity('A new operational ticket entered the queue.');
  }
}

const server = http.createServer((req, res) => {
  if (!req.url || !req.method) {
    sendJson(res, 400, { error: 'Invalid request' });
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, {
      status: 'ok',
      service: 'ops-console',
      port: PORT,
      uptimeSeconds: Math.floor(process.uptime())
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/dashboard') {
    sendJson(res, 200, getDashboard());
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/actions/assign-next') {
    assignNextTicket();
    sendJson(res, 200, getDashboard());
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/actions/run-playbook') {
    runPlaybook();
    sendJson(res, 200, getDashboard());
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/actions/resolve-oldest') {
    resolveOldestTicket();
    sendJson(res, 200, getDashboard());
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/actions/reset') {
    resetDemo();
    sendJson(res, 200, getDashboard());
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`[ops-console] API listening on http://${HOST}:${PORT}`);
});

const driftTimer = setInterval(driftState, 8000);
driftTimer.unref();

function shutdown() {
  clearInterval(driftTimer);
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
