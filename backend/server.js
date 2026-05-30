import http from "node:http";
import crypto from "node:crypto";
import mysql from "mysql2/promise";

const config = {
  port: envInt("PORT", 4000),
  tokenSecret: process.env.AUTH_TOKEN_SECRET ?? process.env.AUTH_JWT_SECRET ?? "change-this-secret",
  tokenTtlSeconds: envInt("AUTH_TOKEN_TTL_SECONDS", 60 * 60 * 12),
  adminEmail: normalizeEmail(process.env.AUTH_ADMIN_EMAIL ?? "logeng@gmail.com"),
  mysql: {
    host: process.env.MYSQL_HOST ?? "mysql",
    port: envInt("MYSQL_PORT", 3306),
    database: process.env.MYSQL_DATABASE ?? "dse855",
    user: process.env.MYSQL_USER ?? "dse",
    password: process.env.MYSQL_PASSWORD ?? "dse_password"
  }
};

const pool = mysql.createPool({
  ...config.mysql,
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: true
});

function envInt(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return Number.parseInt(value, 10);
}

async function ensureSchema() {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS app_users (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(120) NOT NULL,
      email VARCHAR(190) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_app_users_email (email)
    )
  `);
}

function normalizeEmail(email) {
  return String(email ?? "").trim().toLowerCase();
}

function sanitizeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    isAdmin: normalizeEmail(user.email) === config.adminEmail
  };
}

function validateCredentials({ name, email, password }, isRegister, passwordRequired = true) {
  const cleanEmail = normalizeEmail(email);
  const cleanName = String(name ?? "").trim();
  const cleanPassword = String(password ?? "");

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return { error: "Informe um e-mail valido." };
  }

  if (isRegister && cleanName.length < 2) {
    return { error: "Informe um nome com pelo menos 2 caracteres." };
  }

  if (passwordRequired && cleanPassword.length < 8) {
    return { error: "A senha precisa ter pelo menos 8 caracteres." };
  }

  if (!passwordRequired && cleanPassword.length > 0 && cleanPassword.length < 8) {
    return { error: "A nova senha precisa ter pelo menos 8 caracteres." };
  }

  return {
    value: {
      name: cleanName,
      email: cleanEmail,
      password: cleanPassword
    }
  };
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const derived = await scrypt(password, salt);
  return `scrypt$${salt}$${derived}`;
}

async function verifyPassword(password, storedHash) {
  const [algorithm, salt, hash] = String(storedHash ?? "").split("$");
  if (algorithm !== "scrypt" || !salt || !hash) return false;

  const derived = await scrypt(password, salt);
  const known = Buffer.from(hash, "base64url");
  const candidate = Buffer.from(derived, "base64url");
  return known.length === candidate.length && crypto.timingSafeEqual(known, candidate);
}

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, key) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(key.toString("base64url"));
    });
  });
}

function signToken(user) {
  const header = base64urlJson({ alg: "HS256", typ: "JWT" });
  const now = Math.floor(Date.now() / 1000);
  const payload = base64urlJson({
    sub: String(user.id),
    name: user.name,
    email: user.email,
    iat: now,
    exp: now + config.tokenTtlSeconds
  });
  const signature = hmac(`${header}.${payload}`);
  return `${header}.${payload}.${signature}`;
}

function verifyToken(token) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) return null;

  const [header, payload, signature] = parts;
  const expected = hmac(`${header}.${payload}`);
  const known = Buffer.from(expected);
  const candidate = Buffer.from(signature);
  if (known.length !== candidate.length || !crypto.timingSafeEqual(known, candidate)) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!decoded.exp || decoded.exp < Math.floor(Date.now() / 1000)) return null;
    return decoded;
  } catch {
    return null;
  }
}

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function hmac(value) {
  return crypto.createHmac("sha256", config.tokenSecret).update(value).digest("base64url");
}

async function readJson(request) {
  const body = await new Promise((resolve, reject) => {
    let data = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) request.destroy();
    });
    request.on("end", () => resolve(data));
    request.on("error", reject);
  });

  if (!body) return {};
  return JSON.parse(body);
}

function getBearerToken(request) {
  const header = request.headers.authorization ?? "";
  const [type, token] = header.split(" ");
  return type?.toLowerCase() === "bearer" ? token : "";
}

async function authenticateRequest(request, response, requireAdmin = false) {
  const token = verifyToken(getBearerToken(request));
  if (!token) {
    writeJson(response, 401, { ok: false, error: "Sessao expirada. Entre novamente." });
    return null;
  }

  const [rows] = await pool.execute("SELECT id, name, email FROM app_users WHERE id = :id LIMIT 1", {
    id: token.sub
  });
  const user = rows[0];

  if (!user) {
    writeJson(response, 401, { ok: false, error: "Usuario nao encontrado." });
    return null;
  }

  const safeUser = sanitizeUser(user);
  if (requireAdmin && !safeUser.isAdmin) {
    writeJson(response, 403, { ok: false, error: "Apenas o usuario principal pode gerenciar usuarios." });
    return null;
  }

  return safeUser;
}

async function handleCreateUser(request, response) {
  const currentUser = await authenticateRequest(request, response, true);
  if (!currentUser) return;

  const payload = await readJson(request);
  const validation = validateCredentials(payload, true);
  if (validation.error) {
    writeJson(response, 400, { ok: false, error: validation.error });
    return;
  }

  const { name, email, password } = validation.value;
  const passwordHash = await hashPassword(password);

  try {
    const [result] = await pool.execute(
      "INSERT INTO app_users (name, email, password_hash) VALUES (:name, :email, :passwordHash)",
      { name, email, passwordHash }
    );
    const user = { id: result.insertId, name, email };
    writeJson(response, 201, { ok: true, user: sanitizeUser(user) });
  } catch (error) {
    if (error?.code === "ER_DUP_ENTRY") {
      writeJson(response, 409, { ok: false, error: "Este e-mail ja esta cadastrado." });
      return;
    }
    throw error;
  }
}

async function handleLogin(request, response) {
  const payload = await readJson(request);
  const validation = validateCredentials(payload, false);
  if (validation.error) {
    writeJson(response, 400, { ok: false, error: validation.error });
    return;
  }

  const { email, password } = validation.value;
  const [rows] = await pool.execute(
    "SELECT id, name, email, password_hash FROM app_users WHERE email = :email LIMIT 1",
    { email }
  );
  const user = rows[0];

  if (!user || !(await verifyPassword(password, user.password_hash))) {
    writeJson(response, 401, { ok: false, error: "E-mail ou senha invalidos." });
    return;
  }

  writeJson(response, 200, { ok: true, user: sanitizeUser(user), token: signToken(user) });
}

async function handleMe(request, response) {
  const user = await authenticateRequest(request, response);
  if (!user) return;

  writeJson(response, 200, { ok: true, user });
}

async function handleListUsers(request, response) {
  const currentUser = await authenticateRequest(request, response, true);
  if (!currentUser) return;

  const [rows] = await pool.execute(
    "SELECT id, name, email, created_at, updated_at FROM app_users ORDER BY name ASC, id ASC"
  );

  writeJson(response, 200, {
    ok: true,
    users: rows.map((user) => ({
      ...sanitizeUser(user),
      createdAt: user.created_at,
      updatedAt: user.updated_at
    }))
  });
}

async function handleUpdateUser(request, response, id) {
  const currentUser = await authenticateRequest(request, response, true);
  if (!currentUser) return;

  const payload = await readJson(request);
  const validation = validateCredentials(payload, true, false);
  if (validation.error) {
    writeJson(response, 400, { ok: false, error: validation.error });
    return;
  }

  const { name, email, password } = validation.value;
  const updates = { id, name, email };
  let sql = "UPDATE app_users SET name = :name, email = :email";

  if (password) {
    updates.passwordHash = await hashPassword(password);
    sql += ", password_hash = :passwordHash";
  }

  sql += " WHERE id = :id";

  try {
    const [result] = await pool.execute(sql, updates);
    if (result.affectedRows === 0) {
      writeJson(response, 404, { ok: false, error: "Usuario nao encontrado." });
      return;
    }

    const [rows] = await pool.execute("SELECT id, name, email FROM app_users WHERE id = :id LIMIT 1", { id });
    writeJson(response, 200, { ok: true, user: sanitizeUser(rows[0]) });
  } catch (error) {
    if (error?.code === "ER_DUP_ENTRY") {
      writeJson(response, 409, { ok: false, error: "Este e-mail ja esta cadastrado." });
      return;
    }
    throw error;
  }
}

async function handleDeleteUser(request, response, id) {
  const currentUser = await authenticateRequest(request, response, true);
  if (!currentUser) return;

  const [rows] = await pool.execute("SELECT id, email FROM app_users WHERE id = :id LIMIT 1", { id });
  const user = rows[0];

  if (!user) {
    writeJson(response, 404, { ok: false, error: "Usuario nao encontrado." });
    return;
  }

  if (normalizeEmail(user.email) === config.adminEmail) {
    writeJson(response, 400, { ok: false, error: "O usuario principal nao pode ser removido." });
    return;
  }

  await pool.execute("DELETE FROM app_users WHERE id = :id", { id });
  writeJson(response, 200, { ok: true, user: sanitizeUser(user) });
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");

  try {
    if (request.method === "GET" && url.pathname === "/health") {
      writeJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && url.pathname === "/auth/users") {
      await handleListUsers(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/auth/users") {
      await handleCreateUser(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/auth/login") {
      await handleLogin(request, response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/auth/me") {
      await handleMe(request, response);
      return;
    }

    const userMatch = url.pathname.match(/^\/auth\/users\/(\d+)$/);
    if (userMatch && request.method === "PUT") {
      await handleUpdateUser(request, response, userMatch[1]);
      return;
    }

    if (userMatch && request.method === "DELETE") {
      await handleDeleteUser(request, response, userMatch[1]);
      return;
    }

    writeJson(response, 404, { ok: false, error: "Rota nao encontrada." });
  } catch (error) {
    console.error(error);
    writeJson(response, 500, { ok: false, error: "Erro interno no servidor." });
  }
});

await ensureSchema();

server.listen(config.port, "0.0.0.0", () => {
  console.log(`Auth backend em :${config.port}`);
});

const stop = async () => {
  server.close();
  await pool.end();
};

process.on("SIGTERM", stop);
process.on("SIGINT", stop);
