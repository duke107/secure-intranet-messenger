const { Pool } = require('pg');
const bcrypt = require('bcrypt');


const pool = new Pool({
    user: 'admin',
    host: 'localhost',
    database: 'im_db',
    password: 'password',
    port: 5432,
});

async function reseed() {
    const client = await pool.connect();
    try {
        console.log('Re-seeding E2E users...');
        const hashA = await bcrypt.hash('password123', 10);
        const hashB = await bcrypt.hash('password123', 10);
        
        await client.query(`
            INSERT INTO users (id, username, password_hash, rank)
            VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING
        `, ['UserA', 'UserA', hashA, 'E2E Tester']);
        
        await client.query(`
            INSERT INTO users (id, username, password_hash, rank)
            VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING
        `, ['UserB', 'UserB', hashB, 'E2E Tester']);

        // Insert a dummy message
        await client.query(`
            INSERT INTO messages (id, client_message_id, sender_id, recipient_id, payload, status)
            VALUES ($1, $2, $3, $4, $5, $6)
        `, [
            require('crypto').randomUUID(),
            require('crypto').randomUUID(),
            'UserA',
            'UserB',
            JSON.stringify({text: "Hello from UserA! I restored our E2E data."}),
            'DELIVERED'
        ]);

        console.log('Re-seeded users successfully!');
    } catch (err) {
        console.error('Failed to reseed:', err);
    } finally {
        client.release();
        pool.end();
    }
}

reseed();
