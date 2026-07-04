-- Migration: add assigned_mobile column to subscriptions and orders tables
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor > New query)

ALTER TABLE subscriptions
ADD COLUMN IF NOT EXISTS assigned_mobile text;

ALTER TABLE orders
ADD COLUMN IF NOT EXISTS assigned_mobile text;

-- Seed test row (dev only — remove before production migration)
UPDATE subscriptions
SET assigned_mobile = '0400000001'
WHERE stripe_subscription_id = 'sub_test_001';
