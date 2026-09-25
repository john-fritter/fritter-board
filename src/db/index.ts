import pg, { Pool, type PoolClient } from "pg";

// BIGINT (ids, counts) arrives as a string by default. Every id on this board
// fits comfortably in a double, so parse them as numbers once, here.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

let pool: Pool | null = null;

/**
 * Every connection runs with search_path=board, so queries name tables
 * unqualified. Migrations still qualify everything with `board.` explicitly.
 */
export function createPool(url: string): Pool {
  return new Pool({
    connectionString: url,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    options: "-c search_path=board",
  });
}

export function getPool(): Pool {
  if (pool) return pool;
  const url = process.env["DATABASE_URL"];
  if (!url) {
    throw new Error("DATABASE_URL environment variable is required");
  }
  pool = createPool(url);
  return pool;
}

/** Anything that can run a query: the pool, or a client inside a transaction. */
export type Db = Pick<Pool, "query"> | PoolClient;

export async function withTransaction<T>(
  db: Pool,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
