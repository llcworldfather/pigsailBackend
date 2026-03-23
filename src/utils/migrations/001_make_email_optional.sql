-- Migration: Make email field optional in users table
-- This migration updates the existing database to support the new login/registration logic

-- Drop the existing table and recreate with new schema
-- Note: This will delete all existing data. In production, use ALTER TABLE instead.
DROP TABLE IF EXISTS users CASCADE;

-- Recreate users table with updated schema
CREATE TABLE users (
    id VARCHAR(255) PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,              -- 账号：用于登录验证
    display_name VARCHAR(100) NOT NULL,                -- 显示名称：聊天中显示的称呼
    email VARCHAR(255) UNIQUE,                         -- 邮箱：可选，自动生成默认值
    password_hash VARCHAR(255) NOT NULL,               -- 密码哈希
    avatar TEXT,                                       -- 头像URL
    status VARCHAR(20) DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'away')),
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_seen TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_status ON users(status);

-- Create function to update updated_at column
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create trigger for updated_at
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Add comment to explain the new field structure
COMMENT ON TABLE users IS '用户表：username用于登录，display_name用于显示称呼';
COMMENT ON COLUMN users.username IS '账号：用户登录时使用的唯一标识符';
COMMENT ON COLUMN users.display_name IS '显示名称：在聊天界面中显示的用户称呼';
COMMENT ON COLUMN users.email IS '邮箱：可选字段，系统会自动生成默认值';