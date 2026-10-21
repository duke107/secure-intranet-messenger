const { Pool } = require('pg');

const pool = new Pool({
    user: 'admin',
    host: 'localhost',
    database: 'im_db',
    password: 'password',
    port: 5432,
});

async function seed() {
    const client = await pool.connect();
    try {
        console.log('Dropping Foreign Key constraints to allow arbitrary testing names...');
        
        // Drop foreign keys so we can insert any string for sender_id/recipient_id
        await client.query(`ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_sender_id_fkey;`);
        await client.query(`ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_recipient_id_fkey;`);
        await client.query(`ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_group_id_fkey;`);

        // Alter the columns to VARCHAR instead of UUID so you can use "UserA" and "UserB" directly
        await client.query(`ALTER TABLE messages ALTER COLUMN sender_id TYPE VARCHAR(255);`);
        await client.query(`ALTER TABLE messages ALTER COLUMN recipient_id TYPE VARCHAR(255);`);
        
        console.log('Database constraints relaxed for E2E testing! You can now use "UserA" and "UserB".');
    } catch (err) {
        console.error('Migration failed:', err);
    } finally {
        client.release();
        pool.end();
    }
}

seed();
