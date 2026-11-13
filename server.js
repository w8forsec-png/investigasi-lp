const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(process.env.CMS_DB_PATH || path.join(DATA_DIR, "cases.db"));
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS teams (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    deleted_at TEXT
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    rank_number TEXT NOT NULL DEFAULT '',
    specialty TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL CHECK (role IN ('admin', 'leader', 'member')),
    team_id INTEGER REFERENCES teams(id),
    username TEXT NOT NULL UNIQUE,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    is_analyst INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT
  );
  CREATE TABLE IF NOT EXISTS cases (
    id INTEGER PRIMARY KEY,
    lp_number TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    reported_at TEXT NOT NULL,
    statute TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'Aktif',
    team_id INTEGER NOT NULL REFERENCES teams(id),
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TEXT
  );
  CREATE TABLE IF NOT EXISTS case_members (
    case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    duty TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (case_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY,
    case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    profile_type TEXT NOT NULL DEFAULT 'Terduga',
    name TEXT NOT NULL,
    alias TEXT NOT NULL DEFAULT '',
    nik TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    role_in_case TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TEXT
  );
  CREATE TABLE IF NOT EXISTS field_reports (
    id INTEGER PRIMARY KEY,
    case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    source_unit TEXT NOT NULL,
    title TEXT NOT NULL,
    reference TEXT NOT NULL DEFAULT '',
    details TEXT NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TEXT
  );
  CREATE TABLE IF NOT EXISTS technical_entries (
    id INTEGER PRIMARY KEY,
    case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    target_ref TEXT NOT NULL DEFAULT '',
    findings TEXT NOT NULL,
    field_report_id INTEGER REFERENCES field_reports(id),
    parent_entry_id INTEGER REFERENCES technical_entries(id),
    progress_status TEXT NOT NULL DEFAULT 'Analisis awal',
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TEXT
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY,
    actor_id INTEGER NOT NULL REFERENCES users(id),
    action TEXT NOT NULL,
    case_id INTEGER REFERENCES cases(id),
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const technicalColumns = new Set(db.prepare("PRAGMA table_info(technical_entries)").all().map(column => column.name));
if (!technicalColumns.has("field_report_id")) {
  db.exec("ALTER TABLE technical_entries ADD COLUMN field_report_id INTEGER REFERENCES field_reports(id)");
}
if (!technicalColumns.has("parent_entry_id")) {
  db.exec("ALTER TABLE technical_entries ADD COLUMN parent_entry_id INTEGER REFERENCES technical_entries(id)");
}
if (!technicalColumns.has("progress_status")) {
  db.exec("ALTER TABLE technical_entries ADD COLUMN progress_status TEXT NOT NULL DEFAULT 'Analisis awal'");
}
for (const table of ["teams", "users", "cases", "profiles", "field_reports", "technical_entries"]) {
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
  if (!columns.has("deleted_at")) db.exec(`ALTER TABLE ${table} ADD COLUMN deleted_at TEXT`);
}
const userColumns = new Set(db.prepare("PRAGMA table_info(users)").all().map(column => column.name));
if (!userColumns.has("is_analyst")) db.exec("ALTER TABLE users ADD COLUMN is_analyst INTEGER NOT NULL DEFAULT 0");
const profileColumns = new Set(db.prepare("PRAGMA table_info(profiles)").all().map(column => column.name));
for (const [column, definition] of [
  ["profile_type", "TEXT NOT NULL DEFAULT 'Terduga'"],
  ["nik", "TEXT NOT NULL DEFAULT ''"],
  ["address", "TEXT NOT NULL DEFAULT ''"],
  ["phone", "TEXT NOT NULL DEFAULT ''"]
]) {
  if (!profileColumns.has(column)) db.exec(`ALTER TABLE profiles ADD COLUMN ${column} ${definition}`);
}
db.prepare(`
  UPDATE teams SET description = 'Unit analis teknis'
  WHERE description IN ('Unit investigasi lapangan', 'Unit analisis teknis')
`).run();
db.prepare("UPDATE users SET specialty = 'Analis teknis' WHERE username = 'katim.bravo' AND specialty = 'Opsnal'").run();
db.prepare("UPDATE users SET specialty = 'Analis teknis' WHERE username = 'personel.bravo' AND specialty = 'Lapangan'").run();
db.prepare(`
  UPDATE case_members SET duty = 'Analisis teknis'
  WHERE duty = 'Lapangan' AND user_id = (SELECT id FROM users WHERE username = 'personel.bravo')
`).run();
db.prepare(`
  UPDATE users SET is_analyst = 1
  WHERE username IN ('personel.alfa', 'personel.bravo') AND role = 'member' AND specialty = 'Analis teknis'
`).run();

function passwordRecord(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function seedDemoData() {
  if (db.prepare("SELECT COUNT(*) AS count FROM users").get().count) return;
  const demoPassword = process.env.CMS_DEMO_PASSWORD;
  if (!demoPassword || demoPassword.length < 12) {
    throw new Error("Set CMS_DEMO_PASSWORD (minimal 12 karakter) untuk seed akun server SQLite legacy.");
  }
  const insertTeam = db.prepare("INSERT INTO teams (name, description) VALUES (?, ?)");
  insertTeam.run("Tim Alfa", "Unit analis teknis");
  insertTeam.run("Tim Bravo", "Unit analis teknis");

  const insertUser = db.prepare(`
    INSERT INTO users (name, rank_number, specialty, role, team_id, username, password_salt, password_hash, is_analyst)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const users = [
    ["Admin Utama", "—", "Pimpinan", "admin", null, "admin", 0],
    ["Katim Alfa", "IPDA / 1001", "Analis IT", "leader", 1, "katim.alfa", 0],
    ["Personel Alfa", "BRIPTU / 1002", "Analis teknis", "member", 1, "personel.alfa", 1],
    ["Katim Bravo", "IPDA / 2001", "Analis teknis", "leader", 2, "katim.bravo", 0],
    ["Personel Bravo", "BRIPTU / 2002", "Analis teknis", "member", 2, "personel.bravo", 1]
  ];
  for (const [name, rank, specialty, role, teamId, username, isAnalyst] of users) {
    const record = passwordRecord(demoPassword);
    insertUser.run(name, rank, specialty, role, teamId, username, record.salt, record.hash, isAnalyst);
  }

  const insertCase = db.prepare(`
    INSERT INTO cases (lp_number, title, reported_at, statute, location, status, team_id, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  `);
  insertCase.run("LP/DEMO/001", "Perkara demonstrasi Alfa", "2026-01-12", "Contoh pasal", "Wilayah Utara", "Aktif", 1);
  insertCase.run("LP/DEMO/002", "Perkara demonstrasi Bravo", "2026-02-03", "Contoh pasal", "Wilayah Selatan", "Proses", 2);
  db.prepare("INSERT INTO case_members (case_id, user_id, duty) VALUES (1, 2, 'Koordinator'), (1, 3, 'Analisis teknis'), (2, 4, 'Koordinator'), (2, 5, 'Analisis teknis')").run();
  db.prepare(`
    INSERT INTO technical_entries (case_id, category, title, target_ref, findings, created_by)
    VALUES (1, 'Analisis perangkat', 'Catatan analisis awal', 'Data contoh', 'Data demonstrasi; bukan hasil investigasi nyata.', 3)
  `).run();
}
seedDemoData();

const sessions = new Map();
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function json(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    ...headers
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        reject(Object.assign(new Error("Ukuran permintaan melebihi 1 MB."), { status: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(Object.assign(new Error("Format JSON tidak valid."), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function audit(userId, action, caseId = null, detail = "") {
  db.prepare("INSERT INTO audit_log (actor_id, action, case_id, detail) VALUES (?, ?, ?, ?)")
    .run(userId, action, caseId, detail.slice(0, 250));
}

function userFromRequest(req) {
  const token = (req.headers.cookie || "").split(";").map(x => x.trim())
    .find(x => x.startsWith("cms_session="))?.slice("cms_session=".length);
  const session = token && sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return db.prepare(`
    SELECT id, name, rank_number, specialty,
      CASE WHEN is_analyst = 1 THEN 'analyst' ELSE role END AS role,
      team_id, username FROM users
    WHERE id = ? AND active = 1 AND deleted_at IS NULL
  `).get(session.userId) || null;
}

function canManageTeamUsers(user) {
  return user.role === "admin" || user.role === "leader" || user.role === "analyst";
}

function canAccessCase(user, caseId, includeArchived = false) {
  if (user.role === "admin") return Boolean(db.prepare("SELECT 1 FROM cases WHERE id = ? AND (? = 1 OR deleted_at IS NULL)").get(caseId, includeArchived ? 1 : 0));
  const isTeamLead = user.role === "leader" || user.role === "analyst";
  const row = db.prepare("SELECT team_id FROM cases WHERE id = ? AND (? = 1 OR deleted_at IS NULL)").get(caseId, includeArchived && isTeamLead ? 1 : 0);
  if (!row || row.team_id !== user.team_id) return false;
  if (isTeamLead) return true;
  return Boolean(db.prepare("SELECT 1 FROM case_members WHERE case_id = ? AND user_id = ?").get(caseId, user.id));
}

function canManageCase(user, caseId) {
  if (user.role === "admin") return Boolean(db.prepare("SELECT 1 FROM cases WHERE id = ?").get(caseId));
  if (user.role !== "leader" && user.role !== "analyst") return false;
  return Boolean(db.prepare("SELECT 1 FROM cases WHERE id = ? AND team_id = ?").get(caseId, user.team_id));
}

function scopedCases(user, includeArchived = false) {
  const archiveFilter = includeArchived ? "" : " AND c.deleted_at IS NULL";
  if (user.role === "admin") return db.prepare(`SELECT c.* FROM cases c WHERE 1=1${archiveFilter} ORDER BY c.created_at DESC`).all();
  if (user.role === "leader" || user.role === "analyst") return db.prepare(`SELECT c.* FROM cases c WHERE c.team_id = ?${archiveFilter} ORDER BY c.created_at DESC`).all(user.team_id);
  return db.prepare(`
    SELECT c.* FROM cases c JOIN case_members m ON m.case_id = c.id
    WHERE c.team_id = ? AND m.user_id = ? AND c.deleted_at IS NULL ORDER BY c.created_at DESC
  `).all(user.team_id, user.id);
}

function pageResult(items, requestedPage, pageSize = 5) {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Number(requestedPage) || 1), totalPages);
  return {
    items: items.slice((page - 1) * pageSize, page * pageSize),
    pagination: { page, per_page: pageSize, total, total_pages: totalPages }
  };
}

function serveStatic(req, res, pathname) {
  const requested = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const file = path.resolve(PUBLIC_DIR, requested);
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== path.join(PUBLIC_DIR, "index.html")) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, contents) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const type = file.endsWith(".css") ? "text/css; charset=utf-8"
      : file.endsWith(".js") ? "text/javascript; charset=utf-8"
        : "text/html; charset=utf-8";
    res.writeHead(200, {
      "Content-Type": type,
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    });
    res.end(contents);
  });
}

async function handleApi(req, res, url) {
  const { pathname } = url;
  if (pathname === "/api/login" && req.method === "POST") {
    const body = await readBody(req);
    const account = db.prepare("SELECT * FROM users WHERE username = ? AND active = 1").get(String(body.username || ""));
    if (!account) return json(res, 401, { error: "Nama pengguna atau kata sandi tidak cocok." });
    const candidate = crypto.scryptSync(String(body.password || ""), account.password_salt, 64);
    const expected = Buffer.from(account.password_hash, "hex");
    if (candidate.length !== expected.length || !crypto.timingSafeEqual(candidate, expected)) {
      return json(res, 401, { error: "Nama pengguna atau kata sandi tidak cocok." });
    }
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { userId: account.id, expiresAt: Date.now() + SESSION_TTL_MS });
    audit(account.id, "login");
    return json(res, 200, { ok: true }, {
      "Set-Cookie": `cms_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`
    });
  }
  if (pathname === "/api/logout" && req.method === "POST") {
    const token = (req.headers.cookie || "").split(";").map(x => x.trim())
      .find(x => x.startsWith("cms_session="))?.slice("cms_session=".length);
    if (token) sessions.delete(token);
    return json(res, 200, { ok: true }, { "Set-Cookie": "cms_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
  }

  const user = userFromRequest(req);
  if (!user) return json(res, 401, { error: "Silakan masuk terlebih dahulu." });
  if (pathname === "/api/session" && req.method === "GET") {
    const team = user.team_id ? db.prepare("SELECT name FROM teams WHERE id = ?").get(user.team_id) : null;
    return json(res, 200, { user: { ...user, team_name: team?.name || "Semua Tim" } });
  }
  if (pathname === "/api/dashboard" && req.method === "GET") {
    const teamFilter = url.searchParams.get("team");
    const visible = scopedCases(user).filter(c => !teamFilter || user.role === "admin" && String(c.team_id) === teamFilter);
    const casesByStatus = visible.reduce((result, c) => {
      result[c.status] = (result[c.status] || 0) + 1;
      return result;
    }, {});
    const teamSummary = user.role === "admin"
      ? db.prepare(`
          SELECT t.id, t.name, COUNT(c.id) AS case_count,
            SUM(CASE WHEN c.status != 'Selesai' THEN 1 ELSE 0 END) AS active_count
          FROM teams t LEFT JOIN cases c ON c.team_id = t.id AND c.deleted_at IS NULL
          WHERE t.deleted_at IS NULL GROUP BY t.id ORDER BY t.id
        `).all()
      : [];
    return json(res, 200, {
      totals: { cases: visible.length, active: visible.filter(c => c.status !== "Selesai").length, profiles: visible.reduce((sum, c) => sum + db.prepare("SELECT COUNT(*) AS n FROM profiles WHERE case_id = ? AND deleted_at IS NULL").get(c.id).n, 0), technical_entries: visible.reduce((sum, c) => sum + db.prepare("SELECT COUNT(*) AS n FROM technical_entries WHERE case_id = ? AND deleted_at IS NULL").get(c.id).n, 0) },
      casesByStatus,
      teams: teamSummary,
      cases: visible.slice(0, 8).map(c => ({ ...c, team_name: db.prepare("SELECT name FROM teams WHERE id = ?").get(c.team_id).name }))
    });
  }
  if (pathname === "/api/teams" && req.method === "GET") {
    if (!canManageTeamUsers(user)) return json(res, 403, { error: "Akses hanya untuk pimpinan, Katim, atau Tim Analis." });
    const includeArchived = url.searchParams.get("include_archived") === "1";
    if (includeArchived && user.role !== "admin") return json(res, 403, { error: "Hanya pimpinan yang dapat melihat arsip tim." });
    const teams = db.prepare(`
      SELECT t.id, t.name, t.description, t.deleted_at,
        (SELECT u.name FROM users u WHERE u.team_id = t.id AND u.role = 'leader' AND u.deleted_at IS NULL LIMIT 1) AS leader,
        (SELECT COUNT(*) FROM users u WHERE u.team_id = t.id AND u.active = 1 AND u.deleted_at IS NULL) AS members,
        (SELECT COUNT(*) FROM cases c WHERE c.team_id = t.id AND c.deleted_at IS NULL) AS case_count,
        (SELECT COUNT(*) FROM cases c WHERE c.team_id = t.id AND c.status != 'Selesai' AND c.deleted_at IS NULL) AS active_cases
      FROM teams t WHERE (? IS NULL OR t.id = ?) AND (? = 1 OR t.deleted_at IS NULL) ORDER BY t.id
    `).all(user.role === "admin" ? null : user.team_id, user.role === "admin" ? null : user.team_id, includeArchived ? 1 : 0);
    return json(res, 200, { teams });
  }
  const teamMatch = pathname.match(/^\/api\/teams\/(\d+)(?:\/restore)?$/);
  if (teamMatch) {
    if (user.role !== "admin") return json(res, 403, { error: "Akses hanya untuk pimpinan." });
    const teamId = Number(teamMatch[1]);
    const restoring = pathname.endsWith("/restore");
    const team = db.prepare("SELECT * FROM teams WHERE id = ?").get(teamId);
    if (!team) return json(res, 404, { error: "Tim tidak ditemukan." });
    if (req.method === "PATCH" && restoring) {
      db.prepare("UPDATE teams SET deleted_at = NULL WHERE id = ?").run(teamId);
      audit(user.id, "team.restored", null, `team:${teamId}`);
      return json(res, 200, { ok: true });
    }
    if (req.method === "PATCH" && !restoring) {
      const body = await readBody(req);
      const name = String(body.name || "").trim();
      const description = String(body.description || "").trim();
      if (!name) return json(res, 400, { error: "Nama tim wajib diisi." });
      try {
        db.prepare("UPDATE teams SET name = ?, description = ? WHERE id = ?").run(name.slice(0, 80), description.slice(0, 160), teamId);
        audit(user.id, "team.updated", null, `team:${teamId}`);
        return json(res, 200, { ok: true });
      } catch (error) {
        if (error.code === "SQLITE_CONSTRAINT_UNIQUE") return json(res, 409, { error: "Nama tim sudah digunakan." });
        throw error;
      }
    }
    if (req.method === "DELETE") {
      const activeCases = db.prepare("SELECT COUNT(*) AS n FROM cases WHERE team_id = ? AND deleted_at IS NULL").get(teamId).n;
      if (activeCases) return json(res, 409, { error: "Arsipkan seluruh perkara tim terlebih dahulu." });
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("UPDATE users SET active = 0, deleted_at = CURRENT_TIMESTAMP WHERE team_id = ? AND deleted_at IS NULL").run(teamId);
        db.prepare("UPDATE teams SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?").run(teamId);
        audit(user.id, "team.archived", null, `team:${teamId}`);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return json(res, 200, { ok: true });
    }
  }
  const teamUsersMatch = pathname.match(/^\/api\/teams\/(\d+)\/users$/);
  if (teamUsersMatch && req.method === "GET") {
    if (!canManageTeamUsers(user)) return json(res, 403, { error: "Akses hanya untuk pimpinan, Katim, atau Tim Analis." });
    const teamId = Number(teamUsersMatch[1]);
    const includeArchived = url.searchParams.get("include_archived") === "1";
    if (user.role !== "admin" && teamId !== user.team_id) return json(res, 404, { error: "Tim tidak ditemukan." });
    if (includeArchived && user.role !== "admin") return json(res, 403, { error: "Hanya pimpinan yang dapat melihat personel yang diarsipkan." });
    const users = db.prepare(`
      SELECT id, name, username, rank_number, specialty,
        CASE WHEN is_analyst = 1 THEN 'analyst' ELSE role END AS role,
        active, deleted_at
      FROM users WHERE team_id = ? AND role != 'admin' AND (? = 1 OR deleted_at IS NULL)
      ORDER BY CASE WHEN role = 'leader' THEN 0 WHEN is_analyst = 1 THEN 1 ELSE 2 END, name
    `).all(teamId, includeArchived ? 1 : 0);
    const result = pageResult(users, url.searchParams.get("page"));
    return json(res, 200, { users: result.items, pagination: result.pagination });
  }
  if (pathname === "/api/users" && req.method === "POST") {
    if (!canManageTeamUsers(user)) return json(res, 403, { error: "Hanya pimpinan, Katim, atau Tim Analis yang dapat membuat akun." });
    const body = await readBody(req);
    const name = String(body.name || "").trim();
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const role = String(body.role || "");
    const teamId = Number(body.team_id);
    const allowedRoles = user.role === "admin" ? ["leader", "analyst", "member"] : ["analyst", "member"];
    if (!name || !/^[a-zA-Z0-9._-]{3,50}$/.test(username) || password.length < 12 || !allowedRoles.includes(role)) {
      return json(res, 400, { error: "Nama, nama pengguna (3–50 karakter), kata sandi minimal 12 karakter, dan peran yang valid wajib diisi." });
    }
    if (user.role !== "admin" && teamId !== user.team_id) return json(res, 403, { error: "Katim dan Tim Analis hanya dapat menambah akun di timnya sendiri." });
    if (!db.prepare("SELECT 1 FROM teams WHERE id = ? AND deleted_at IS NULL").get(teamId)) {
      return json(res, 400, { error: "Tim aktif tidak ditemukan." });
    }
    const passwordInfo = passwordRecord(password);
    try {
      const result = db.prepare(`
        INSERT INTO users (name, rank_number, specialty, role, team_id, username, password_salt, password_hash, is_analyst)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        name.slice(0, 100),
        String(body.rank_number || "").slice(0, 80),
        String(body.specialty || "").slice(0, 100),
        role === "analyst" ? "member" : role,
        teamId,
        username,
        passwordInfo.salt,
        passwordInfo.hash,
        role === "analyst" ? 1 : 0
      );
      audit(user.id, "user.created", null, `user:${result.lastInsertRowid}`);
      return json(res, 201, { id: Number(result.lastInsertRowid) });
    } catch (error) {
      if (error.code === "SQLITE_CONSTRAINT_UNIQUE") return json(res, 409, { error: "Nama pengguna sudah digunakan." });
      throw error;
    }
  }
  const userMatch = pathname.match(/^\/api\/users\/(\d+)(?:\/restore)?$/);
  if (userMatch) {
    if (!canManageTeamUsers(user)) return json(res, 403, { error: "Hanya pimpinan, Katim, atau Tim Analis yang dapat mengelola akun." });
    const userId = Number(userMatch[1]);
    const restoring = pathname.endsWith("/restore");
    const target = db.prepare(`
      SELECT u.*, CASE WHEN u.is_analyst = 1 THEN 'analyst' ELSE u.role END AS effective_role
      FROM users u WHERE u.id = ? AND u.role != 'admin'
    `).get(userId);
    if (!target) return json(res, 404, { error: "Personel tidak ditemukan." });
    target.role = target.effective_role;
    if (user.role !== "admin" && (target.team_id !== user.team_id || target.role === "leader")) {
      return json(res, 403, { error: "Katim dan Tim Analis hanya dapat mengelola anggota atau analis di timnya." });
    }
    if (req.method === "PATCH" && restoring) {
      const team = db.prepare("SELECT deleted_at FROM teams WHERE id = ?").get(target.team_id);
      if (team?.deleted_at) return json(res, 409, { error: "Pulihkan tim terlebih dahulu." });
      db.prepare("UPDATE users SET deleted_at = NULL, active = 1 WHERE id = ?").run(userId);
      audit(user.id, "user.restored", null, `user:${userId}`);
      return json(res, 200, { ok: true });
    }
    if (req.method === "PATCH" && !restoring) {
      const body = await readBody(req);
      const name = String(body.name || "").trim();
      const role = String(body.role || target.role);
      const allowedRoles = user.role === "admin" ? ["leader", "analyst", "member"] : ["analyst", "member"];
      if (!name || !allowedRoles.includes(role)) return json(res, 400, { error: "Nama dan peran personel yang valid wajib diisi." });
      db.prepare("UPDATE users SET name = ?, rank_number = ?, specialty = ?, role = ?, is_analyst = ? WHERE id = ?")
        .run(
          name.slice(0, 100),
          String(body.rank_number || "").slice(0, 80),
          String(body.specialty || "").slice(0, 100),
          role === "analyst" ? "member" : role,
          role === "analyst" ? 1 : 0,
          userId
        );
      audit(user.id, "user.updated", null, `user:${userId}`);
      return json(res, 200, { ok: true });
    }
    if (req.method === "DELETE") {
      if (target.id === user.id) return json(res, 409, { error: "Anda tidak dapat mengarsipkan akun yang sedang digunakan." });
      db.prepare("UPDATE users SET active = 0, deleted_at = CURRENT_TIMESTAMP WHERE id = ?").run(userId);
      audit(user.id, "user.archived", null, `user:${userId}`);
      return json(res, 200, { ok: true });
    }
  }
  if (pathname === "/api/cases" && req.method === "GET") {
    const includeArchived = url.searchParams.get("include_archived") === "1";
    if (includeArchived && user.role === "member") return json(res, 403, { error: "Hanya pimpinan, Katim, atau Tim Analis yang dapat melihat arsip." });
    const query = String(url.searchParams.get("q") || "").trim().toLowerCase();
    const matching = scopedCases(user, includeArchived).filter(c => {
      const teamName = db.prepare("SELECT name FROM teams WHERE id = ?").get(c.team_id)?.name || "";
      return !query || `${c.lp_number} ${c.title} ${teamName}`.toLowerCase().includes(query);
    });
    const result = pageResult(matching, url.searchParams.get("page"));
    const cases = result.items.map(c => ({
      ...c,
      team_name: db.prepare("SELECT name FROM teams WHERE id = ?").get(c.team_id).name,
      profile_count: db.prepare("SELECT COUNT(*) AS n FROM profiles WHERE case_id = ? AND deleted_at IS NULL").get(c.id).n,
      technical_count: db.prepare("SELECT COUNT(*) AS n FROM technical_entries WHERE case_id = ? AND deleted_at IS NULL").get(c.id).n
    }));
    return json(res, 200, { cases, pagination: result.pagination });
  }
  if (pathname === "/api/cases" && req.method === "POST") {
    if (!["admin", "leader", "analyst"].includes(user.role)) return json(res, 403, { error: "Hanya pimpinan, Katim, atau Tim Analis yang dapat membuat perkara." });
    const body = await readBody(req);
    const lpNumber = String(body.lp_number || "").trim();
    const title = String(body.title || "").trim();
    const teamId = user.role === "admin" ? Number(body.team_id) : user.team_id;
    const victim = {
      name: String(body.victim_name || "").trim(),
      nik: String(body.victim_nik || "").trim(),
      address: String(body.victim_address || "").trim(),
      phone: String(body.victim_phone || "").trim()
    };
    const hasVictimDetails = Object.values(victim).some(Boolean);
    const reportedAt = String(body.reported_at || "");
    if (!lpNumber || !title || !/^\d{4}-\d{2}-\d{2}$/.test(reportedAt) || !db.prepare("SELECT 1 FROM teams WHERE id = ? AND deleted_at IS NULL").get(teamId)) {
      return json(res, 400, { error: "Nomor LP, judul, tanggal LP, dan tim yang valid wajib diisi." });
    }
    if (user.role !== "admin" && Number(body.team_id) !== user.team_id) {
      return json(res, 403, { error: "Katim dan Tim Analis hanya dapat membuat perkara untuk timnya sendiri." });
    }
    if (hasVictimDetails && !victim.name) return json(res, 400, { error: "Nama wajib diisi jika data korban dicantumkan." });
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = db.prepare(`
        INSERT INTO cases (lp_number, title, reported_at, statute, location, status, team_id, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(lpNumber.slice(0, 80), title.slice(0, 120), reportedAt, String(body.statute || "").slice(0, 150), String(body.location || "").slice(0, 300), "Aktif", teamId, user.id);
      const caseId = Number(result.lastInsertRowid);
      if (hasVictimDetails) {
        db.prepare(`
          INSERT INTO profiles (case_id, profile_type, name, nik, address, phone, created_by)
          VALUES (?, 'Korban', ?, ?, ?, ?, ?)
        `).run(caseId, victim.name.slice(0, 100), victim.nik.slice(0, 32), victim.address.slice(0, 300), victim.phone.slice(0, 32), user.id);
      }
      audit(user.id, "case.created", caseId, lpNumber);
      db.exec("COMMIT");
      return json(res, 201, { id: caseId });
    } catch (error) {
      db.exec("ROLLBACK");
      if (error.code === "SQLITE_CONSTRAINT_UNIQUE") return json(res, 409, { error: "Nomor LP sudah terdaftar." });
      throw error;
    }
  }

  const caseMatch = pathname.match(/^\/api\/cases\/(\d+)(?:\/(?:(profiles|field-reports|technical|assignments)(?:\/(\d+)(?:\/(restore))?)?|(restore)))?$/);
  if (caseMatch) {
    const caseId = Number(caseMatch[1]);
    const subresource = caseMatch[2];
    const itemId = caseMatch[3] ? Number(caseMatch[3]) : null;
    const restoringItem = caseMatch[4] === "restore";
    const restoringCase = caseMatch[5] === "restore";
    const includeArchived = url.searchParams.get("include_archived") === "1";
    if (!canAccessCase(user, caseId, includeArchived || restoringCase || restoringItem)) return json(res, 404, { error: "Perkara tidak ditemukan." });
    if (restoringCase && req.method === "PATCH") {
      if (!canManageCase(user, caseId)) return json(res, 403, { error: "Hanya pimpinan atau kepala tim yang dapat memulihkan perkara." });
      const team = db.prepare("SELECT t.deleted_at FROM cases c JOIN teams t ON t.id = c.team_id WHERE c.id = ?").get(caseId);
      if (team?.deleted_at) return json(res, 409, { error: "Pulihkan tim perkara terlebih dahulu." });
      db.prepare("UPDATE cases SET deleted_at = NULL WHERE id = ?").run(caseId);
      audit(user.id, "case.restored", caseId);
      return json(res, 200, { ok: true });
    }
    if (!subresource && itemId === null && req.method === "PATCH") {
      if (!canManageCase(user, caseId)) return json(res, 403, { error: "Hanya pimpinan atau kepala tim yang dapat mengubah data perkara." });
      const body = await readBody(req);
      const lpNumber = String(body.lp_number || "").trim();
      const title = String(body.title || "").trim();
      const status = String(body.status || "");
      const reportedAt = String(body.reported_at || "");
      if (!lpNumber || !title || !/^\d{4}-\d{2}-\d{2}$/.test(reportedAt) || !["Aktif", "Proses", "Selesai"].includes(status)) {
        return json(res, 400, { error: "Nomor LP, judul, dan status perkara yang valid wajib diisi." });
      }
      try {
        db.prepare(`
          UPDATE cases SET lp_number = ?, title = ?, reported_at = ?, statute = ?, location = ?, status = ?
          WHERE id = ?
        `).run(lpNumber.slice(0, 80), title.slice(0, 120), reportedAt, String(body.statute || "").slice(0, 150), String(body.location || "").slice(0, 300), status, caseId);
        audit(user.id, "case.updated", caseId, lpNumber);
        return json(res, 200, { ok: true });
      } catch (error) {
        if (error.code === "SQLITE_CONSTRAINT_UNIQUE") return json(res, 409, { error: "Nomor LP sudah terdaftar." });
        throw error;
      }
    }
    if (!subresource && itemId === null && req.method === "DELETE") {
      if (!canManageCase(user, caseId)) return json(res, 403, { error: "Hanya pimpinan atau kepala tim yang dapat mengarsipkan perkara." });
      db.prepare("UPDATE cases SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?").run(caseId);
      audit(user.id, "case.archived", caseId);
      return json(res, 200, { ok: true });
    }
    const entityTables = {
      profiles: { table: "profiles", label: "profil", fields: ["profile_type", "name", "alias", "nik", "address", "phone", "role_in_case", "notes"], limits: [20, 100, 100, 32, 300, 32, 80, 1000], required: ["profile_type", "name"] },
      "field-reports": { table: "field_reports", label: "informasi lapangan", fields: ["source_unit", "title", "reference", "details"], limits: [100, 120, 150, 3000], required: ["source_unit", "title", "details"] },
      technical: { table: "technical_entries", label: "analisis", fields: ["category", "title", "target_ref", "progress_status", "findings"], limits: [80, 120, 120, 30, 3000], required: ["category", "title", "findings"] }
    };
    if (itemId && entityTables[subresource]) {
      const entity = entityTables[subresource];
      const record = db.prepare(`SELECT id, deleted_at FROM ${entity.table} WHERE id = ? AND case_id = ?`).get(itemId, caseId);
      if (!record) return json(res, 404, { error: `Catatan ${entity.label} tidak ditemukan.` });
      if (req.method === "PATCH" && restoringItem) {
        db.prepare(`UPDATE ${entity.table} SET deleted_at = NULL WHERE id = ? AND case_id = ?`).run(itemId, caseId);
        audit(user.id, `${entity.table}.restored`, caseId, `record:${itemId}`);
        return json(res, 200, { ok: true });
      }
      if (req.method === "PATCH" && !restoringItem) {
        const body = await readBody(req);
        const current = db.prepare(`SELECT ${entity.fields.join(", ")} FROM ${entity.table} WHERE id = ? AND case_id = ?`).get(itemId, caseId);
        const values = entity.fields.map(field => String(body[field] ?? current[field] ?? "").trim());
        const updated = Object.fromEntries(entity.fields.map((field, index) => [field, values[index]]));
        if (entity.required.some(field => !updated[field])) {
          return json(res, 400, { error: `Lengkapi semua kolom wajib untuk ${entity.label}.` });
        }
        if (subresource === "profiles" && !["Korban", "Terduga"].includes(updated.profile_type)) {
          return json(res, 400, { error: "Jenis profil harus Korban atau Terduga." });
        }
        if (subresource === "technical" && !["Analisis awal", "Tindak lanjut", "Selesai"].includes(updated.progress_status)) {
          return json(res, 400, { error: "Status perkembangan analisis tidak valid." });
        }
        const setClause = entity.fields.map(field => `${field} = ?`).join(", ");
        db.prepare(`UPDATE ${entity.table} SET ${setClause} WHERE id = ? AND case_id = ?`)
          .run(...values.map((value, index) => value.slice(0, entity.limits[index])), itemId, caseId);
        audit(user.id, `${entity.table}.updated`, caseId, `record:${itemId}`);
        return json(res, 200, { ok: true });
      }
      if (req.method === "DELETE") {
        db.prepare(`UPDATE ${entity.table} SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND case_id = ?`).run(itemId, caseId);
        audit(user.id, `${entity.table}.archived`, caseId, `record:${itemId}`);
        return json(res, 200, { ok: true });
      }
    }
    if (!subresource && req.method === "GET") {
      const caseRecord = db.prepare(`
        SELECT c.*, t.name AS team_name FROM cases c JOIN teams t ON t.id = c.team_id
        WHERE c.id = ? AND (? = 1 OR c.deleted_at IS NULL)
      `).get(caseId, includeArchived && user.role !== "member" ? 1 : 0);
      if (!caseRecord) return json(res, 404, { error: "Perkara tidak ditemukan." });
      const archiveCondition = includeArchived ? "" : " AND deleted_at IS NULL";
      const profiles = db.prepare(`SELECT id, profile_type, name, alias, nik, address, phone, role_in_case, notes, created_at, deleted_at FROM profiles WHERE case_id = ?${archiveCondition} ORDER BY id DESC`).all(caseId);
      const fieldReports = db.prepare(`
        SELECT r.id, r.source_unit, r.title, r.reference, r.details, r.created_at, r.deleted_at, u.name AS author
        FROM field_reports r JOIN users u ON u.id = r.created_by WHERE r.case_id = ?${archiveCondition.replaceAll("deleted_at", "r.deleted_at")} ORDER BY r.id DESC
      `).all(caseId);
      const technicalEntries = db.prepare(`
        SELECT a.id, a.category, a.title, a.target_ref, a.findings, a.field_report_id,
          a.parent_entry_id, a.progress_status, a.created_at, a.deleted_at, u.name AS author,
          r.title AS source_report_title, parent.title AS previous_title
        FROM technical_entries a
        JOIN users u ON u.id = a.created_by
        LEFT JOIN field_reports r ON r.id = a.field_report_id
        LEFT JOIN technical_entries parent ON parent.id = a.parent_entry_id
        WHERE a.case_id = ?${includeArchived ? "" : " AND a.deleted_at IS NULL"} ORDER BY a.id DESC
      `).all(caseId);
      const members = db.prepare(`
        SELECT u.id, u.name, u.rank_number, u.specialty, m.duty FROM case_members m JOIN users u ON u.id = m.user_id WHERE m.case_id = ?
      `).all(caseId);
      return json(res, 200, { case: caseRecord, profiles, field_reports: fieldReports, technical_entries: technicalEntries, members });
    }
    if (subresource === "profiles" && req.method === "POST") {
      const body = await readBody(req);
      const profileType = String(body.profile_type || "Terduga").trim();
      const name = String(body.name || "").trim();
      if (!name || !["Korban", "Terduga"].includes(profileType)) return json(res, 400, { error: "Jenis profil dan nama yang valid wajib diisi." });
      const result = db.prepare(`
        INSERT INTO profiles (case_id, profile_type, name, alias, nik, address, phone, role_in_case, notes, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        caseId,
        profileType,
        name.slice(0, 100),
        String(body.alias || "").slice(0, 100),
        String(body.nik || "").slice(0, 32),
        String(body.address || "").slice(0, 300),
        String(body.phone || "").slice(0, 32),
        String(body.role_in_case || "").slice(0, 80),
        String(body.notes || "").slice(0, 1000),
        user.id
      );
      audit(user.id, "profile.created", caseId, `profile:${result.lastInsertRowid}`);
      return json(res, 201, { id: Number(result.lastInsertRowid) });
    }
    if (subresource === "field-reports" && req.method === "POST") {
      const body = await readBody(req);
      const title = String(body.title || "").trim();
      const details = String(body.details || "").trim();
      if (!title || !details) return json(res, 400, { error: "Judul dan rincian informasi lapangan wajib diisi." });
      const result = db.prepare(`
        INSERT INTO field_reports (case_id, source_unit, title, reference, details, created_by)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(caseId, String(body.source_unit || "Tim Lapangan").trim().slice(0, 100), title.slice(0, 120), String(body.reference || "").trim().slice(0, 150), details.slice(0, 3000), user.id);
      audit(user.id, "field_report.recorded", caseId, `report:${result.lastInsertRowid}`);
      return json(res, 201, { id: Number(result.lastInsertRowid) });
    }
    if (subresource === "technical" && req.method === "POST") {
      const body = await readBody(req);
      const category = String(body.category || "").trim();
      const title = String(body.title || "").trim();
      const findings = String(body.findings || "").trim();
      if (!category || !title || !findings) return json(res, 400, { error: "Kategori, judul, dan hasil analisis wajib diisi." });
      const parentEntryId = body.parent_entry_id ? Number(body.parent_entry_id) : null;
      const requestedReportId = body.field_report_id ? Number(body.field_report_id) : null;
      const parent = parentEntryId
        ? db.prepare("SELECT id, field_report_id FROM technical_entries WHERE id = ? AND case_id = ?").get(parentEntryId, caseId)
        : null;
      if (parentEntryId && !parent) return json(res, 400, { error: "Analisis sebelumnya tidak ditemukan dalam perkara ini." });
      const fieldReportId = requestedReportId || parent?.field_report_id || null;
      if (requestedReportId && !db.prepare("SELECT 1 FROM field_reports WHERE id = ? AND case_id = ?").get(requestedReportId, caseId)) {
        return json(res, 400, { error: "Informasi lapangan tidak ditemukan dalam perkara ini." });
      }
      if (parent && requestedReportId && parent.field_report_id !== requestedReportId) {
        return json(res, 400, { error: "Tindak lanjut harus tetap terhubung dengan sumber analisis yang sama." });
      }
      const progressStatus = String(body.progress_status || (parent ? "Tindak lanjut" : "Analisis awal"));
      if (!["Analisis awal", "Tindak lanjut", "Selesai"].includes(progressStatus)) {
        return json(res, 400, { error: "Status perkembangan analisis tidak valid." });
      }
      const result = db.prepare(`
        INSERT INTO technical_entries
          (case_id, category, title, target_ref, findings, field_report_id, parent_entry_id, progress_status, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(caseId, category.slice(0, 80), title.slice(0, 120), String(body.target_ref || "").slice(0, 120), findings.slice(0, 3000), fieldReportId, parentEntryId, progressStatus, user.id);
      audit(user.id, "technical_entry.created", caseId, `entry:${result.lastInsertRowid}`);
      return json(res, 201, { id: Number(result.lastInsertRowid) });
    }
    if (subresource === "assignments" && req.method === "POST") {
      if (user.role !== "admin" && user.role !== "leader" && user.role !== "analyst") return json(res, 403, { error: "Hanya pimpinan, Katim, atau Tim Analis yang dapat mengatur penugasan." });
      const body = await readBody(req);
      const memberId = Number(body.user_id);
      const member = db.prepare("SELECT id FROM users WHERE id = ? AND team_id = ? AND active = 1 AND deleted_at IS NULL").get(memberId, user.role === "admin" ? db.prepare("SELECT team_id FROM cases WHERE id = ?").get(caseId).team_id : user.team_id);
      if (!member) return json(res, 400, { error: "Personel harus aktif dan berasal dari tim perkara ini." });
      db.prepare("INSERT OR REPLACE INTO case_members (case_id, user_id, duty) VALUES (?, ?, ?)").run(caseId, memberId, String(body.duty || "").slice(0, 100));
      audit(user.id, "assignment.updated", caseId, `user:${memberId}`);
      return json(res, 200, { ok: true });
    }
  }
  return json(res, 404, { error: "Rute tidak ditemukan." });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    try {
      await handleApi(req, res, url);
    } catch (error) {
      if (res.headersSent) return;
      const status = error.status || 500;
      if (status === 500) console.error(error);
      json(res, status, { error: status === 500 ? "Terjadi kesalahan pada server." : error.message });
    }
    return;
  }
  if (req.method !== "GET") {
    res.writeHead(405, { Allow: "GET" });
    return res.end();
  }
  serveStatic(req, res, url.pathname);
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Dashboard tersedia di http://${HOST}:${PORT}`);
  });
}

module.exports = { server, db, canAccessCase };
