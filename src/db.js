// SQLite storage (zero external setup, as preferred). Uses Node's built-in node:sqlite.
// NOT IP-protected: commodity code.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const dbPath = process.env.DB_PATH || './data/airpay.db';
if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);

try {
  db.exec('PRAGMA journal_mode = WAL;');
} catch {
  /* in-memory databases ignore this */
}

db.exec(`
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  flight_no TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  flight_no TEXT,
  items_json TEXT,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  amount_usd REAL NOT NULL,
  amount_inr REAL NOT NULL,
  buyer_name TEXT,
  buyer_contact TEXT,
  contact_key TEXT,
  buyer_country TEXT,
  state TEXT NOT NULL,
  rail TEXT,
  rail_decision_json TEXT,
  paypal_ref TEXT,
  paypal_kind TEXT,
  approve_url TEXT,
  pay_token TEXT,
  created_offline_at INTEGER,
  synced_at TEXT,
  link_expires_at INTEGER,
  paid_at TEXT,
  deferred_at TEXT,
  due_at TEXT,
  flat_charge_inr REAL DEFAULT 0,
  airline_settled_at TEXT,
  lender_confirmed INTEGER DEFAULT 0,
  repaid_at TEXT,
  UNIQUE (device_id, client_id)
);
CREATE INDEX IF NOT EXISTS idx_orders_state ON orders(state);
CREATE INDEX IF NOT EXISTS idx_orders_contact ON orders(contact_key);
CREATE INDEX IF NOT EXISTS idx_orders_ref ON orders(paypal_ref);

CREATE TABLE IF NOT EXISTS qr_tokens (
  token_hash TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  status TEXT NOT NULL,
  exp INTEGER NOT NULL,
  created_at TEXT,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  type TEXT,
  received_at TEXT
);

CREATE TABLE IF NOT EXISTS sb_accounts (
  contact_key TEXT PRIMARY KEY,
  balance_inr REAL DEFAULT 0,
  outstanding_inr REAL DEFAULT 0
);

-- Standing backup-card authorisations, given by the passenger through the auto-generated form (box tick + OTP).
CREATE TABLE IF NOT EXISTS card_consents (
  contact_key TEXT PRIMARY KEY,
  name TEXT,
  booking_ref TEXT,
  consent_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  terms_json TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor TEXT,
  type TEXT NOT NULL,
  order_id TEXT,
  payload TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);

-- SMS return-code route (mock gateway): one-time codes bound to an order, single-use payee identifiers, route memory.
CREATE TABLE IF NOT EXISTS sms_challenges (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  claimed_hash TEXT NOT NULL,
  payee_hash TEXT,
  code_hash TEXT NOT NULL,
  ref_hash TEXT NOT NULL,
  payee_code_hash TEXT,
  two_sided INTEGER DEFAULT 0,
  status TEXT NOT NULL,
  route_idx INTEGER DEFAULT 0,
  route_sent_at INTEGER,
  amount_inr REAL NOT NULL,
  exp INTEGER NOT NULL,
  tries INTEGER DEFAULT 0,
  payer_ok INTEGER DEFAULT 0,
  payee_ok INTEGER DEFAULT 0,
  created_at TEXT,
  verified_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sms_code ON sms_challenges(code_hash);
CREATE INDEX IF NOT EXISTS idx_sms_ref ON sms_challenges(ref_hash);
CREATE INDEX IF NOT EXISTS idx_sms_payee ON sms_challenges(payee_code_hash);
CREATE INDEX IF NOT EXISTS idx_sms_claimed ON sms_challenges(claimed_hash);

CREATE TABLE IF NOT EXISTS payee_ids (
  ident TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  amount_inr REAL NOT NULL,
  status TEXT NOT NULL,
  exp INTEGER NOT NULL,
  created_at TEXT,
  burned_at TEXT
);

CREATE TABLE IF NOT EXISTS route_memory (
  contact_hash TEXT PRIMARY KEY,
  route_idx INTEGER NOT NULL,
  updated_at TEXT
);
`);

// Migrations for databases created before payer instruments / backup-card consent existed.
db.exec(`
CREATE TABLE IF NOT EXISTS consents (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  contact_key TEXT NOT NULL,
  country TEXT NOT NULL,
  instrument TEXT NOT NULL,
  max_amount_inr REAL NOT NULL,
  status TEXT NOT NULL,
  valid_until INTEGER NOT NULL,
  form_hash TEXT NOT NULL,
  otp_hash TEXT,
  otp_exp INTEGER,
  otp_tries INTEGER DEFAULT 0,
  created_at TEXT,
  confirmed_at TEXT,
  revoked_at TEXT
);
`);
for (const ddl of [
  'ALTER TABLE orders ADD COLUMN instrument TEXT',
  'ALTER TABLE orders ADD COLUMN backup_card INTEGER DEFAULT 0',
  'ALTER TABLE orders ADD COLUMN consent_id TEXT',
  'ALTER TABLE orders ADD COLUMN limit_key TEXT',
  'ALTER TABLE orders ADD COLUMN sim_funds_json TEXT',
  'ALTER TABLE orders ADD COLUMN funding_json TEXT',
]) {
  try {
    db.exec(ddl);
  } catch {
    /* column already exists */
  }
}

const P = (v) => (v === undefined ? null : v);
export const get = (sql, ...a) => db.prepare(sql).get(...a.map(P));
export const all = (sql, ...a) => db.prepare(sql).all(...a.map(P));
export const run = (sql, ...a) => db.prepare(sql).run(...a.map(P));
