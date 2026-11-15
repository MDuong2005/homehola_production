import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

/**
 * Khởi tạo Connection Pool kết nối PostgreSQL
 * Sử dụng pattern Singleton trên môi trường development để tránh cạn kiệt connection do Next.js hot reload
 */
const globalForDb = globalThis as unknown as {
  pool: Pool | undefined;
};

const pool =
  globalForDb.pool ??
  new Pool({
    connectionString:
      process.env.DATABASE_URL ||
      'postgresql://postgres:secret@localhost:5433/hoalac_rooms',
    max: 10, // Tối ưu tài nguyên cho VPS / máy cá nhân
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

if (process.env.NODE_ENV !== 'production') {
  globalForDb.pool = pool;
}

/**
 * Drizzle ORM client với đầy đủ schema ánh xạ
 */
export const db = drizzle(pool, { schema });

export { pool };
