import { open } from 'react-native-quick-sqlite';
import { v4 as uuidv4 } from 'uuid';
// import { getWebSocketInstance } from './websocketService';

const db = open({ name: 'im_database.sqlite' });

export interface ChatMessage {
    recipient_id?: string;
    group_id?: string;
    payload: string;
}

// In-memory queue to track pending RPC ACK timers
const pendingRPCs = new Map<string, NodeJS.Timeout>();

export const sendMessage = async (message: ChatMessage, currentUserId: string) => {
    const clientMessageId = uuidv4();
    const timestamp = new Date().toISOString();
    
    // 1. Queue message locally as PENDING
    db.executeSql(
        `INSERT INTO messages 
        (client_message_id, sender_id, recipient_id, group_id, payload, outbox_sync_status, created_at, updated_at) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            clientMessageId,
            currentUserId,
            message.recipient_id || null,
            message.group_id || null,
            message.payload,
            'PENDING',
            timestamp,
            timestamp
        ]
    );

    // 2. Prepare WebSocket Frame
    const frame = {
        event_type: 'MSG_SEND',
        client_message_id: clientMessageId,
        recipient_id: message.recipient_id,
        group_id: message.group_id,
        payload: message.payload,
        timestamp: timestamp,
    };

    // 3. Push over WebSocket if connected
    // const ws = getWebSocketInstance();
    const ws = null; // Mock for now
    if (ws && ws.readyState === /*WebSocket.OPEN*/ 1) {
        ws.send(JSON.stringify(frame));
        
        // Setup explicit RPC ACK Timeout logic
        const timeout = setTimeout(() => {
            console.warn(`RPC Timeout: Message ${clientMessageId} did not receive ACK_SENT.`);
            // Transition back to 'FAILED' or keep 'PENDING' for background worker
            db.executeSql(
                `UPDATE messages SET outbox_sync_status = 'FAILED' WHERE client_message_id = ?`,
                [clientMessageId]
            );
            pendingRPCs.delete(clientMessageId);
        }, 5000); // 5-second RPC timeout
        
        pendingRPCs.set(clientMessageId, timeout);

    } else {
        console.log('User is offline, message queued as PENDING for background sync.');
    }
    
    return clientMessageId;
};

// Expose a function to be called when WebSocket receives 'ACK_SENT'
export const handleAckSent = (clientMessageId: string) => {
    if (pendingRPCs.has(clientMessageId)) {
        clearTimeout(pendingRPCs.get(clientMessageId));
        pendingRPCs.delete(clientMessageId);
        
        db.executeSql(
            `UPDATE messages SET outbox_sync_status = 'SENT', updated_at = CURRENT_TIMESTAMP WHERE client_message_id = ?`,
            [clientMessageId]
        );
    }
};
