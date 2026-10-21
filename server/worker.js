const { Kafka } = require('kafkajs');
const { Pool } = require('pg');
const Redis = require('ioredis');

// 1. Connection Pool with strict limits
const pool = new Pool({
    user: 'admin',
    host: 'localhost',
    database: 'im_db',
    password: 'password',
    port: 5432,
    max: 20, 
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

const redis = new Redis();
const kafka = new Kafka({ clientId: 'im-worker', brokers: ['localhost:9092'] });
const consumer = kafka.consumer({ groupId: 'chat-persistence-group' });
const producer = kafka.producer();

// Periodic cron to poll the stateless DLQ (Redis Sorted Set) for orphaned ACKs
setInterval(async () => {
    const now = Date.now();
    try {
        // Fetch ACKs that have passed their 2-second delay
        const delayed = await redis.zrangebyscore('delayed_acks', '-inf', now);
        if (delayed.length === 0) return;

        console.log(`Re-processing ${delayed.length} delayed ACKs from DLQ...`);

        const messages = delayed.map(payload => {
            const parsed = JSON.parse(payload);
            return {
                key: parsed.client_message_id || 'batch',
                value: payload
            };
        });

        // Re-inject into Kafka for stateless processing
        await producer.send({
            topic: 'chat.acks',
            messages
        });

        // Remove them from the DLQ
        await redis.zremrangebyscore('delayed_acks', '-inf', now);
    } catch (err) {
        console.error('DLQ Processor Error:', err);
    }
}, 2000);


async function runWorker() {
    await producer.connect();
    await consumer.connect();
    // Subscribe to both ingress and acks
    await consumer.subscribe({ topic: 'chat.ingress', fromBeginning: false });
    await consumer.subscribe({ topic: 'chat.acks', fromBeginning: false });
    await consumer.subscribe({ topic: 'calls.ingress', fromBeginning: false });

    console.log('Worker listening for messages and ACKs...');

    // 2. Batch Processing via eachBatch
    await consumer.run({
        eachBatchAutoResolve: true,
        eachBatch: async ({ batch, resolveOffset, heartbeat, commitOffsetsIfNecessary }) => {
            const messages = batch.messages;
            if (messages.length === 0) return;

            if (batch.topic === 'chat.ingress') {
                await processIngress(messages, heartbeat);
            } else if (batch.topic === 'chat.acks') {
                await processAcks(messages, heartbeat);
            } else if (batch.topic === 'calls.ingress') {
                await processCalls(messages, heartbeat);
            }
        },
    });
}

async function processIngress(messages, heartbeat) {
    const clientMessageIds = [];
    const senderIds = [];
    const recipientIds = [];
    const groupIds = [];
    const payloads = [];
    const isForwarded = [];
    const attachmentKeys = [];

    const insertParsed = [];
    const deleteParsed = [];

    for (let message of messages) {
        try {
            const parsed = JSON.parse(message.value.toString());
            
            if (parsed.event_type === 'MSG_DELETE') {
                deleteParsed.push(parsed);
            } else {
                insertParsed.push(parsed);
                clientMessageIds.push(parsed.client_message_id);
                senderIds.push(parsed.sender_id);
                recipientIds.push(parsed.recipient_id || null);
                groupIds.push(parsed.group_id || null);
                payloads.push(parsed.payload);
                isForwarded.push(parsed.is_forwarded === true);
                attachmentKeys.push(JSON.stringify(parsed.attachment_keys || []));
            }
        } catch (err) {
            console.error('Failed to parse ingress message:', err);
        }
    }

    const dbClient = await pool.connect();
    try {
        await dbClient.query('BEGIN');

        // Handle Standard Inserts
        if (insertParsed.length > 0) {
            const insertQuery = `
                INSERT INTO messages (client_message_id, sender_id, recipient_id, group_id, payload, is_forwarded, attachment_keys)
                SELECT client_message_id, sender_id, recipient_id, group_id, payload, is_forwarded, 
                       ARRAY(SELECT jsonb_array_elements_text(att_json))
                FROM UNNEST ($1::uuid[], $2::varchar[], $3::varchar[], $4::varchar[], $5::text[], $6::boolean[], $7::jsonb[]) 
                AS t(client_message_id, sender_id, recipient_id, group_id, payload, is_forwarded, att_json)
                ON CONFLICT (client_message_id, created_at) DO NOTHING
                RETURNING client_message_id;
            `;
            
            const result = await dbClient.query(insertQuery, [
                clientMessageIds, senderIds, recipientIds, groupIds, payloads, isForwarded, attachmentKeys
            ]);

            const insertedIds = new Set(result.rows.map(row => row.client_message_id));

            for (let parsed of insertParsed) {
                if (!insertedIds.has(parsed.client_message_id)) continue; 

                const egressFrame = {
                    event_type: 'MSG_RECEIVE',
                    client_message_id: parsed.client_message_id,
                    sender_id: parsed.sender_id,
                    payload: parsed.payload,
                    is_forwarded: parsed.is_forwarded === true,
                    timestamp: new Date().toISOString()
                };

                if (parsed.group_id) {
                    await redis.publish(`group:${parsed.group_id}`, JSON.stringify({ ...egressFrame, group_id: parsed.group_id }));
                } else if (parsed.recipient_id) {
                    await redis.publish(`user:${parsed.recipient_id}`, JSON.stringify(egressFrame));
                }
            }
        }

        // Handle Tombstone Deletes
        if (deleteParsed.length > 0) {
            const deleteIds = deleteParsed.map(p => p.client_message_id);
            const deleteResult = await dbClient.query(`
                UPDATE messages SET is_deleted = TRUE, updated_at = CURRENT_TIMESTAMP
                WHERE client_message_id = ANY($1::uuid[])
                RETURNING client_message_id, sender_id, recipient_id, group_id
            `, [deleteIds]);

            // Broadcast optimized tombstones
            for (const row of deleteResult.rows) {
                const tombstone = {
                    event_type: 'MSG_DELETE',
                    client_message_id: row.client_message_id,
                    is_deleted: true
                };
                const payloadStr = JSON.stringify(tombstone);

                if (row.group_id) {
                    await redis.publish(`group:${row.group_id}`, payloadStr);
                } else if (row.recipient_id) {
                    await redis.publish(`user:${row.recipient_id}`, payloadStr);
                    await redis.publish(`user:${row.sender_id}`, payloadStr); // Sync sender's other devices
                }
            }
        }

        await dbClient.query('COMMIT');
        await heartbeat();
    } catch (err) {
        await dbClient.query('ROLLBACK');
        console.error('Batch process failed:', err);
        throw err; 
    } finally {
        dbClient.release();
    }
}

async function processAcks(messages, heartbeat) {
    const clientMessageIds = [];
    const statuses = [];
    const originalPayloads = new Map();

    for (let message of messages) {
        try {
            const parsed = JSON.parse(message.value.toString());
            
            if (parsed.event_type === 'ACK_DELIVERED') {
                clientMessageIds.push(parsed.client_message_id);
                statuses.push('DELIVERED');
                originalPayloads.set(parsed.client_message_id, parsed);
            } else if (parsed.event_type === 'ACK_READ_BULK') {
                // Client batch logic unrolled
                for (let id of parsed.client_message_ids) {
                    clientMessageIds.push(id);
                    statuses.push('READ');
                    originalPayloads.set(id, {
                        event_type: 'ACK_READ',
                        client_message_id: id,
                        timestamp: parsed.timestamp
                    });
                }
            }
        } catch (err) {
            console.error('Failed to parse ack message:', err);
        }
    }

    if (clientMessageIds.length === 0) return;

    // Fast Batch Update via JOIN UNNEST
    const updateQuery = `
        UPDATE messages AS m
        SET outbox_sync_status = u.status, updated_at = CURRENT_TIMESTAMP
        FROM (SELECT * FROM UNNEST($1::uuid[], $2::varchar[])) AS u(id, status)
        WHERE m.client_message_id = u.id
        RETURNING m.sender_id, m.client_message_id, m.outbox_sync_status;
    `;

    const dbClient = await pool.connect();
    try {
        await dbClient.query('BEGIN');
        const result = await dbClient.query(updateQuery, [clientMessageIds, statuses]);
        await dbClient.query('COMMIT');

        const successfulIds = new Set();

        for (let row of result.rows) {
            successfulIds.add(row.client_message_id);
            // Route the ACK back to the original sender
            const ackFrame = originalPayloads.get(row.client_message_id);
            if (ackFrame) {
                await redis.publish(`user:${row.sender_id}`, JSON.stringify(ackFrame));
            }
        }

        // Handle the Ingress vs. ACK Race Condition Statelessly via Redis DLQ
        const missingIds = clientMessageIds.filter(id => !successfulIds.has(id));
        
        if (missingIds.length > 0) {
            const pipeline = redis.pipeline();
            const delayTime = Date.now() + 2000; // 2 second delay

            for (let id of missingIds) {
                const payload = originalPayloads.get(id);
                if (payload) {
                    pipeline.zadd('delayed_acks', delayTime, JSON.stringify(payload));
                }
            }
            await pipeline.exec();
        }

        await heartbeat();
    } catch (err) {
        await dbClient.query('ROLLBACK');
        console.error('Batch ack update failed:', err);
        throw err;
    } finally {
        dbClient.release();
    }
}

async function processCalls(messages, heartbeat) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        for (const message of messages) {
            await heartbeat();
            const frame = JSON.parse(message.value.toString());
            
            const roomId = frame.room_id;
            const callerId = frame.sender_id;
            
            if (frame.event_type === 'CALL_OFFER') {
                await client.query(`
                    INSERT INTO calls (id, room_id, caller_id, recipient_id, group_id, call_type, status, created_at)
                    VALUES ($1, $2, $3, $4, $5, $6, 'MISSED', $7)
                    ON CONFLICT (id) DO NOTHING
                `, [
                    crypto.randomUUID(), roomId, callerId, 
                    frame.recipient_id || null, frame.group_id || null, 
                    frame.call_type || 'audio', new Date()
                ]);
            } else if (frame.event_type === 'CALL_ANSWER') {
                await client.query(`
                    UPDATE calls SET started_at = $1, status = 'IN_PROGRESS' WHERE room_id = $2
                `, [new Date(), roomId]);
            } else if (frame.event_type === 'CALL_REJECTED') {
                await client.query(`
                    UPDATE calls SET status = 'REJECTED', ended_at = $1 WHERE room_id = $2
                `, [new Date(), roomId]);
            } else if (frame.event_type === 'CALL_ENDED') {
                const res = await client.query('SELECT started_at FROM calls WHERE room_id = $1', [roomId]);
                const endedAt = new Date();
                let duration = 0;
                let status = 'COMPLETED';
                
                if (res.rows.length > 0 && res.rows[0].started_at) {
                    duration = Math.floor((endedAt.getTime() - new Date(res.rows[0].started_at).getTime()) / 1000);
                } else {
                    status = 'MISSED';
                }
                
                await client.query(`
                    UPDATE calls SET status = $1, ended_at = $2, duration_seconds = $3 WHERE room_id = $4
                `, [status, endedAt, duration, roomId]);
            }
        }
        
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('Call event processing failed:', e);
    } finally {
        client.release();
    }
}

runWorker().catch(console.error);
