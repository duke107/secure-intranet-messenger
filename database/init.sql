-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users Table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(255) UNIQUE NOT NULL,
    profile_picture_url VARCHAR(512),
    rank VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Chat History Clears (High-water mark for deleted local chat history)
CREATE TABLE chat_history_clears (
    user_id VARCHAR(255) REFERENCES users(username) ON DELETE CASCADE,
    chat_id VARCHAR(255) NOT NULL,
    cleared_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, chat_id)
);

-- Groups Table
CREATE TABLE groups (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Group Members Table
CREATE TABLE group_members (
    group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(50) DEFAULT 'member',
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (group_id, user_id)
);

-- Messages Table (Partitioned by date for 30-day retention)
-- Includes an updated_at field acting as a sync cursor for the high-water mark delta fetch.
CREATE TABLE messages (
    id UUID DEFAULT uuid_generate_v4(),
    client_message_id UUID NOT NULL,
    sender_id UUID REFERENCES users(id),
    group_id UUID REFERENCES groups(id), -- Nullable for DMs
    recipient_id UUID REFERENCES users(id), -- Nullable for Group Chats
    payload TEXT NOT NULL,
    attachment_keys TEXT[] DEFAULT '{}',
    outbox_sync_status VARCHAR(50) DEFAULT 'PENDING',
    is_deleted BOOLEAN DEFAULT FALSE,
    is_forwarded BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX idx_messages_attachment_keys ON messages USING GIN (attachment_keys);

-- Example Partition (Automated via pg_partman in production)
CREATE TABLE messages_y2026m09d08 PARTITION OF messages
    FOR VALUES FROM ('2026-09-08 00:00:00Z') TO ('2026-09-09 00:00:00Z');

-- Default Partition (Catch-all for local testing since pg_partman is not running)
CREATE TABLE messages_default PARTITION OF messages DEFAULT;

-- Function to auto-update updated_at on modify (for Tombstones)
CREATE OR REPLACE FUNCTION trigger_set_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_messages_timestamp
BEFORE UPDATE ON messages
FOR EACH ROW
EXECUTE FUNCTION trigger_set_timestamp();

-- Indexes
CREATE INDEX idx_messages_group_id ON messages(group_id);
CREATE INDEX idx_messages_sender_id ON messages(sender_id);
CREATE INDEX idx_messages_recipient_id ON messages(recipient_id);
CREATE UNIQUE INDEX idx_messages_client_message_id ON messages(client_message_id, created_at);
-- Index on updated_at for optimized delta fetching
CREATE INDEX idx_messages_updated_at ON messages(updated_at);
