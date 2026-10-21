const WebSocket = require('ws');
const Redis = require('ioredis');
const { Kafka } = require('kafkajs');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const Minio = require('minio');
const crypto = require('crypto');
const { AccessToken } = require('livekit-server-sdk');

const JWT_SECRET = 'super_secret_jwt_key_for_testing';

const pool = new Pool({
    user: 'admin',
    host: 'localhost',
    database: 'im_db',
    password: 'password',
    port: 5432,
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// --- MinIO Setup ---
const minioClient = new Minio.Client({
    endPoint: '127.0.0.1',
    port: 9000,
    useSSL: false,
    accessKey: 'minioadmin',
    secretKey: 'minioadmin'
});

const BUCKET_NAME = 'chat-media';

(async () => {
    try {
        const exists = await minioClient.bucketExists(BUCKET_NAME);
        if (!exists) {
            await minioClient.makeBucket(BUCKET_NAME, 'us-east-1');
            console.log(`Created bucket: ${BUCKET_NAME}`);
            console.log('IMPORTANT: Please configure CORS for this bucket via the MinIO Web Console!');
        }
    } catch (e) {
        console.error('Error initializing MinIO:', e.message);
    }
})();

// --- Security Middleware & Utils ---
async function logAudit(userId, targetId, action, ipAddress) {
    try {
        await pool.query(
            'INSERT INTO audit_logs (user_id, target_id, action, ip_address) VALUES ($1, $2, $3, $4)',
            [userId, targetId, action, ipAddress]
        );
    } catch (err) {
        console.error('Audit Log Error:', err);
    }
}

function authenticateToken(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
}

function requireRole(allowedRoles) {
    return (req, res, next) => {
        if (!req.user || !req.user.role) return res.status(403).json({ error: 'Forbidden' });
        if (!allowedRoles.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
        next();
    };
}

// --- REST API: Admin ---

app.post('/api/admin/lockout/:targetId', authenticateToken, requireRole(['SuperAdmin', 'Admin']), async (req, res) => {
    const targetId = req.params.targetId;
    const ipAddress = req.ip || req.connection.remoteAddress;

    try {
        await pool.query('UPDATE users SET is_locked = TRUE WHERE id = $1', [targetId]);
        await logAudit(req.user.userId, targetId, 'LOCKOUT_USER', ipAddress);
        
        // Broadcast FORCE_LOGOUT
        const redisPub = new Redis();
        await redisPub.publish(`control:${targetId}`, JSON.stringify({ action: 'FORCE_LOGOUT' }));
        redisPub.quit();

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// --- REST API: E2EE Keys ---

app.post('/api/keys/upload', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    const { identityKey, signedPreKey, oneTimeKeys } = req.body;
    
    if (!identityKey || !signedPreKey || !Array.isArray(oneTimeKeys)) {
        return res.status(400).json({ error: 'Invalid key payload' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // Upsert Identity Key
        await client.query(
            `INSERT INTO user_identity_keys (user_id, x25519_pub, mlkem_pub) 
             VALUES ($1, $2, $3) 
             ON CONFLICT (user_id) DO UPDATE SET x25519_pub = EXCLUDED.x25519_pub, mlkem_pub = EXCLUDED.mlkem_pub`,
            [userId, identityKey.x25519_pub, identityKey.mlkem_pub]
        );

        // Upsert Signed Pre-Key
        await client.query(
            `INSERT INTO user_signed_pre_keys (user_id, x25519_pub, mlkem_pub, signature) 
             VALUES ($1, $2, $3, $4) 
             ON CONFLICT (user_id) DO UPDATE SET x25519_pub = EXCLUDED.x25519_pub, mlkem_pub = EXCLUDED.mlkem_pub, signature = EXCLUDED.signature`,
            [userId, signedPreKey.x25519_pub, signedPreKey.mlkem_pub, signedPreKey.signature]
        );

        // ALWAYS delete old one-time keys before inserting new ones! 
        // This ensures the backend doesn't serve keys that the frontend deleted upon logout/wipe.
        await client.query(`DELETE FROM user_one_time_keys WHERE user_id = $1`, [userId]);

        // Insert One-Time Keys
        for (const key of oneTimeKeys) {
            await client.query(
                `INSERT INTO user_one_time_keys (id, user_id, x25519_pub, mlkem_pub) VALUES ($1, $2, $3, $4)`,
                [key.id, userId, key.x25519_pub, key.mlkem_pub]
            );
        }

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Key upload error:', err);
        res.status(500).json({ error: 'Failed to upload keys' });
    } finally {
        client.release();
    }
});

app.get('/api/keys/fetch/:userId', authenticateToken, async (req, res) => {
    const targetUserId = req.params.userId;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const identityRes = await client.query('SELECT x25519_pub, mlkem_pub FROM user_identity_keys WHERE user_id = $1', [targetUserId]);
        if (identityRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'User keys not found' });
        }

        const signedRes = await client.query('SELECT x25519_pub, mlkem_pub, signature FROM user_signed_pre_keys WHERE user_id = $1', [targetUserId]);
        
        // Pop a one-time key
        const oneTimeRes = await client.query(
            `DELETE FROM user_one_time_keys 
             WHERE id = (SELECT id FROM user_one_time_keys WHERE user_id = $1 LIMIT 1 FOR UPDATE SKIP LOCKED) 
             RETURNING id, x25519_pub, mlkem_pub`,
            [targetUserId]
        );

        await client.query('COMMIT');
        
        res.json({
            identityKey: identityRes.rows[0],
            signedPreKey: signedRes.rows[0],
            oneTimeKey: oneTimeRes.rows.length > 0 ? oneTimeRes.rows[0] : null // Null implies fallback to signed pre-key
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Key fetch error:', err);
        res.status(500).json({ error: 'Failed to fetch keys' });
    } finally {
        client.release();
    }
});

// --- REST API: Authentication ---
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });

    try {
        const hash = await bcrypt.hash(password, 10);
        await pool.query(
            `INSERT INTO users (id, username, password_hash) VALUES ($1, $2, $3)`,
            [username, username, hash]
        );
        const token = jwt.sign({ userId: username, role: 'User' }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, userId: username, role: 'User' });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'User already exists' });
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query(`SELECT password_hash, is_locked, system_role FROM users WHERE username = $1`, [username]);
        if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
        
        if (result.rows[0].is_locked) return res.status(403).json({ error: 'Account is locked' });

        const isValid = await bcrypt.compare(password, result.rows[0].password_hash);
        if (!isValid) return res.status(401).json({ error: 'Invalid credentials' });

        const token = jwt.sign({ userId: username, role: result.rows[0].system_role }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, userId: username, role: result.rows[0].system_role });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// --- REST API: Chat History ---

app.get('/api/calls', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });

    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        const userId = decoded.userId;

        const result = await pool.query(
            `SELECT id, room_id, caller_id, recipient_id, group_id, call_type, status, started_at, ended_at, duration_seconds, created_at 
             FROM calls 
             WHERE caller_id = $1 OR recipient_id = $1 OR (group_id IS NOT NULL AND group_id IN (SELECT group_id::text FROM group_members WHERE user_id = $1))
             ORDER BY created_at DESC LIMIT 50`,
            [userId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/messages', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });

    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        const userId = decoded.userId;

        // Note: is_deleted is selected and sent to the client for tombstone syncing
        const result = await pool.query(
            `SELECT m.client_message_id as id, m.sender_id as "senderId", m.recipient_id as "recipientId", m.group_id as "groupId", m.payload, m.outbox_sync_status as status, m.is_deleted, m.is_forwarded, m.created_at as timestamp 
             FROM messages m
             LEFT JOIN chat_history_clears c 
               ON c.user_id = $1 AND c.chat_id = COALESCE(m.group_id::text, (CASE WHEN m.sender_id::text = $1 THEN m.recipient_id::text ELSE m.sender_id::text END))
             WHERE (m.sender_id::text = $1 OR m.recipient_id::text = $1 OR m.group_id::text IN (SELECT group_id::text FROM group_members WHERE user_id = $1))
               AND (c.cleared_at IS NULL OR m.created_at > c.cleared_at)
             ORDER BY m.created_at ASC`,
            [userId]
        );
        
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(401).json({ error: 'Invalid token' });
    }
});

app.post('/api/chats/:chatId/clear', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });

    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        const userId = decoded.userId;
        const chatId = req.params.chatId;

        await pool.query(
            `INSERT INTO chat_history_clears (user_id, chat_id, cleared_at)
             VALUES ($1, $2, CURRENT_TIMESTAMP)
             ON CONFLICT (user_id, chat_id) DO UPDATE SET cleared_at = CURRENT_TIMESTAMP`,
            [userId, chatId]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// --- REST API: User Profiles ---

app.get('/api/users/:userId', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });

    try {
        const targetUserId = req.params.userId;
        const result = await pool.query('SELECT username, profile_picture_url, rank FROM users WHERE username = $1', [targetUserId]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        
        let presence = await redisCache.get(`presence:${targetUserId.toLowerCase()}`);
        
        res.json({ ...result.rows[0], presence: presence || 'offline' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.put('/api/users/me', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });

    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        const userId = decoded.userId;
        const { profile_picture_url, rank } = req.body;

        await pool.query(
            'UPDATE users SET profile_picture_url = $1, rank = $2 WHERE username = $3',
            [profile_picture_url, rank, userId]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// --- REST API: Moderation (Blocking) ---

app.get('/api/blocked', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });

    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        const userId = decoded.userId;

        const result = await pool.query('SELECT blocked_id FROM blocked_users WHERE blocker_id = $1', [userId]);
        res.json(result.rows.map(r => r.blocked_id));
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/block', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });

    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        const userId = decoded.userId;
        const { targetUserId } = req.body;

        if (!targetUserId) return res.status(400).json({ error: 'Missing target user' });

        await pool.query(
            'INSERT INTO blocked_users (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [userId, targetUserId]
        );

        // Invalidate Gateway Cache dynamically
        const redisPub = new Redis();
        await redisPub.publish(`control:${userId}`, JSON.stringify({ action: 'UPDATE_BLOCKLIST' }));
        redisPub.quit();

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/unblock', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });

    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        const userId = decoded.userId;
        const { targetUserId } = req.body;

        if (!targetUserId) return res.status(400).json({ error: 'Missing target user' });

        await pool.query(
            'DELETE FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2',
            [userId, targetUserId]
        );

        // Invalidate Gateway Cache dynamically
        const redisPub = new Redis();
        await redisPub.publish(`control:${userId}`, JSON.stringify({ action: 'UPDATE_BLOCKLIST' }));
        redisPub.quit();

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// --- REST API: Media Orchestration (MinIO) ---

app.get('/api/upload/presign', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });

    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        
        const { filename, contentType } = req.query;
        if (!filename) return res.status(400).json({ error: 'filename query param required' });

        const objectKey = `uploads/${crypto.randomUUID()}-${filename}`;
        
        // 5 minute expiry for PUT
        const presignedUrl = await minioClient.presignedPutObject(BUCKET_NAME, objectKey, 5 * 60);

        res.json({ presignedUrl, objectKey });
    } catch (err) {
        console.error('Presign Error:', err);
        res.status(500).json({ error: 'Server error generating upload URL' });
    }
});

app.post('/api/media/presign-read', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });

    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        const userId = decoded.userId;
        const { objectKeys } = req.body;

        if (!Array.isArray(objectKeys) || objectKeys.length === 0) {
            return res.status(400).json({ error: 'objectKeys array required' });
        }

        // Gatekeeper Logic: Verify user has access to the chats where these attachment_keys were shared
        // We query the DB using the GIN index
        const aclResult = await pool.query(
            `SELECT attachment_keys FROM messages
             WHERE attachment_keys && $1::TEXT[]
               AND (sender_id::text = $2 OR recipient_id::text = $2 OR group_id::text IN (SELECT group_id::text FROM group_members WHERE user_id = $2))`,
            [objectKeys, userId]
        );

        // Flatten the keys the user is actually allowed to see
        const allowedKeys = new Set();
        aclResult.rows.forEach(row => {
            row.attachment_keys.forEach(k => allowedKeys.add(k));
        });

        const urls = {};
        for (const key of objectKeys) {
            if (allowedKeys.has(key)) {
                // 60 minute expiry for GET
                urls[key] = await minioClient.presignedGetObject(BUCKET_NAME, key, 60 * 60);
            }
        }

        res.json({ urls });
    } catch (err) {
        console.error('Presign Read Error:', err);
        res.status(500).json({ error: 'Server error generating read URLs' });
    }
});

// --- REST API: Voice/Video (LiveKit) ---

app.post('/api/calls/token', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });

    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        const userId = decoded.userId;
        const { roomName } = req.body;

        if (!roomName) return res.status(400).json({ error: 'roomName required' });

        // Generate LiveKit token using default local dev credentials
        const at = new AccessToken('devkey', 'secret', {
            identity: userId,
            name: userId,
        });
        at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });

        const livekitToken = await at.toJwt();
        res.json({ token: livekitToken });
    } catch (err) {
        console.error('LiveKit Token Error:', err);
        res.status(500).json({ error: 'Server error generating LiveKit token' });
    }
});

// --- REST API: Group Administration ---

app.post('/api/groups', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });

    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        const userId = decoded.userId;
        const { name, is_announcement_only } = req.body;

        if (!name) return res.status(400).json({ error: 'Group name required' });

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const groupRes = await client.query('INSERT INTO groups (name, is_announcement_only) VALUES ($1, $2) RETURNING id', [name, !!is_announcement_only]);
            const groupId = groupRes.rows[0].id;
            
            await client.query('INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, $3)', [groupId, userId, 'admin']);
            await client.query('COMMIT');

            // Force creator to subscribe to new group
            const redisPub = new Redis();
            await redisPub.publish(`control:${userId}`, JSON.stringify({ action: 'SUBSCRIBE_GROUP', group_id: groupId }));
            redisPub.quit();

            res.json({ id: groupId, name, role: 'admin', is_announcement_only: !!is_announcement_only });
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/groups', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });

    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        const userId = decoded.userId;

        const result = await pool.query(`
            SELECT g.id, g.name, g.is_announcement_only, gm.role 
            FROM groups g 
            JOIN group_members gm ON g.id = gm.group_id 
            WHERE gm.user_id = $1
        `, [userId]);
        
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/groups/:id/members', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });

    try {
        const result = await pool.query('SELECT user_id, role FROM group_members WHERE group_id = $1', [req.params.id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/groups/:id/members', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });

    try {
        const { targetUserId } = req.body;
        const groupId = req.params.id;

        await pool.query('INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [groupId, targetUserId]);

        const redisPub = new Redis();
        await redisPub.publish(`control:${targetUserId}`, JSON.stringify({ action: 'SUBSCRIBE_GROUP', group_id: groupId }));
        await redisPub.publish(`group:${groupId}`, JSON.stringify({ event_type: 'GROUP_STATE_CHANGE', group_id: groupId }));
        redisPub.quit();

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.delete('/api/groups/:id/members/:targetId', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });

    try {
        const groupId = req.params.id;
        const targetUserId = req.params.targetId;

        await pool.query('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, targetUserId]);

        const redisPub = new Redis();
        await redisPub.publish(`control:${targetUserId}`, JSON.stringify({ action: 'UNSUBSCRIBE_GROUP', group_id: groupId }));
        await redisPub.publish(`group:${groupId}`, JSON.stringify({ event_type: 'GROUP_STATE_CHANGE', group_id: groupId }));
        
        // Remove from cache
        await redisCache.hdel(`group_roles:${groupId}`, targetUserId);
        redisPub.quit();

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.put('/api/groups/:id/role', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });

    try {
        const groupId = req.params.id;
        const { targetUserId, role } = req.body; // 'admin' or 'member'

        await pool.query('UPDATE group_members SET role = $1 WHERE group_id = $2 AND user_id = $3', [role, groupId, targetUserId]);

        // Direct Global Cache Mutation
        await redisCache.hset(`group_roles:${groupId}`, targetUserId, role);

        const redisPub = new Redis();
        await redisPub.publish(`group:${groupId}`, JSON.stringify({ event_type: 'GROUP_STATE_CHANGE', group_id: groupId }));
        redisPub.quit();

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.put('/api/groups/:id/announcement', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });

    try {
        const groupId = req.params.id;
        const { is_announcement_only } = req.body; 

        await pool.query('UPDATE groups SET is_announcement_only = $1 WHERE id = $2', [is_announcement_only, groupId]);

        // Direct Global Cache Mutation
        await redisCache.set(`group_meta_announcement:${groupId}`, is_announcement_only ? 'true' : 'false');

        const redisPub = new Redis();
        await redisPub.publish(`group:${groupId}`, JSON.stringify({ event_type: 'GROUP_STATE_CHANGE', group_id: groupId }));
        redisPub.quit();

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.delete('/api/groups/:id', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });

    try {
        const groupId = req.params.id;
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        const userId = decoded.userId;

        // Verify the user is an admin
        const roleRes = await pool.query('SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, userId]);
        if (roleRes.rows.length === 0 || roleRes.rows[0].role !== 'admin') {
            return res.status(403).json({ error: 'Only admins can delete groups' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // Delete messages first to avoid foreign key constraints
            await client.query('DELETE FROM messages WHERE group_id = $1', [groupId]);
            // Deleting the group will cascade delete group_members
            await client.query('DELETE FROM groups WHERE id = $1', [groupId]);
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }

        // Clean up global cache
        await redisCache.del(`group_roles:${groupId}`);
        await redisCache.del(`group_meta_announcement:${groupId}`);

        // Broadcast to all active users in the group that it has been deleted
        const redisPub = new Redis();
        await redisPub.publish(`group:${groupId}`, JSON.stringify({ event_type: 'GROUP_DELETED', group_id: groupId }));
        redisPub.quit();

        res.json({ success: true });
    } catch (err) {
        console.error('Delete group error', err);
        res.status(500).json({ error: 'Server error' });
    }
});

const server = app.listen(8080, () => {
    console.log('Gateway (REST + WebSocket) running on port 8080');
});

// --- Infrastructure ---

const kafka = new Kafka({ clientId: 'im-gateway', brokers: ['localhost:9092'] });
const producer = kafka.producer();

async function initKafka() {
    await producer.connect();
    console.log('Connected to Kafka producer');
}
initKafka().catch(console.error);

// --- Gateway Dispatch & Caching Layer ---

const redisCache = new Redis();
const singletonSubscriber = new Redis();

// Singleton Maps for O(1) in-memory fan-out
const userMap = new Map(); // Map<userId, Set<WebSocket>>
const groupMap = new Map(); // Map<groupId, Set<WebSocket>>

singletonSubscriber.on('message', (channel, message) => {
    if (channel.startsWith('user:')) {
        const uid = channel.split(':')[1];
        const wsSet = userMap.get(uid);
        if (wsSet) {
            for (let ws of wsSet) {
                if (ws.readyState === WebSocket.OPEN) ws.send(message);
            }
        }
    } else if (channel.startsWith('group:')) {
        const gid = channel.split(':')[1];
        const wsSet = groupMap.get(gid);
        if (wsSet) {
            for (let ws of wsSet) {
                if (ws.readyState === WebSocket.OPEN) ws.send(message);
            }
        }
    } else if (channel.startsWith('control:')) {
        const uid = channel.split(':')[1];
        try {
            const payload = JSON.parse(message);
            if (payload.action === 'SUBSCRIBE_GROUP') {
                const gid = payload.group_id;
                singletonSubscriber.subscribe(`group:${gid}`);
            } else if (payload.action === 'UNSUBSCRIBE_GROUP') {
                const gid = payload.group_id;
                // Remove the user from this group's active set on this Gateway
                const wsSet = groupMap.get(gid);
                if (wsSet) {
                    const uSet = userMap.get(uid);
                    if (uSet) {
                        for (let ws of uSet) {
                            wsSet.delete(ws);
                        }
                    }
                    if (wsSet.size === 0) {
                        groupMap.delete(gid);
                        singletonSubscriber.unsubscribe(`group:${gid}`);
                    }
                }
            } else if (payload.action === 'UPDATE_BLOCKLIST') {
                // Invalidate and reload blocklist logic dynamically
                pool.query('SELECT blocked_id FROM blocked_users WHERE blocker_id = $1', [uid])
                    .then(res => {
                        const blocked = res.rows.map(r => r.blocked_id);
                        redisCache.del(`blocked:${uid}`).then(() => {
                            if (blocked.length > 0) redisCache.sadd(`blocked:${uid}`, ...blocked);
                        });
                    }).catch(console.error);
            }
        } catch (e) {
            console.error('Control message parse error', e);
        }
    }
});


// --- WebSocket Gateway ---

const wss = new WebSocket.Server({ server });

wss.on('connection', async (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');

    let userId;
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        userId = decoded.userId;

        const userStatus = await pool.query('SELECT is_locked FROM users WHERE id = $1', [userId]);
        if (userStatus.rows.length === 0 || userStatus.rows[0].is_locked) {
            ws.close(4003, 'Account is locked');
            return;
        }
    } catch (err) {
        ws.close(4001, 'Unauthorized');
        return;
    }

    // Initialize user map
    if (!userMap.has(userId)) {
        userMap.set(userId, new Set());
        // First connection for this user on this Gateway node subscribes to Redis
        singletonSubscriber.subscribe(`user:${userId}`);
        singletonSubscriber.subscribe(`control:${userId}`); // Subscribe to control channel
    }
    userMap.get(userId).add(ws);

    // Initialize presence TTL
    await redisCache.setex(`presence:${userId.toLowerCase()}`, 60, 'online');

    // Initial DB Fetch & Caching on Boot (Hydrating connection context)
    try {
        const groupsRes = await pool.query('SELECT group_id FROM group_members WHERE user_id = $1', [userId]);
        for (const row of groupsRes.rows) {
            const gid = row.group_id;
            if (!groupMap.has(gid)) {
                groupMap.set(gid, new Set());
                singletonSubscriber.subscribe(`group:${gid}`); // Node-level subscription
            }
            groupMap.get(gid).add(ws);
        }

        const blockRes = await pool.query('SELECT blocked_id FROM blocked_users WHERE blocker_id = $1', [userId]);
        if (blockRes.rows.length > 0) {
            const blockedIds = blockRes.rows.map(r => r.blocked_id);
            // No TTL: Remains until actively modified via control channel
            await redisCache.sadd(`blocked:${userId}`, ...blockedIds);
        }
    } catch (err) {
        console.error('Cache hydration failed', err);
    }

    ws.on('message', async (data) => {
        try {
            const frame = JSON.parse(data);
            
            if (!frame.event_type || !frame.timestamp) {
                throw new Error('Invalid frame schema: missing event_type or timestamp');
            }
            if (!frame.client_message_id && !frame.client_message_ids && frame.event_type !== 'PING') {
                throw new Error('Invalid frame schema: missing message identifiers');
            }

            if (frame.event_type === 'PING') {
                await redisCache.setex(`presence:${userId.toLowerCase()}`, 60, 'online');
                return;
            }

            if (frame.event_type === 'MSG_SEND') {
                
                // 1. Blocklist Gatekeeping (Protecting the DB Ingress)
                if (frame.recipient_id) {
                    // Check if recipient blocked sender
                    const isBlocked = await redisCache.sismember(`blocked:${frame.recipient_id}`, userId);
                    if (isBlocked) {
                        return ws.send(JSON.stringify({ error: 'Message blocked by recipient policies' }));
                    }

                    // Check if sender blocked recipient
                    const hasBlockedRecipient = await redisCache.sismember(`blocked:${userId}`, frame.recipient_id);
                    if (hasBlockedRecipient) {
                        return ws.send(JSON.stringify({ error: 'You must unblock this user to send a message' }));
                    }
                }

                // 2. Announcement-Only Group Gatekeeping
                if (frame.group_id) {
                    let isAnnouncement = await redisCache.get(`group_meta_announcement:${frame.group_id}`);
                    if (isAnnouncement === null) {
                        const groupRes = await pool.query('SELECT is_announcement_only FROM groups WHERE id = $1', [frame.group_id]);
                        if (groupRes.rows.length === 0) return ws.send(JSON.stringify({ error: 'Group not found' }));
                        
                        isAnnouncement = groupRes.rows[0].is_announcement_only ? 'true' : 'false';
                        await redisCache.set(`group_meta_announcement:${frame.group_id}`, isAnnouncement);
                    }

                    if (isAnnouncement === 'true') {
                        let role = await redisCache.hget(`group_roles:${frame.group_id}`, userId);
                        if (!role) {
                            const roleRes = await pool.query('SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2', [frame.group_id, userId]);
                            if (roleRes.rows.length === 0) return ws.send(JSON.stringify({ error: 'Not a member' }));
                            role = roleRes.rows[0].role;
                            await redisCache.hset(`group_roles:${frame.group_id}`, userId, role);
                        }

                        if (role !== 'admin') {
                            return ws.send(JSON.stringify({ error: 'ERROR_UNAUTHORIZED: Announcement-only group' }));
                        }
                    }
                }

                // 3. Dispatch to Ingress Pipeline
                await producer.send({
                    topic: 'chat.ingress',
                    messages: [{ 
                        key: frame.client_message_id, 
                        value: JSON.stringify({ ...frame, sender_id: userId }) 
                    }],
                });

                ws.send(JSON.stringify({
                    event_type: 'ACK_SENT',
                    client_message_id: frame.client_message_id,
                    timestamp: new Date().toISOString()
                }));

            } else if (frame.event_type === 'ACK_DELIVERED' || frame.event_type === 'ACK_READ_BULK') {
                await producer.send({
                    topic: 'chat.acks',
                    messages: [{ 
                        key: userId, 
                        value: JSON.stringify({ ...frame, sender_id: userId }) 
                    }],
                });
            } else if (frame.event_type === 'MSG_DELETE') {
                // Route Deletes through Kafka to ensure sequential processing
                await producer.send({
                    topic: 'chat.ingress', // Worker processes this and updates is_deleted = TRUE
                    messages: [{ 
                        key: frame.client_message_id, 
                        value: JSON.stringify({ ...frame, sender_id: userId }) 
                    }],
                });
            } else if (['CALL_OFFER', 'CALL_ANSWER', 'CALL_REJECTED', 'CALL_ENDED'].includes(frame.event_type)) {
                console.log(`[Signaling] Routing ${frame.event_type} from ${userId} to recipient: ${frame.recipient_id}, group: ${frame.group_id}`);
                // Ephemeral WebRTC Signaling (Bypass Kafka Persistence for Realtime Routing)
                const payload = JSON.stringify({ ...frame, sender_id: userId });
                
                // Publish to Kafka for durable Call History persistence
                if (frame.room_id) {
                    await producer.send({
                        topic: 'calls.ingress',
                        messages: [{ 
                            key: frame.room_id, 
                            value: payload 
                        }],
                    });
                }

                if (frame.recipient_id) {
                    await redisCache.publish(`user:${frame.recipient_id}`, payload);
                    // Mirror to other sessions of sender
                    await redisCache.publish(`user:${userId}`, payload);
                } else if (frame.group_id) {
                    await redisCache.publish(`group:${frame.group_id}`, payload);
                }
            }
        } catch (err) {
            console.error('Failed to process message:', err);
            ws.send(JSON.stringify({ error: 'Invalid payload' }));
        }
    });

    ws.on('close', () => {
        // Clean up user connections
        const uSet = userMap.get(userId);
        if (uSet) {
            uSet.delete(ws);
            if (uSet.size === 0) {
                userMap.delete(userId);
                singletonSubscriber.unsubscribe(`user:${userId}`);
                singletonSubscriber.unsubscribe(`control:${userId}`);
                
                // Graceful disconnect timestamp
                redisCache.set(`presence:${userId.toLowerCase()}`, new Date().toISOString());
            }
        }
        
        // Clean up group connections
        for (const [gid, wsSet] of groupMap.entries()) {
            if (wsSet.has(ws)) {
                wsSet.delete(ws);
                // Only unsubscribe if NO user on this Gateway node is in this group
                if (wsSet.size === 0) {
                    groupMap.delete(gid);
                    singletonSubscriber.unsubscribe(`group:${gid}`);
                }
            }
        }
    });
});
