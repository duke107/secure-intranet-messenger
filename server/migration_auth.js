const { Pool } = require('pg');

const pool = new Pool({
    user: 'admin',
    host: 'localhost',
    database: 'im_db',
    password: 'password',
    port: 5432,
});

async function migrate() {
    const client = await pool.connect();
    try {
        console.log('Running Authentication Migration...');
        
        // Add password_hash to users
        await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);`);
        
        // Drop group_members constraint and alter user_id
        await client.query(`ALTER TABLE group_members DROP CONSTRAINT IF EXISTS group_members_user_id_fkey;`);
        await client.query(`ALTER TABLE group_members ALTER COLUMN user_id TYPE VARCHAR(255);`);

        // Change users ID to VARCHAR
        await client.query(`ALTER TABLE users ALTER COLUMN id DROP DEFAULT;`);
        await client.query(`ALTER TABLE users ALTER COLUMN id TYPE VARCHAR(255);`);

        console.log('Migration complete!');
    } catch (err) {
        console.error('Migration failed:', err);
    } finally {
        client.release();
        pool.end();
    }
}

migrate();
