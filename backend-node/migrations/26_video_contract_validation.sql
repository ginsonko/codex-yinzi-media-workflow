ALTER TABLE video_generations ADD COLUMN contract_validation_mode TEXT NOT NULL DEFAULT 'strict';
ALTER TABLE video_generations ADD COLUMN contract_validation_receipt_json TEXT;
