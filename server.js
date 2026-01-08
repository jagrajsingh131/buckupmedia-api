import express from "express";
import cors from "cors";
import pkg from "pg";
import admin from "firebase-admin";

const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// --------------------
// ENV you will set in Render
// --------------------
// DATABASE_URL = Neon connection string
// FIREBASE_SERVICE_JSON = service account json (one-line)
// FRONTEND_ORIGIN = https://yourusername.github.io  (optional)

// Postgres pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Firebase Admin init (service account JSON as env)
const serviceJson = process.env.FIREBASE_SERVICE_JSON
  ? JSON.parse(process.env.FIREBASE_SERVICE_JSON)
  : null;

if (!serviceJson) {
  console.warn("Missing FIREBASE_SERVICE_JSON env. Auth will fail.");
} else {
  admin.initializeApp({
    credential: admin.credential.cert(serviceJson)
  });
}

// --------------------
// Auth middleware (Firebase ID token)
// --------------------
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing token" });

    const decoded = await admin.auth().verifyIdToken(token);
    req.user = {
      uid: decoded.uid,
      email: decoded.email || ""
    };
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid token", details: e.message });
  }
}

// --------------------
// DB init
// --------------------
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone VARCHAR(20) NOT NULL,
      tag TEXT DEFAULT '',
      created_by_uid TEXT NOT NULL,
      created_by_email TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_accounts_created_at ON accounts(created_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_accounts_phone ON accounts(phone);
  `);
}

await initDb();

// --------------------
// Helpers
// --------------------
function normalizeName(raw) {
  return String(raw || "")
    .replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function normalizePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length >= 10) return digits.slice(-10);
  return "";
}

// --------------------
// API: Get accounts (shared, visible to all)
// --------------------
app.get("/accounts", requireAuth, async (req, res) => {
  try {
    const { tag = "", createdBy = "", date = "", q = "" } = req.query;

    const params = [];
    const where = [];

    if (tag) { params.push(tag.toLowerCase()); where.push(`LOWER(tag)= $${params.length}`); }
    if (createdBy) { params.push(`%${String(createdBy).toLowerCase()}%`); where.push(`LOWER(created_by_email) LIKE $${params.length}`); }
    if (date) {
      // date format: YYYY-MM-DD
      params.push(date);
      where.push(`TO_CHAR(created_at AT TIME ZONE 'UTC','YYYY-MM-DD') = $${params.length}`);
    }
    if (q) {
      params.push(`%${String(q).toLowerCase()}%`);
      where.push(`(LOWER(name) LIKE $${params.length} OR phone LIKE $${params.length})`);
    }

    const sql = `
      SELECT id, name, phone, tag, created_by_email, created_at
      FROM accounts
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY created_at DESC
      LIMIT 2000;
    `;
    const r = await pool.query(sql, params);
    res.json({ accounts: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --------------------
// API: Add accounts (bulk paste/file)
// body: { accounts: [{name, phone}] }
// --------------------
app.post("/accounts/bulk", requireAuth, async (req, res) => {
  try {
    const list = Array.isArray(req.body.accounts) ? req.body.accounts : [];
    if (!list.length) return res.status(400).json({ error: "No accounts provided" });

    const cleaned = [];
    for (const a of list) {
      const name = normalizeName(a.name);
      const phone = normalizePhone(a.phone);
      if (!name || !phone) continue;
      cleaned.push({ name, phone });
    }

    // remove duplicates in same request by phone
    const seen = new Set();
    const unique = cleaned.filter(x => {
      if (seen.has(x.phone)) return false;
      seen.add(x.phone);
      return true;
    });

    if (!unique.length) return res.status(400).json({ error: "No valid accounts after cleaning" });

    // Insert
    const values = [];
    const params = [];
    let i = 1;
    for (const a of unique) {
      values.push(`($${i++}, $${i++}, $${i++}, $${i++})`);
      params.push(a.name, a.phone, req.user.uid, req.user.email);
    }

    const sql = `
      INSERT INTO accounts (name, phone, created_by_uid, created_by_email)
      VALUES ${values.join(",")}
      RETURNING id;
    `;
    const r = await pool.query(sql, params);
    res.json({ saved: r.rowCount, ids: r.rows.map(x => x.id) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --------------------
// API: Add single account
// body: { name, phone }
// --------------------
app.post("/accounts", requireAuth, async (req, res) => {
  try {
    const name = normalizeName(req.body.name);
    const phone = normalizePhone(req.body.phone);
    if (!name || !phone) return res.status(400).json({ error: "Invalid name/phone" });

    const r = await pool.query(
      `INSERT INTO accounts (name, phone, created_by_uid, created_by_email)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [name, phone, req.user.uid, req.user.email]
    );
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --------------------
// API: Update tag
// body: { tag }
// --------------------
app.patch("/accounts/:id/tag", requireAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const tag = String(req.body.tag || "").toLowerCase().trim();

    await pool.query(`UPDATE accounts SET tag=$1 WHERE id=$2`, [tag, id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/", (req, res) => res.send("BuckupMedia API OK"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("API running on", PORT));
