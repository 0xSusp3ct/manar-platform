import { createClient } from "@libsql/client";
import worker from "../vercel/worker.js";
import { SCHEMA_STATEMENTS } from "../vercel/schema.js";

let client;
let database;
let schemaReady;

function getDatabase() {
  if (database) return database;

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("TURSO_DATABASE_URL is required");

  client = createClient({ url, authToken, intMode: "number" });
  database = {
    prepare(sql) {
      return prepared(sql, []);
    },
    async batch(statements) {
      const results = await client.batch(
        statements.map((statement) => ({ sql: statement.sql, args: statement.args })),
        "write",
      );
      return results.map(normalizeRunResult);
    },
  };
  return database;
}

function prepared(sql, args) {
  return {
    sql,
    args,
    bind(...values) {
      return prepared(sql, values);
    },
    async first() {
      const result = await client.execute({ sql, args });
      return result.rows.length ? normalizeRow(result, result.rows[0]) : null;
    },
    async all() {
      const result = await client.execute({ sql, args });
      return { results: result.rows.map((row) => normalizeRow(result, row)) };
    },
    async run() {
      return normalizeRunResult(await client.execute({ sql, args }));
    },
  };
}

function normalizeRow(result, row) {
  if (row && typeof row === "object" && !Array.isArray(row)) {
    return Object.fromEntries(result.columns.map((column, index) => [column, row[column] ?? row[index]]));
  }
  return Object.fromEntries(result.columns.map((column, index) => [column, row[index]]));
}

function normalizeRunResult(result) {
  return {
    meta: {
      changes: Number(result.rowsAffected || 0),
      last_row_id: Number(result.lastInsertRowid || 0),
    },
  };
}

async function ensureSchema() {
  getDatabase();
  if (!schemaReady) {
    schemaReady = client.batch(SCHEMA_STATEMENTS.map((sql) => ({ sql, args: [] })), "write")
      .catch((error) => {
        schemaReady = undefined;
        throw error;
      });
  }
  await schemaReady;
}

export function closeDatabaseForTests() {
  client?.close();
  client = undefined;
  database = undefined;
  schemaReady = undefined;
}

export const maxDuration = 30;

export default {
  async fetch(request) {
    try {
      await ensureSchema();
      return worker.fetch(request, {
        DB: getDatabase(),
        TOKEN_SECRET: process.env.TOKEN_SECRET,
        ADMIN_EMAIL: process.env.ADMIN_EMAIL,
        ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
        SCORING_PROFILE: process.env.SCORING_PROFILE || "current50",
      });
    } catch (error) {
      console.error("Manar Vercel adapter failed", error?.stack || error);
      return Response.json(
        { error: "قاعدة البيانات غير متاحة مؤقتًا." },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
  },
};
