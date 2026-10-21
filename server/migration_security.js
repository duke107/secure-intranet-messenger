const { Pool } = require('pg');

const pool = new Pool({
    user: 'admin',
    host: 'localhost',
    database: 'im_db',
    password: 'password', // Assumed from previous context
    port: 5432,
});

async function migrate() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        console.log('Starting Security Phase 2 Migrations...');

        // 1. Roles and Locking
        console.log('Adding system_role and is_locked to users table...');
        await client.query(`
            DO $$ 
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'system_role_enum') THEN
                    CREATE TYPE system_role_enum AS ENUM ('User', 'Admin', 'SuperAdmin');
                END IF;
            END $$;
        `);
        
        await client.query(`
            ALTER TABLE users 
            ADD COLUMN IF NOT EXISTS system_role system_role_enum DEFAULT 'User',
            ADD COLUMN IF NOT EXISTS is_locked BOOLEAN DEFAULT FALSE;
        `);

        // 2. Pre-Key Architecture (3-Tier)
        console.log('Creating Pre-Key architecture tables...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS user_identity_keys (
                user_id VARCHAR(50) PRIMARY KEY REFERENCES users(id),
                x25519_pub VARCHAR(255) NOT NULL,
                mlkem_pub TEXT NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS user_signed_pre_keys (
                user_id VARCHAR(50) PRIMARY KEY REFERENCES users(id),
                x25519_pub VARCHAR(255) NOT NULL,
                mlkem_pub TEXT NOT NULL,
                signature TEXT NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS user_one_time_keys (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id VARCHAR(50) REFERENCES users(id),
                x25519_pub VARCHAR(255) NOT NULL,
                mlkem_pub TEXT NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        // Index for fast popping of one-time keys
        await client.query(`CREATE INDEX IF NOT EXISTS idx_user_one_time_keys_user_id ON user_one_time_keys(user_id);`);

        // 3. Partitioned Audit Logs
        console.log('Creating partitioned audit_logs table...');
        
        // Ensure parent table doesn't already exist as a non-partitioned table.
        // We drop it if it exists and is empty (just in case), or we create it safely.
        await client.query(`
            CREATE TABLE IF NOT EXISTS audit_logs (
                id UUID DEFAULT gen_random_uuid(),
                user_id VARCHAR(50),
                target_id VARCHAR(50),
                action VARCHAR(100) NOT NULL,
                ip_address VARCHAR(45),
                timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id, timestamp)
            ) PARTITION BY RANGE (timestamp);
        `);

        // Create partitions for the current year (2026) to next year
        console.log('Creating audit_logs partitions...');
        const partitions = [
            '2026_09', '2026_10', '2026_11', '2026_12',
            '2027_01', '2027_02', '2027_03', '2027_04'
        ];

        for (const part of partitions) {
            const [year, month] = part.split('_');
            let nextYear = parseInt(year);
            let nextMonth = parseInt(month) + 1;
            if (nextMonth > 12) {
                nextMonth = 1;
                nextYear++;
            }
            const startDate = `${year}-${month}-01`;
            const endDate = `${nextYear}-${nextMonth.toString().padStart(2, '0')}-01`;
            
            await client.query(`
                CREATE TABLE IF NOT EXISTS audit_logs_${part} 
                PARTITION OF audit_logs 
                FOR VALUES FROM ('${startDate}') TO ('${endDate}');
            `);
        }

        await client.query('COMMIT');
        console.log('Security Phase 2 Migrations Completed Successfully!');
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('Migration failed:', e);
    } finally {
        client.release();
        await pool.end();
    }
}

migrate();
