import { open } from 'react-native-quick-sqlite';
import { v4 as uuidv4 } from 'uuid';
// import { getWebSocketInstance } from './websocketService';

const db = open({ name: 'im_database.sqlite' });

export const initClientDatabase = () => {
    db.executeSql(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL
        );
    `);

    db.executeSql(`
        CREATE TABLE IF NOT EXISTS groups (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL
        );
    `);

    db.executeSql(`
        CREATE TABLE IF NOT EXISTS group_members (
            group_id TEXT,
            user_id TEXT,
            role TEXT,
            PRIMARY KEY (group_id, user_id)
        );
    `);

    db.executeSql(`
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            client_message_id TEXT UNIQUE NOT NULL,
            sender_id TEXT NOT NULL,
            group_id TEXT, 
            recipient_id TEXT,
            payload TEXT,
            is_deleted INTEGER DEFAULT 0,
            outbox_sync_status TEXT DEFAULT 'PENDING',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // FTS5 Virtual Table setup
    db.executeSql(`
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
            payload, 
            content='messages', 
            content_rowid='rowid'
        );
    `);

    // Triggers for FTS5 synchronization
    db.executeSql(`
        CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
            INSERT INTO messages_fts(rowid, payload) VALUES (new.rowid, new.payload);
        END;
    `);

    db.executeSql(`
        CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
            INSERT INTO messages_fts(messages_fts, rowid, payload) VALUES('delete', old.rowid, old.payload);
        END;
    `);

    db.executeSql(`
        CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
            INSERT INTO messages_fts(messages_fts, rowid, payload) VALUES('delete', old.rowid, old.payload);
            INSERT INTO messages_fts(rowid, payload) VALUES (new.rowid, new.payload);
        END;
    `);
    
    // Tombstone Trigger
    db.executeSql(`
        CREATE TRIGGER IF NOT EXISTS update_messages_timestamp AFTER UPDATE ON messages BEGIN
            UPDATE messages SET updated_at = CURRENT_TIMESTAMP WHERE rowid = new.rowid;
        END;
    `);
};
